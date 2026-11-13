import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { dependencies } from "./dependencies.ts";
import type { Expr } from "./ir.ts";
import { prettyExpr } from "./ir.ts";
import { sourceInventory, validateIR } from "./ir-integrity.ts";
import { encodeNumber } from "./numeric-values.ts";
import { verify } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/ternary", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("ternaries retain precedence, right associativity and all pure body contexts", async () => {
  const entry = fixture("contexts", `
function sign(x:bigint):bigint{return x<0n?-1n:x===0n?0n:1n;}
contract(sign,{ensures:(r,x)=>x<0n?r===-1n:x===0n?r===0n:r===1n});
function contexts(x:bigint):bigint{
  const positive=x<0n?-x:x;
  let y=x===0n?1n:positive;
  y+=x===0n?1n:0n;
  if(x<0n?true:x>0n){
    switch(x<0n?-1n:1n){case x<0n?-1n:1n:return (y>0n?y:1n)+1n;default:return 0n;}
  }
  return y;
}
contract(contexts,{ensures:(r,x)=>r===(x===0n?2n:(x<0n?-x:x)+1n)});
function condition(x:bigint):bigint{return (x<0n?true:false)?-x:x;}
contract(condition,{requires:x=>x<0n?x>=-10n:x<=10n,ensures:r=>r>=0n});`);
  expect(prettyExpr(adapt(entry).functions[0].body)).toBe("((x < 0n) ? (-1n) : ((x === 0n) ? 0n : 1n))");
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [-10n, -1n, 0n, 1n, 10n]) {
    expect(runtime.execute("sign", [x]).result).toBe(x < 0n ? -1n : x === 0n ? 0n : 1n);
    expect(runtime.execute("contexts", [x]).result).toBe(x === 0n ? 2n : (x < 0n ? -x : x) + 1n);
  }
  expect((await checkProperties(runtime, { seed: 42, numRuns: 20 })).every(r => r.status === "passed")).toBe(true);
});

test("result dependencies survive in the condition and either predicate branch", async () => {
  const entry = fixture("result-dependencies", `
function condition(x:number):number{return x;}
contract(condition,{ensures:r=>r===r?true:true});
function yes(x:number):number{return x;}
contract(yes,{ensures:r=>true?r===r:true});
function no(x:number):number{return x;}
contract(no,{ensures:r=>false?true:r===r});
function text(s:string):string{return s;}
contract(text,{ensures:r=>true?r===r:false});`);
  const selected = dependencies(adapt(entry));
  expect([...selected.sorts].sort()).toEqual(["float64", "string"]);
  for (const name of ["condition", "yes", "no"]) expect([...selected.parameters.get(name)!]).toEqual(["x"]);
  expect([...selected.parameters.get("text")!]).toEqual(["s"]);
  const report = await verify(entry);
  expect(report.results.find(r => r.function === "condition")).toMatchObject({ status: "proved" });
  for (const name of ["yes", "no"]) expect(report.results.find(r => r.function === name)).toMatchObject({ status: "disproved" });
  expect(report.results.find(r => r.function === "text")).toMatchObject({ status: "proved" });
});

const chooseSource = "function choose(x:number):number{return x!==x?NaN:x===0?-0:x;}";

test("number and string ternaries preserve NaN, signed zero and UTF-16", async () => {
  const entry = fixture("scalars", `
${chooseSource}
contract(choose,{ensures:(r,x)=>x!==x?r!==r:r===x});
function text(s:string):string{return s===""?"\\ud800":s==="😀"?s+"!":s;}
contract(text,{ensures:(r,s)=>r===(s===""?"\\ud800":s==="😀"?s+"!":s)});
function size(s:string):number{return (s===""?"😀":s).length;}
contract(size,{ensures:r=>r>0});
function literalSize(x:number):number{const s=x>0?"a":"bb";return s.length;}
contract(literalSize,{ensures:r=>r>=1 && r<=2});`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [NaN, Infinity, -Infinity, 0, -0, Number.MIN_VALUE, -2, 3])
    expect(Object.is(runtime.execute("choose", [x]).result, Number.isNaN(x) ? NaN : x === 0 ? -0 : x)).toBe(true);
  for (const s of ["", "😀", "\ud800", "\u0000", "abc"])
    expect(runtime.execute("text", [s]).result).toBe(s === "" ? "\ud800" : s === "😀" ? s + "!" : s);
  for (const s of ["", "abc"]) expect(runtime.execute("size", [s]).result).toBe(s === "" ? 2 : s.length);
  for (const x of [NaN, -1, 0, 1]) expect(runtime.execute("literalSize", [x]).result).toBe(x > 0 ? 1 : 2);
});

