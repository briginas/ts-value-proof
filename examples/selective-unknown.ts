import { contract } from "../src/contract.js";
function choose(flag: boolean, value: number): number {
  if (flag) return value;
  return 0;
}
contract(choose, {
  requires: (_flag, value) => value >= 0,
  ensures: result => result >= 0,
});
