import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { prettyExpr } from "./ir.ts";
import { sourceInventory, validateIR } from "./ir-integrity.ts";
import { verify } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/division", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("bigint division discards fractional parts with exact signs and magnitude", async () => {
  const huge = 123456789012345678901234567890123456789n;
  const values = [0n, 1n, -1n, 7n, -7n, huge, -huge];
  const pairs = values.flatMap(a => [1n, -1n, 3n, -3n, huge, -huge].map(b => [a,b] as const));
  const source = pairs.map(([a,b], i) => `function f${i}():bigint{return (${a}n)/(${b}n);}
contract(f${i},{ensures:r=>r===(${a/b}n)});`).join("\n");
  const entry = fixture("bigint-constants", source);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const [i, [a,b]] of pairs.entries()) expect(runtime.execute("f"+i, []).result).toBe(a/b);
});

test("symbolic division in predicates, precedence, guards and switch", async () => {
  const entry = fixture("bigint-symbolic", `
function quotient(x:bigint,y:bigint):bigint{return x/y;}
contract(quotient,{requires:(x,y)=>y!==0n,ensures:(r,x,y)=>r===x/y});
function guarded(x:bigint,y:bigint):bigint{if(y===0n)return 0n;return x/y;}
contract(guarded,{ensures:(r,x,y)=>y===0n || r===x/y});
function selected(x:bigint):bigint{switch(x/2n){case 6n/3n:return 1n;default:return 0n;}}
contract(selected,{ensures:(r,x)=>r===0n || x/2n===2n});
function precedence(x:bigint):bigint{return 1n+x/2n*3n/4n;}
contract(precedence,{ensures:(r,x)=>r===1n+((x/2n)*3n)/4n});
function positive(x:bigint,y:bigint):bigint{return x/y;}
contract(positive,{requires:(x,y)=>y!==0n && x/y>0n,ensures:r=>r>0n});
function optional(x:bigint,y:bigint):bigint{if(y===0n)return 1n;return x/y;}
contract(optional,{requires:(x,y)=>y===0n || x/y>0n,ensures:r=>r>0n});`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  expect(prettyExpr(runtime.ir.functions.find(f=>f.name==="precedence")!.body)).toBe("(1n + (((x / 2n) * 3n) / 4n))");
  expect((await checkProperties(runtime, { seed: 42, numRuns: 20 })).every(r => r.status === "passed")).toBe(true);
});

test("potential zero divisors never produce proofs or fabricated counterexamples", async () => {
  const entry = fixture("unsafe", `
function body(x:bigint,y:bigint):bigint{return x/y;}
contract(body,{ensures:(r,x,y)=>r===x/y});
function pre(x:bigint,y:bigint):bigint{return x;}
contract(pre,{requires:(x,y)=>x/y>0n && y!==0n,ensures:r=>r>0n});
function post(x:bigint,y:bigint):bigint{return x;}
contract(post,{ensures:(r,x,y)=>r/y===x/y});
function nested(x:bigint,y:bigint):bigint{return x/(y/y);}
contract(nested,{ensures:(r,x)=>r===x});
function innerZero(x:bigint,y:bigint):bigint{return x/(y/2n);}
contract(innerZero,{requires:(x,y)=>y!==0n,ensures:(r,x,y)=>r===x/(y/2n)});
function branch(x:bigint,y:bigint):bigint{if(x/y>0n)return 1n;return 0n;}
contract(branch,{ensures:r=>r>=0n});`);
  const report = await verify(entry);
  expect(report.status).toBe("unknown");
  for (const r of report.results.filter(r=>r.status!=="satisfiable")) {
    expect(r).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
    expect(r).not.toHaveProperty("counterexample");
    expect("reason" in r && r.reason).toMatch(/zero divisor/);
  }
  expect(()=>createTestRuntime(entry).execute("body", [1n,0n])).toThrow();
});

test("division respects modular guarantees, call paths and argument evaluation", async () => {
  const entry = fixture("calls", `
function identity(x:bigint):bigint{return x;}
contract(identity,{requires:x=>x>=0n,ensures:(r,x)=>r===x});
function guarded(x:bigint,y:bigint):bigint{if(y===0n)return 0n;if(x/y<0n)return 0n;return identity(x/y);}
contract(guarded,{ensures:r=>r>=0n});
function half(x:bigint):bigint{return x/2n;}
contract(half,{ensures:(r,x)=>r===x/2n});
function caller(x:bigint):bigint{return half(x)/3n;}
contract(caller,{ensures:(r,x)=>r===(x/2n)/3n});
function unsafe(x:bigint,y:bigint):bigint{return identity(x/y);}
function unsafePath(x:bigint,y:bigint):bigint{if(x/y>0n)return identity(x);return 0n;}
function weak(x:bigint):bigint{return x;}
contract(weak,{ensures:r=>r>=0n});
function weakCaller(x:bigint):bigint{return weak(x)/2n;}
contract(weakCaller,{ensures:(r,x)=>r===x/2n});`);
  const report = await verify(entry);
  for (const r of report.results.filter(r=>["identity","guarded","half","caller"].includes(r.function)))
    expect(["proved","satisfiable"], JSON.stringify(r)).toContain(r.status);
  for (const name of ["unsafe", "unsafePath"])
    expect(report.results.find(r=>r.function===name)).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
  expect(report.results.find(r=>r.function==="weakCaller")).toMatchObject({status:"unknown",reasonCode:"weak-callee-contract"});
});

test("callee postconditions cannot circularly justify their own division", async () => {
  const entry = fixture("circular", `
function bad(x:bigint):bigint{return x;}
contract(bad,{ensures:(r,x)=>1n/x>0n && x!==0n});
function caller(x:bigint):bigint{return bad(x);}
contract(caller,{ensures:r=>r>0n});`);
  const report = await verify(entry);
  expect(report.status).toBe("unknown");
  expect(report.results.every(r=>r.status==="unknown" && r.reasonCode==="unsupported-dependency")).toBe(true);
});

test("guarded callee division preserves call reachability and eager arguments", async () => {
  const entry = fixture("callee-paths", `
function quotient(x:bigint,y:bigint):bigint{return x/y;}
contract(quotient,{requires:(x,y)=>y!==0n,ensures:(r,x,y)=>r===x/y});
function guarded(x:bigint,y:bigint):bigint{if(y===0n)return 0n;return quotient(x,y);}
contract(guarded,{ensures:(r,x,y)=>y===0n || r===x/y});
function accept(x:bigint,y:bigint):bigint{return y;}
contract(accept,{requires:(x,y)=>y===0n || x>=0n,ensures:(r,x,y)=>r===y});
function eager(x:bigint,y:bigint):bigint{return accept(x/y,y);}
contract(eager,{ensures:(r,x,y)=>r===y});
function nested(x:bigint,y:bigint):bigint{if(y!==0n){if(x/y>0n)return quotient(x,y);}return 0n;}
contract(nested,{ensures:r=>r>=0n});`);
  const report = await verify(entry);
  for (const r of report.results) {
    if (r.function === "eager") expect(r).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
    else expect(["proved","satisfiable"], JSON.stringify(r)).toContain(r.status);
  }
});

test("unreachable division and independent predicates retain selective checking", async () => {
  const entry = fixture("selective", `
function guarded(x:bigint):bigint{if(false)return x/0n;return x;}
contract(guarded,{ensures:(r,x)=>r===x});
function independent(x:bigint,y:bigint):bigint{return x/y;}
contract(independent,{requires:(x,y)=>x>=0n,ensures:(r,x)=>x>=0n});
function disjunction(x:bigint):bigint{return x;}
contract(disjunction,{ensures:(r,x)=>true || r/0n===x});`);
  expect((await verify(entry)).status).toBe("verified");
});

test("number division matches binary64 including observable signed zeros", async () => {
  const pairs = [[1,3], [0.1,0.2], [1,0], [1,-0], [-1,0], [0,0], [Infinity,Infinity],
    [Infinity,-2], [1,Infinity], [-1,Infinity], [NaN,1], [0,-1], [-0,-1],
    [Number.MIN_VALUE,2], [-Number.MIN_VALUE,2], [3*Number.MIN_VALUE,2],
    [2**-1022,2], [Number.MAX_VALUE,0.5], [1,Number.MIN_VALUE]];
  const literal = (x:number) => Object.is(x,-0) ? "-0" : String(x);
  const source = pairs.map(([a,b],i)=> {
    const value = a/b;
    const predicate = Number.isNaN(value) ? "r!==r" : value===0
      ? `r===0 && 1/r===${literal(1/value)}` : `r===${literal(value)}`;
    return `function f${i}():number{return (${literal(a)})/(${literal(b)});}
contract(f${i},{ensures:r=>${predicate}});`;
  }).join("\n");
  const entry = fixture("numbers", source);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const [i,[a,b]] of pairs.entries()) expect(Object.is(runtime.execute("f"+i,[]).result,a/b)).toBe(true);
});

