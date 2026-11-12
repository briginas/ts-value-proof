import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { adapt } from "./adapter.ts";
import { verify, type VerificationReport } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { decodeNumber, encodeNumber } from "./numeric-values.ts";
import { validateIR } from "./ir-integrity.ts";
import { assertReportDiagnostics } from "./check-diagnostics.ts";
import { nextNumber, numberPool } from "./number-inputs.ts";

const directory = path.resolve("work/number-source");
fs.mkdirSync(directory,{recursive:true});
const prefix = 'import { contract } from "../../src/contract.js";\n';
function fixture(name: string, text: string) {
  const file=path.join(directory,name+".ts"); fs.writeFileSync(file,prefix+text); return file;
}
const identity = `function f(x: number): number { return x; }
contract(f,{requires:x=>x===x,ensures:(r,x)=>r===x});`;
async function report(name: string, text: string) {
  const r=await verify(fixture(name,text)); assert.equal(r.semantics,"number-ieee754-binary64");
  assertReportDiagnostics(r); return r;
}
const implementations = (r: VerificationReport) => r.results.filter(r=>r.kind==="implementation");
const literals: [string,number][] = [["9007199254740993",9007199254740992],["5e-324",Number.MIN_VALUE],
  ["1e309",Infinity],["1e-999",0],["-0",-0],["0b1010_0101",165],["0o7_7",63],["0xff_ff",65535],
  ["1_234.5e-1",123.45],["NaN",NaN],["Infinity",Infinity],["-Infinity",-Infinity]];
const literalFile=fixture("literals",literals.map(([literal],i)=>
  `function f${i}(): number { return ${literal}; }\ncontract(f${i},{requires:()=>true,ensures:()=>true});`).join("\n"));
const literalRuntime=createTestRuntime(literalFile);
for (const [i,[,expected]] of literals.entries()) {
  const body=literalRuntime.ir.functions[i].body;
  const value=body.kind==="unary" && body.operand.kind==="number" ? -decodeNumber(body.operand.value)
    : body.kind==="number" ? decodeNumber(body.value) : assert.fail("number literal expected");
  assert(Object.is(value,expected));
  assert(Object.is(literalRuntime.execute("f"+i,[]).result,expected));
}
assert.equal((await verify(literalFile)).status,"verified");
const shadow=fixture("shadow",`function f(Infinity: number, NaN: number): number { return Infinity - NaN; }
contract(f,{requires:(NaN,Infinity)=>NaN===0 && Infinity===1,ensures:r=>r===-1});`);
assert.equal((await verify(shadow)).status,"verified");
assert.equal(createTestRuntime(shadow).execute("f",[0,1]).result,-1);
assert.equal((await report("positive",identity)).status,"verified");
const nan = await report("nan-identity",identity.replace('x=>x===x','()=>true').replaceAll('x:', '__proto__:').replace('return x','return __proto__'));
assert.equal(nan.status,"refuted");
const violation=implementations(nan)[0];
assert(violation.status==="disproved");
const transported=JSON.parse(JSON.stringify(violation.counterexample));
assert(Object.hasOwn(transported,"__proto__") && Number.isNaN(decodeNumber(transported.__proto__)));
const loss=await report("precision",`function f(x:number):number { return x+1; }
contract(f,{requires:x=>x===9007199254740992,ensures:(r,x)=>r>x});`);
assert.equal(loss.status,"refuted");
const lossResult=implementations(loss)[0];
assert(lossResult.status==="disproved" && decodeNumber(lossResult.counterexample.x)===2**53);
const fractional=await report("fractional",`function f():number { return 0.1+0.2; }
contract(f,{requires:()=>true,ensures:r=>r===0.3});`);
assert.equal(fractional.status,"refuted");
assert.equal(implementations(fractional)[0].status,"disproved");
const inconsistent=await report("inconsistent",identity.replace('x=>x===x','x=>x<0 && x>=0'));
assert.equal(inconsistent.status,"inconsistent");
assert.deepEqual(inconsistent.results.map(r=>r.status),["inconsistent"]);
const zeros=await report("zeros",identity.replace('x=>x===x','x=>x===0').replace('r===x','r===-0'));
assert.equal(zeros.status,"verified");
assert(implementations(zeros)[0].condition.includes('-0'));
const guard=await report("guard",`function positive(x:number):number {return x;}
contract(positive,{requires:x=>x>=0,ensures:(r,x)=>r===x});
function caller(x:number):number {if(x<0)return 0;return positive(x);}`);
assert.equal(guard.status,"refuted");
const call=guard.results.find(r=>r.kind==="call");
assert(call?.status==="disproved" && Number.isNaN(decodeNumber(call.counterexample.x)));
const paths=await report("paths",`function positive(x:number):number {return x;}
contract(positive,{requires:x=>x>=0,ensures:(r,x)=>r===x});
function caller(x:number):number {if(x>=0){if(x>1)return 0;}else{if(x<0)return 0;}return positive(x);}`);
const calls=paths.results.filter(r=>r.kind==="call");
assert.deepEqual(calls.map(r=>r.status),["proved","disproved"]);
assert(calls[0].kind==="call" && calls[1].kind==="call" && calls[0].callId===calls[1].callId && calls[0].pathCondition!==calls[1].pathCondition);
const weak=await report("weak",`function f(x:number):number {return x;}
contract(f,{requires:x=>x>=0 && x<Infinity,ensures:r=>r>=0});
function caller(x:number):number {return f(x);}
contract(caller,{requires:x=>x>=0 && x<Infinity,ensures:(r,x)=>r===x});`);
assert.equal(weak.status,"unknown");
assert.deepEqual(weak.results.map(r=>r.status),["satisfiable","proved","satisfiable","proved","unknown"]);
assert(weak.results.some(r=>r.status==="unknown" && r.reasonCode==="weak-callee-contract" && !("counterexample" in r)));
const badCallee=await report("bad-callee",`function f(x:number):number {return 0;}
contract(f,{requires:x=>x===1,ensures:r=>r===1});
function caller(x:number):number {return f(x);}
contract(caller,{requires:x=>x===1,ensures:r=>r===1});`);
assert.equal(badCallee.status,"refuted");
assert.deepEqual(badCallee.results.map(r=>r.status),["satisfiable","disproved","satisfiable","proved","proved"]);
const limited=await verify(fixture("limits",identity),{resourceLimit:1});
assert.equal(limited.status,"unknown");
assert(limited.results.some(r=>r.status==="unknown" && r.reasonCode==="solver-unknown" && r.reason));
for(const op of ['*','/','%','**','|','==']) {
  const file=fixture("operator-"+op.charCodeAt(0),identity.replace('return x;',op==='=='?'if(x==0)return 1;return 0;':`return x ${op} 1;`));
  assert.equal((await verify(file)).status,"unknown");
}
for(const expression of ['Number(x)','Math.abs(x)','Object.is(x,0) ? 0 : x'])
  assert.throws(()=>adapt(fixture('unsupported-'+expression.length,identity.replace('return x;',`return ${expression};`))),/Unsupported/);
