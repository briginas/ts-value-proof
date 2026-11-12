import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { verify } from "./verify.ts";
import { verifyProgram } from "./verification.ts";
import { sourceInventory } from "./ir-integrity.ts";
import { withNumberModel } from "./number-backend.ts";
import { decodeScalar, encodeScalar, encodeNumber } from "./numeric-values.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { stringPool } from "./string-inputs.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/string", name);
  fs.mkdirSync(directory, {recursive:true});
  const entry = path.join(directory,"entry.ts");
  const api = path.relative(directory,path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("UTF-16 terms agree with native JavaScript, including isolated surrogates", async () => {
  const samples = ["", "a", "Ж", "\0", "😀", "\ud800", "\udfff", "e\u0301", "\"\\\n", "12n"];
  for (const bad of ["12n", null, [], {kind:"string",value:1}, {kind:"string",value:"x",extra:1},
    Object.assign(Object.create({kind:"string"}),{value:"x",extra:1})])
    expect(() => decodeScalar(bad,"string")).toThrow(/string encoding/);
  await withNumberModel(async model => {
    const lit = (value:string) => model.literal({kind:"string",value});
    for (const a of samples) {
      expect(await model.read(lit(a))).toBe(a);
      expect(await model.read(model.length!(lit(a)))).toBe(a.length);
      expect(decodeScalar(JSON.parse(JSON.stringify(encodeScalar(a))),"string")).toBe(a);
      for (const b of samples) {
        expect(await model.read(model.add(lit(a),lit(b)))).toBe(a+b);
        expect(await model.read(model.eq(lit(a),lit(b)))).toBe(a===b);
        expect(await model.read(model.length!(model.add(lit(a),lit(b))))).toBe((a+b).length);
      }
    }
    expect(await model.read(model.eq(lit("😀"),lit("\ud83d\ude00")))).toBe(true);
    expect(await model.read(model.eq(lit("é"),lit("e\u0301")))).toBe(false);
  });
});

test("identity, concatenation, literal length and native length contracts", async () => {
  const entry = fixture("positive", `
function identity(s:string):string{return s;}
contract(identity,{ensures:(r,s)=>r===s});
function concat(a:string,b:string):string{return a+b;}
contract(concat,{ensures:(r,a,b)=>r===a+b && r.length===a.length+b.length});
function length(s:string):number{return s.length;}
contract(length,{ensures:(r,s)=>r===s.length && r>=0});
function emoji():number{return "😀".length;}
contract(emoji,{ensures:r=>r===2});
function literal():string{return \`hello\`;}
contract(literal,{ensures:r=>r==="hello"});`);
  const report = await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("verified");
  expect(report.semantics).toBe("string-utf16-number-binary64");
  expect(report.scope?.[0].parameters[0].status).toBe("modeled");
  const runtime=createTestRuntime(entry);
  expect(runtime.execute("length",["😀"]).result).toBe(2);
  expect(runtime.execute("identity",["\ud800"]).result).toBe("\ud800");
  expect((await checkProperties(runtime,{seed:42,numRuns:20})).every(r=>r.status==="passed")).toBe(true);
});

test("strings use complete concrete counterexamples and satisfy native requires", async () => {
  const entry=fixture("negative", `function f(s:string,n:number):string{return s+"x";}
contract(f,{requires:(s,n)=>s==="\\ud800" && n===2,ensures:(r,s)=>r===s});`);
  const report=await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("refuted");
  const r=report.results.find(r=>r.status==="disproved");
  expect(r?.status).toBe("disproved");
  if(r?.status!=="disproved")return;
  expect(r.counterexample.s).toEqual({kind:"string",value:"\ud800"});
  const args=[decodeScalar(r.counterexample.s,"string"),decodeScalar(r.counterexample.n,"float64")];
  expect(createTestRuntime(entry).execute("f",args).ensures).toBe(false);
});

test("path guards, string branches, strong and weak callee contracts", async () => {
  const entry=fixture("calls", `function nonempty(s:string):string{return s;}
contract(nonempty,{requires:s=>s!=="",ensures:(r,s)=>r===s});
function safe(s:string):string{if(s==="")return "x";return nonempty(s);}
contract(safe,{ensures:r=>r!==""});
function unsafe(s:string):string{return nonempty(s);}
contract(unsafe,{ensures:()=>true});
function weak(s:string):string{return s;}
contract(weak,{ensures:()=>true});
function caller(s:string):string{return weak(s);}
contract(caller,{ensures:(r,s)=>r===s});`);
  const report=await verify(entry);
  expect(report.results.filter(r=>r.sourceName==="safe").every(r=>r.status==="proved"),JSON.stringify(report)).toBe(true);
  expect(report.results.find(r=>r.sourceName==="unsafe" && r.kind==="call")).toMatchObject({status:"disproved",counterexample:{s:{kind:"string",value:""}}});
  expect(report.results.find(r=>r.sourceName==="caller")).toMatchObject({status:"unknown",reasonCode:"weak-callee-contract"});
  expect(createTestRuntime(entry).execute("safe",["😀"]).ensures).toBe(true);
});

test("length in call arguments keeps bindings and call inventory", async () => {
  const entry=fixture("length-call",`function count(n:number):number{return n;}
contract(count,{requires:n=>n>=0,ensures:(r,n)=>r===n});
function caller(s:string):number{return count(s.length);}
contract(caller,{ensures:(r,s)=>r===s.length});`);
  const report=await verify(entry);
  expect(report.status,JSON.stringify(report)).toBe("verified");
  expect(createTestRuntime(entry).execute("caller",["😀"]).calls[0].args).toEqual([2]);
});

test("inconsistent string preconditions and solver resource limits remain non-success", async () => {
  const entry=fixture("inconsistent",`function f(s:string):string{return s;}
contract(f,{requires:s=>s==="" && s!=="",ensures:()=>false});`);
  expect((await verify(entry)).status).toBe("inconsistent");
  const limited=fixture("limited",`function f(a:string,b:string):string{return a+b;}
contract(f,{requires:(a,b)=>a+b===b+a,ensures:(r,a)=>r===a});`);
  expect((await verify(limited,{resourceLimit:1})).status).toBe("unknown");
});

test("unsupported string operations never receive a proof or coercion", async () => {
  for(const [i,body,sort] of [[0,'s+1','string'],[1,'s.slice(1)','string'],[2,'s[0]','string'],[3,'`${s}`','string']] as const){
    const entry=fixture("unsupported"+i,`function f(s:string):${sort}{return ${body};}contract(f,{ensures:r=>r===""});`);
    try { expect((await verify(entry)).status).toBe("unknown"); }
    catch(error){expect(String(error)).toMatch(/unsupported/i);}
    expect(()=>createTestRuntime(entry)).toThrow();
  }
  const compare=await verify(fixture("compare",`function f(a:string,b:string):string{return a;}
contract(f,{requires:(a,b)=>a<b,ensures:()=>true});`));
  expect(compare.results[0]).toMatchObject({status:"unknown",reasonCode:"unsupported-dependency"});
  expect((await verify(fixture("mixed-bigint",`function f(s:string,n:bigint):string{return s;}
contract(f,{requires:(s,n)=>s!=="" && n>0n,ensures:(r,s)=>r===s});`))).reasonCode).toBe("unsupported-numeric-model");
});

test("selective numeric contracts fill unused strings and retain numeric semantics", async () => {
  const report=await verify(fixture("unused",`function f(s:string,x:number):number{return x;}
contract(f,{ensures:(r)=>r!==r});`));
  expect(report.semantics).toBe("number-ieee754-binary64");
  expect(report.results[0]).toMatchObject({status:"disproved",counterexample:{s:{kind:"string",value:""}}});
});

test("malformed string IR is rejected before solving", async () => {
  const entry=fixture("ir",`function f(s:string):number{return s.length;}contract(f,{ensures:r=>r>=0});`);
  for(const bad of [{kind:"string",value:123},{kind:"length",operand:{kind:"number",value:encodeNumber(1)}},
    {kind:"binary",op:"+",left:{kind:"string",value:"a"},right:{kind:"number",value:encodeNumber(1)}}]){
    const ir=adapt(entry);
    ir.functions[0].body=bad as typeof ir.functions[0]["body"];
    ir.coverage.inventory=sourceInventory(ir);
    await expect(verifyProgram(ir)).rejects.toThrow(/Invalid IR/);
  }
});

test("v3 regression survives JSON and correction; signature or encoding changes are inapplicable", async () => {
  const source=(body:string)=>`function f(s:string,n:number):string{return ${body};}
contract(f,{requires:(s,n)=>s==="\\ud800" && n===2,ensures:(r,s)=>r===s});`;
  const entry=fixture("replay",source('s+"!"'));
  const output=await generateRegressions(entry,path.join(path.dirname(entry),"generated"));
  expect(output.cases).toBe(1);expect(output.unconfirmed).toEqual([]);
  const loaded=loadRegressions(output.manifestFile);
  expect(loaded.manifest.version).toBe(3);
  const item=loaded.manifest.cases[0];
  expect(item.function).toMatchObject({parameterSorts:["string","float64"],returnSort:"string"});
  expect(replayRegression(loaded.runtime,entry,item).status).toBe("failed");
  fixture("replay",source('s'));
  expect(replayRegression(createTestRuntime(entry),entry,item).status).toBe("passed");
  for(const inputs of [["12n",encodeNumber(2)],[{kind:"string",value:42},encodeNumber(2)], [{kind:"string",value:"\ud800",extra:1},encodeNumber(2)]])
    expect(replayRegression(createTestRuntime(entry),entry,{...item,inputs:inputs as typeof item.inputs}).status).toBe("inapplicable");
  expect(replayRegression(createTestRuntime(entry),entry,{...item,function:{...item.function,returnSort:"float64"}}).status).toBe("inapplicable");
  const bad=JSON.parse(fs.readFileSync(output.manifestFile,"utf8"));bad.semantics="number-ieee754-binary64";
  fs.writeFileSync(output.manifestFile,JSON.stringify(bad));
  expect(()=>loadRegressions(output.manifestFile)).toThrow(/manifest/);
});

test("property generation covers UTF-16 and reproduces mixed input failures", async () => {
  const entry=fixture("property",`function f(s:string,n:number):string{return s+"x";}
contract(f,{requires:(s,n)=>s==="rare\\ud800" && n===2,ensures:(r,s)=>r===s});`);
  const runtime=createTestRuntime(entry);
  expect(stringPool(runtime.ir.functions[0])).toEqual(expect.arrayContaining(["","\0","😀","\ud800","\udfff","rare\ud800"]));
  const options={numRuns:10,seed:42,maxSkipsPerRun:1000};
  const a=await checkProperties(runtime,options),b=await checkProperties(runtime,options);
  expect(a).toEqual(b);expect(a[0].status).toBe("failed");
  expect(a[0].counterexample?.[0]).toEqual({kind:"string",value:"rare\ud800"});
  expect(()=>runtime.execute("f",[2,"rare\ud800"])).toThrow(/arguments/);
});

test("length arithmetic retains binary64 rounding, NaN and signed zeros", async () => {
  await withNumberModel(async model => {
    const number=(value:number)=>model.literal({kind:"number",value:encodeNumber(value)});
    for(const value of ["","a","😀","\ud800"]){
      const length=model.length!(model.literal({kind:"string",value}));
      for(const n of [0,-0,1,-1,0.1,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER,2**53]){
        expect(Object.is(await model.read(model.add(length,number(n))),value.length+n)).toBe(true);
        expect(Object.is(await model.read(model.sub(length,number(n))),value.length-n)).toBe(true);
        expect(await model.read(model.eq(length,number(n)))).toBe(value.length===n);
        expect(await model.read(model.lt(length,number(n)))).toBe(value.length<n);
      }
    }
    for(const a of [0,-0,1,Number.MAX_SAFE_INTEGER])for(const b of [0,-0,1,Number.MAX_SAFE_INTEGER])
      expect(Object.is(await model.read(model.add(number(a),number(b))),a+b)).toBe(true);
  });
});

test("oversized counterexamples remain unknown and are never truncated", async () => {
  await withNumberModel(async model => {
    let huge=model.literal({kind:"string",value:"x"});
    for(let i=0;i<17;i++)huge=model.add(huge,huge);
    const answer=await model.solve([],new Map([["s",huge]]),{});
    expect(answer).toMatchObject({status:"unknown",reason:expect.stringContaining("decoding limit")});
    expect(answer).not.toHaveProperty("counterexample");
  });
});

test("v3 call regressions bind callee types and support corrected guards", async () => {
  const code=(body:string)=>`function nonempty(s:string):string{return s;}
contract(nonempty,{requires:s=>s!=="",ensures:(r,s)=>r===s});
function caller(__proto__:string):string{${body}}`;
  const entry=fixture("call-replay",code("return nonempty(__proto__);"));
  const output=await generateRegressions(entry,path.join(path.dirname(entry),"generated"));
  const loaded=loadRegressions(output.manifestFile);
  const item=loaded.manifest.cases.find(c=>c.kind==="call")!;
  expect(item.inputs).toEqual([{kind:"string",value:""}]);
  expect(replayRegression(loaded.runtime,entry,item).status).toBe("failed");
  if(item.kind!=="call")throw new Error("Missing call regression");
  expect(replayRegression(loaded.runtime,entry,{...item,callee:{...item.callee,parameterSorts:["float64"]}}).status).toBe("inapplicable");
  fixture("call-replay",code('if(__proto__==="")return "fallback";return nonempty(__proto__);'));
  expect(replayRegression(createTestRuntime(entry),entry,item).status).toBe("passed");
});
