import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { callPaths } from "./dependencies.ts";
import { sourceInventory, validateIR } from "./ir-integrity.ts";
import { prettyExpr } from "./ir.ts";
import { verify } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/local-variables", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("const/let chains, shadowing and block continuations preserve bigint values", async () => {
  const entry = fixture("scopes", `
function f(x:bigint):bigint {
  const a = x + 1n, b:bigint = a * 2n;
  let c = b - a;
  const negative:boolean = c < 0n;
  if (negative) { const x = -c; return x; }
  { const c = 17n; if (x === 20n) return c; }
  return c;
}
contract(f,{ensures:(r,x)=>r>=0n && (x===20n || r===x+1n || r===-x-1n)});
function shadow(x:bigint):bigint {
  { const x = 2n; if (x > 5n) return x; }
  return x;
}
contract(shadow,{ensures:(r,x)=>r===x});`);
  expect((await verify(entry)).status).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [-1000000000000000000000000000n, -2n, -1n, 0n, 20n, 99999999999999999999999999n]) {
    expect(runtime.execute("f", [x])).toMatchObject({ result: x === 20n ? 17n : x < -1n ? -x-1n : x+1n, ensures: true });
    expect(runtime.execute("shadow", [x]).result).toBe(x);
  }
  expect((await checkProperties(runtime, {seed: 42, numRuns: 20})).every(r => r.status === "passed")).toBe(true);
});

test("number and string locals preserve binary64, global shadowing and UTF-16", async () => {
  const entry = fixture("numbers-strings", `
function f(x:number):number { const Infinity = x, NaN = Infinity; let y:number = NaN; return y; }
contract(f,{ensures:(r,x)=>(r===x || (r!==r && x!==x))});
function zero():number { const z = -0; return 1/z; }
contract(zero,{ensures:r=>r===-Infinity});
function round():number { const x = 9007199254740992, y = x+1; return y-x; }
contract(round,{ensures:r=>r===0});
function text(s:string):string { const suffix = "😀", joined:string = s+suffix; return joined; }
contract(text,{ensures:(r,s)=>r===s+"😀"});
function length(s:string):number { const joined = s+"😀", n = joined.length; return n; }
contract(length,{requires:s=>s==="\\ud800",ensures:r=>r===3});`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE])
    expect(Object.is(runtime.execute("f", [x]).result, x)).toBe(true);
  expect(runtime.execute("zero", []).result).toBe(-Infinity);
  expect(runtime.execute("round", []).result).toBe(0);
  expect(runtime.execute("text", ["\ud800"]).result).toBe("\ud800😀");
  expect(runtime.execute("length", ["\ud800"]).result).toBe(3);
});

test("switch locals preserve fallthrough, nested breaks and call identities", async () => {
  const entry = fixture("switch-calls", `
function positive(x:bigint):bigint { return x; }
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>r===x});
function f(x:bigint):bigint {
  const next = x + 1n;
  switch(x) {
    case -1n: { const next = 0n; if (next===0n) break; }
    case 0n: const value = next; return positive(value);
    case 1n: { const local = next; switch(local) { case 2n: break; default: return 0n; } }
    default: { const below = next<=0n; if (below) return 0n; }
  }
  if (next<=0n) return 0n;
  return positive(next);
}
contract(f,{ensures:r=>r>=0n});`);
  const ir = adapt(entry);
  expect(ir.coverage.calls).toHaveLength(2);
  const paths = callPaths(ir.functions.find(f => f.name === "f")!.body);
  expect(paths.length).toBeGreaterThan(2);
  expect(new Set(paths.map(p => p.call.id)).size).toBe(2);
  for (const {call} of paths)
    expect(paths.filter(p => p.call.id===call.id).every(p => JSON.stringify(p.call)===JSON.stringify(call))).toBe(true);
  expect((await verify(entry)).status).toBe("verified");
  const runtime = createTestRuntime(entry);
  expect(runtime.sites).toHaveLength(2);
  for (const x of [-3n, -1n, 0n, 1n, 2n]) {
    const execution = runtime.execute("f", [x]);
    expect(execution.result).toBe(x<0n ? 0n : x+1n);
    expect(execution.calls.every(c => c.accepted)).toBe(true);
  }
});