assert.throws(()=>adapt(fixture("truthiness",identity.replace('return x;','if(x)return 0;return 1;'))),/boolean/);
const mixed=fixture("mixed",identity+'\nfunction other():bigint{return 0n;} contract(other,{ensures:r=>r===0n});');
const mixedReport=await verify(mixed);
assert.equal(mixedReport.status,"unknown"); assert.equal(mixedReport.reasonCode,"unsupported-numeric-model");
assert.deepEqual(mixedReport.results,[]);
assert.throws(()=>createTestRuntime(mixed),/Mixed/);
const broken=structuredClone(adapt(path.join(directory,"guard.ts")));
const body=broken.functions[1].body;
assert(body.kind==="ternary" && body.else.kind==="call");
body.else.args=[{kind:"bigint",value:"0"}];
assert.throws(()=>validateIR(broken),/Invalid IR/);

for(const value of [0,-0,Number.MIN_VALUE,2**-1022,2**53,Number.MAX_VALUE,Infinity,-Infinity]) {
  const next=nextNumber(value,1), previous=nextNumber(value,-1);
  assert(next>value || value===Infinity);
  assert(previous<value || value===-Infinity);
  if (Number.isFinite(value) && value!==0) {
    assert.equal(nextNumber(next,-1),value);
    assert.equal(nextNumber(previous,1),value);
  }
}
assert(Object.is(nextNumber(-Number.MIN_VALUE,1),-0));
assert(Object.is(nextNumber(Number.MIN_VALUE,-1),0));
assert.equal(nextNumber(0.1,1),0.10000000000000002);
assert.equal(nextNumber(0.1,-1),0.09999999999999999);
const pool=numberPool(adapt(fixture("pool",identity.replace('x=>x===x','x=>x===0.1'))).functions[0]);
for(const value of [0,-0,NaN,Infinity,-Infinity,0.1,nextNumber(0.1,1),nextNumber(0.1,-1)])
  assert(pool.some(n=>Object.is(n,value)));
for (const [file,code] of [[mixed,2],[path.join(directory,'operator-42.ts'),2],['examples/number-identity.ts',0]] as const) {
  const run=spawnSync(process.execPath,['scripts/verify.ts',file],{encoding:'utf8',timeout:20000});
  assert.equal(run.status,code,run.stdout+run.stderr);
  assert.deepEqual(JSON.parse(run.stdout),JSON.parse(fs.readFileSync('work/verification.json','utf8')));
}
console.log("Number source: literals, symbols, VC paths, statuses, diagnostics, unsupported code, neighbours and CLI passed");
process.exit(0);
