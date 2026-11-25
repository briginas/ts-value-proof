import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { adapt } from "./adapter.ts";
import { checkLeanObligations } from "./lean-translation.ts";
import { enumerateObligations } from "./obligations.ts";
import { verify } from "./verifier.ts";

test("withdraw gets independent, matching verdicts on all four obligations", async () => {
  const report = await verify("examples/withdraw.ts");
  expect(report.status).toBe("refuted");
  expect(report.results.map(row => [row.sourceName, row.kind, row.status, row.crossCheck])).toEqual([
    ["withdraw", "preconditions", "satisfiable"],
    ["withdraw", "implementation", "proved"],
    ["payChecked", "call", "proved"],
    ["payUnchecked", "call", "disproved"],
  ].map(([name, kind, status]) => [name, kind, status, { z3: { status }, lean: { status }, comparison: "agreed" }]));
  expect(report.results.find(row => row.sourceName === "payUnchecked")).toHaveProperty("counterexample");
});

function contractFixture(source: string) {
  mkdirSync("work", { recursive: true });
  const dir = mkdtempSync(path.resolve("work/lean-integration-"));
  const entry = path.join(dir, "entry.ts");
  const api = path.relative(dir, path.resolve("src/contract.js")).split(path.sep).join("/");
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("Lean alone proves or refutes typed obligations with bindings, paths and large integers", async () => {
  const entry = contractFixture(`
function impossible(x:bigint):bigint { return x; }
contract(impossible,{requires:x=>x>0n && x<=0n});
function wrong(x:bigint):bigint { return x-1n; }
contract(wrong,{ensures:(r,x)=>r===x});
function shift(x:bigint):bigint {
  const saved=x; x+=123456789012345678901234567890123456789n;
  return saved<0n ? -x : x;
}
contract(shift,{ensures:(r,x)=>x<0n ? r===-(x+123456789012345678901234567890123456789n) : r===x+123456789012345678901234567890123456789n});
function positive(x:bigint):bigint { return x; }
contract(positive,{requires:x=>x>0n});
function branches(x:bigint):bigint {
  let arg=0n;
  if(x>0n) arg=x+1n; else arg=x-1n;
  return positive(arg);
}
contract(branches,{ensures:(r,x)=>r===x});
function less(x:bigint,y:bigint):bigint { return x; }
contract(less,{requires:(x,y)=>x<y});
function swapped(x:bigint,y:bigint):bigint { return less(y,x); }
contract(swapped,{requires:(x,y)=>x>y});
function eager(x:bigint):bigint { const unused=x*x; return 1n; }
contract(eager,{requires:x=>x>0n,ensures:r=>r===1n});
function flag(x:boolean):bigint { return x ? 0n : 1n; }
contract(flag,{ensures:r=>r>=0n});`);
  const rows = enumerateObligations(adapt(entry));
  const answers = await checkLeanObligations(rows);
  const verdicts = (name: string, kind: typeof rows[number]["kind"]) =>
    rows.filter(row => row.kind === kind && row.owner.sourceName === name).map(row => answers.get(row.key));
  expect(verdicts("impossible", "preconditions")).toEqual([{ status: "inconsistent" }]);
  expect(verdicts("wrong", "implementation")).toEqual([{ status: "disproved" }]);
  expect(verdicts("shift", "implementation")).toEqual([{ status: "proved" }]);
  expect(verdicts("branches", "call")).toEqual([{ status: "proved" }, { status: "disproved" }]);
  expect(verdicts("branches", "implementation")).toMatchObject([{ status: "unsupported", reason: expect.stringContaining("call") }]);
  expect(verdicts("swapped", "call")).toEqual([{ status: "proved" }]);
  expect(verdicts("eager", "preconditions")).toEqual([{ status: "satisfiable" }]);
  expect(verdicts("eager", "implementation")).toEqual([{ status: "proved" }]);
  expect(verdicts("flag", "implementation")).toMatchObject([{ status: "unsupported", reason: expect.stringContaining("opaque") }]);
});

test("Lean cross-checks signed literal factors after substitution", async () => {
  const entry = contractFixture(`
function double(x: bigint): bigint { return x * 2n; }
contract(double, { ensures: (r, x) => r === x + x });
function negateDouble(x: bigint): bigint { const k = -2n; return k * x; }
contract(negateDouble, { ensures: (r, x) => r === -(x + x) });
function large(x: bigint): bigint { return x * 9007199254740993n; }
contract(large, { ensures: (r, x) => r - 9007199254740992n * x === x });
function zero(x: bigint): bigint { return x * 0n; }
contract(zero, { ensures: r => r === 0n });
function wrong(x: bigint): bigint { return 2n * x; }
contract(wrong, { ensures: (r, x) => r === x });
function nonnegative(x: bigint, k: bigint): bigint { return x; }
contract(nonnegative, { requires: (x, k) => x * k >= 0n });
function scaleCall(x: bigint): bigint { return nonnegative(x, -2n); }
contract(scaleCall, { requires: x => 2n * x <= 0n });
function zeroDivision(x: bigint): bigint { return 0n * (1n / x); }
contract(zeroDivision, { ensures: r => r === 0n });`);
  const { results } = await verify(entry);
  const verdicts = results.map(row => [row.sourceName, row.kind, row.crossCheck.lean.status, row.crossCheck.comparison]);
  expect(verdicts).toEqual([
    ["double", "implementation", "proved", "agreed"],
    ["negateDouble", "implementation", "proved", "agreed"],
    ["large", "implementation", "proved", "agreed"],
    ["zero", "implementation", "proved", "agreed"],
    ["wrong", "implementation", "disproved", "agreed"],
    ["nonnegative", "preconditions", "satisfiable", "agreed"],
    ["scaleCall", "preconditions", "satisfiable", "agreed"],
    ["scaleCall", "call", "proved", "agreed"],
    ["zeroDivision", "implementation", "unsupported", "unconfirmed"],
  ]);
});

test("Lean proves the square example and keeps an exhausted proof unknown", async () => {
  const entry = "examples/multiplication.ts";
  const { results } = await verify(entry);
  expect(results).toMatchObject([{
    sourceName: "square", kind: "implementation", status: "proved",
    crossCheck: { z3: { status: "proved" }, lean: { status: "proved" }, comparison: "agreed" },
  }]);
  const obligations = enumerateObligations(adapt(entry));
  const limited = await checkLeanObligations(obligations, { maxHeartbeats: 1 });
  expect(limited.get(obligations[0].key)).toMatchObject({ status: "unknown" });
});

test("Lean checks the sign, order and exact factors of two-parameter products", async () => {
  const entry = contractFixture(`
function nonnegative(x: bigint, y: bigint): bigint { return x * y; }
contract(nonnegative, { requires: (x, y) => x >= 0n && y >= 0n, ensures: r => r >= 0n });
function swapped(x: bigint, y: bigint): bigint { return x * y; }
contract(swapped, { ensures: (r, x, y) => r === y * x });
function wrongSign(x: bigint, y: bigint): bigint { return x * y; }
contract(wrongSign, { ensures: r => r >= 0n });
function missesWitness(x: bigint): bigint { return x * x; }
contract(missesWitness, { ensures: r => r !== 4n });
function shifted(x: bigint, y: bigint): bigint { return (x + 9007199254740993n) * y; }
contract(shifted, { ensures: (r, x, y) => r === (x + 9007199254740992n) * y });`);
  const { results } = await verify(entry);
  expect(results.map(row => [row.sourceName, row.kind, row.crossCheck.lean.status, row.crossCheck.comparison])).toEqual([
    ["nonnegative", "preconditions", "satisfiable", "agreed"],
    ["nonnegative", "implementation", "proved", "agreed"],
    ["swapped", "implementation", "proved", "agreed"],
    ["wrongSign", "implementation", "disproved", "agreed"],
    ["missesWitness", "implementation", "unknown", "unconfirmed"],
    ["shifted", "implementation", "disproved", "agreed"],
  ]);
  expect(results.find(row => row.sourceName === "missesWitness")).toMatchObject({
    status: "disproved", crossCheck: { z3: { status: "disproved" } },
  });
});
