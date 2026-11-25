import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LeanVerdict } from "./cross-check.ts";

const runFile = promisify(execFile);
const version = "4.19.0";
const executableName = process.platform === "win32" ? "lean.exe" : "lean";

export type LeanGoal = {
  key: string;
  kind: "preconditions" | "implementation" | "call";
  variables: string[];
  assumptions: string[];
  goal: string;
};

export type LeanRunnerOptions = {
  executable?: string;
  timeoutMs?: number;
  maxHeartbeats?: number;
};

// Invoke a compiler with its own standard library. An elan proxy on PATH can
// otherwise install a toolchain just by being asked to report its version.
async function* localCompilers(): AsyncGenerator<string> {
  const elan = process.env.ELAN_HOME || join(homedir(), ".elan");
  const candidates = [
    join(elan, "toolchains", `leanprover--lean4---v${version}`, "bin", executableName),
    ...(process.env.PATH || "").split(delimiter).filter(Boolean).map((dir) => join(dir, executableName)),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const compiler = await realpath(candidate);
      if (seen.has(compiler) || basename(compiler) !== executableName) continue;
      seen.add(compiler);
      const bin = dirname(compiler);
      const library = join(bin, "..", "lib", "lean", "Init.olean");
      if (!(await stat(library)).isFile()) continue;
      const tool = await stat(compiler);
      const proxy = await stat(join(bin, process.platform === "win32" ? "elan.exe" : "elan")).catch(() => undefined);
      if (proxy && tool.dev === proxy.dev && tool.ino === proxy.ino) continue;
      yield compiler;
    } catch {
      // This PATH entry has no standalone compiler.
    }
  }
}

const prelude = [
  "import Lean",
  "set_option autoImplicit false",
  "set_option linter.unusedVariables false",
  // Try small integral witnesses inside Lean. Backtrack through the complete
  // tuple, with each candidate checked by kernel reduction of the predicate.
  'syntax "tryIntWitnesses" : tactic',
  "macro_rules",
  "| `(tactic| tryIntWitnesses) => `(tactic|",
  "  first",
  "  | decide",
  "  | (refine ⟨(0 : Int), ?_⟩; tryIntWitnesses)",
  "  | (refine ⟨(1 : Int), ?_⟩; tryIntWitnesses)",
  "  | (refine ⟨(-1 : Int), ?_⟩; tryIntWitnesses))",
];

function quantify(quantifier: string, variables: string[], proposition: string): string {
  return variables.length ? `${quantifier} ${variables.join(" ")} : Int, ${proposition}` : proposition;
}

function proof(goal: LeanGoal, positive: boolean): { proposition: string; steps: string[] } {
  const vs = goal.variables;
  const inputs = vs.map((_, i) => `w${i}`);
  const assumptions = goal.assumptions.map((assumption) => `(${assumption})`).join(" ∧ ") || "True";
  const arithmetic = "first | omega | (repeat' split at * <;> omega)";
  if (goal.kind === "preconditions") {
    const exists = quantify("∃", vs, assumptions);
    if (positive) return { proposition: exists, steps: ["tryIntWitnesses"] };
    const steps = ["intro h"];
    if (vs.length) steps.push(`obtain ⟨${[...inputs, "ha"].join(", ")}⟩ := h`);
    return { proposition: `¬ (${exists})`, steps: [...steps, arithmetic] };
  }
  const statement = quantify("∀", vs, `(${assumptions}) → (${goal.goal})`);
  if (positive) {
    return { proposition: statement, steps: [`intro ${[...inputs, "ha"].join(" ")}`, arithmetic] };
  }
  const witness = quantify("∃", vs, `(${assumptions}) ∧ ¬ (${goal.goal})`);
  return {
    proposition: `¬ (${statement})`,
    steps: [
      "intro h",
      `have bad : ${witness} := by tryIntWitnesses`,
      `obtain ⟨${[...inputs, "ha", "hg"].join(", ")}⟩ := bad`,
      `exact hg (h ${[...inputs, "ha"].join(" ")})`,
    ],
  };
}

type Attempt = { name: string; start: number; axioms: number; tag: number };

function batchSource(goals: readonly LeanGoal[], heartbeats: number) {
  const lines = [...prelude];
  const attempts: Attempt[][] = [];
  for (const [index, goal] of goals.entries()) {
    const pair = [];
    for (const positive of [true, false]) {
      const name = `check${index}${positive ? "Pos" : "Neg"}`;
      const { proposition, steps } = proof(goal, positive);
      const start = lines.length + 1;
      lines.push(
        `set_option maxHeartbeats ${heartbeats} in`,
        `def ${name} : Option (PLift (${proposition})) := by`,
        "  first",
        "  | refine some ⟨?_⟩",
        ...steps.map((step) => `    ${step}`),
        "    done",
        "  | exact none",
        `#print axioms ${name}`,
        `#reduce if ${name}.isSome then "proved" else "open"`,
      );
      pair.push({ name, start, axioms: lines.length - 1, tag: lines.length });
    }
    attempts.push(pair);
  }
  return { source: lines.join("\n") + "\n", attempts };
}

type Diagnostic = { pos: { line: number }; severity: string; data: string };

