import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { createTestRuntime } from "./test-runtime.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";
import { checkProperties } from "./property-tests.ts";

const root = path.resolve("work/runtime");
function fixture(name: string, source: string, other: Record<string, string> = {}) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  for (const [file, text] of Object.entries({ "entry.ts": source, ...other }))
    fs.writeFileSync(path.join(directory, file), text.replaceAll("@api", api));
  return { directory, entry: path.join(directory, "entry.ts") };
}
const prefix = 'import { contract } from "@api";\n';
const identity = `function hidden(x: bigint): bigint { return x; }
contract(hidden, { requires: x => x >= 0n, ensures: (r, x) => r === x });`;

test("actual private functions, aliases, re-exports and separate contract modules retain symbol identity", () => {
  const { entry } = fixture("modules", `import { same as one } from "./one.js";
import { alias as two } from "./barrel.js";
import "./contracts.js";
function __vc_runtime(x: bigint): bigint { return one(x) + two(x); }
const local = __vc_runtime;
`, {
    "one.ts": prefix + `export function same(x: bigint): bigint { return x + 1n; }
contract(same, { requires: x => x > 0n, ensures: (r, x) => r === x + 1n });`,
    "two.ts": `function same(x: bigint): bigint { return x - 1n; }
export const alias = same;`,
    "barrel.ts": 'export * from "./two.js"; export { contract as bind } from "@api";',
    "contracts.ts": `import { alias, bind } from "./barrel.js";
bind(alias, { requires: x => x > 1n, ensures: (r, x) => r === x - 1n });`,
  });
  const runtime = createTestRuntime(entry);
  const execution = runtime.execute("__vc_runtime", [9007199254740993n]);
  expect(execution.result).toBe(18014398509481986n);
  expect(execution.calls.map(call => call.accepted)).toEqual([true, true]);
  expect(new Set(execution.calls.map(call => call.site.callee)).size).toBe(2);
  expect(execution.ensures).toBeUndefined();
  const second = runtime.ir.functions.find(fn => fn.source.file.endsWith("two.ts"))!;
  expect(runtime.execute(second.name, [2n]).ensures).toBe(true);
});

test("implementation regression retains exact huge negative inputs and passes after a real fix", async () => {
  const huge = "-900719925474099312345678901234567890";
  const source = prefix + `function hidden(__proto__: bigint): bigint { return __proto__ + 1n; }
const alias = hidden;
contract(alias, { requires: x => x === (${huge}n), ensures: (r, x) => r === x });`;
  const { entry, directory } = fixture("implementation", source);
  const generated = await generateRegressions(entry, path.join(directory, "generated"));
  expect(generated.cases).toBe(1);
  expect(generated.unconfirmed).toEqual([]);
  const { manifest, runtime } = loadRegressions(generated.manifestFile);
  const regression = manifest.cases[0];
  expect(regression.inputs).toEqual([huge + "n"]);
  expect(regression.function.name).toBe("hidden");
  expect(replayRegression(runtime, entry, regression).status).toBe("failed");
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("return __proto__ + 1n", "return __proto__"));
  expect(replayRegression(createTestRuntime(entry), entry, regression).status).toBe("passed");
  const malformed = { ...regression, inputs: ["9007199254740993"] };
  expect(replayRegression(runtime, entry, malformed).status).toBe("inapplicable");
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replaceAll("__proto__", "changed"));
  expect(replayRegression(createTestRuntime(entry), entry, regression).status).toBe("inapplicable");
});

test("generated Vitest suite fails on unsafe caller without contract and passes after guard fix", async () => {
  const source = fs.readFileSync("examples/withdraw.ts", "utf8").replace("../src/contract.js", "@api");
  const { entry, directory } = fixture("call-regression", source);
  const generated = await generateRegressions(entry, path.join(directory, "generated"));
  expect(generated.cases).toBe(1);
  const { runtime, manifest } = loadRegressions(generated.manifestFile);
  const regression = manifest.cases[0];
  expect(regression.kind).toBe("call");
  expect(regression.function.name).toBe("payUnchecked");
  expect(replayRegression(runtime, entry, regression).status).toBe("failed");
  function run() {
    return spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", generated.testFile, "--maxWorkers=1"],
      { encoding: "utf8", timeout: 45000, env: { ...process.env, NO_COLOR: "1" } });
  }
  const broken = run();
  expect(broken.status, broken.stderr + broken.stdout).toBe(1);
  expect(broken.stdout + broken.stderr).toContain("Actual arguments violate requires");
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace(
    "if (balance < 0n || amount <= 0n) return 0n;", "if (balance < 0n || amount <= 0n || amount > balance) return 0n;"));
  const replay = replayRegression(createTestRuntime(entry), entry, regression);
  expect(replay.status).toBe("passed");
  expect(replay.reason).toContain("does not reach");
  const fixed = run();
  expect(fixed.status, fixed.stderr + fixed.stdout).toBe(0);
});

test("call regression checks actual arguments even when caller ensures is trivially true", async () => {
  const { entry, directory } = fixture("true-ensures", prefix + `function positive(x: bigint): bigint { return x; }
contract(positive, { requires: x => x > 0n, ensures: (r, x) => r === x });
function caller(x: bigint): bigint { if (x > 0n) { if (x > 1n) return positive(x); } else { if (x < -1n) return 0n; } return positive(x + 1n); }
contract(caller, { requires: () => true, ensures: () => true });`);
  const generated = await generateRegressions(entry, path.join(directory, "generated"));
  const { runtime, manifest } = loadRegressions(generated.manifestFile);
  expect(manifest.cases.length).toBe(1);
  expect(manifest.cases[0].kind).toBe("call");
  expect(manifest.cases[0].inputs).toEqual(["-1n"]);
  expect(runtime.execute("caller", [-1n]).ensures).toBe(true);
  expect(runtime.execute("caller", [-1n]).calls[0].args).toEqual([0n]);
  expect(replayRegression(runtime, entry, manifest.cases[0]).status).toBe("failed");
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("if (x < -1n)", "if (x < 0n)"));
  expect(replayRegression(createTestRuntime(entry), entry, manifest.cases[0]).status).toBe("passed");
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("requires: () => true", "requires: x => x > 0n"));
  expect(replayRegression(createTestRuntime(entry), entry, manifest.cases[0]).status).toBe("inapplicable");
});

