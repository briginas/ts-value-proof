import { contract } from "../src/contract.js";
function identity(value: number): number { return value; }
// NaN is a counterexample: it is not equal to itself.
contract(identity, { ensures: (result, value) => result === value });
