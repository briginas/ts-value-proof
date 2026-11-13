import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { verify } from "./verify.ts";
import { validateIR } from "./ir-integrity.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";
import { decodeNumber } from "./numeric-values.ts";

function fixture(name: string, source: string, modules: Record<string, string> = {}) {
  const directory = path.resolve("work/selective", name);
  fs.mkdirSync(directory, {recursive: true});
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  for (const [file, text] of Object.entries({"entry.ts": 'import { contract } from "@api";\n' + source, ...modules}))
    fs.writeFileSync(path.join(directory, file), text.replaceAll("@api", api));
  return path.join(directory, "entry.ts");
}
const results = async (name: string, code: string) => verify(fixture(name, code));

test("positional numeric projection keeps arbitrary input types and numeric aliases", async () => {
  for (const [i, parameters, pre] of [
    [0, "x: Num, label: string, object: Obj, flag: boolean, cb: () => void, union: string | number, a: any, u: unknown", "x"],
    [1, "label: string, x: Num, object: Obj", "_label, x"],
    [2, "label: string, object: Obj, x: Num", "_label, _object, x"],
  ] as const) {
    const report = await results("positions" + i, `type Num = number; interface Obj { value: number }
function f(${parameters}): number { return x; }
contract(f, { requires: (${pre}) => x >= 0, ensures: (r) => r >= 0 });`);
    expect(report.status).toBe("verified");
    expect(report.semantics).toBe("number-ieee754-binary64");
    expect(report.scope?.[0].parameters.filter(p => p.status === "modeled").map(p => p.name)).toEqual(["x"]);
    expect(report.scope?.[0].callSites).toBe(0);
  }
});

test("opaque returns and literals pass through without a fabricated model", async () => {
  const report = await results("opaque-return", `function f(label: string, x: number): string { return label; }
contract(f, {requires: (_label, x) => x >= 0});
function caller(x: number): string {return f("hello", x);}
contract(caller, {requires: x => x >= 0});
function nil(x: number): null {return null;}
contract(nil, {requires: x => x >= 0});`);
  expect(report.status).toBe("verified");
  expect(report.results.map(r => r.kind)).toEqual(["preconditions", "preconditions", "call", "preconditions"]);
  expect(report.scope?.[0].predicates).toEqual(["requires"]);
});

test("type-only edges, declarations, aliases and re-exports do not execute modules", async () => {
  const entry = fixture("type-modules", `import type { Model, Num } from "./barrel.js";
import { type Decl } from "./ambient.js";
export interface Local { field: string }
export type Alias = Local;
function f(model: Model, declaration: Decl, local: Alias, x: Num): Num {return x;}
contract(f, {requires: (_m, _d, _l, x) => x >= 0});`, {
    "barrel.ts": 'export type { Model, Num } from "./types.js";',
    "types.ts": 'export type Model = {name:string}; export type Num = number; throw new Error("MUST NOT EXECUTE");',
    "ambient.d.ts": 'export interface Decl {name:string}',
  });
  expect((await verify(entry)).status).toBe("verified");
  expect(adapt(entry).functions).toHaveLength(1);
  expect(() => createTestRuntime(entry)).toThrow(/runtime graph/);
  const numeric = fixture("type-only-runtime", `import type { Num } from "./types.js";
function f(x: Num): Num {return x;} contract(f, {ensures: () => true});`, {
    "types.ts": 'export type Num = number; throw new Error("MUST NOT EXECUTE");',
  });
  expect(createTestRuntime(numeric).execute("f", [1]).ensures).toBe(true);
  fs.writeFileSync(path.join(path.dirname(numeric), "types.ts"), '// @ts-nocheck\nexport type Num = number;');
  expect(() => adapt(numeric)).toThrow(/suppressed TypeScript/);
});