test("initializer division is checked before later guards, even for unused locals", async () => {
  const entry = fixture("eager", `
function early(x:bigint,y:bigint):bigint { const q=x/y; if(y===0n)return 0n; return q; }
contract(early,{ensures:(r,x,y)=>y===0n || r===x/y});
function unused(x:bigint,y:bigint):bigint { const q=x/y; return 0n; }
contract(unused,{ensures:r=>r===0n});
function safe(x:bigint,y:bigint):bigint { if(y===0n)return 0n; const q=x/y; return q; }
contract(safe,{ensures:(r,x,y)=>y===0n || r===x/y});
function required(x:bigint,y:bigint):bigint { const q=x/y; return q; }
contract(required,{requires:(x,y)=>y!==0n,ensures:(r,x,y)=>r===x/y});
function short(x:bigint,y:bigint):bigint { const positive=y!==0n && x/y>0n; if(positive)return 1n;return 0n; }
contract(short,{ensures:r=>r>=0n});
function accept(x:bigint):bigint { return x; }
contract(accept,{requires:x=>x>=0n,ensures:(r,x)=>r===x});
function callEarly(x:bigint,y:bigint):bigint { const q=x/y; if(y===0n)return 0n; return accept(0n); }
function callSafe(x:bigint,y:bigint):bigint { if(y===0n)return 0n; const q=x/y; return accept(0n); }`);
  const report = await verify(entry);
  for (const result of report.results) {
    if (["early", "unused", "callEarly"].includes(result.function))
      expect(result).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency",reason:expect.stringContaining("zero divisor")});
    else expect(["proved", "satisfiable"], JSON.stringify(result)).toContain(result.status);
  }
  const runtime = createTestRuntime(entry);
  for (const name of ["early", "unused", "callEarly"]) expect(() => runtime.execute(name,[1n,0n])).toThrow();
  for (const name of ["safe", "callSafe"]) expect(runtime.execute(name,[1n,0n]).result).toBe(0n);
});

test("unsupported local dependencies keep locations and independent predicates", async () => {
  const entry = fixture("selective", `
function f(x:bigint):bigint { const rem=x%2n; return rem; }
contract(f,{requires:x=>x>=0n,ensures:r=>r>=0n});
function independent(x:bigint,flag:boolean):bigint { const copy=flag; const rem=x%2n; return rem; }
contract(independent,{requires:x=>x>=0n,ensures:(r,x)=>x>=0n});
function opaque(x:bigint,flag:boolean):bigint { const copy=flag; if(copy)return x; return 0n; }
contract(opaque,{ensures:r=>r>=0n});`);
  const report = await verify(entry);
  const failure = report.results.find(r => r.function === "f" && r.kind === "implementation");
  expect(failure).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency",dependencySource:{file:entry}});
  if (!failure || !("dependencySource" in failure) || !failure.dependencySource) throw new Error("missing dependency");
  const source = fs.readFileSync(entry,"utf8");
  expect(source.slice(failure.dependencySource.start,failure.dependencySource.end)).toBe("x%2n");
  expect(report.results.filter(r => r.function==="independent").every(r => ["proved","satisfiable"].includes(r.status))).toBe(true);
  expect(report.results.find(r => r.function==="opaque")).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
  expect(() => createTestRuntime(entry)).toThrow(/Unsupported test runtime graph/);
});

