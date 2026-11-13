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
  const directory = path.resolve("work/assignments", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("assignments preserve snapshots, self references and original contract arguments", async () => {
  const entry = fixture("snapshots", `
function f(x:bigint):bigint {
  let y=x; const saved=y;
  y+=1n; (x=9n); y=y+y; y-=saved; y*=3n; y/=3n;
  return y;
}
contract(f,{ensures:(r,x)=>r===x+2n});
function parameter(x:bigint):bigint { const saved=x; x+=1n; return x-saved; }
contract(parameter,{ensures:r=>r===1n});
function shape(x:bigint):bigint { let y=x; y+=1n; return y; }
contract(shape,{ensures:(r,x)=>r===x+1n});
function quotient(x:bigint):bigint { x/=2n; return x; }
contract(quotient,{ensures:(r,x)=>r===x/2n});`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  expect(prettyExpr(runtime.ir.functions.find(f=>f.name==="shape")!.body)).toBe("(x, ((x + 1n), (x + 1n)))");
  for (const x of [-999999999999999999999999n, -3n, 0n, 3n, 999999999999999999999999n]) {
    expect(runtime.execute("f", [x])).toMatchObject({result:x+2n, ensures:true});
    expect(runtime.execute("parameter", [x]).result).toBe(1n);
    expect(runtime.execute("quotient", [x]).result).toBe(x/2n);
  }
  expect((await checkProperties(runtime,{seed:42,numRuns:30})).every(r=>r.status==="passed")).toBe(true);
});

test("block writes escape their block while shadowing and early returns stay independent", async () => {
  const entry = fixture("branches", `
function f(x:bigint):bigint {
  let y=x;
  { y+=1n; { let y=50n; y+=10n; if(x===50n)return y; } }
  if(x<0n) { y=-y; if(x===-1n)return y; } else y+=2n;
  if(y<0n)y=0n;
  return y;
}
contract(f,{ensures:(r,x)=>(x===50n && r===60n) || (x<0n && r===-x-1n) || (x>=0n && x!==50n && r===x+3n)});
function boolean(x:bigint):bigint { let positive=x>0n; positive=!positive; if(positive)return 0n;return 1n; }
contract(boolean,{ensures:(r,x)=>(x>0n && r===1n) || (x<=0n && r===0n)});`);
  expect((await verify(entry)).status).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [-10n,-1n,0n,1n,50n,51n]) {
    expect(runtime.execute("f",[x])).toMatchObject({result:x===50n?60n:x<0n?-x-1n:x+3n,ensures:true});
    expect(runtime.execute("boolean",[x]).ensures).toBe(true);
  }
});

test("switch writes preserve selector snapshots, fallthrough, defaults and nearest break", async () => {
  const entry = fixture("switch", `
function f(x:bigint):bigint {
  let y=0n; let label=1n;
  switch(x) {
    case 0n: x=10n; label=10n; y=1n;
    case label: y+=2n;
      switch(x) { case 10n: y+=4n; break; default: y+=8n; }
      if(y===7n)break;
      y+=16n; break;
    default: y=32n;
    case 2n: y+=64n;
  }
  return y;
}
contract(f,{ensures:(r,x)=>(x===0n && r===7n) || (x===1n && r===26n) || (x===2n && r===64n) || (x!==0n && x!==1n && x!==2n && r===96n)});
function noDefault(x:bigint):bigint { let y=x; switch(x){case 0n:y=1n;break;case 1n:y=2n;}return y; }
contract(noDefault,{ensures:(r,x)=>(x===0n && r===1n) || (x===1n && r===2n) || (x!==0n && x!==1n && r===x)});`);
  const report = await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [-1n,0n,1n,2n,10n]) {
    expect(runtime.execute("f",[x])).toMatchObject({result:x===0n?7n:x===1n?26n:x===2n?64n:96n,ensures:true});
    expect(runtime.execute("noDefault",[x]).ensures).toBe(true);
  }
});

