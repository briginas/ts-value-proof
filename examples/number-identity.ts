import { contract } from "../src/contract.js";

export function identity(x: number): number {
  return x;
}

// Strict equality excludes NaN; both zero signs and infinities remain allowed.
contract(identity, {
  requires: x => x === x,
  ensures: (result, x) => result === x,
});
