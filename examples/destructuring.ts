import { contract } from "../src/contract.ts";

function swapDifference(x: bigint, y: bigint): bigint {
  let [a, b] = [x, y];
  [a, b] = [b, a];
  return a - b;
}

contract(swapDifference, {
  ensures: (result, x, y) => result === y - x,
});

function nestedDefaults(x: bigint): bigint {
  const { pair: [first, { value: second = first + 1n }] } = {
    pair: [x, { value: undefined }],
  };
  return second;
}

contract(nestedDefaults, {
  ensures: (result, x) => result === x + 1n,
});
