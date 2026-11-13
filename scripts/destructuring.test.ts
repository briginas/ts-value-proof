import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { callPaths } from "./dependencies.ts";
import { validateIR } from "./ir-integrity.ts";
import { verify } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/destructuring", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("nested declarations, shorthand, keys, shadowing and mutable binding elements", async () => {
  const entry = fixture("bindings", `
function f(x:bigint):bigint {
  const {pair:[a,{value:b}], "quoted-key":c, 0:d} = {pair:[x,{value:x+1n}], "quoted-key":2n, 0:3n};
  let {a:local}={a}; local+=b;
  let [next]=[local]; next+=c+d;
  { const {x}={x:next}; if(x===6n)return x; }
  const {x:copy}={x};
  return next-copy;
}
contract(f,{ensures:(r,x)=>r===x+6n});
function names(x:bigint):bigint {let {x:NaN}={x}; ({NaN}={NaN:NaN+1n});return NaN;}
contract(names,{ensures:(r,x)=>r===x+1n});`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [-99999999999999999999n,-1n,0n,1n,99999999999999999999n]) {
    expect(runtime.execute("f",[x])).toMatchObject({result:x+6n, ensures:true});
    expect(runtime.execute("names",[x])).toMatchObject({result:x+1n, ensures:true});
  }
  expect((await checkProperties(runtime,{seed:42,numRuns:20})).every(r=>r.status==="passed")).toBe(true);
});

test("assignments snapshot all RHS values before writes and defaults see earlier targets", async () => {
  const entry = fixture("snapshots", `
function swap(x:bigint,y:bigint):bigint {let [a,b]=[x,y];[a,b]=[b,a];return a-b;}
contract(swap,{ensures:(r,x,y)=>r===y-x});
function defaults(x:bigint):bigint {
  let a=0n,b=0n; [a,b=a]=[x,undefined];
  ({a, b:a}={a:b+1n,b:a+2n});
  return a;
}
contract(defaults,{ensures:(r,x)=>r===x+2n});
function parameters(x:bigint,y:bigint):bigint {({a:x,b:y}={a:y,b:x});return x-y;}
contract(parameters,{ensures:(r,x,y)=>r===y-x});
function repeated(x:bigint):bigint {let a=x;[a,a=a+1n]=[x+2n,undefined];return a;}
contract(repeated,{ensures:(r,x)=>r===x+3n});
function nested(x:bigint):bigint {
  const [a=x,,b=a+1n]=[,x,undefined];
  const {item:{value:c}={value:b+1n}}={item:undefined};
  let d=0n; ({item:{value:d}={value:c+1n}}={item:undefined});
  return d;
}
contract(nested,{ensures:(r,x)=>r===x+3n});
function absent(x:bigint):bigint {const {a=x}: {a?:bigint}={}; return a;}
contract(absent,{ensures:(r,x)=>r===x});
function shadow(undefined:bigint):bigint {const [a=1n]=[undefined];return a;}
contract(shadow,{ensures:(r,x)=>r===x});
function keys(x:bigint):bigint {const {constructor:a, toString:b, 0x10:c}={constructor:x,toString:x+1n,16:x+2n};return a+b+c;}
contract(keys,{ensures:(r,x)=>r===x+x+x+3n});
function shorthandDefault(x:bigint):bigint {let a=0n;({a=x}={a:undefined});return a;}
contract(shorthandDefault,{ensures:(r,x)=>r===x});`);
  const report = await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for(const x of [-2n,0n,3n]) {
    for(const name of ["swap","parameters"]) expect(runtime.execute(name,[x,7n]).result).toBe(7n-x);
    expect(runtime.execute("defaults",[x]).result).toBe(x+2n);
    for(const name of ["repeated","nested"]) expect(runtime.execute(name,[x]).result).toBe(x+3n);
    expect(runtime.execute("absent",[x]).result).toBe(x);
    expect(runtime.execute("shadow",[x]).result).toBe(x);
    expect(runtime.execute("keys",[x]).result).toBe(x+x+x+3n);
    expect(runtime.execute("shorthandDefault",[x]).result).toBe(x);
  }
});

