import { contract } from "../src/contract.js";

export function increment(value: bigint): bigint {
  return value + 1n;
}
contract(increment, {
  requires: () => true,
  ensures: (result, value) => result > value && result - 1n === value,
});

export function offset(value: bigint): bigint {
  return value + 123456789012345678901234567890123456789012345678901n;
}
contract(offset, {
  requires: () => true,
  ensures: (result, value) =>
    result - value === 123456789012345678901234567890123456789012345678901n,
});
