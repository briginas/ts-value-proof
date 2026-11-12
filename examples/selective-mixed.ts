import { contract } from "../src/contract.js";
type Metadata = { label: string };
function amount(label: string, value: number, metadata: Metadata): number { return value; }
contract(amount, {
  requires: (_label, value) => value >= 0,
  ensures: result => result >= 0,
});
