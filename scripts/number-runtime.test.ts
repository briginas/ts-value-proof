import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, vi } from "vitest";
import { createTestRuntime } from "./test-runtime.ts";
import { generateRegressions, loadRegressions, replayRegression, type Regression } from "./regressions.ts";
import { checkProperties } from "./property-tests.ts";
import { decodeNumber, encodeNumber } from "./numeric-values.ts";

const prefix='import { contract } from "@api";\n';
function fixture(name:string, source:string, other:Record<string,string>={}) {
  const directory=path.resolve('work/number-runtime',name);
  fs.mkdirSync(directory,{recursive:true});
  for(const [file,text] of Object.entries({'entry.ts':source,...other})) {
    const target=path.join(directory,file);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const api=path.relative(path.dirname(target),path.resolve('src/contract.js')).split(path.sep).join('/');
    fs.writeFileSync(target,text.replaceAll('@api',api));
  }
  return {directory,entry:path.join(directory,'entry.ts')};
}
const identity=`function f(x:number):number{return x;}
contract(f,{requires:()=>true,ensures:(r,x)=>r===x || (r!==r && x!==x)});`;
function runSuite(file:string) {
  return spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1'],
    {encoding:'utf8',timeout:45000,env:{...process.env,NO_COLOR:'1'}});
}

test('number runtime preserves special values, arity and real predicates',()=>{
  const {entry}=fixture('runtime',prefix+identity+`
function zero():number{return 0.1+0.2;}
contract(zero,{requires:()=>true,ensures:r=>r===0.3});
function positive(x:number):number{return x;}
contract(positive,{requires:x=>x>=0,ensures:(r,x)=>r===x});
function caller(x:number):number{return positive(x);}`);
  const runtime=createTestRuntime(entry);
  for(const x of [NaN,Infinity,-Infinity,0,-0,Number.MIN_VALUE]) {
    expect(runtime.accepts('f',[x])).toBe(true);
    expect(Object.is(runtime.execute('f',[x]).result,x)).toBe(true);
    expect(runtime.execute('f',[x]).ensures).toBe(true);
  }
  expect(runtime.execute('zero',[])).toMatchObject({result:0.30000000000000004,ensures:false});
  expect(()=>runtime.execute('f',[1n])).toThrow(/arguments/);
  expect(()=>runtime.execute('f',[])).toThrow(/arguments/);
  expect(()=>runtime.execute('missing',[])).toThrow(/arguments/);
  expect(runtime.accepts('positive',[NaN])).toBe(false);
  expect(()=>runtime.execute('positive',[NaN])).toThrow(/requires/);
  const call=runtime.execute('caller',[NaN]);
  expect(call.ensures).toBeUndefined();
  expect(call.calls).toHaveLength(1);
  expect(call.calls[0].args[0]).toBeNaN();
  expect(call.calls[0].accepted).toBe(false);
  const bigint=fixture('bigint-reject',prefix+identity.replaceAll('number','bigint'));
  expect(()=>createTestRuntime(bigint.entry).execute('f',[0])).toThrow(/arguments/);
  const rejected=fixture('reject',prefix+identity+'\nthrow new Error("executed");');
  expect(()=>createTestRuntime(rejected.entry)).toThrow(/Unsupported/);
});

test('number aliases, imports, re-exports and contract registration keep symbol bindings',async()=>{
  const {entry,directory}=fixture('modules',`import { alias } from "./barrel.js";
import "./contracts.js";
function caller(x:number):number{return alias(x);}`,{
    'fn.ts':'export function f(x:number):number{return x;}\nexport const alias=f;',
    'barrel.ts':'export { alias } from "./fn.js";',
    'contracts.ts':prefix+'import { alias } from "./barrel.js";\ncontract(alias,{requires:x=>x>=0,ensures:(r,x)=>r===x});',
  });
  const runtime=createTestRuntime(entry);
  expect(runtime.execute('caller',[NaN]).calls[0].accepted).toBe(false);
  const generated=await generateRegressions(entry,path.join(directory,'generated'));
  expect(generated.cases).toBe(1);
  expect(generated.unconfirmed).toEqual([]);
  const {manifest}=loadRegressions(generated.manifestFile);
  expect(manifest.cases[0].kind).toBe('call');
  expect(replayRegression(runtime,entry,manifest.cases[0]).status).toBe('failed');
});

