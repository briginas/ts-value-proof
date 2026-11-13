import { contract } from "../src/contract.ts";

function absoluteDifference(left: bigint, right: bigint): bigint {
  const difference = left - right;
  const negative = difference < 0n;
  if (negative) {
    let magnitude: bigint = -difference;
    return magnitude;
  }
  return difference;
}

contract(absoluteDifference, {
  ensures: (result, left, right) => result >= 0n &&
    (result === left - right || result === right - left),
});