test("binary64 and UTF-16 leaves preserve exact runtime values", async () => {
  const entry=fixture("models", `
function number(x:number):number {let [a,b]=[x,-0];[a,b]=[b,a];return b;}
contract(number,{ensures:(r,x)=>r===x || (r!==r && x!==x)});
function zero():number {const {x=-0}={x:undefined};return 1/x;}
contract(zero,{ensures:r=>r===-Infinity});
function text(s:string):string {const {a:[value]}={a:[s+"😀"]};return value;}
contract(text,{ensures:(r,s)=>r===s+"😀"});
function boolean(x:number):number {const [yes]=[x===0];if(yes)return 0;return 1;}
contract(boolean,{ensures:(r,x)=>x===0 ? r===0 : r===1});
function globalShorthand():number {const {NaN:a,Infinity:b}={NaN,Infinity};return a+b;}
contract(globalShorthand,{ensures:r=>r!==r});`);
  const report=await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("verified");
  const runtime=createTestRuntime(entry);
  for(const x of [NaN,Infinity,-Infinity,-0,0,Number.MIN_VALUE,9007199254740992])
    expect(Object.is(runtime.execute("number",[x]).result,x)).toBe(true);
  expect(runtime.execute("zero",[]).result).toBe(-Infinity);
  expect(runtime.execute("text",["\ud800"]).result).toBe("\ud800😀");
  expect(runtime.execute("globalShorthand",[]).result).toBeNaN();
});

test("eager unused RHS values and selected defaults retain division obligations", async () => {
  const entry=fixture("eager", `
function omitted(x:bigint,d:bigint):bigint {const [,a]=[x/d,x];if(d===0n)return 0n;return a;}
contract(omitted,{ensures:r=>r===r});
function unused(x:bigint,d:bigint):bigint {const {a}:{a:bigint;unused:bigint}={a:x,unused:x/d};return a;}
contract(unused,{ensures:r=>r===r});
function selected(x:bigint,d:bigint):bigint {const [a=x/d]=[undefined];return a;}
contract(selected,{ensures:r=>r===r});
function skipped(x:bigint,d:bigint):bigint {const [a=x/d]=[x];return a;}
contract(skipped,{ensures:(r,x)=>r===x});
function safe(x:bigint,d:bigint):bigint {if(d===0n)return 0n;const [a=x/d]=[undefined];return a;}
contract(safe,{ensures:(r,x,d)=>d===0n || r===x/d});
function independent(x:bigint,d:bigint):bigint {const [a=x/d]=[undefined];return a;}
contract(independent,{ensures:(r,x)=>x===x});
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n});
function caller(x:bigint,d:bigint):bigint {const [,a]=[x/d,1n];if(d===0n)return 0n;return positive(a);}`);
  const report=await verify(entry);
  for(const result of report.results) {
    if(["omitted","unused","selected","caller"].includes(result.function))
      expect(result).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency",reason:expect.stringContaining("zero divisor")});
    else expect(["proved","satisfiable"],JSON.stringify(result)).toContain(result.status);
  }
  const runtime=createTestRuntime(entry);
  for(const name of ["omitted","unused","selected","caller"])expect(()=>runtime.execute(name,[1n,0n])).toThrow();
  expect(runtime.execute("skipped",[1n,0n]).result).toBe(1n);
  expect(runtime.execute("safe",[1n,0n]).result).toBe(0n);
});

test("unsupported arithmetic keeps source positions and selective verification", async () => {
  const entry=fixture("dependencies", `
function f(x:bigint):bigint {const {a}:{a:bigint;unused:bigint}={a:x,unused:x%2n};return a;}
contract(f,{requires:x=>x>=0n,ensures:r=>r>=0n});
function independent(x:bigint):bigint {const [a]=[x%2n];return a;}
contract(independent,{ensures:(r,x)=>x===x});
function skipped(x:bigint):bigint {const [a=x%2n]=[x];return a;}
contract(skipped,{ensures:(r,x)=>r===x});`);
  const report=await verify(entry);
  const failure=report.results.find(r=>r.function==="f" && r.kind==="implementation");
  expect(failure).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency",dependencySource:{file:entry}});
  if(!failure || !("dependencySource" in failure) || !failure.dependencySource)throw new Error("missing source");
  expect(fs.readFileSync(entry,"utf8").slice(failure.dependencySource.start,failure.dependencySource.end)).toBe("x%2n");
  expect(report.results.filter(r=>r.function!=="f").every(r=>r.status==="proved")).toBe(true);
});