test('v2 implementation regression survives JSON and a compatible precision fix',async()=>{
  const {entry,directory}=fixture('precision',prefix+`function f(__proto__:number):number{return __proto__+1;}
contract(f,{requires:x=>x===9007199254740992,ensures:(r,x)=>r>x});`);
  const generated=await generateRegressions(entry,path.join(directory,'generated'));
  expect(generated.cases).toBe(1); expect(generated.unconfirmed).toEqual([]);
  const {manifest,runtime}=loadRegressions(generated.manifestFile);
  expect(manifest.version).toBe(2);
  expect(manifest.semantics).toBe('number-ieee754-binary64');
  const regression=manifest.cases[0];
  expect(regression.function.semantics).toBe(manifest.semantics);
  expect(regression.inputs).toEqual([encodeNumber(2**53)]);
  expect(replayRegression(runtime,entry,regression).status).toBe('failed');
  const failing=runSuite(generated.testFile);
  expect(failing.status,failing.stdout+failing.stderr).toBe(1);
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('return __proto__+1','return __proto__+2'));
  expect(replayRegression(createTestRuntime(entry),entry,regression).status).toBe('passed');
  const fixed=runSuite(generated.testFile);
  expect(fixed.status,fixed.stdout+fixed.stderr).toBe(0);
  for(const value of [null,0,'0n',{kind:'number',bits:'7ff8000000000000'},
    {kind:'number',bits:'0000000000000000',special:'NaN'}])
    expect(replayRegression(runtime,entry,{...regression,inputs:[value]} as Regression).status).toBe('inapplicable');
  expect(replayRegression(runtime,entry,{...regression,function:{...regression.function,parameters:['renamed']}}).status).toBe('inapplicable');
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('x===9007199254740992','x===0'));
  expect(replayRegression(createTestRuntime(entry),entry,regression).status).toBe('inapplicable');
});

test('NaN call regression fails suite, then passes with corrected guard without regeneration',async()=>{
  const {entry,directory}=fixture('nan-call',prefix+`function f(x:number):number{return x;}
contract(f,{requires:x=>x>=0,ensures:(r,x)=>r===x});
function caller(x:number):number{if(x<0)return 0;return f(x);}`);
  const generated=await generateRegressions(entry,path.join(directory,'generated'));
  expect(generated.unconfirmed).toEqual([]); expect(generated.cases).toBe(1);
  const {manifest,runtime}=loadRegressions(generated.manifestFile);
  const regression=manifest.cases[0];
  expect(regression.kind).toBe('call');
  expect(decodeNumber(regression.inputs[0])).toBeNaN();
  if(regression.kind!=='call') throw new Error('call expected');
  expect(regression.callee.semantics).toBe(manifest.semantics);
  expect(replayRegression(runtime,entry,{...regression,callee:{...regression.callee,semantics:'bigint-exact-integers'}}).status).toBe('inapplicable');
  expect(replayRegression(runtime,entry,regression).status).toBe('failed');
  const failing=runSuite(generated.testFile); expect(failing.status,failing.stdout+failing.stderr).toBe(1);
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('if(x<0)','if(!(x>=0))'));
  expect(replayRegression(createTestRuntime(entry),entry,regression).status).toBe('passed');
  const fixed=runSuite(generated.testFile); expect(fixed.status,fixed.stdout+fixed.stderr).toBe(0);
});

test('NaN, infinities and signed zero round-trip saved implementation cases',async()=>{
  const {entry,directory}=fixture('specials',prefix+`function nan(x:number):number{return x;}
contract(nan,{requires:x=>x!==x,ensures:r=>r===0});
function positive(x:number):number{return x-x;}
contract(positive,{requires:x=>x===Infinity,ensures:r=>r===0});
function negative(x:number):number{return x-x;}
contract(negative,{requires:x=>x===-Infinity,ensures:r=>r===0});
function zero(x:number):number{return 0;}
contract(zero,{requires:x=>x===0,ensures:r=>r===1});`);
  const generated=await generateRegressions(entry,path.join(directory,'generated'));
  expect(generated.cases).toBe(4);
  const {manifest,runtime}=loadRegressions(generated.manifestFile);
  for(const regression of manifest.cases) expect(replayRegression(runtime,entry,regression).status).toBe('failed');
  const zero=manifest.cases.find(r=>r.function.name==='zero')!;
  // JS predicates cannot distinguish zero signs; transport must preserve either.
  const negativeZero=JSON.parse(JSON.stringify({...zero,inputs:[encodeNumber(-0)]}));
  expect(Object.is(decodeNumber(negativeZero.inputs[0]),-0)).toBe(true);
  expect(replayRegression(runtime,entry,negativeZero).status).toBe('failed');
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('return x;}','return 0;}')
    .replaceAll('return x-x','return 0').replace('function zero(x:number):number{return 0','function zero(x:number):number{return 1'));
  const fixed=createTestRuntime(entry);
  for(const regression of [...manifest.cases,negativeZero]) expect(replayRegression(fixed,entry,regression).status).toBe('passed');
});