test("unknown dependencies stay local and unsupported requires blocks dependent proofs", async () => {
  const report = await results("unknown", `function branch(flag: boolean, x: number): number {if(flag)return x;return 0;}
contract(branch, {requires: (_flag, x) => x >= 0, ensures: r => r >= 0});
function object(o: {value:number}, x:number):number{return x;}
contract(object, {requires: o => o.value >= 0, ensures: r => r >= 0});
function independent(x:number):number{return x;}
contract(independent, {requires:x=>x>=0, ensures:r=>r>=0});`);
  expect(report.status).toBe("unknown");
  expect(report.results.map(r => r.status)).toEqual(["satisfiable", "unknown", "unknown", "unknown", "satisfiable", "proved"]);
  for (const r of report.results) {
    if (r.status !== "unknown") continue;
    expect(r.reasonCode).toBe("unsupported-dependency");
    expect(r.dependencySource?.line).toBeGreaterThan(0);
    expect(r).not.toHaveProperty("counterexample");
  }
  const operation = await results("operation", `function f(x:number):number{return x%x;}
contract(f,{requires:x=>x>=0,ensures:r=>r>=0});`);
  expect(operation.results.map(r => r.status)).toEqual(["satisfiable", "unknown"]);
});

test("optional predicates, logical semantics and relevance select obligations and model", async () => {
  const onlyPre = await results("only-pre", `function f(x:number,token:bigint):number{return x;}
contract(f,{requires:x=>x>=0});`);
  expect(onlyPre.status).toBe("verified");
  expect(onlyPre.semantics).toBe("number-ieee754-binary64");
  expect(onlyPre.results.map(r => r.kind)).toEqual(["preconditions"]);
  const onlyPost = await results("only-post", `function f(x:number):number{return x;}
contract(f,{ensures:(r,x)=>r===x});`);
  expect(onlyPost.status).toBe("refuted");
  expect(onlyPost.results).toHaveLength(1);
  const failure = onlyPost.results[0];
  expect(failure.kind).toBe("implementation");
  if (failure.status !== "disproved") throw new Error("Expected concrete violation");
  expect(Number.isNaN(decodeNumber(failure.counterexample.x))).toBe(true);
  const logical = await results("logical", `function f(x:string):string{return x;}
contract(f,{ensures:()=>true});`);
  expect(logical.status).toBe("verified");
  expect(logical.semantics).toBe("logical");
  const mixed = await results("mixed", `function f(x:number,y:bigint):number{return x;}
contract(f,{requires:(x,y)=>x>=0 && y>=0n});`);
  expect(mixed.reasonCode).toBe("unsupported-numeric-model");
  expect(mixed.results).toEqual([]);
});

test("counterexamples need all concrete inputs including unused numeric arguments", async () => {
  const opaque = await results("incomplete", `function f(x:number,o:unknown):number{return x;}
contract(f,{ensures:()=>false});`);
  expect(opaque.results[0]).toMatchObject({status:"unknown",reasonCode:"incomplete-counterexample"});
  expect(opaque.results[0]).not.toHaveProperty("counterexample");
  const concrete = await results("full-input", `function f(x:number,y:number,token:bigint):number{return x;}
contract(f,{requires:x=>x===1,ensures:()=>false});`);
  const result = concrete.results.find(r => r.kind === "implementation")!;
  expect(result.status).toBe("disproved");
  if (result.status !== "disproved") throw new Error("Expected violation");
  expect(Object.keys(result.counterexample).sort()).toEqual(["token","x","y"]);
  expect(result.counterexample.token).toBe("0n");
  expect(decodeNumber(result.counterexample.x)).toBe(1);
});