test("nested number ternaries prove negative zero and reject a positive-zero mutation", async () => {
  // Together with the unrestricted NaN/equality proof above, this checks the
  // original property for every number. Restrict reciprocal division to both
  // zero inputs so Z3 need not bit-blast division over an unrestricted ternary.
  const contract = "contract(choose,{requires:x=>x===0,ensures:r=>1/r===-Infinity});";
  const entry = fixture("signed-zero", `${chooseSource}\n${contract}`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [0, -0]) {
    expect(runtime.accepts("choose", [x])).toBe(true);
    const execution = runtime.execute("choose", [x]);
    expect(Object.is(execution.result, -0)).toBe(true);
    expect(execution.ensures).toBe(true);
  }

  const broken = fixture("signed-zero-mutated", `${chooseSource.replace("?-0:", "?0:")}\n${contract}`);
  const refuted = await verify(broken);
  expect(refuted.status, JSON.stringify(refuted)).toBe("refuted");
  expect(refuted.results.find(r => r.kind === "implementation")).toMatchObject({
    status: "disproved", reasonCode: "contract-violation", counterexample: { x: expect.anything() },
  });
  const generated = await generateRegressions(broken, path.join(path.dirname(broken), "generated"));
  const { manifest } = loadRegressions(generated.manifestFile);
  expect(manifest.cases).toHaveLength(1);
  expect(replayRegression(createTestRuntime(broken), broken, manifest.cases[0]).status).toBe("failed");
});

test("ternary obligations preserve solver resource limits", async () => {
  const entry = fixture("limits", `function f(x:number):number{return x>0?x:-x;}
contract(f,{ensures:r=>r===r?r>=0:false});`);
  const report = await verify(entry, { resourceLimit: 1 });
  expect(report.results[0]).toMatchObject({ status: "unknown", reasonCode: "solver-unknown" });
  expect(report.results[0]).not.toHaveProperty("counterexample");
});

test("only selected divisions require a nonzero divisor in bodies and predicates", async () => {
  const entry = fixture("division", `
function body(x:bigint,y:bigint):bigint{return y===0n?0n:x/y;}
contract(body,{ensures:(r,x,y)=>y===0n?r===0n:r===x/y});
function pre(x:bigint,y:bigint):bigint{return y!==0n?x/y:1n;}
contract(pre,{requires:(x,y)=>y===0n?true:x/y>0n,ensures:r=>r>0n});
function local(x:bigint,y:bigint):bigint{const q=y===0n?0n:x/y;return q;}
contract(local,{ensures:(r,x,y)=>r===(y===0n?0n:x/y)});
function dead(x:bigint):bigint{return true?x:x/0n;}
contract(dead,{ensures:(r,x)=>r===x});
function unsafe(x:bigint,y:bigint):bigint{return y===0n?x/y:0n;}
contract(unsafe,{ensures:r=>r===r});
function unsafePre(x:bigint,y:bigint):bigint{return x;}
contract(unsafePre,{requires:(x,y)=>y===0n?x/y>0n:true});`);
  const report = await verify(entry);
  for (const r of report.results) {
    if (r.function.startsWith("unsafe")) expect(r).toMatchObject({ status: "unknown", reasonCode: "unsupported-dependency" });
    else expect(["proved", "satisfiable"], JSON.stringify(r)).toContain(r.status);
  }
  const runtime = createTestRuntime(entry);
  expect(runtime.execute("body", [7n, 0n]).result).toBe(0n);
  expect(runtime.execute("body", [-7n, 3n]).result).toBe(-2n);
  expect(runtime.execute("dead", [5n]).result).toBe(5n);
});

test("branch calls keep identities, path guards and lazy runtime execution", async () => {
  const entry = fixture("calls", `
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>x>0n?r===x:false});
function negative(x:bigint):bigint{return -x;}
contract(negative,{requires:x=>x<0n,ensures:(r,x)=>r===-x});
function absolute(x:bigint):bigint{return x>0n?positive(x):x<0n?negative(x):0n;}
contract(absolute,{ensures:(r,x)=>r===(x<0n?-x:x)});
function argument(x:bigint):bigint{return positive(x>0n?x:1n);}
contract(argument,{ensures:r=>r>0n});
function bad(x:bigint):bigint{return x<=0n?positive(x):0n;}
function shared(x:bigint):bigint{if(x<0n)x=-x;return x>0n?positive(x):0n;}
contract(shared,{ensures:(r,x)=>r===(x<0n?-x:x)});`);
  const report = await verify(entry);
  const bad = report.results.find(r => r.function === "bad" && r.kind === "call");
  expect(bad).toMatchObject({ status: "disproved" });
  for (const r of report.results.filter(r => r.function !== "bad"))
    expect(["proved", "satisfiable"], JSON.stringify(r)).toContain(r.status);
  const shared = report.results.filter(r => r.function === "shared" && r.kind === "call");
  expect(shared).toHaveLength(2);
  expect(new Set(shared.map(r => r.kind === "call" && r.callId)).size).toBe(1);
  const runtime = createTestRuntime(entry);
  const positive = runtime.execute("absolute", [3n]);
  const negative = runtime.execute("absolute", [-3n]);
  expect(positive.calls.map(c => c.site.callee)).toEqual(["positive"]);
  expect(negative.calls.map(c => c.site.callee)).toEqual(["negative"]);
  expect(positive.calls[0].site.id).not.toBe(negative.calls[0].site.id);
  expect(runtime.execute("absolute", [0n]).calls).toEqual([]);
});