test("compound number assignments preserve binary64 and string assignments preserve UTF-16", async () => {
  const entry = fixture("numbers-strings", `
function round():number { let x=9007199254740992; x+=1; x-=9007199254740992; return x; }
contract(round,{ensures:r=>r===0});
function zero():number { let x=0; x*=-1; x/=2; return 1/x; }
contract(zero,{ensures:r=>r===-Infinity});
function nan():number { let x=Infinity; x-=Infinity; return x; }
contract(nan,{ensures:r=>r!==r});
function overflow():number { let x=1e308; x*=2; return x; }
contract(overflow,{ensures:r=>r===Infinity});
function tiny():number { let x=-5e-324; x/=2; return 1/x; }
contract(tiny,{ensures:r=>r===-Infinity});
function identity(x:number):number { let NaN=x; let Infinity=NaN; Infinity=x; x=0; NaN=Infinity; return NaN; }
contract(identity,{ensures:(r,x)=>r===x || (r!==r && x!==x)});
function text(s:string):string { let t=s; const saved=t; s="!"; t+="😀"; t=t+s; return t+saved; }
contract(text,{ensures:(r,s)=>r===s+"😀!"+s});
function length(s:string):number { let n=0; n=s.length; n+=2; return n; }
contract(length,{requires:s=>s==="\\ud800",ensures:r=>r===3});`);
  const report = await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("verified");
  const runtime=createTestRuntime(entry);
  for (const [name,result] of [["round",0],["zero",-Infinity],["nan",NaN],["overflow",Infinity],["tiny",-Infinity]] as const)
    expect(Object.is(runtime.execute(name,[]).result,result)).toBe(true);
  for(const x of [NaN,Infinity,-Infinity,-0,0,Number.MIN_VALUE])
    expect(Object.is(runtime.execute("identity",[x]).result,x)).toBe(true);
  expect(runtime.execute("text",["\ud800"]).result).toBe("\ud800😀!\ud800");
  expect(runtime.execute("length",["\ud800"]).result).toBe(3);
});

test("shared calls keep their identity with path-specific argument values", async () => {
  const entry=fixture("calls", `
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>r===x});
function other(x:bigint):bigint{return x;}
contract(other,{ensures:(r,x)=>r===x});
function f(x:bigint):bigint { let y=x; if(y<=0n)y=1n; switch(x){case 2n:y+=1n;case 3n:y+=2n;break;} return positive(y); }
contract(f,{ensures:r=>r>0n});`);
  const ir=adapt(entry);
  const paths=callPaths(ir.functions.find(f=>f.name==="f")!.body);
  expect(ir.coverage.calls).toHaveLength(1);
  expect(new Set(paths.map(p=>p.call.id)).size).toBe(1);
  expect(new Set(paths.map(p=>prettyExpr(p.call.args[0]))).size).toBeGreaterThan(1);
  expect((await verify(entry)).status).toBe("verified");
  const runtime=createTestRuntime(entry);
  expect(runtime.sites).toHaveLength(1);
  for(const x of [-1n,0n,1n,2n,3n,4n]) {
    const execution=runtime.execute("f",[x]);
    expect(execution.calls).toHaveLength(1);
    expect(execution.calls[0]).toMatchObject({accepted:true,args:[x<=0n?1n:x===2n?5n:x===3n?5n:x]});
  }
  const changedArgument=structuredClone(ir);
  callPaths(changedArgument.functions.find(f=>f.name==="f")!.body)[0].call.args=[{kind:"bigint",value:"0"}];
  expect(()=>validateIR(changedArgument)).toThrow(/source inventory/);
  paths[0].call.callee="other";
  ir.coverage.inventory=sourceInventory(ir);
  expect(()=>validateIR(ir)).toThrow(/conflicting call identity/);
});

test("overwritten assignments still check eager evaluation before later guards and calls", async () => {
  const entry=fixture("eager", `
function early(x:bigint,d:bigint):bigint { let y=x; y/=d; y=1n; if(d===0n)return 0n;return y; }
contract(early,{ensures:r=>r>=0n});
function safe(x:bigint,d:bigint):bigint { let y=x;if(d===0n)return 0n;y/=d;return y; }
contract(safe,{ensures:(r,x,d)=>d===0n || r===x/d});
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>r===x});
function callEarly(x:bigint,d:bigint):bigint { let y=x;y=x/d;y=1n;if(d===0n)return 0n;return positive(y); }
function callSafe(x:bigint,d:bigint):bigint { if(d===0n)return 0n;let y=x;y/=d;y=1n;return positive(y); }`);
  const report=await verify(entry);
  for(const result of report.results) {
    if(["early","callEarly"].includes(result.function))
      expect(result).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency",reason:expect.stringContaining("zero divisor")});
    else expect(["proved","satisfiable"],JSON.stringify(result)).toContain(result.status);
  }
  const runtime=createTestRuntime(entry);
  expect(()=>runtime.execute("early",[1n,0n])).toThrow();
  expect(runtime.execute("safe",[1n,0n]).result).toBe(0n);
});

