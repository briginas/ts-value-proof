import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { adapt } from "./adapter.ts";
import { validateIR } from "./ir-integrity.ts";
import { prettyExpr, type Expr } from "./ir.ts";
import { verifyIntegers } from "./bigint-backend.ts";
import { verify, type VerificationReport } from "./verify.ts";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { checkBindings } from "./check-bindings.ts";
import { assertLocation, assertReportDiagnostics } from "./check-diagnostics.ts";

fs.mkdirSync("work/cases", { recursive: true });
const reports: Array<VerificationReport & { test: string }> = [];
const prefix = 'import { contract } from "../src/contract.js";\n';
function fixture(name: string, source: string): string {
  const target = path.resolve("work/cases/" + name + ".ts");
  fs.writeFileSync(target, source.replace("../src/contract.js", "../../src/contract.js"));
  return target;
}
function passed(name: string): void { console.log("PASS " + name); }
async function checked(name: string, source: string): Promise<VerificationReport> {
  const report = await verify(fixture(name, source));
  reports.push({test: name, ...report});
  return report;
}
function implementation(report: VerificationReport, name?: string) {
  return report.results.find(r => r.kind === "implementation" && (!name || r.function === name));
}
async function runtime(source: string): Promise<Record<string, (...args: bigint[]) => bigint>> {
  // Test-only execution of our own fixtures. The verifier never runs user code.
  const module = ts.transpileModule(source.replace("../src/contract.js",
    pathToFileURL(path.resolve("src/contract.ts")).href), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return await import("data:text/javascript;base64," + Buffer.from(module).toString("base64"));
}

try {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], { stdio: "pipe" });
  passed("type inference and expected errors for number, objects and bigint");
  reports.push(...await checkBindings());

  const source = fs.readFileSync("examples/withdraw.ts", "utf8");
  const baseline = await checked("baseline", source);
  assert.equal(baseline.semantics, "bigint-exact-integers");
  assert.equal(baseline.status, "refuted");
  assert.equal(implementation(baseline)?.status, "proved");
  assert.deepEqual(baseline.results.filter(r => r.kind === "call").map(r => r.status), ["proved", "disproved"]);
  const unsafe = baseline.results.find(r => r.kind === "call" && r.status === "disproved");
  assert.ok(unsafe?.kind === "call" && unsafe.status === "disproved");
  assert.equal(unsafe.reasonCode, "contract-violation");
  assert.equal(unsafe.sourceName, "payUnchecked");
  assert.deepEqual(unsafe.requires, []);
  assertLocation(unsafe.callSource, "withdraw(balance, amount)");
  assert.equal(typeof unsafe.counterexample.amount, "string");
  assert.equal(typeof unsafe.counterexample.balance, "string");
  const amount = BigInt((unsafe.counterexample.amount as string).slice(0, -1));
  const balance = BigInt((unsafe.counterexample.balance as string).slice(0, -1));
  assert.ok(balance >= 0n && amount > 0n && amount > balance);
  const live = await runtime(source);
  assert.ok(live.payUnchecked(balance, amount) < 0n);
  passed("integer implementation, guarded/unsafe calls and native JS counterexample replay");

  const broken = await checked("broken", source.replace("return balance - amount;", "return balance + amount;"));
  assert.equal(implementation(broken)?.status, "disproved");
  assert.equal(broken.status, "refuted");
  const inconsistent = await checked("inconsistent",
    source.replace("balance >= 0n && amount > 0n && amount <= balance", "balance > 0n && balance < 0n"));
  assert.equal(inconsistent.status, "inconsistent");
  const contradictory = inconsistent.results.find(r => r.status === "inconsistent")!;
  assert.ok(contradictory.kind === "preconditions");
  assert.equal(contradictory.reasonCode, "inconsistent-contract");
  assert.equal(contradictory.condition, "((balance > 0n) && (balance < 0n))");
  assertLocation(contradictory.requires[0].source, "(balance, amount) => balance > 0n && balance < 0n");
  assert.equal(implementation(inconsistent), undefined);
  passed("broken implementation and contradictory preconditions cannot produce overall success");

  const renamed = await checked("renamed", source
    .replace("(balance, amount) => balance >= 0n && amount > 0n && amount <= balance",
      "(b, a) => b >= 0n && a > 0n && a <= b")
    .replace("(result, balance, amount) => result >= 0n && result === balance - amount",
      "(r, b, a) => r >= 0n && r === b - a"));
  assert.equal(implementation(renamed)?.status, "proved");
  const composition = await checked("composition", source + "\n" +
    "export function remaining(b: bigint, a: bigint): bigint { return withdraw(b, a); }\n" +
    "contract(remaining, { requires: (b,a) => b >= 0n && a > 0n && a <= b,\n" +
    "ensures: (r,b,a) => r >= 0n && r === b-a });\n");
  assert.equal(implementation(composition, "remaining")?.status, "proved");
  const binding = await checked("binding", prefix +
    "export function first(x: bigint): bigint { return x; }\n" +
    "export function second(x: bigint): bigint { return x + 1n; }\n" +
    "contract(first, { requires: x => x >= 0n, ensures: (r,x) => r === x });\n" +
    "contract(second, { requires: x => x >= 0n, ensures: (r,x) => r === x });\n");
  assert.deepEqual(binding.results.filter(r => r.kind === "implementation").map(r => [r.function, r.status]),
    [["first", "proved"], ["second", "disproved"]]);
  passed("symbol binding, renamed parameters and callee postcondition reuse");

  const weak = await checked("weak-callee-contract", prefix +
    "export function identity(x: bigint): bigint { return x; }\n" +
    "contract(identity, { requires: x => x >= 0n, ensures: r => r >= 0n });\n" +
    "export function caller(x: bigint): bigint { return identity(x); }\n" +
    "contract(caller, { requires: x => x >= 0n, ensures: (r,x) => r === x });\n");
  assert.equal(weak.status, "unknown");
  assert.equal(implementation(weak, "caller")?.status, "unknown");
  const weakResult = implementation(weak, "caller")!;
  assert.ok(weakResult.status === "unknown");
  assert.equal(weakResult.reasonCode, "weak-callee-contract");
  assert.equal(Object.hasOwn(weakResult, "counterexample"), false);
  passed("insufficient callee postconditions produce unknown, not an unconfirmed counterexample");

  const discrete = await checked("discrete", prefix +
    "export function positive(x: bigint): bigint { return x; }\n" +
    "contract(positive, { requires: x => x > 0n, ensures: r => r >= 1n });\n" +
    "export function increment(x: bigint): bigint { return x + 1n; }\n" +
    "contract(increment, { requires: () => true, ensures: (r,x) => r > x });\n");
  assert.equal(discrete.status, "verified");
  const fractional = await checked("no-fractional-bigint", prefix +
    "export function identity(x: bigint): bigint { return x; }\n" +
    "contract(identity, { requires: x => x > 0n && x < 1n, ensures: () => false });\n");
  assert.equal(fractional.status, "inconsistent");
  passed("integer discreteness, no fractions and no fixed-width overflow");

  const huge = 123456789012345678901234567890123456789012345678901n;
  for (const value of [huge, -huge]) {
    const exact = await checked(value < 0n ? "negative-counterexample" : "huge-counterexample", prefix +
      "export function identity(x: bigint): bigint { return x; }\n" +
      "contract(identity, { requires: x => x === " + value + "n, ensures: r => r !== " + value + "n });\n");
    const result = implementation(exact);
    assert.ok(result?.kind === "implementation" && result.status === "disproved");
    assert.equal(result.counterexample.x, value + "n");
  }
  passed("large positive/negative counterexamples preserve every digit");

  const examples: Array<[string, bigint]> = [
    ["0n", 0n], ["-0n", 0n], ["0xffn", 255n], ["0b10101n", 21n],
    ["0o777n", 511n], ["1_000_000_000_000_001n", 1000000000000001n],
    ["-0xffffffffffffffffffffffffffffffffn", -(2n ** 128n - 1n)],
  ];
  const values = [0n, -1n, 1n, 9007199254740993n, -huge, huge];
  for (let i = 0; i < values.length; i++) {
    const a = values[i], b = values[(i + 1) % values.length];
    examples.push(["(" + a + "n) + (" + b + "n)", a + b]);
    examples.push(["(" + a + "n) - (" + b + "n)", a - b]);
    examples.push(["-((" + a + "n) - (" + b + "n))", -(a - b)]);
  }
  let differentialSource = prefix;
  for (const [i, [expr, expected]] of examples.entries())
    differentialSource += "export function sample" + i + "(): bigint { return " + expr + "; }\n" +
      "contract(sample" + i + ", { requires: () => true, ensures: r => r === " + expected + "n });\n";
  const differential = await checked("differential", differentialSource);
  assert.equal(differential.status, "verified");
  assert.equal(differential.results.filter(r => r.kind === "implementation").length, examples.length);
  const native = await runtime(differentialSource);
  for (const [i, [, expected]] of examples.entries()) assert.equal(native["sample" + i](), expected);
  passed(examples.length + " exact arithmetic cases agree with native JavaScript bigint");

  const branches = await checked("branches", prefix +
    "export function abs(x: bigint): bigint { if (x < 0n) return -x; return x; }\n" +
    "contract(abs, { requires: () => true, ensures: (r,x) => r >= 0n && (r === x || r === -x) });\n" +
    "export function identity(x: bigint): bigint { if (x < 0n) { return x; } else { return x; } }\n" +
    "contract(identity, { requires: () => true, ensures: (r,x) => r === x });\n");
  assert.equal(branches.status, "verified");
  passed("early returns and explicit if/else preserve integer path conditions");

  // These bodies returned verified before the source/IR integrity check, even
  // though their native execution violates the postcondition.
  for (const [name, body, input] of [
    ["nested-fallthrough", "if (x > 0n) { if (x > 1n) return 2n; } return 0n;", 2n],
    ["else-fallthrough", "if (x > 0n) return 0n; else { if (x < -1n) return 2n; } return 0n;", -2n],
    ["nested-standalone-block", "if (x > 0n) { { return 2n; } } return 0n;", 2n],
  ] as const) {
    const example = prefix + `export function f(x: bigint): bigint { ${body} }\n` +
      "contract(f, { requires: () => true, ensures: r => r === 0n });\n";
    assert.equal((await runtime(example)).f(input), 2n);
    const report = await checked(name, example);
    assert.equal(report.status, "refuted");
    const result = implementation(report);
    assert.ok(result?.status === "disproved");
    assert.equal((await runtime(example)).f(BigInt((result.counterexample.x as string).slice(0, -1))), 2n);
  }
  const thisParameter = prefix +
    "export function f(this: bigint, x: bigint, y: bigint): bigint { if (x > 0n) return 1n; return 0n; }\n" +
    "contract(f, { requires: (x,y) => x === 0n && y > 0n, ensures: r => r === 1n });\n";
  assert.equal((await runtime(thisParameter)).f.call(0n, 0n, 1n), 0n);
  assert.throws(() => adapt(fixture("this-parameter", thisParameter)), /Unsupported/);
  passed("lost nested returns and erased this parameters cannot produce false proofs");

  const proto = await checked("proto-counterexample", prefix +
    "export function f(__proto__: bigint): bigint { return __proto__; }\n" +
    "contract(f, { requires: x => x === 9007199254740993n, ensures: r => r !== 9007199254740993n });\n");
  const protoResult = implementation(proto);
  assert.ok(protoResult?.status === "disproved");
  assert.equal(Object.hasOwn(protoResult.counterexample, "__proto__"), true);
  assert.equal(JSON.parse(JSON.stringify(protoResult.counterexample)).__proto__, "9007199254740993n");
  passed("counterexamples retain parameter names that collide with Object.prototype");

  const integrity = adapt(fixture("integrity", prefix +
    "export function f(x: bigint, y: bigint): bigint { if (x > y) return x; return y; }\n" +
    "contract(f, { requires: () => true, ensures: (r,x,y) => r >= x && r >= y });\n"));
  const fn = integrity.functions[0];
  assert.deepEqual(fn.params.map(({name, sort}) => ({name, sort})), [{ name: "x", sort: "int" }, { name: "y", sort: "int" }]);
  assert.deepEqual(fn.body, { kind: "ternary",
    condition: { kind: "binary", op: ">", left: { kind: "ident", name: "x" }, right: { kind: "ident", name: "y" } },
    then: { kind: "ident", name: "x" }, else: { kind: "ident", name: "y" } });
  assert.equal(prettyExpr(fn.contracts[1].predicate), "((result >= x) && (result >= y))");
  assert.equal(fn.source.file, path.resolve("work/cases/integrity.ts"));
  assert.equal(fn.source.line, 2);
  assert.equal(fn.contracts[1].source.line, 3);
  const exactIR = adapt(fixture("exact-ir", prefix +
    "function f(): bigint { return 0xffff_ffff_ffff_ffffn; }\n" +
    "contract(f, { requires: () => true, ensures: r => r === 18446744073709551615n });\n"));
  assert.deepEqual(exactIR.functions[0].body, { kind: "bigint", value: "18446744073709551615" });
  assert.equal(prettyExpr(exactIR.functions[0].body), "18446744073709551615n");
  assert.deepEqual(JSON.parse(JSON.stringify(exactIR)), exactIR);
  for (const mutate of [
    (ir: typeof integrity) => { ir.functions.push(structuredClone(ir.functions[0])); },
    (ir: typeof integrity) => { ir.functions.pop(); },
    (ir: typeof integrity) => { ir.functions[0].params[1].name = "x"; },
    (ir: typeof integrity) => { Object.assign(ir.functions[0], { returnSort: "real" }); },
    (ir: typeof integrity) => { Object.assign(ir.functions[0].params[0], { sort: "real" }); },
    (ir: typeof integrity) => { ir.functions[0].body = { kind: "ident", name: "missing" }; },
    (ir: typeof integrity) => { ir.functions[0].body = { kind: "result" }; },
    (ir: typeof integrity) => { ir.functions[0].body = { kind: "literal", value: true }; },
    (ir: typeof integrity) => { ir.functions[0].body = { kind: "bigint", value: "1.5" }; },
    (ir: typeof integrity) => { ir.functions[0].body = { kind: "bigint", value: "01" }; },
    (ir: typeof integrity) => { Object.assign(ir.functions[0].body, { kind: "unsupported" }); },
    (ir: typeof integrity) => { ir.functions[0].contracts.pop(); },
    (ir: typeof integrity) => { ir.functions[0].contracts = []; },
    (ir: typeof integrity) => { ir.functions[0].contracts[0].predicate = { kind: "result" }; },
    (ir: typeof integrity) => { ir.functions[0].contracts[1].predicate = { kind: "bigint", value: "0" }; },
    (ir: typeof integrity) => { ir.functions[0].source.line = 0; },
    (ir: typeof integrity) => {
      const body = ir.functions[0].body;
      if (body.kind === "ternary") body.condition = { kind: "bigint", value: "0" };
    },
  ]) {
    const changed = structuredClone(integrity);
    mutate(changed);
    assert.throws(() => validateIR(changed), /Invalid IR/);
    await assert.rejects(() => verifyIntegers(changed), /Invalid IR/);
  }
  passed("own IR preserves source shapes, exact literals and locations; invalid IR is rejected before Z3");

  // Independently execute our own fixed control-flow corpus, then ask the
  // verifier both to prove each sampled result and refute its negation.
  const bodies = [
    "if (x < 0n) return -x; return x;",
    "if (x < 0n) { if (x < -1n) return x + 2n; else return -x; } return x - 2n;",
    "if (x < -1n) return -2n; else if (x > 1n) return 2n; else return x;",
    "if (x < 0n) { return -x; } else { return x + 1n; }",
    "if (!(x < 0n) && (x === 0n || x > 1n)) return 1n; return -1n;",
    "if ((x >= -1n && x <= 1n) === (x !== 0n)) return x + 1n; return -x;",
    "if (false && x > 0n || true && x < 0n) return x - 1n; return x + 1n;",
    "if (x !== 0n) return -(-x + 1n); return x - (x + 2n);",
    "if (x > 0n) { if (x > 1n) return 2n; } return 0n;",
    "if (x > 0n) return 0n; else { if (x < -1n) return 2n; } return 0n;",
    "if (x > 0n) { { return 2n; } } return 0n;",
    "{ if (x < 0n) return -x; } { if (x > 1n) return x + 1n; } return 0n;",
    "if (x > 0n) { if (x > 2n) return 3n; } else { if (x < -2n) return -3n; } return x;",
    "{ { if (x === 0n) return 1n; } if (x === 1n) return 2n; } return -x;",
  ];
  const sampleInputs = [-huge, -2n, -1n, 0n, 1n, 2n, huge];
  const bodyModule = await runtime(bodies.map((body, i) =>
    `export function branch${i}(x: bigint): bigint { ${body} }`).join("\n"));
  let sampledSource = prefix;
  const sampledExpectations = new Map<string, bigint>();
  for (const [i, body] of bodies.entries()) for (const [j, x] of sampleInputs.entries()) {
    const expected = bodyModule[`branch${i}`](x);
    for (const [suffix, operator] of [["good", "==="], ["bad", "!=="]]) {
      const name = `branch${i}_${j}_${suffix}`;
      sampledExpectations.set(name, x);
      sampledSource += `export function ${name}(x: bigint): bigint { ${body} }\n` +
        `contract(${name}, { requires: x => x === (${x}n), ensures: r => r ${operator} (${expected}n) });\n`;
    }
  }
  const sampled = await checked("branch-differential", sampledSource);
  const sampledResults = sampled.results.filter(r => r.kind === "implementation");
  assert.equal(sampledResults.length, bodies.length * sampleInputs.length * 2);
  for (const result of sampledResults) {
    assert.equal(result.status, result.function.endsWith("good") ? "proved" : "disproved", result.function);
    if (result.status === "disproved")
      assert.equal(result.counterexample.x, sampledExpectations.get(result.function) + "n");
  }
  passed(`${sampledResults.length} branch, boolean and short-circuit obligations agree with native JavaScript`);

  const multiCallSource = prefix +
    "export function positive(x: bigint): bigint { return x; }\n" +
    "contract(positive, { requires: x => x > 0n, ensures: (r,x) => r === x });\n" +
    "export function caller(x: bigint): bigint { if (x > 0n) return positive(x) + positive(x + 1n); else return 0n; }\n" +
    "contract(caller, { requires: () => true, ensures: (r,x) => (x > 0n && r === x + x + 1n) || (x <= 0n && r === 0n) });\n";
  const multiCall = await checked("multiple-guarded-calls", multiCallSource);
  assert.equal(multiCall.status, "verified");
  assert.deepEqual(multiCall.results.filter(r => r.kind === "call").map(r => r.status), ["proved", "proved"]);
  const wrongPath = await checked("wrong-call-path", multiCallSource.replace("if (x > 0n)", "if (x >= 0n)"));
  assert.equal(wrongPath.status, "refuted");
  const badCall = wrongPath.results.find(r => r.kind === "call" && r.status === "disproved");
  assert.ok(badCall?.status === "disproved");
  assert.equal(badCall.counterexample.x, "0n");
  const brokenCallee = await checked("broken-callee", multiCallSource.replace("return x;", "return x + 1n;"));
  assert.equal(brokenCallee.status, "refuted");
  assert.equal(implementation(brokenCallee, "positive")?.status, "disproved");
  const impossibleCallee = await checked("impossible-callee", multiCallSource.replace("(r,x) => r === x", "() => false"));
  assert.equal(impossibleCallee.status, "refuted");
  const weakBranch = await checked("weak-branch", multiCallSource.replace("(r,x) => r === x", "r => r > 0n"));
  assert.equal(weakBranch.status, "unknown");
  assert.equal(implementation(weakBranch, "caller")?.status, "unknown");
  const contradictoryCallee = await checked("contradictory-callee", multiCallSource.replace("x => x > 0n", "x => x > 0n && x < 0n"));
  assert.equal(contradictoryCallee.status, "inconsistent");
  passed("multiple calls, branch guards and invalid/weak callee contracts preserve whole-file status");

  // The last source call is copied into both fallthrough paths. Verify each
  // path, but count its source identity once; a bad guard must still fail.
  const continuationSource = prefix +
    "export function positive(x: bigint): bigint { return x; }\n" +
    "contract(positive, { requires: x => x > 0n, ensures: (r,x) => r === x });\n" +
    "export function caller(x: bigint): bigint { if (x > 0n) { if (x > 1n) return positive(x); } else { if (x < 0n) return 0n; } return positive(x + 1n); }\n" +
    "contract(caller, { requires: () => true, ensures: (r,x) => (x < 0n && r === 0n) || (x >= 0n && x <= 1n && r === x + 1n) || (x > 1n && r === x) });\n";
  const continuation = await checked("continuation-calls", continuationSource);
  assert.equal(continuation.status, "verified");
  assert.equal(continuation.results.filter(r => r.kind === "call").length, 3);
  const callIR = adapt("work/cases/continuation-calls.ts");
  assert.equal(callIR.coverage.calls.length, 2);
  const callNodes: Extract<Expr, { kind: "call" }>[] = [];
  function collectCalls(expr: Expr): void {
    if (expr.kind === "call") callNodes.push(expr);
    else if (expr.kind === "ternary") { collectCalls(expr.then); collectCalls(expr.else); }
  }
  collectCalls(callIR.functions.find(fn => fn.sourceName === "caller")!.body);
  assert.equal(callNodes.length, 3);
  assert.equal(callNodes[1].id, callNodes[2].id);
  const callSource = fs.readFileSync("work/cases/continuation-calls.ts", "utf8");
  assert.equal(callSource.slice(callNodes[1].source.start, callNodes[1].source.end), "positive(x + 1n)");
  const callRuntime = (await runtime(continuationSource)).caller;
  for (const x of [-2n, -1n, 0n, 1n, 2n])
    assert.equal(callRuntime(x), x < 0n ? 0n : x <= 1n ? x + 1n : x);
  const unsafeContinuation = await checked("unsafe-continuation-call",
    continuationSource.replace("if (x < 0n)", "if (x < -1n)"));
  const unsafeContinuationCall = unsafeContinuation.results.find(r => r.kind === "call" && r.status === "disproved");
  assert.ok(unsafeContinuationCall?.kind === "call" && unsafeContinuationCall.status === "disproved");
  assert.equal(unsafeContinuationCall.counterexample.x, "-1n");
  const sharedCalls = unsafeContinuation.results.filter(r => r.kind === "call" && r.callId === unsafeContinuationCall.callId);
  assert.equal(sharedCalls.length, 2);
  assert.deepEqual(sharedCalls.map(r => r.status), ["proved", "disproved"]);
  assert.deepEqual(sharedCalls.map(r => r.kind === "call" && r.pathCondition),
    ["((x > 0n) && (!(x > 1n)))", "((!(x > 0n)) && (!(x < (-1n))))"]);
  for (const call of sharedCalls) {
    assert.ok(call.kind === "call");
    assert.deepEqual(call.callSource, unsafeContinuationCall.callSource);
    assert.deepEqual(call.arguments, { x: "(x + 1n)" });
    assert.equal(call.checkedCondition, "((x + 1n) > 0n)");
    assertLocation(call.callSource, "positive(x + 1n)");
    assertLocation(call.contractSource, "x => x > 0n");
  }
  for (const mutate of [
    (ir: typeof callIR) => { ir.coverage.calls.pop(); },
    (ir: typeof callIR) => { ir.coverage.calls.push("missing"); },
    (ir: typeof callIR) => { ir.coverage.calls[1] = ir.coverage.calls[0]; },
    (ir: typeof callIR) => {
      const body = ir.functions.find(fn => fn.sourceName === "caller")!.body;
      if (body.kind === "ternary" && body.then.kind === "ternary" && body.then.then.kind === "call")
        body.then.then.callee = "missing";
    },
    (ir: typeof callIR) => {
      const body = ir.functions.find(fn => fn.sourceName === "caller")!.body;
      if (body.kind === "ternary" && body.then.kind === "ternary" && body.then.then.kind === "call")
        body.then.then.args = [];
    },
    (ir: typeof callIR) => {
      const body = ir.functions.find(fn => fn.sourceName === "caller")!.body;
      if (body.kind === "ternary" && body.then.kind === "ternary" && body.then.else.kind === "call")
        body.then.else = { ...body.then.else, args: [{ kind: "bigint", value: "1" }] };
    },
  ]) {
    const changed = structuredClone(callIR);
    mutate(changed);
    await assert.rejects(() => verifyIntegers(changed), /Invalid IR/);
  }
  passed("shared continuations retain source call identity, path guards and exact call coverage");

  const exhausted = await verify("work/cases/discrete.ts", { resourceLimit: 1 });
  reports.push({ test: "solver-resource-exhaustion", ...exhausted });
  assert.equal(exhausted.status, "unknown");
  assert.ok(exhausted.results.some(r => r.kind === "preconditions" && r.status === "unknown"));
  assert.ok(exhausted.results.some(r => r.kind === "implementation" && r.status === "unknown"));
  assert.ok(exhausted.results.every(r => r.status !== "unknown" || r.reason));
  assert.ok(exhausted.results.every(r => r.status !== "unknown" || r.reasonCode === "solver-unknown"));
  assert.ok(!exhausted.results.some(r => r.status === "proved"));
  passed("real Z3 resource exhaustion remains unknown in consistency and proof queries");

  const floatSource = prefix +
    "export function add(x: number, y: number): number { return x + y; }\n" +
    "contract(add, { requires: (x,y) => x === 0.1 && y === 0.2, ensures: r => r === 0.3 });\n";
  const floating = await checked("float-model", floatSource);
  assert.equal(floating.status, "refuted");
  assert.equal(floating.semantics, "number-ieee754-binary64");
  assert.equal(implementation(floating)?.status, "disproved");
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal((await verify("examples/withdraw-number.ts")).status, "refuted");
  passed("number cannot silently fall back to mathematical reals");

  assert.equal(implementation(await verify(fixture("division", source.replace("return balance - amount;", "return balance / amount;"))))?.status, "unknown");
  assert.throws(() => adapt(fixture("mixed", source.replace("balance >= 0n", "balance >= 0"))), /mixed numeric/);
  assert.throws(() => adapt(fixture("type-error", source.replace("result >= 0n", 'result.toUpperCase() === "0"'))), /toUpperCase/);
  assert.throws(() => adapt(fixture("recursive", source.replace("return balance - amount;", "return withdraw(balance, amount);"))), /recursive/);
  assert.throws(() => adapt(fixture("truthiness", source.replace("if (balance < 0n || amount <= 0n)", "if (balance)"))), /boolean/);
  passed("unsupported division stays unknown; numeric mixing, truthiness, type errors and recursion are rejected");

  for (const [name, body] of [
    ["variable", "const y = x; return y;"],
    ["mutation", "x += 1n; return x;"],
    ["loop", "while (x < 0n) { x += 1n; } return x;"],
    ["try", "try { return x; } catch { return 0n; }"],
    ["ternary", "return x > 0n ? x : -x;"],
    ["bigint-call", "return BigInt(x);"],
  ]) {
    assert.throws(() => adapt(fixture("unsupported-" + name, prefix +
      `export function f(x: bigint): bigint { ${body} }\n` +
      "contract(f, { requires: () => true, ensures: () => true });\n")), /Unsupported/);
  }
  assert.throws(() => adapt(fixture("call-in-condition", multiCallSource.replace("if (x > 0n)", "if (positive(x) > 0n)"))), /Unsupported/);
  assert.throws(() => adapt(fixture("nested-call", multiCallSource.replace("positive(x + 1n)", "positive(positive(x))"))), /Unsupported/);
  await assert.rejects(() => checked("dropped-call", multiCallSource.replace("else return 0n;", "else return 0n; return positive(x);")), /call coverage/);
  passed("unsupported syntax, condition/nested calls and dropped calls cannot pass verification");

  // A failed run immediately after a verified run must replace its saved report.
  for (const [file, expected] of [["examples/bigint-exact.ts", 0], ["work/cases/nested-fallthrough.ts", 1],
                                ["examples/modules/index.ts", 0],
                                ["work/cases/bindings/broken-imported-implementation/entry.ts", 1],
                                ["work/cases/bindings/duplicate-imported-contract/entry.ts", 2],
                                ["work/cases/bindings/same-name-modules/entry.ts", 1],
                                ["work/cases/bindings/imported-call-precondition/entry.ts", 1],
                                ["work/cases/unsafe-continuation-call.ts", 1],
                                ["work/cases/inconsistent.ts", 1],
                                ["work/cases/weak-callee-contract.ts", 2],
                                ["examples/withdraw.ts", 1], ["examples/withdraw-number.ts", 1],
                                ["work/cases/this-parameter.ts", 2], ["work/cases/unsupported-loop.ts", 2],
                                ["work/cases/type-error.ts", 2]] as const) {
    const cli = spawnSync(process.execPath, ["scripts/verify.ts", file], {encoding: "utf8", timeout: 20000});
    assert.equal(cli.status, expected, cli.stderr + cli.stdout);
    const cliReport = JSON.parse(cli.stdout);
    assert.ok(cliReport.status);
    assert.equal(Object.hasOwn(cliReport, "generated"), false);
    assertReportDiagnostics(cliReport);
    if (file === "work/cases/type-error.ts") {
      assert.equal(cliReport.reasonCode, "type-error");
      assertLocation(cliReport.source, "toUpperCase");
      assert.equal(cliReport.reason.includes("\u001b"), false);
    }
    if (file === "work/cases/unsupported-loop.ts") {
      assert.equal(cliReport.reasonCode, "unsupported-code");
      assertLocation(cliReport.source, "while (x < 0n) { x += 1n; }");
    }
    if (file === "examples/withdraw-number.ts") assert.equal(cliReport.semantics, "number-ieee754-binary64");
    const original = reports.find(r => r.input === path.resolve(file));
    if (original) {
      // Z3 may choose a different valid model between processes; diagnostics must match.
      const withoutModels = (report: VerificationReport) => report.results.map(r =>
        Object.fromEntries(Object.entries(r).filter(([key]) => key !== "counterexample")));
      assert.deepEqual(withoutModels(cliReport), withoutModels(original));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync("work/verification.json", "utf8")), cliReport);
    if (expected === 2) assert.equal(cliReport.status, "unknown");
  }
  passed("CLI exit codes distinguish verified, refuted and unknown");
  for (const report of reports) assertReportDiagnostics(report);
  passed("source diagnostics, cross-file contracts, distinct path results and reason codes survive JSON/CLI");
  fs.writeFileSync("work/check-results.json", JSON.stringify(reports, null, 2) + "\n");
  console.log("All checks passed. Guarantees apply only to the documented numeric subsets.");
  process.exit(0);
} catch (error) {
  if (error && typeof error === "object" && "stdout" in error && Buffer.isBuffer(error.stdout)) console.error(error.stdout.toString());
  else console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
}
