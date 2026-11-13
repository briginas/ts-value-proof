import { contract } from "../src/contract.ts";

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

contract(absolute, {
  ensures: (result, value) => value < 0n ? result === -value : result === value,
});

export function safeDivide(value: bigint, divisor: bigint): bigint {
  // Only the selected branch runs, so zero never reaches the division.
  const quotient = divisor === 0n ? 0n : value / divisor;
  return quotient;
}

contract(safeDivide, {
  ensures: (result, value, divisor) =>
    divisor === 0n ? result === 0n : result === value / divisor,
});

export function sign(value: bigint): bigint {
  return value < 0n ? -1n : value === 0n ? 0n : 1n;
}

contract(sign, {
  ensures: (result, value) =>
    value < 0n ? result === -1n : value === 0n ? result === 0n : result === 1n,
});
