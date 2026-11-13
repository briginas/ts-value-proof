import assert from "node:assert/strict";
import { decodeNumber, decodeNumeric, encodeNumber, encodeNumeric } from "./numeric-values.ts";

const values = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE,
  2 ** -1022, 2 ** -1022 - Number.MIN_VALUE, 2 ** 53, 2 ** 53 - 1, Number.MAX_VALUE, -Number.MAX_VALUE, 0.1];
for (const value of values)
  assert(Object.is(decodeNumber(JSON.parse(JSON.stringify(encodeNumber(value)))), value));
for (const value of [0n, -1n, 900719925474099300000n])
  assert.equal(decodeNumeric(JSON.parse(JSON.stringify(encodeNumeric(value))), "int"), value);
for (const value of [0, null, "NaN", "0n", {}, [], {kind:"number", bits:"0"},
  {kind:"number", bits:"000000000000000G"}, {kind:"number", bits:"7ff8000000000000"},
  {kind:"number", bits:"0000000000000000", special:"NaN"}, {kind:"number", special:"Infinity"}])
  assert.throws(() => decodeNumber(value), /Invalid number encoding/);
console.log("Number codec: exact roundtrips and malformed values passed");

import { validateIR, numericSort, sourceInventory } from "./ir-integrity.ts";
import type { Expr, ProgramIR } from "./ir.ts";
const source = { file: "/number.ts", start: 1, end: 2, line: 1, column: 1 };
const num = (value: number): Expr => ({ kind: "number", value: encodeNumber(value) });
const ir: ProgramIR = { functions: [{ name: "f", sourceName: "f", source, params: [], returnSort: "float64",
  body: num(-0), contracts: [{ kind: "requires", predicate: {kind:"literal", value:true}, source },
    { kind: "ensures", predicate: {kind:"literal", value:true}, source }] }],
  coverage: { functions:["f"], contracts:["f"], calls:[], inventory: [] } };
ir.coverage.inventory = sourceInventory(ir);
validateIR(ir);
assert.equal(numericSort(ir), "int"); // Only boolean obligations: no numeric dependencies.
for (const mutate of [
  (p: ProgramIR) => { p.functions[0].body = {kind:"number", value:{kind:"number", bits:"7ff8000000000000"}}; },
  (p: ProgramIR) => { p.functions[0].body = {kind:"bigint", value:"0"}; },
  (p: ProgramIR) => { p.functions[0].body = {kind:"binary", op:"+", left:num(0), right:{kind:"literal", value:true}}; },
  (p: ProgramIR) => { p.functions[0].body = {kind:"ternary", condition:{kind:"literal", value:true}, then:num(0), else:{kind:"bigint", value:"0"}}; },
  (p: ProgramIR) => { p.functions[0].params.push({name:"x", sort:"int"}); },
  (p: ProgramIR) => { p.functions[0].returnSort = "int"; },
  (p: ProgramIR) => { p.coverage.calls.push("lost"); },
  (p: ProgramIR) => { p.functions.push({...p.functions[0], name:"g", returnSort:"int"}); p.coverage.functions.push("g"); },
]) {
  const changed = structuredClone(ir); mutate(changed);
  assert.throws(() => validateIR(changed), /Invalid IR/);
}
console.log("Number IR: literal, signature, branch, operand and coverage validation passed");

import { withNumberModel, verifyNumbers } from "./number-backend.ts";
const corpus = [0,-0,1,-1,0.1,0.2,0.3,Number.MIN_VALUE,-Number.MIN_VALUE,2**-1022,
  Number.MAX_VALUE,-Number.MAX_VALUE,2**53,2**53-1,Infinity,-Infinity,NaN];
