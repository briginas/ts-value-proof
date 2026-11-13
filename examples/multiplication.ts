import { contract } from "../src/contract.ts";

export function square(value: bigint): bigint {
  return value * value;
}

contract(square, {
  ensures: result => result >= 0n,
});
