import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { afterEach, expect, test, vi } from "vitest";
import { valueProof } from "../src/vite.ts";
import { checkLeanObligations } from "./lean-translation.ts";
import type { LeanVerdict } from "./cross-check.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";
import { runVerifyCli, type VerificationReport } from "./verify.ts";

vi.mock("./lean-translation.ts", () => ({ checkLeanObligations: vi.fn() }));

const project = process.cwd();
const work = path.join(project, "work");
fs.mkdirSync(work, { recursive: true });
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(predicate: string): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(work, "cross-check-consumer-"));
  roots.push(root);
  const entry = path.join(root, "identity.ts");
  const api = path.relative(root, path.join(project, "src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import { contract } from ${JSON.stringify(api)};
export function identity(x: bigint): bigint { return x; }
contract(identity, { ensures: (r, x) => ${predicate} });
`);
  return { root, entry };
}

function leanReturns(verdict: LeanVerdict) {
  vi.mocked(checkLeanObligations).mockImplementation(async obligations =>
    new Map(obligations.map(obligation => [obligation.key, verdict])));
}

async function cliReport(root: string, entry: string) {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    process.chdir(root);
    const code = await runVerifyCli(entry);
    expect(output).toHaveBeenCalledTimes(1);
    const text = output.mock.calls[0][0] as string;
    expect(fs.readFileSync("work/verification.json", "utf8")).toBe(text + "\n");
    return { code, report: JSON.parse(text) as VerificationReport };
  } finally {
    process.chdir(project);
    output.mockRestore();
  }
}

const scenarios = [
  { title: "both prove", predicate: "r === x", lean: { status: "proved" },
    z3: "proved", comparison: "agreed", overall: "verified", code: 0 },
  { title: "Lean is missing", predicate: "r === x", lean: { status: "unavailable", reason: "Lean is missing" },
    z3: "proved", comparison: "unconfirmed", overall: "verified", code: 0 },
  { title: "both disprove", predicate: "r !== 7n", lean: { status: "disproved" },
    z3: "disproved", comparison: "agreed", overall: "refuted", code: 1 },
  { title: "only Z3 finds the violation", predicate: "r !== 7n", lean: { status: "unknown", reason: "Budget exhausted" },
    z3: "disproved", comparison: "unconfirmed", overall: "refuted", code: 1 },
  { title: "Lean contradicts Z3", predicate: "r !== 7n", lean: { status: "proved" },
    z3: "disproved", comparison: "disagreement", overall: "unknown", code: 2 },
] as const;

test.each(scenarios)("CLI, Vite and saved regressions when $title", async scenario => {
  const { root, entry } = fixture(scenario.predicate);
  leanReturns(scenario.lean);
  const { code, report } = await cliReport(root, entry);
  expect(code).toBe(scenario.code);
  expect(report.status).toBe(scenario.overall);
  expect(report.results).toHaveLength(1);
  const [row] = report.results;
  expect(row.crossCheck).toMatchObject({
    z3: { status: scenario.z3 }, lean: scenario.lean, comparison: scenario.comparison,
  });
  const bundle = build({ configFile: false, root, logLevel: "silent", plugins: [valueProof({ entries: [entry] })],
    build: { target: "es2022", lib: { entry, formats: ["es"], fileName: "identity" } } });
  if (scenario.code === 0) {
    await bundle;
    expect(fs.existsSync(path.join(root, "dist/identity.js"))).toBe(true);
    return;
  }
  await expect(bundle).rejects.toThrow(`Contract verification ${scenario.overall}`);
  expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  const generated = await generateRegressions(entry, path.join(root, "generated"));
  const { manifest, runtime } = loadRegressions(generated.manifestFile);
  if (scenario.comparison === "disagreement") {
    expect(row).toMatchObject({ status: "unknown", reasonCode: "backend-disagreement" });
    expect(row).not.toHaveProperty("counterexample");
    expect(manifest.cases).toEqual([]);
    expect(generated.unknownObligations).toBe(1);
  } else {
    expect(row).toMatchObject({ status: "disproved", counterexample: { x: "7n" } });
    expect(manifest.cases).toHaveLength(1);
    expect(manifest.cases[0].inputs).toEqual(["7n"]);
    expect(replayRegression(runtime, entry, manifest.cases[0]).status).toBe("failed");
  }
});

test("a conflict stays visible alongside an independent refutation", async () => {
  const { root, entry } = fixture("r !== 7n");
  fs.appendFileSync(entry, `export function other(x: bigint): bigint { return x; }
contract(other, { ensures: r => r !== 9n });
`);
  vi.mocked(checkLeanObligations).mockImplementation(async obligations =>
    new Map(obligations.map(item =>
      [item.key, { status: item.owner.sourceName === "identity" ? "proved" : "disproved" }])));
  const { code, report } = await cliReport(root, entry);
  expect(code).toBe(1);
  expect(report.status).toBe("refuted");
  expect(report.results.find(row => row.sourceName === "identity")).toMatchObject({
    status: "unknown", reasonCode: "backend-disagreement", crossCheck: { comparison: "disagreement" },
  });
  expect(report.results.find(row => row.sourceName === "other")).toMatchObject({
    status: "disproved", counterexample: { x: "9n" }, crossCheck: { comparison: "agreed" },
  });
});
