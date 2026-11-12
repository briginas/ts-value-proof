import assert from "node:assert/strict";
import { contract } from "../src/contract.ts";

let executions = 0;
function identity(value: bigint): bigint { executions++; return value; }
const specification = {
  requires: (value: bigint) => { executions++; return value >= 0n; },
  ensures: (result: bigint, value: bigint) => { executions++; return result === value; },
};
const bound = contract(identity, specification);
assert.equal(executions, 0, "creating a contract must not execute functions or predicates");
assert.equal(bound.fn, identity);
assert.equal(bound.specification, specification);
assert.equal(bound.fn(7n), 7n);
assert.equal(executions, 1, "calling bound.fn must not automatically execute predicates");
console.log("PASS contract API preserves references without executing predicates");
for (const partial of [{ requires: specification.requires }, { ensures: specification.ensures }]) {
  const before: number = executions;
  const result = contract(identity, partial);
  assert.equal(result.fn, identity);
  assert.equal(result.specification, partial);
  assert.deepEqual(Object.keys(result.specification), Object.keys(partial));
  assert.equal(executions, before);
}
console.log("PASS requires-only and ensures-only preserve exactly the supplied predicates");
