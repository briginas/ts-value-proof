import { decodeScalar, semanticsFor, type ScalarSort, type Semantics, type EncodedValue } from "./numeric-values.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyProgram } from "./verification.ts";
import { createTestRuntime, callSites, type TestRuntime } from "./test-runtime.ts";
import type { FunctionIR, SourceLocation } from "./ir.ts";

type FunctionKey = { file: string; name: string; parameters: string[]; semantics?: Semantics | "invalid"; parameterSorts?: string[]; returnSort?: string };
export type Regression = {
  function: FunctionKey;
  inputs: EncodedValue[];
  source: SourceLocation;
  contractSource: SourceLocation;
} & (
  | { kind: "implementation" }
  | { kind: "call"; callSource: SourceLocation; callOrdinal: number; callCount: number; callee: FunctionKey }
);
export type RegressionManifest = {
  version: 1 | 2 | 3;
  semantics?: Semantics;
  entry: string;
  cases: Regression[];
};
export type ReplayResult = { status: "passed" | "failed" | "inapplicable"; reason: string };

function key(fn: FunctionIR, entry: string, sort: ScalarSort): FunctionKey {
  return { file: path.relative(path.dirname(path.resolve(entry)), fn.source.file),
    name: fn.sourceName, parameters: fn.params.map(p => p.name),
    ...(sort === "string" ? {semantics: semanticsFor(sort), parameterSorts:fn.params.map(p=>p.sort),returnSort:fn.returnSort} : {}),
    ...(sort !== "string" && fn.returnSort === "float64" ? {semantics: semanticsFor(fn.returnSort)} : {}) };
}
function sameFunction(a: FunctionKey, b: FunctionKey): boolean {
  if (!b || typeof b !== "object" || typeof b.file !== "string" || typeof b.name !== "string" ||
      !Array.isArray(b.parameters) || b.parameters.some(p => typeof p !== "string") ||
      (b.semantics !== undefined && b.semantics !== "bigint-exact-integers" && b.semantics !== "number-ieee754-binary64" && b.semantics !== "string-utf16-number-binary64")) return false;
  if (a.semantics === "string-utf16-number-binary64" &&
      (JSON.stringify(a.parameterSorts) !== JSON.stringify(b.parameterSorts) || a.returnSort !== b.returnSort)) return false;
  return (a.semantics ?? "bigint-exact-integers") === (b.semantics ?? "bigint-exact-integers") && a.file === b.file && a.name === b.name && JSON.stringify(a.parameters) === JSON.stringify(b.parameters);
}
function decode(inputs: EncodedValue[], fn: FunctionIR) {
  if (!Array.isArray(inputs)) throw new Error("Regression inputs must be an array");
  if (inputs.length !== fn.params.length) throw new Error("Regression input arity mismatch");
  return inputs.map((x,i) => decodeScalar(x, fn.params[i].sort as ScalarSort));
}

/** Rebind by module/name/signature, not unstable offsets or internal IR IDs.
 * Calls additionally retain their ordinal, total count and target symbol. An
 * structurally incompatible edit needs regeneration. Replay also checks all
 * observed calls, so moving an unsafe call cannot hide it behind a safe ordinal.
 */