test("unsupported declaration forms, effects and scope escapes are rejected", () => {
  const unsupported = [
    "var y=x; return y;", "let y:bigint; return x;", "let y=x; y%=2n; return y;",
    "let y=x; y**=2n; return y;", "let y=x; y++; return y;", "let y=x; return ++y;",
    "const {a}=x; return a;", "const [a]=x; return a;", "const y=x.a; return 0n;",
    "const y=x[0]; return 0n;", "const y=callee(1n); return y;", "const y=true?1n:2n;return y;",
    "using y=null; return x;",
  ];
  for (const [index,body] of unsupported.entries()) {
    const param = index===6 || index===8 ? "{a:bigint}" : index===7 || index===9 ? "bigint[]" : "bigint";
    const entry=fixture("reject-"+index, `function callee(x:bigint):bigint{return x;}
contract(callee,{ensures:(r,x)=>r===x});
function f(x:${param}):bigint { ${body} }
contract(f,{ensures:()=>true});`);
    expect(() => adapt(entry), body).toThrow(expect.objectContaining({reasonCode:"unsupported-code"}));
  }
  for (const [index,body] of [
    "return y; const y=x;", "{ const y=x; } return y;", "const y=y+1n; return y;",
    "const y:bigint=1; return y;", "switch(x){case 0n:const y=1n;case 1n:return y;}return x;",
  ].entries()) {
    const entry=fixture("type-error-"+index, `function f(x:bigint):bigint{${body}}contract(f,{ensures:()=>true});`);
    expect(() => adapt(entry)).toThrow(expect.objectContaining({reasonCode:"type-error"}));
  }
  // Unions with undefined pass TS definite assignment, but a direct case entry skips initialization.
  const cross=fixture("cross-clause", `function f(x:bigint):bigint {
switch(x){case 0n:const ok:boolean|undefined=true;case 1n:if(ok===true)return 1n;}return 0n;}
contract(f,{ensures:()=>true});`);
  expect(() => adapt(cross)).toThrow(/free identifier/);
});

test("IR rejects corrupted initializer sequences and preserves call coverage", () => {
  const entry=fixture("ir", `function f(x:bigint):bigint{const y=x+1n;return y;}
contract(f,{ensures:(r,x)=>r>x});`);
  const ir=adapt(entry);
  const body=ir.functions[0].body;
  expect(prettyExpr(body)).toBe("((x + 1n), (x + 1n))");
  if(body.kind!=="sequence") throw new Error("missing sequence");
  body.first={kind:"ident",name:"unbound"};
  ir.coverage.inventory=sourceInventory(ir);
  expect(()=>validateIR(ir)).toThrow(/unbound identifier/);
  const dropped=adapt(entry);
  if(dropped.functions[0].body.kind!=="sequence") throw new Error("missing sequence");
  dropped.functions[0].body=dropped.functions[0].body.then;
  expect(()=>validateIR(dropped)).toThrow(/source inventory coverage changed/);
  const invalid=adapt(entry);
  invalid.functions[0].contracts[0].predicate={kind:"sequence",first:{kind:"literal",value:true},then:{kind:"literal",value:true}};
  invalid.coverage.inventory=sourceInventory(invalid);
  expect(()=>validateIR(invalid)).toThrow(/sequence outside function body/);
  const dead=fixture("dead-call", `function g(x:bigint):bigint{return x;}contract(g,{ensures:(r,x)=>r===x});
function f(x:bigint):bigint{const y=x;return y;return g(y);}contract(f,{ensures:(r,x)=>r===x});`);
  expect(()=>adapt(dead)).toThrow(/call coverage changed/);
});

test("local values produce replayable implementation and call counterexamples", async () => {
  const entry=fixture("regressions", `
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>r===x});
function f(x:bigint):bigint{const wrong=x-1n;return wrong;}
contract(f,{ensures:(r,x)=>r>x});
function caller(x:bigint):bigint{const arg=x;return positive(arg);}`);
  expect((await verify(entry)).status).toBe("refuted");
  const generated=await generateRegressions(entry,path.join(path.dirname(entry),"generated"));
  const {manifest}=loadRegressions(generated.manifestFile);
  expect(manifest.cases.map(c=>c.kind).sort()).toEqual(["call","implementation"]);
  const runtime=createTestRuntime(entry);
  for(const regression of manifest.cases) expect(replayRegression(runtime,entry,regression).status).toBe("failed");
});