test("requires-only calls remain checked and abstract results never fabricate violations", async () => {
  const report = await results("abstract", `function f(x:bigint):bigint{return x;}
contract(f,{requires:x=>x>=0n});
function caller(x:bigint):bigint{return f(x);}
contract(caller,{requires:x=>x>=0n,ensures:(r,x)=>r===x});
function independent(x:bigint):bigint{return f(x);}
contract(independent,{requires:x=>x>=0n,ensures:()=>true});
function unsafe(x:bigint):bigint{return f(x);}
contract(unsafe,{requires:()=>true});`);
  expect(report.status).toBe("refuted");
  expect(report.results.find(r => r.function === "caller" && r.kind === "implementation"))
    .toMatchObject({status:"unknown",reasonCode:"weak-callee-contract"});
  expect(report.results.find(r => r.function === "independent" && r.kind === "implementation")?.status).toBe("proved");
  expect(report.results.find(r => r.function === "unsafe" && r.kind === "call")?.status).toBe("disproved");
  const postOnly = await results("callee-post", `function f(x:bigint):bigint{return x;}
contract(f,{ensures:(r,x)=>r===x});
function caller(x:bigint):bigint{return f(x);}
contract(caller,{ensures:(r,x)=>r===x});`);
  expect(postOnly.status).toBe("verified");
  expect(postOnly.results.map(r => r.kind)).toEqual(["implementation","implementation"]);
});

test("IR source inventory detects lost signatures, predicates, dependencies and calls", () => {
  const entry = fixture("inventory", `function f(label:string,x:bigint):bigint{return x;}
contract(f,{requires:(_label,x)=>x>=0n});
function caller(label:string,x:bigint):bigint{return f(label,x);}`);
  const original = adapt(entry);
  for (const mutate of [
    (ir: typeof original) => {ir.functions[0].params.shift();},
    (ir: typeof original) => {ir.functions[0].contracts=[];},
    (ir: typeof original) => {ir.functions[0].contracts[0].predicate={kind:"literal",value:true};},
    (ir: typeof original) => {ir.functions[1].body={kind:"bigint",value:"0"};},
  ]) {const ir=structuredClone(original);mutate(ir);expect(()=>validateIR(ir)).toThrow(/Invalid IR/);}
  expect(() => adapt(fixture("unreachable-call", `function f(x:bigint):bigint{return x;}
contract(f,{requires:x=>x>=0n});function caller(x:bigint):bigint{return x;return f(x);}`))).toThrow(/call coverage/);
});

test("unsupported structures and effectful arguments remain rejected", () => {
  for (const [name, declaration] of Object.entries({
    generic:'function f<T>(x:T):T{return x;}',
    optional:'function f(x?:number):number{return 0;}',
    rest:'function f(...x:number[]):number{return 0;}',
    default:'function f(x:number=1):number{return x;}',
    destructure:'function f({x}:{x:number}):number{return x;}',
    this:'function f(this:unknown,x:number):number{return x;}',
    loop:'function f(x:number):number{while(x>0){x=x-1;}return x;}',
    ternaryTruthiness:'function f(x:number):number{return x?x:0;}',
    truthiness:'function f(x:number):number{if(x)return 1;return 0;}',
    callback:'function f(cb:()=>number):number{return cb();}',
  })) expect(()=>adapt(fixture("reject-"+name,declaration+'contract(f,{requires:()=>true});'))).toThrow();
  expect(()=>adapt(fixture("getter", `function f(o:unknown,x:number):number{return x;}
contract(f,{requires:(_o,x)=>x>=0});function caller(o:{value:unknown},x:number):number{return f(o.value,x);}`))).toThrow(/property access/);
});

