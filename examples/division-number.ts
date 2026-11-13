import { contract } from "../src/contract.ts";

export function third(): number {
  return 1 / 3;
}

contract(third, {
  ensures: result => result === 0.3333333333333333,
});

export function negativeInfinity(): number {
  return 1 / -0;
}

contract(negativeInfinity, {
  ensures: result => result === -Infinity,
});