test("branches and switch fallthrough keep call paths and replayable counterexamples", async () => {
  const entry=fixture("paths", `
function positive(x:bigint):bigint{return x;}
contract(positive,{requires:x=>x>0n,ensures:(r,x)=>r===x});
function f(x:bigint):bigint {
  let [a,b]=[x,1n]; if(a<=0n)[a,b]=[b,a];
  switch(x){case 2n:({a}={a:a+1n});case 3n:[a]=[a+2n];break;default:break;}
  return positive(a);
}
contract(f,{ensures:r=>r>0n});
function wrong(x:bigint):bigint {const [a]=[x-1n];return a;}
contract(wrong,{ensures:(r,x)=>r>x});
function badCall(x:bigint):bigint {let [a]=[x];[a]=[0n];return positive(a);}`);
  const ir=adapt(entry);
  const paths=callPaths(ir.functions.find(f=>f.name==="f")!.body);
  expect(new Set(paths.map(p=>p.call.id)).size).toBe(1);
  expect(new Set(paths.map(p=>JSON.stringify(p.call.args))).size).toBeGreaterThan(1);
  const report=await verify(entry);
  expect(report.status).toBe("refuted");
  expect(report.results.filter(r=>r.function==="f").every(r=>["proved","satisfiable"].includes(r.status))).toBe(true);
  const runtime=createTestRuntime(entry);
  for(const x of [-1n,0n,1n,2n,3n,4n]) {
    const execution=runtime.execute("f",[x]);
    expect(execution).toMatchObject({result:x<=0n?1n:x===2n||x===3n?5n:x,ensures:true});
    expect(execution.calls).toHaveLength(1);
    expect(execution.calls[0].accepted).toBe(true);
  }
  const generated=await generateRegressions(entry,path.join(path.dirname(entry),"generated"));
  const {manifest}=loadRegressions(generated.manifestFile);
  expect(new Set(manifest.cases.map(c=>c.kind))).toEqual(new Set(["implementation","call"]));
  for(const regression of manifest.cases)expect(replayRegression(runtime,entry,regression).status).toBe("failed");
  const changed=structuredClone(ir);
  const body=changed.functions.find(f=>f.name==="wrong")!.body;
  if(body.kind!=="sequence")throw new Error("missing evaluation");
  changed.functions.find(f=>f.name==="wrong")!.body=body.then;
  expect(()=>validateIR(changed)).toThrow(/source inventory/);
});

test("unsupported patterns, sources and defaults fail closed even if unused", () => {
  const bodies=[
    "const [...a]=[x];", "const {a,...rest}={a:x,b:x};", "const [a]=[...[x]];",
    "const {a}={...{a:x}};", "const {[\"a\"]:a}={a:x};", "const {a}={[\"a\"]:x};",
    "const {a}={get a(){return x;}};", "const {a}={a(){return x;}};",
    "const [a]=[callee(x)];", "const [a=callee(x)]=[x];", "const [a=(x=1n)]=[x];",
    "const [a]=[undefined];", "const [a]=[[x]];", "const {a}= {a:{x}};",
    "const [a]=[x, {get value(){return x;}}];", "const [a]=[x,...[x]];",
    "let a=x;[...a]=[x];", "const [a=x]=[x,x=2n];",
    "const {a}:{a:bigint;__proto__:null}={a:x,__proto__:null};",
    "const {toString:a=callee(x)}={};",
    "const {toString:a}={};", "const {length:a}=[x];",
    "const values=[x];const [a]=values;",
    "let a=x; const {a:b}={a}; ({a:b}={a:callee(x)});",
  ];
  for(const [i,body] of bodies.entries()) {
    const entry=fixture("reject-"+i, `function callee(x:bigint):bigint{return x;}contract(callee,{ensures:()=>true});
function f(x:bigint):bigint{${body}return x;}contract(f,{ensures:()=>true});`);
    // Some malformed patterns are rejected earlier by TypeScript.
    expect(()=>adapt(entry),body).toThrow(expect.objectContaining({reasonCode:expect.stringMatching(/^(type-error|unsupported-code)$/)}));
  }
  for(const [i,[param,body]] of [
    ["{a:bigint}","const {a}=x;"], ["bigint[]","const [a]=x;"],
    ["{a:bigint}","[x.a]=[1n];"], ["bigint|undefined","const [a=1n]=[x];"],
  ].entries()) {
    const entry=fixture("source-"+i,`function f(x:${param}):bigint{${body}return 0n;}contract(f,{ensures:()=>true});`);
    expect(()=>adapt(entry)).toThrow(expect.objectContaining({reasonCode:"unsupported-code"}));
  }
  for(const [i,body] of [
    "const [a]=[x];[a]=[1n];", "let [a]=[x];[a]=[1];", "[a]=[x];",
    "const [a]=[a];", "const [a=b,b]=[undefined,x];", "{const [a]=[x];}return a;",
  ].entries()) {
    const entry=fixture("types-"+i,`function f(x:bigint):bigint{${body}return x;}contract(f,{ensures:()=>true});`);
    expect(()=>adapt(entry),body).toThrow(expect.objectContaining({reasonCode:"type-error"}));
  }
});