test('manifest version, model and zero-arity rebinding are checked, old v1 stays unchanged',async()=>{
  const {entry,directory}=fixture('zero-arity',prefix+`function f():number{return 0;}
contract(f,{requires:()=>true,ensures:r=>r===1});`);
  const generated=await generateRegressions(entry,path.join(directory,'generated'));
  const original=fs.readFileSync(generated.manifestFile,'utf8');
  const {manifest}=loadRegressions(generated.manifestFile);
  for(const change of [{version:3},{version:2,semantics:'bigint-exact-integers'},{version:2,semantics:null},{entry:null},{cases:{}}]) {
    fs.writeFileSync(generated.manifestFile,JSON.stringify({...manifest,...change}));
    expect(()=>loadRegressions(generated.manifestFile)).toThrow(/manifest/);
  }
  fs.writeFileSync(generated.manifestFile,original);
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replaceAll('number','bigint').replaceAll('return 0','return 0n').replace('r===1','r===1n'));
  expect(replayRegression(createTestRuntime(entry),entry,manifest.cases[0]).status).toBe('inapplicable');
  const v1=await generateRegressions(entry,path.join(directory,'v1'));
  const before=fs.readFileSync(v1.manifestFile,'utf8');
  const loaded=loadRegressions(v1.manifestFile);
  expect(loaded.manifest.version).toBe(1);
  expect(loaded.manifest.semantics).toBeUndefined();
  expect(loaded.manifest.cases[0].function.semantics).toBeUndefined();
  expect(fs.readFileSync(v1.manifestFile,'utf8')).toBe(before);
  expect(replayRegression(loaded.runtime,entry,loaded.manifest.cases[0]).status).toBe('failed');
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replaceAll('bigint','number').replaceAll('0n','0').replaceAll('1n','1'));
  expect(replayRegression(createTestRuntime(entry),entry,loaded.manifest.cases[0]).status).toBe('inapplicable');
  for(const item of [null,{}, {...manifest.cases[0],function:{...manifest.cases[0].function,semantics:undefined}}]) {
    fs.writeFileSync(generated.manifestFile,JSON.stringify({...manifest,cases:[item]}));
    const bad=loadRegressions(generated.manifestFile);
    expect(replayRegression(bad.runtime,entry,bad.manifest.cases[0]).status).toBe('inapplicable');
  }
});

test('number properties preserve requires during shrinking, exact JSON and seed',async()=>{
  const {entry}=fixture('properties',prefix+`function f(x:number):number{return x;}
contract(f,{requires:()=>true,ensures:(r,x)=>r===x});`);
  const runtime=createTestRuntime(entry);
  const options={seed:123,numRuns:100};
  const first=await checkProperties(runtime,options);
  expect(first[0].status).toBe('failed'); expect(first[0].checked).toBeGreaterThan(0);
  expect(await checkProperties(runtime,options)).toEqual(first);
  const args=JSON.parse(JSON.stringify(first[0].counterexample)).map(decodeNumber);
  expect(runtime.accepts('f',args)).toBe(true);
  expect(runtime.execute('f',args).ensures).toBe(false);
  fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('r===x','r===x || (r!==r && x!==x)'));
  const fixed=await checkProperties(createTestRuntime(entry),options);
  expect(fixed[0].status).toBe('passed'); expect(fixed[0].checked).toBe(100);
});