test("ternary counterexamples generate replayable regressions", async () => {
  const entry = fixture("regressions", `
function f(x:bigint):bigint{return x<0n?-x:x;}
contract(f,{requires:x=>x===-900719925474099312345n,ensures:(r,x)=>true?r===x:false});`);
  expect((await verify(entry)).status).toBe("refuted");
  const generated = await generateRegressions(entry, path.join(path.dirname(entry), "generated"));
  const { manifest } = loadRegressions(generated.manifestFile);
  expect(manifest.cases).toHaveLength(1);
  expect(manifest.cases[0].inputs).toEqual(["-900719925474099312345n"]);
  expect(replayRegression(createTestRuntime(entry), entry, manifest.cases[0]).status).toBe("failed");
});

test("unsupported ternary dependencies retain selective checking and model restrictions", async () => {
  const entry = fixture("unsupported", `
function used(x:bigint):bigint{return x>0n?x%2n:x;}
contract(used,{ensures:r=>r>=0n});
function independent(x:bigint):bigint{return x>0n?x%2n:x;}
contract(independent,{ensures:(r,x)=>x===x});
function opaque(x:bigint,b:boolean):bigint{return b?x:0n;}
contract(opaque,{ensures:r=>r>=0n});
function opaqueBranch(x:bigint,b:boolean):bigint{return (x>0n?b:false)?x:0n;}
contract(opaqueBranch,{ensures:r=>r>=0n});`);
  const report = await verify(entry);
  expect(report.results.find(r => r.function === "independent")).toMatchObject({ status: "proved" });
  for (const name of ["used", "opaque", "opaqueBranch"])
    expect(report.results.find(r => r.function === name)).toMatchObject({ status: "unknown", reasonCode: "unsupported-dependency" });
  await expect(verify(fixture("mixed-model", `function f(x:number,y:bigint):number{return y>0n?x:0;}
contract(f,{ensures:r=>true?r===r:false});`))).resolves.toMatchObject({ status: "unknown", reasonCode: "unsupported-numeric-model" });
});

test("ternaries do not admit truthiness, mixed branches, mutations or forbidden calls", () => {
  for (const [name, body] of [
    ["truthiness", "return x?x:0n;"],
    ["condition-call", "return id(x)>0n?x:0n;"],
    ["nested-condition-call", "return (x>0n?id(x)>0n:false)?x:0n;"],
    ["initializer-call", "const y=true?id(x):x;return y;"],
    ["assignment-call", "x=true?x:id(x);return x;"],
    ["argument-call", "return id(true?x:id(x));"],
    ["mutation", "return true?(x=1n):x;"],
    ["increment", "return true?x++:x;"],
    ["getter", "const y=true?obj.value:x;return y;"],
  ]) {
    const source = `function id(x:bigint):bigint{return x;}contract(id,{ensures:(r,x)=>r===x});
function f(x:bigint,obj:{value:bigint}):bigint{${body}}contract(f,{ensures:()=>true});`;
    expect(() => adapt(fixture("rejected-" + name, source)), name).toThrow(/Unsupported/);
  }
  expect(() => adapt(fixture("mixed-branches", `function f(x:number):number|string{return x>0?x:"";}
contract(f,{ensures:()=>true});`))).toThrow(/same value kind/);
  for (const kind of ["requires", "ensures"])
    expect(() => adapt(fixture("predicate-call-" + kind, `function id(x:bigint):bigint{return x;}
contract(id,{ensures:(r,x)=>r===x});function f(x:bigint):bigint{return x;}
contract(f,{${kind}:x=>true?id(x)>0n:true});`))).toThrow(/Unsupported/);
});

test("pure ternary IR still rejects invalid conditions, result positions and calls", () => {
  const entry = fixture("ir", `function id(x:number):number{return x;}contract(id,{ensures:(r,x)=>r===x});
function f(x:number):number{return x>0?id(x):0;}contract(f,{requires:x=>x>=0,ensures:r=>true?r>=0:false});`);
  for (const kind of ["condition", "sort", "condition-call", "predicate-call", "result"]) {
    const ir = adapt(entry);
    const fn = ir.functions[1];
    if (fn.body.kind !== "ternary") throw new Error("expected branch");
    const call = fn.body.then;
    if (kind === "condition") fn.body.condition = { kind: "number", value: encodeNumber(0) };
    if (kind === "sort") fn.body.else = { kind: "string", value: "" };
    if (kind === "condition-call") fn.body.condition = { kind: "binary", op: ">", left: call, right: { kind: "number", value: encodeNumber(0) } };
    if (kind === "predicate-call" || kind === "result") {
      const value: Expr = kind === "result" ? { kind: "result" } : call;
      fn.contracts[0].predicate = { kind: "ternary", condition: { kind: "literal", value: true },
        then: { kind: "binary", op: "===", left: value, right: value }, else: { kind: "literal", value: false } };
    }
    ir.coverage.inventory = sourceInventory(ir);
    expect(() => validateIR(ir), kind).toThrow(/Invalid IR/);
  }
});
