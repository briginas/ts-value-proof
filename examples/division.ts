import { contract } from "../src/contract.ts";

export function quotient(dividend: bigint, divisor: bigint): bigint {
  return dividend / divisor;
}

contract(quotient, {
  requires: (dividend, divisor) => divisor !== 0n,
  ensures: (result, dividend, divisor) => result === dividend / divisor,
});

export function negativeQuotient(): bigint {
  return -7n / 3n;
}

contract(negativeQuotient, {
  ensures: result => result === -2n,
});
