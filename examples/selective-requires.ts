import { contract } from "../src/contract.js";
function amount(value: number): number { return value; }
contract(amount, { requires: value => value >= 0 });