test("unsupported RHS dependencies retain positions and independent input predicates", async () => {
  const entry=fixture("selective", `
function f(x:bigint):bigint{let y=0n;y=x%2n;y=1n;return y;}
contract(f,{requires:x=>x>=0n,ensures:r=>r>=0n});
function independent(x:bigint):bigint{let y=0n;y=x%2n;x=0n;return y;}
contract(independent,{requires:x=>x>=0n,ensures:(r,x)=>x>=0n});`);
  const report=await verify(entry);
  const failure=report.results.find(r=>r.function==="f" && r.kind==="implementation");
  expect(failure).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency",dependencySource:{file:entry}});
  if(!failure || !("dependencySource" in failure) || !failure.dependencySource)throw new Error("missing source");
  const {start,end}=failure.dependencySource;
  expect(fs.readFileSync(entry,"utf8").slice(start,end)).toBe("x%2n");
  expect(report.results.filter(r=>r.function==="independent").every(r=>["proved","satisfiable"].includes(r.status))).toBe(true);
  const mixed=fixture("coercion", `function f(s:string):string{s+=1;return s;}contract(f,{ensures:r=>r==="1"});`);
  expect((await verify(mixed)).results[0]).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
});

test("unsupported assignment contexts and targets are rejected before solving", () => {
  const bodies=[
    "x%=2n;", "x**=2n;", "x&=1n;", "x|=1n;", "x^=1n;", "x<<=1n;", "x>>=1n;",
    "x||=1n;", "x&&=1n;", "x??=1n;", "x++;", "--x;", "x=callee(x);",
    "let y=x; x=y=1n;", "let y=(x=1n);", "return x=1n;", "if((x=1n)>0n)return x;",
    "switch(x=1n){case 1n:break;}", "switch(x){case x=1n:break;}", "[x]=[1n];",
    "({x}={x:1n});", "return callee(x=1n);",
  ];
  for(const [i,body] of bodies.entries()) {
    const entry=fixture("reject-"+i, `function callee(x:bigint):bigint{return x;}contract(callee,{ensures:r=>r>0n});
function f(x:bigint):bigint{${body}return x;}contract(f,{ensures:()=>true});`);
    expect(()=>adapt(entry),body).toThrow(expect.objectContaining({reasonCode:"unsupported-code"}));
  }
  for(const [i,[param,body]] of [
    ["{a:bigint}","x.a=1n;"], ["bigint[]","x[0]=1n;"],
    ["{a:bigint}","let y=0n;y=x.a;"], ["bigint[]","let y=0n;y=x[0];"],
  ].entries()) {
    const entry=fixture("property-"+i, `function f(x:${param}):bigint{${body}return 0n;}contract(f,{ensures:()=>true});`);
    expect(()=>adapt(entry)).toThrow(expect.objectContaining({reasonCode:"unsupported-code"}));
  }
  for(const [i,body] of ["const y=x;y=1n;","x=1;","y=x;","{let y=x;}y=1n;"].entries()) {
    const entry=fixture("type-"+i, `function f(x:bigint):bigint{${body}return x;}contract(f,{ensures:()=>true});`);
    expect(()=>adapt(entry)).toThrow(expect.objectContaining({reasonCode:"type-error"}));
  }
});

test("assignment implementation and call counterexamples replay against original source", async () => {
  const entry=fixture("replay", `
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>r===x});
function f(x:bigint):bigint{x-=1n;return x;}
contract(f,{ensures:(r,x)=>r>x});
function caller(x:bigint):bigint{if(x>0n)x=0n;else x=-1n;return positive(x);}`);
  expect((await verify(entry)).status).toBe("refuted");
  const generated=await generateRegressions(entry,path.join(path.dirname(entry),"generated"));
  const {manifest}=loadRegressions(generated.manifestFile);
  expect(new Set(manifest.cases.map(c=>c.kind))).toEqual(new Set(["implementation","call"]));
  const runtime=createTestRuntime(entry);
  for(const regression of manifest.cases)expect(replayRegression(runtime,entry,regression).status).toBe("failed");
});