function diagnostics(output: string): Diagnostic[] {
  return output.trim().split("\n").map((line) => {
    const msg = JSON.parse(line) as Diagnostic;
    if (!Number.isSafeInteger(msg.pos?.line) || typeof msg.data !== "string" ||
        !["information", "warning", "error"].includes(msg.severity)) throw new Error("Invalid Lean diagnostic");
    return msg;
  });
}

function readPolarity(attempt: Attempt, messages: Diagnostic[]): boolean | undefined {
  const rows = messages.filter(({ pos }) => pos.line >= attempt.start && pos.line <= attempt.tag);
  if (rows.some(({ severity }) => severity !== "information")) return undefined;
  const audits = rows.filter(({ pos }) => pos.line === attempt.axioms);
  const tags = rows.filter(({ pos }) => pos.line === attempt.tag);
  if (audits.length !== 1 || tags.length !== 1) return undefined;
  const audit = audits[0].data;
  if (audit !== `'${attempt.name}' does not depend on any axioms`) {
    const prefix = `'${attempt.name}' depends on axioms: [`;
    if (!audit.startsWith(prefix) || !audit.endsWith("]")) return undefined;
    const axioms = audit.slice(prefix.length, -1).split(", ");
    if (!axioms.every((a) => ["propext", "Classical.choice", "Quot.sound"].includes(a))) return undefined;
  }
  if (tags[0].data === '"proved"') return true;
  if (tags[0].data === '"open"') return false;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function missingBinary(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "EACCES";
}

function fixed(goals: readonly LeanGoal[], verdict: LeanVerdict): Map<string, LeanVerdict> {
  return new Map(goals.map(({ key }) => [key, verdict]));
}

export async function runLeanGoals(
  goals: readonly LeanGoal[], options: LeanRunnerOptions = {},
): Promise<Map<string, LeanVerdict>> {
  if (goals.length === 0) return new Map();
  const candidates = options.executable ? [resolve(options.executable)] : localCompilers();
  const unavailable: LeanVerdict = { status: "unavailable", reason: `Local Lean ${version} compiler is unavailable` };
  const heartbeats = options.maxHeartbeats ?? 80_000;
  const timeout = options.timeoutMs ?? 15_000;
  if (![heartbeats, timeout].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)) {
    throw new RangeError("Lean resource limits must be positive 32-bit integers");
  }
  // Elan checks its recursion guard before toolchain resolution. Even a copied
  // proxy next to an unrelated standard library must never fetch a compiler.
  const env: NodeJS.ProcessEnv = { ...process.env, LEAN_RECURSION_COUNT: "100" };
  delete env.LEAN_PATH;
  delete env.LEAN_SYSROOT;
  const command = { timeout, env, killSignal: "SIGKILL" as const, maxBuffer: 8 * 1024 * 1024 };
  try {
    let compiler: string | undefined;
    for await (const candidate of candidates) {
      let banner: string;
      try {
        banner = (await runFile(candidate, ["--version"], { ...command, cwd: dirname(candidate) })).stdout;
      } catch (error) {
        if (missingBinary(error) || (errorCode(error) === 1 && error instanceof Error && error.message.includes("infinite recursion"))) continue;
        throw error;
      }
      if (banner.startsWith(`Lean (version ${version},`)) {
        compiler = candidate;
        break;
      }
    }
    if (!compiler) return fixed(goals, unavailable);
    const dir = await mkdtemp(join(tmpdir(), "ts-value-proof-lean-"));
    try {
      const execOptions = { ...command, cwd: dir };
      const { source, attempts } = batchSource(goals, heartbeats);
      await writeFile(join(dir, "Checks.lean"), source);
      let output: string;
      try {
        output = (await runFile(compiler, ["--json", "Checks.lean"], execOptions)).stdout;
      } catch (error) {
        if (missingBinary(error)) return fixed(goals, unavailable);
        // Lean continues checking independent declarations after a localized error.
        if (errorCode(error) !== 1 || !error || typeof error !== "object" ||
            !("stdout" in error) || typeof error.stdout !== "string") throw error;
        output = error.stdout;
        if (!diagnostics(output).some(({ severity }) => severity === "error")) throw error;
      }
      const messages = diagnostics(output);
      if (messages.some((msg) => msg.severity !== "information" && msg.pos.line <= prelude.length)) {
        return fixed(goals, { status: "unknown", reason: "Lean could not compile the proof prelude" });
      }
      const result = new Map<string, LeanVerdict>();
      for (const [index, goal] of goals.entries()) {
        const [positive, negative] = attempts[index].map((attempt) => readPolarity(attempt, messages));
        let verdict: LeanVerdict;
        if (positive === undefined || negative === undefined || (positive && negative)) {
          verdict = { status: "unknown", reason: "Lean compilation or proof audit failed" };
        } else if (positive) {
          verdict = { status: goal.kind === "preconditions" ? "satisfiable" : "proved" };
        } else if (negative) {
          verdict = { status: goal.kind === "preconditions" ? "inconsistent" : "disproved" };
        } else {
          verdict = { status: "unknown", reason: "Lean did not prove either polarity within its proof budget" };
        }
        result.set(goal.key, verdict);
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 2 });
    }
  } catch (error) {
    const timedOut = errorCode(error) == null && error && typeof error === "object" && "killed" in error && error.killed;
    return fixed(goals, { status: "unknown", reason: timedOut ? "Lean process timed out" : "Lean process or diagnostic output failed" });
  }
}