test("runtime preflight rejects unsupported graphs and partial predicates execute correctly", async () => {
  for (const [name, params, body] of [["opaque","x:number,o:unknown","x"],["mixed","x:number,o:bigint","x"],["operator","x:number","x%x"]]) {
    const entry=fixture("runtime-"+name,`function f(${params}):number{return ${body};}contract(f,{requires:()=>true});`);
    expect(()=>createTestRuntime(entry)).toThrow(/runtime graph/);
    await expect(generateRegressions(entry,path.dirname(entry)+"/generated")).rejects.toThrow(/runtime graph/);
  }
  const entry=fixture("runtime-partial", `function pre(x:number):number{return x;}contract(pre,{requires:x=>x>=0});
function post(x:number):number{return x;}contract(post,{ensures:(r,x)=>r===x});
function caller(x:number):number{return pre(x);}contract(caller,{requires:()=>true});
function noPre(x:number):number{return post(x);}contract(noPre,{ensures:()=>true});`);
  const runtime=createTestRuntime(entry);
  expect(runtime.accepts("pre",[-1])).toBe(false);
  expect(runtime.execute("pre",[1]).ensures).toBeUndefined();
  for(const x of [NaN,Infinity,-Infinity,-0]) expect(runtime.accepts("post",[x])).toBe(true);
  expect(runtime.execute("post",[NaN]).ensures).toBe(false);
  expect(runtime.execute("caller",[-1]).calls[0].accepted).toBe(false);
  expect(runtime.execute("noPre",[NaN]).calls[0].accepted).toBe(true);
  const properties=await checkProperties(runtime,{numRuns:200,seed:123});
  expect(properties.map(r=>r.status)).toEqual(["unknown","failed","failed","passed"]);
  expect(properties[0].checked).toBe(0);
  expect(await checkProperties(runtime,{numRuns:200,seed:123})).toEqual(properties);
  const inconsistent=createTestRuntime(fixture("inconsistent-pre",`function f(x:bigint):bigint{return x;}contract(f,{requires:x=>x>0n && x<0n});`));
  expect((await checkProperties(inconsistent))[0]).toMatchObject({status:"inconsistent",checked:0});
});

test("regression replay requires the specific predicate and retains v1/v2 formats", async () => {
  for(const [name,type,zero] of [["bigint","bigint","0n"],["number","number","0"]]) {
    const code=`function f(x:${type}):${type}{return x;}contract(f,{ensures:()=>false});`;
    const entry=fixture("replay-"+name,code);
    const generated=await generateRegressions(entry,path.dirname(entry)+"/generated");
    const {manifest,runtime}=loadRegressions(generated.manifestFile);
    expect(manifest.version).toBe(type==="number"?2:1);
    expect(manifest.cases).toHaveLength(1);
    expect(replayRegression(runtime,entry,manifest.cases[0]).status).toBe("failed");
    fixture("replay-"+name,code.replace("ensures:()=>false","requires:()=>true"));
    expect(replayRegression(createTestRuntime(entry),entry,manifest.cases[0]).status).toBe("inapplicable");
    const callCode=`function f(x:${type}):${type}{return x;}contract(f,{requires:x=>x>${zero}});
function caller(x:${type}):${type}{return f(x);}`;
    const callEntry=fixture("replay-call-"+name,callCode);
    const gen=await generateRegressions(callEntry,path.dirname(callEntry)+"/generated");
    const saved=loadRegressions(gen.manifestFile);
    expect(saved.manifest.cases).toHaveLength(1);
    expect(replayRegression(saved.runtime,callEntry,saved.manifest.cases[0]).status).toBe("failed");
    fixture("replay-call-"+name,callCode.replace(`requires:x=>x>${zero}`,"ensures:()=>true"));
    expect(replayRegression(createTestRuntime(callEntry),callEntry,saved.manifest.cases[0]).status).toBe("inapplicable");
  }
});

test("CLI replaces reports, preserves local unknowns and rejects unsupported generation", () => {
  const cases=[
    ["verified","function f(x:number):number{return x;}contract(f,{requires:x=>x>=0});",0],
    ["refuted","function f(x:number):number{return x;}contract(f,{ensures:()=>false});",1],
    ["unknown","function f(x:number,o:unknown):number{return x;}contract(f,{ensures:()=>false});",2],
    ["inconsistent","function f(x:bigint):bigint{return x;}contract(f,{requires:x=>x>0n && x<0n});",1],
  ] as const;
  for(const [status,code,exit] of cases) {
    const entry=fixture("cli-"+status,code);
    const run=spawnSync(process.execPath,["scripts/verify.ts",entry],{encoding:"utf8",timeout:20000});
    expect(run.status,run.stdout+run.stderr).toBe(exit);
    expect(JSON.parse(run.stdout).status).toBe(status);
    expect(JSON.parse(run.stdout)).toEqual(JSON.parse(fs.readFileSync("work/verification.json","utf8")));
  }
  const entry=fixture("cli-generate",cases[2][1]);
  const run=spawnSync(process.execPath,["scripts/regressions.ts",entry,path.dirname(entry)+"/generated"],{encoding:"utf8",timeout:20000});
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("runtime graph");
});