test("number division in predicates and string lengths", async () => {
  const entry = fixture("number-predicates", `
function half(x:number):number{return x/2;}
contract(half,{requires:x=>x===6 && x/2===3,ensures:r=>r===3});
function length(s:string):number{return s.length/2;}
contract(length,{requires:s=>s==="😀",ensures:r=>r===1});`);
  expect((await verify(entry)).status).toBe("verified");
});

test("incorrect quotients produce exact replayable regressions", async () => {
  for (const [name, source] of [
    ["bigint", `function f(x:bigint):bigint{return x/3n;}
contract(f,{requires:x=>x===-900719925474099312345n,ensures:r=>r===0n});`],
    ["number", `function f(x:number):number{return x/x;}
contract(f,{ensures:r=>r===1});`],
  ]) {
    const entry = fixture("regression-"+name, source);
    const report = await verify(entry);
    expect(report.status).toBe("refuted");
    const generated = await generateRegressions(entry, path.join(path.dirname(entry), "generated"));
    const { manifest } = loadRegressions(generated.manifestFile);
    expect(manifest.cases).toHaveLength(1);
    expect(replayRegression(createTestRuntime(entry), entry, manifest.cases[0]).status).toBe("failed");
    if (name === "bigint") expect(manifest.cases[0].inputs).toEqual(["-900719925474099312345n"]);
  }
});