await withNumberModel(async m => {
  const lit = (n: number) => m.literal({kind:"number",value:encodeNumber(n)});
  for (const a of corpus) {
    assert(Object.is(await m.read(lit(a)),a));
    assert(Object.is(await m.read(m.neg(lit(a))),-a));
    for (const b of corpus) {
      assert(Object.is(await m.read(m.add(lit(a),lit(b))),a+b));
      assert(Object.is(await m.read(m.sub(lit(a),lit(b))),a-b));
      assert(Object.is(await m.read(m.mul(lit(a),lit(b))),a*b));
      assert(Object.is(await m.read(m.div(lit(a),lit(b))),a/b));
      for (const [term, expected] of [[m.eq(lit(a),lit(b)),a===b], [m.lt(lit(a),lit(b)),a<b],
        [m.le(lit(a),lit(b)),a<=b], [m.gt(lit(a),lit(b)),a>b], [m.ge(lit(a),lit(b)),a>=b],
        [m.Not(m.eq(lit(a),lit(b))),a!==b]] as const) assert.equal(await m.read(term), expected);
      assert(Object.is(await m.read(m.If(m.le(lit(a),lit(b)),lit(a),lit(b))), a<=b?a:b));
    }
  }
  for (const a of [true,false]) for (const b of [true,false]) {
    assert.equal(await m.read(m.eq(m.truth(a),m.truth(b))),a===b);
    assert.equal(await m.read(m.Not(m.eq(m.truth(a),m.truth(b)))),a!==b);
    assert.equal(await m.read(m.And(m.truth(a),m.truth(b))),a&&b);
    assert.equal(await m.read(m.Or(m.truth(a),m.truth(b))),a||b);
  }
  // Half an ULP: even mantissa rounds down, odd mantissa rounds up.
  for (const a of [1,1+Number.EPSILON])
    assert(Object.is(await m.read(m.add(lit(a),lit(Number.EPSILON/2))),a+Number.EPSILON/2));
  // Halfway subnormal products round to the even significand (including zero).
  for (const a of [Number.MIN_VALUE, 3 * Number.MIN_VALUE, -Number.MIN_VALUE, -3 * Number.MIN_VALUE])
    assert(Object.is(await m.read(m.mul(lit(a),lit(0.5))),a*0.5));
  const x = m.variable("__proto__");
  for (const expected of [NaN,Infinity,-Infinity,-0,0,Number.MIN_VALUE,Number.MAX_VALUE,2**53]) {
    const r = await m.solve([m.sameTerm(x,lit(expected))],new Map([["__proto__",x]]),{});
    assert.equal(r.status,"sat");
    if (r.status === "sat") {
      const copy = JSON.parse(JSON.stringify(r.counterexample));
      assert(Object.hasOwn(copy,"__proto__"));
      assert(Object.is(decodeNumber(copy.__proto__),expected));
    }
  }
  assert.equal((await m.solve([m.truth(false)],new Map(),{})).status,"unsat");
  const nan = await m.solve([m.Not(m.eq(x,x))],new Map([["x",x]]),{});
  assert(nan.status === "sat" && Number.isNaN(decodeNumber(nan.counterexample.x)));
  const loss = m.Not(m.gt(m.add(x,lit(1)),x));
  const r = await m.solve([m.eq(x,lit(2**53)),loss],new Map([["x",x]]),{});
  assert(r.status === "sat" && decodeNumber(r.counterexample.x) === 2**53);
  const limited = await m.solve([loss],new Map(),{resourceLimit:1});
  assert(limited.status === "unknown" && limited.reason.length);
  // Timeout may yield either a completed decision or unknown, never a fabricated proof.
  const timed = await m.solve([loss],new Map(),{timeoutMs:1});
  assert(["sat","unknown"].includes(timed.status));
  await assert.rejects(() => m.solve([lit(1)],new Map(),{}),/boolean/);
});
await assert.rejects(() => withNumberModel(async () => { throw new Error("injected failure"); }),/injected failure/);
for (let i=0;i<3;i++) assert.equal((await verifyNumbers(ir)).find(r=>r.kind==="implementation")?.status,"proved");
await assert.rejects(() => verifyNumbers(ir,{timeoutMs:0}),/limits/);
console.log("Binary64: arithmetic including multiplication and division, comparisons, ite, ties-to-even, models, limits and lifecycle passed");
process.exit(0);