test("opaque result dependencies and boolean-only predicates remain local unknowns", async () => {
  const report=await results("opaque-result-dependency", `function flag(x:boolean):boolean{if(x)return true;return false;}
contract(flag,{ensures:r=>r===true});
function pre(x:boolean):boolean{return x;}contract(pre,{requires:x=>x});`);
  expect(report.status).toBe("unknown");
  expect(report.semantics).toBe("logical");
  expect(report.results.map(r=>r.status)).toEqual(["unknown","unknown"]);
  for(const result of report.results) {
    if(result.status!=="unknown") throw new Error("Expected unknown");
    expect(result.reasonCode).toBe("unsupported-dependency");
  }
});

test("property checks include requirements reached through ensures-only callees", async () => {
  const entry=fixture("transitive-property", `function leaf(x:bigint):bigint{return x;}contract(leaf,{requires:x=>x>=0n});
function middle(x:bigint):bigint{return leaf(x);}contract(middle,{ensures:()=>true});
function root(x:bigint):bigint{return middle(x);}contract(root,{requires:()=>true});`);
  const properties=await checkProperties(createTestRuntime(entry),{numRuns:50,seed:4});
  expect(properties.find(r=>r.function==="root")?.status).toBe("failed");
});

test("generated suite fails for absent guarantees and for a newly unsupported runtime", async () => {
  const entry=fixture("suite-no-guarantee", `function f(x:bigint):bigint{return x;}contract(f,{requires:x=>x>=0n});`);
  const generated=await generateRegressions(entry,path.dirname(entry)+"/generated");
  expect(generated.cases).toBe(0);
  const run=()=>spawnSync(process.execPath,["node_modules/vitest/vitest.mjs","run",generated.testFile,"--maxWorkers=1"],
    {encoding:"utf8",timeout:45000,env:{...process.env,NO_COLOR:"1"}});
  const noGuarantee=run();
  expect(noGuarantee.status,noGuarantee.stdout+noGuarantee.stderr).toBe(1);
  expect(noGuarantee.stdout+noGuarantee.stderr).toContain("No ensures or internal requires to test");
  fixture("suite-no-guarantee", `function f(x:bigint,o:unknown):bigint{return x;}contract(f,{requires:x=>x>=0n});`);
  const unsupported=run();
  expect(unsupported.status,unsupported.stdout+unsupported.stderr).toBe(1);
  expect(unsupported.stdout+unsupported.stderr).toContain("Unsupported test runtime graph");
});


test("unsupported unary operations stay local and arithmetic retains call obligations", async () => {
  for (const op of ["+", "~"]) {
    const report=await results("unary-"+op.charCodeAt(0), `function f(x:number):number{return ${op}x;}
contract(f,{ensures:r=>r>=0});`);
    expect(report.results[0]).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
  }
  const report=await results("unsupported-call-expression", `function f(x:number):number{return x;}
contract(f,{requires:x=>x>=0});
function caller(x:number):number{return f(x)%2;}
contract(caller,{requires:()=>true,ensures:r=>r>=0});`);
  expect(report.results.find(r=>r.function==="caller" && r.kind==="call")?.status).toBe("disproved");
  expect(report.results.find(r=>r.function==="caller" && r.kind==="implementation"))
    .toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
});