test("weak abstract callee models are never saved as real regressions", async () => {
  const { entry, directory } = fixture("weak", prefix + `function f(x: bigint): bigint { return x; }
contract(f, { requires: x => x > 0n, ensures: r => r > 0n });
function caller(x: bigint): bigint { return f(x); }
contract(caller, { requires: x => x > 0n, ensures: (r, x) => r === x });`);
  const generated = await generateRegressions(entry, path.join(directory, "generated"));
  expect(generated.unknownObligations).toBeGreaterThan(0);
  expect(generated.cases).toBe(0);
  const properties = await checkProperties(createTestRuntime(entry), { seed: 42, numRuns: 20 });
  expect(properties.map(result => result.status)).toEqual(["passed", "passed"]);
});

test("property checks execute real predicates, shrink failures and reproduce with a seed", async () => {
  const { entry } = fixture("properties", prefix + identity.replace("return x;", "return x + 1n;"));
  const runtime = createTestRuntime(entry);
  const first = await checkProperties(runtime, { seed: 123, numRuns: 30 });
  expect(first[0].status).toBe("failed");
  expect(first[0].checked).toBeGreaterThan(0);
  expect(first[0].counterexample).toEqual(["0n"]);
  expect(await checkProperties(runtime, { seed: 123, numRuns: 30 })).toEqual(first);
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("return x + 1n", "return x"));
  const fixed = await checkProperties(createTestRuntime(entry), { seed: 123, numRuns: 30 });
  expect(fixed[0].status).toBe("passed");
  expect(fixed[0].checked).toBe(30);
});

test("inconsistent or undersampled requires cannot yield a successful property test", async () => {
  const { entry } = fixture("sampling", prefix + `function impossible(x: bigint): bigint { return x; }
contract(impossible, { requires: x => x > 0n && x < 0n, ensures: () => true });
function sparse(x: bigint, y: bigint, z: bigint, w: bigint): bigint { return x; }
contract(sparse, { requires: (x,y,z,w) => x > 1000000n && y === x + 100n && z === y + 100n && w === z + 100n, ensures: () => true });`);
  const results = await checkProperties(createTestRuntime(entry), { seed: 123, numRuns: 5, maxSkipsPerRun: 1 });
  expect(results.map(result => result.status)).toEqual(["inconsistent", "insufficient-inputs"]);
  expect(results.map(result => result.checked)).toEqual([0, 0]);
  expect(results[1].skipped).toBeGreaterThan(0);
});

test("literal-biased sampling reaches exact bigint constraints and zero-argument functions", async () => {
  const { entry } = fixture("literal-sampling", prefix + `function exact(x: bigint): bigint { return x; }
contract(exact, { requires: x => x === -9007199254740993123456789n, ensures: (r, x) => r === x });
function zero(): bigint { return 0n; }
contract(zero, { requires: () => true, ensures: r => r === 0n });`);
  const results = await checkProperties(createTestRuntime(entry), { seed: 42, numRuns: 10 });
  expect(results.map(result => result.status)).toEqual(["passed", "passed"]);
  expect(results.map(result => result.checked)).toEqual([10, 10]);
});

test("test runtime rejects unsupported source before executing it", () => {
  const { entry } = fixture("rejection", prefix + identity + '\nthrow new Error("executed");');
  expect(() => createTestRuntime(entry)).toThrow(/Unsupported/);
  for (const name of ["exports", "Object", "__exportStar", "__createBinding", "__esModule"]) {
    const reserved = fixture("cjs-reserved-" + name, prefix + identity.replaceAll("hidden", name));
    expect(() => createTestRuntime(reserved.entry)).toThrow(/CommonJS-reserved/);
  }
});

test("moving a violation to another call cannot make the saved regression pass", async () => {
  const { entry, directory } = fixture("moved-call", prefix + `function positive(x: bigint): bigint { return x; }
contract(positive, { requires: x => x > 0n, ensures: (r, x) => r === x });
function caller(x: bigint): bigint { return positive(1n) + positive(x); }`);
  const generated = await generateRegressions(entry, path.join(directory, "generated"));
  const { manifest } = loadRegressions(generated.manifestFile);
  expect(manifest.cases).toHaveLength(1);
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("positive(1n) + positive(x)", "positive(x) + positive(1n)"));
  expect(replayRegression(createTestRuntime(entry), entry, manifest.cases[0]).status).toBe("failed");
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("positive(x) + positive(1n)", "positive(x)"));
  expect(replayRegression(createTestRuntime(entry), entry, manifest.cases[0]).status).toBe("inapplicable");
});

test("module exports named __proto__ keep their original function and contract", () => {
  const { entry } = fixture("proto-export", `import { __proto__ as original } from "./fn.js";
function caller(x: bigint): bigint { return original(x); }`, {
    "fn.ts": prefix + identity.replaceAll("hidden", "__proto__").replace("function __proto__", "export function __proto__"),
  });
  const runtime = createTestRuntime(entry);
  const result = runtime.execute("caller", [9007199254740993n]);
  expect(result.result).toBe(9007199254740993n);
  expect(result.calls[0].accepted).toBe(true);
});