test("division retains solver resource limits", async () => {
  for (const [name,source] of [
    ["bigint", `function f(x:bigint,y:bigint):bigint{return x/y;}contract(f,{ensures:r=>r>=0n});`],
    ["number", `function f(x:number,y:number):number{return x/y;}contract(f,{ensures:r=>r>=0});`],
  ]) {
    const report = await verify(fixture("limits-"+name, source), { resourceLimit:1 });
    expect(report.results[0]).toMatchObject({status:"unknown",reasonCode:"solver-unknown"});
    expect(report.results[0]).not.toHaveProperty("counterexample");
  }
});

test("division rejects invalid types and IR; remainder and exponentiation stay unsupported", async () => {
  for (const [name,params] of [["mixed","x:bigint,y:number"],["string","x:string,y:string"],["boolean","x:boolean,y:boolean"]])
    await expect(verify(fixture("invalid-"+name, `function f(${params}):number{return x/y;}contract(f,{ensures:r=>r===0});`)))
      .rejects.toMatchObject({reasonCode:"type-error"});
  const entry = fixture("ir", `function f(x:number,y:number):number{return x/y;}contract(f,{ensures:r=>r===0});`);
  for (const sort of ["int","string","opaque"] as const) {
    const ir = adapt(entry);
    if (sort === "opaque") {
      ir.functions[0].body = {kind:"binary",op:"/",left:{kind:"literal",value:true},right:{kind:"literal",value:false}};
    } else ir.functions[0].params[0].sort=sort;
    ir.coverage.inventory=sourceInventory(ir);
    expect(()=>validateIR(ir)).toThrow(/Invalid IR/);
  }
  for (const operator of ["%","**"]) {
    const report=await verify(fixture("unsupported-"+(operator==="%"?"mod":"pow"), `function f(x:bigint):bigint{return x${operator}2n;}contract(f,{ensures:r=>r>=0n});`));
    expect(report.results[0]).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
  }
});