test('number sampling handles rare constants, NaN-only contracts, zero arity, unknown and exhaustion',async()=>{
  const {entry}=fixture('sampling',prefix+`function rare(x:number):number{return x;}
contract(rare,{requires:x=>x===0.1,ensures:(r,x)=>r===x});
function nan(x:number):number{return x;}
contract(nan,{requires:x=>x!==x,ensures:r=>r!==r});
function zero():number{return -0;}
contract(zero,{requires:()=>true,ensures:r=>r===0});
function impossible(x:number):number{return x;}
contract(impossible,{requires:x=>x<0 && x>=0,ensures:()=>true});`);
  const result=await checkProperties(createTestRuntime(entry),{seed:42,numRuns:10,maxSkipsPerRun:1000});
  expect(result.map(r=>r.status)).toEqual(['passed','passed','passed','inconsistent']);
  expect(result.map(r=>r.checked)).toEqual([10,10,10,0]);
  const unknown=await checkProperties(createTestRuntime(entry),{seed:42,numRuns:10,solverLimits:{resourceLimit:1}});
  expect(unknown.some(r=>r.status==='unknown' && r.checked===0 && r.reason)).toBe(true);
  const sparse=fixture('sparse',prefix+`function f(x:number,y:number,z:number,w:number):number{return x;}
contract(f,{requires:(x,y,z,w)=>x>1000000 && x<Infinity && y===x+100 && z===y+100 && w===z+100,ensures:()=>true});`);
  const exhausted=await checkProperties(createTestRuntime(sparse.entry),{seed:123,numRuns:5,maxSkipsPerRun:1});
  expect(exhausted[0].status).toBe('insufficient-inputs'); expect(exhausted[0].skipped).toBeGreaterThan(0);
});

test('number suites include properties without regressions and weak contracts remain unknown',async()=>{
  const {entry,directory}=fixture('no-cases',prefix+identity);
  const generated=await generateRegressions(entry,path.join(directory,'generated'));
  expect(generated.cases).toBe(0);
  const run=runSuite(generated.testFile); expect(run.status,run.stdout+run.stderr).toBe(0);
  const weak=fixture('weak',prefix+`function f(x:number):number{return x;}
contract(f,{requires:x=>x>=0 && x<Infinity,ensures:r=>r>=0});
function caller(x:number):number{return f(x);}
contract(caller,{requires:x=>x>=0 && x<Infinity,ensures:(r,x)=>r===x});`);
  const abstract=await generateRegressions(weak.entry,path.join(weak.directory,'generated'));
  expect(abstract.cases).toBe(0); expect(abstract.unknownObligations).toBeGreaterThan(0);
});

import * as verification from "./verification.ts";
test('confirmation rejects wrong-source models and deduplicates exact saved cases',async()=>{
  const {entry,directory}=fixture('confirmation',prefix+`function positive(x:number):number{return x;}
contract(positive,{requires:x=>x>=0,ensures:(r,x)=>r===x});
function caller(x:number):number{return positive(0)+positive(x);}`);
  const runtime=createTestRuntime(entry);
  const results=await verification.verifyProgram(runtime.ir);
  const violation=results.find(r=>r.kind==='call' && r.status==='disproved');
  const safe=results.find(r=>r.kind==='call' && r.status==='proved');
  if(!violation || violation.kind!=='call' || violation.status!=='disproved' || !safe || safe.kind!=='call') throw new Error('calls expected');
  const spy=vi.spyOn(verification,'verifyProgram');
  try {
    spy.mockResolvedValue([{...violation,callId:safe.callId,callSource:safe.callSource}]);
    const wrong=await generateRegressions(entry,path.join(directory,'wrong'));
    expect(wrong.cases).toBe(0); expect(wrong.unconfirmed).toHaveLength(1);
    expect(wrong.unconfirmed[0].reason).toContain('reported source call');
    spy.mockResolvedValue([violation,violation]);
    const duplicate=await generateRegressions(entry,path.join(directory,'duplicate'));
    expect(duplicate.cases).toBe(1); expect(duplicate.unconfirmed).toEqual([]);
    const text=fs.readFileSync(duplicate.testFile,'utf8');
    expect(text).not.toContain('positive(0)');
    expect(text).not.toContain('eval(');
    spy.mockResolvedValue([{...violation,counterexample:{x:encodeNumber(1)}}]);
    const unconfirmed=await generateRegressions(entry,path.join(directory,'unconfirmed'));
    expect(unconfirmed.cases).toBe(0); expect(unconfirmed.unconfirmed).toHaveLength(1);
  } finally { spy.mockRestore(); }
});
