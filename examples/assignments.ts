import { contract } from "../src/contract.ts";

function absoluteDifference(left: bigint, right: bigint): bigint {
  let difference = left;
  difference -= right;
  if (difference < 0n) difference = -difference;
  return difference;
}

contract(absoluteDifference, {
  ensures: (result, left, right) => result >= 0n &&
    (result === left - right || result === right - left),
});

function increment(value: bigint): bigint {
  value += 1n;
  return value;
}

contract(increment, {
  // Contract arguments keep the original input, even when a parameter is assigned.
  ensures: (result, value) => result === value + 1n,
});

function fee(tier: bigint): bigint {
  let amount = 10n;
  switch (tier) {
    case 0n: amount = 0n; break;
    case 1n: amount += 5n;
    default: amount *= 2n;
  }
  return amount;
}

contract(fee, { ensures: result => result >= 0n });
