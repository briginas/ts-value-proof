import { contract, type Specification } from "../src/contract.js";
import { importedFunction, specify } from "./type-barrel.js";

function withdraw(balance: number, amount: number): number { return balance - amount; }
function text(value: string): string { return value; }
function object(value: { amount: number }): { total: number } { return { total: value.amount }; }

contract(withdraw, {
  requires: (balance, amount) => {
    const b: number = balance;
    const a: number = amount;
    // @ts-expect-error inferred argument is number, not any
    balance.toUpperCase();
    return b >= a;
  },
  ensures: (result, balance, amount) => {
    const n: number = result;
    // @ts-expect-error inferred result is number, not any
    const s: string = result;
    return n === balance - amount;
  },
});
contract(withdraw, {
  // @ts-expect-error predicate cannot change the argument types inferred from the function
  requires: (balance: string, amount: string) => balance === amount,
  ensures: result => result >= 0,
});
contract(withdraw, {
  requires: () => true,
  // @ts-expect-error result type cannot be changed by the predicate
  ensures: (result: string) => result.length > 0,
});
contract(withdraw, {
  // @ts-expect-error predicates must return boolean
  requires: balance => balance,
  ensures: () => true,
});
contract(withdraw, {
  // @ts-expect-error cannot require a third argument
  requires: (balance, amount, extra: number) => balance + amount > extra,
  ensures: () => true,
});
contract(text, {
  // @ts-expect-error changed function signature changes callback parameter type
  requires: value => value > 0,
  ensures: result => result.length >= 0,
});
contract(object, {
  requires: value => value.amount >= 0,
  ensures: (result, value) => {
    // @ts-expect-error result fields come from the function return type
    result.missing;
    return result.total === value.amount;
  },
});
const bound = contract(withdraw, { requires: () => true, ensures: () => true });
const sameSignature: typeof withdraw = bound.fn;
// @ts-expect-error attaching a contract does not change the function signature
bound.fn("100", "10");

function bigintIdentity(x: bigint): bigint { return x; }
contract(bigintIdentity, {
  requires: x => {
    const v: bigint = x;
    // @ts-expect-error bigint is not number
    const n: number = x;
    return v >= 0n;
  },
  ensures: (r, x) => {
    // @ts-expect-error result preserves bigint type
    const n: number = r;
    return r === x;
  },
});

// A saved contract must track signature changes just like inline predicates.
function original(value: bigint, offset: bigint): bigint { return value + offset; }
const originalSpec: Specification<typeof original> = {
  requires: (value, offset) => value >= offset,
  ensures: (result, value, offset) => result === value + offset,
};
function changedArgument(value: string, offset: bigint): bigint { return BigInt(value) + offset; }
function changedResult(value: bigint, offset: bigint): string { return String(value + offset); }
function removedArgument(value: bigint): bigint { return value; }
function optionalArgument(value: bigint, offset?: bigint): bigint { return value + (offset ?? 0n); }
function nullableResult(value: bigint, offset: bigint): bigint | null { return value > offset ? value : null; }
// @ts-expect-error argument mutation invalidates a previously typed specification
contract(changedArgument, originalSpec);
// @ts-expect-error return type mutation invalidates ensures
contract(changedResult, originalSpec);
// @ts-expect-error a removed argument is no longer available to the predicates
contract(removedArgument, originalSpec);
// @ts-expect-error a formerly required argument can now be undefined
contract(optionalArgument, originalSpec);
// @ts-expect-error ensures must handle the complete result union
contract(nullableResult, originalSpec);
// @ts-expect-error standalone specification assignment must be safe too
const removedSpec: Specification<typeof removedArgument> = originalSpec;
// @ts-expect-error function assignability does not preserve predicate result requirements
const nullableSpec: Specification<typeof nullableResult> = originalSpec;

const alias = original;
const aliasAgain = alias;
const aliasBound = contract(aliasAgain, {
  requires: (value, offset) => {
    // @ts-expect-error aliases preserve parameter types
    const wrong: string = offset;
    return value >= offset;
  },
  ensures: (result, value, offset) => {
    // @ts-expect-error aliases preserve result types
    const wrong: number = result;
    return result === value + offset;
  },
});
const aliasResult: bigint = aliasBound.fn(1n, 2n);
// @ts-expect-error a bound alias preserves required arity
aliasBound.fn(1n);
// @ts-expect-error a bound alias does not permit additional parameters
aliasBound.fn(1n, 2n, 3n);
// @ts-expect-error a bound alias preserves the original result
const wrongAliasResult: string = aliasBound.fn(1n, 2n);
contract(original, {
  requires: () => true,
  // @ts-expect-error ensures cannot change argument types through inference
  ensures: (result: bigint, value: string, offset: bigint) => result === offset && value.length > 0,
});
contract(original, {
  requires: () => true,
  // @ts-expect-error ensures must return boolean too
  ensures: result => result,
});

// Same-signature functions are structurally compatible in TypeScript. Their
// concrete identities are checked separately by the static verifier.
function sameType(value: bigint, offset: bigint): bigint { return value - offset; }
contract(sameType, originalSpec);

specify(importedFunction, {
  requires: value => {
    // @ts-expect-error re-exported aliases retain the original argument type
    const wrong: string = value;
    return value >= 0n;
  },
  ensures: (result, value) => {
    // @ts-expect-error re-exported aliases retain the original return type
    const wrong: number = result;
    return result === value;
  },
});
specify(importedFunction, {
  // @ts-expect-error an imported contract API cannot change the function's type
  requires: (value: number) => value >= 0,
  ensures: () => true,
});

function mixed(label: string, value: number, metadata: unknown): number { return value; }
contract(mixed, { requires: (label, value, metadata) => {
  const text: string = label;
  const num: number = value;
  // @ts-expect-error unknown stays unknown
  metadata.field;
  return num >= 0 && text.length >= 0;
} });
contract(mixed, { ensures: (result, label, value) => {
  // @ts-expect-error result remains number
  const text: string = result;
  return result === value;
} });
// @ts-expect-error at least one defined predicate
contract(mixed, {});
// @ts-expect-error undefined is not a predicate
contract(mixed, { requires: undefined, ensures: undefined });
// @ts-expect-error saved specifications must also be nonempty
const empty: Specification<typeof mixed> = {};
const onlyPre: Specification<typeof original> = { requires: value => value >= 0n };
const onlyPost: Specification<typeof original> = { ensures: r => r >= 0n };
contract(sameType, onlyPre);
contract(sameType, onlyPost);
// @ts-expect-error even requires-only specifications track result changes
contract(changedResult, onlyPre);
// @ts-expect-error even ensures-only specifications track parameter changes
contract(removedArgument, onlyPost);
// @ts-expect-error optional arguments change the signature
contract(optionalArgument, onlyPre);
// @ts-expect-error a nullable result changes the signature
contract(nullableResult, onlyPost);
// @ts-expect-error standalone invariance is preserved
const wrongPre: Specification<typeof changedResult> = onlyPre;
// @ts-expect-error standalone invariance is preserved
const wrongPost: Specification<typeof removedArgument> = onlyPost;