export function replayRegression(runtime: TestRuntime, entry: string, regression: Regression): ReplayResult {
  try {
    const fn = runtime.ir.functions.find(fn => sameFunction(key(fn, entry, runtime.sort), regression.function));
    if (!fn) throw new Error("Function or parameter names changed; regenerate the case");
    const args = decode(regression.inputs, fn);
    if (!runtime.accepts(fn.name, args)) throw new Error("Stored input no longer satisfies requires");
    if (regression.kind === "implementation") {
      const execution = runtime.execute(fn.name, args);
      if (execution.ensures === undefined) throw new Error("Implementation contract is missing");
      return { status: execution.ensures ? "passed" : "failed",
        reason: execution.ensures ? "Actual result satisfies ensures" : "Actual result violates ensures" };
    }
    if (regression.kind !== "call") throw new Error("Unknown regression kind");
    const sites = callSites(fn);
    const target = sites[regression.callOrdinal];
    const callee = target && runtime.ir.functions.find(fn => fn.name === target.callee);
    if (sites.length !== regression.callCount || !target || !callee || !sameFunction(key(callee, entry, runtime.sort), regression.callee))
      throw new Error("Call structure or target changed; regenerate the case");
    if (!callee.contracts.some(c => c.kind === "requires")) throw new Error("Target requires is missing");
    const execution = runtime.execute(fn.name, args);
    const observed = execution.calls.filter(call => call.site.id === target.id);
    const failed = execution.calls.some(call => !call.accepted);
    return { status: failed ? "failed" : "passed", reason: failed
      ? "Actual arguments violate requires during the recorded caller's execution"
      : observed.length ? "Actual arguments satisfy requires at the recorded call" : "The corrected path does not reach the recorded call" };
  } catch (error) {
    return { status: "inapplicable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function loadRegressions(manifestFile: string) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as RegressionManifest;
  if (!manifest || (manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3) ||
      (manifest.version === 3 && manifest.semantics !== "string-utf16-number-binary64") ||
      (manifest.version === 2 && manifest.semantics !== "number-ieee754-binary64") ||
      (manifest.version === 1 && manifest.semantics !== undefined && manifest.semantics !== "bigint-exact-integers") || typeof manifest.entry !== "string" || !Array.isArray(manifest.cases))
    throw new Error("Invalid regression manifest");
  const entry = path.resolve(path.dirname(manifestFile), manifest.entry);
  // Normalize model identity in memory; never rewrite existing v1 files. The
  // container version is authoritative even if a damaged case claims otherwise.
  for (const regression of manifest.cases) {
    if (!regression || typeof regression !== "object") continue;
    const expected = manifest.version === 1 ? undefined : manifest.version === 2 ? "number-ieee754-binary64" : "string-utf16-number-binary64";
    for (const key of [regression.function, regression.kind === "call" ? regression.callee : undefined]) {
      if (!key || typeof key !== "object") continue;
      if (key.semantics !== expected) key.semantics = "invalid";
    }
  }
  return { manifest, entry, runtime: createTestRuntime(entry) };
}

export async function generateRegressions(entry: string, outputDirectory: string) {
  entry = path.resolve(entry);
  outputDirectory = path.resolve(outputDirectory);
  const runtime = createTestRuntime(entry);
  const results = await verifyProgram(runtime.ir);
  const cases: Regression[] = [];
  const unconfirmed: { function: string; reason: string }[] = [];
  for (const result of results) {
    if (result.kind === "preconditions" || result.status !== "disproved") continue;
    const fn = runtime.ir.functions.find(fn => fn.name === result.function)!;
    const base = { function: key(fn, entry, runtime.sort), source: result.source, contractSource: result.contractSource,
      inputs: fn.params.map(p => result.counterexample[p.name]) };
    let regression: Regression;
    if (result.kind === "implementation") regression = { ...base, kind: "implementation" };
    else {
      const sites = callSites(fn);
      const site = sites.find(site => site.id === result.callId)!;
      regression = { ...base, kind: "call", callSource: result.callSource, callOrdinal: site.ordinal,
        callCount: sites.length, callee: key(runtime.ir.functions.find(fn => fn.name === site.callee)!, entry, runtime.sort) };
    }
    regression = JSON.parse(JSON.stringify(regression)) as Regression;
    const replay = replayRegression(runtime, entry, regression);
    if (replay.status !== "failed") {
      unconfirmed.push({ function: result.sourceName, reason: replay.reason });
      continue;
    }
    // Confirmation is stricter than replay after a fix: the original reported
    // source call itself must fail, not merely another call on the same path.
    if (result.kind === "call" && !runtime.execute(fn.name, decode(regression.inputs, fn)).calls
      .some(call => call.site.id === result.callId && !call.accepted)) {
      unconfirmed.push({ function: result.sourceName, reason: "The reported source call did not violate requires at runtime" });
      continue;
    }
    if (!cases.some(existing => JSON.stringify(existing) === JSON.stringify(regression))) cases.push(regression);
  }
  const isNumber = runtime.sort === "float64";
  const isString = runtime.sort === "string";
  const manifest: RegressionManifest = { version: isString ? 3 : isNumber ? 2 : 1,
    ...(isString ? {semantics:"string-utf16-number-binary64" as const} : isNumber ? {semantics: "number-ieee754-binary64" as const} : {}), entry: path.relative(outputDirectory, entry), cases };
  const relativeModule = (name: string) => {
    const relative = path.relative(outputDirectory, fileURLToPath(new URL(name, import.meta.url))).split(path.sep).join("/");
    return JSON.stringify(relative.startsWith(".") ? relative : "./" + relative);
  };
  // Embed no source program or executable counterexample strings. Tests reload
  // current source and check the same saved inputs after the user fixes the code.
  const suite = `import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadRegressions, replayRegression } from ${relativeModule("./regressions.ts")};
import { checkProperties } from ${relativeModule("./property-tests.ts")};

const { manifest, entry, runtime } = loadRegressions(fileURLToPath(new URL("./cases.json", import.meta.url)));
for (const [index, regression] of manifest.cases.entries()) {
  test(\`regression \${index + 1}: \${regression.function.name} / \${regression.kind}\`, () => {
    const result = replayRegression(runtime, entry, regression);
    expect(result.status, result.reason).toBe("passed");
  });
}
test("contract properties on actual implementations", async () => {
  const results = await checkProperties(runtime);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) expect(result.status, JSON.stringify(result)).toBe("passed");
}, 60000);
`;
  fs.mkdirSync(outputDirectory, { recursive: true });
  const manifestFile = path.join(outputDirectory, "cases.json");
  const testFile = path.join(outputDirectory, "contracts.test.ts");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(testFile, suite);
  return { manifestFile, testFile, cases: cases.length, unconfirmed,
    unknownObligations: results.filter(result => result.status === "unknown").length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await generateRegressions(process.argv[2] ?? "examples/withdraw.ts", process.argv[3] ?? "work/generated");
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.unconfirmed.length ? 2 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
