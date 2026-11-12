import { contract } from "../../src/contract.js";
import { identityAlias as identity } from "./identity.js";
import "./contracts.js";

export function increment(value: bigint): bigint { return identity(value) + 1n; }
contract(increment, {
  requires: value => value >= 0n,
  ensures: (result, value) => result === value + 1n,
});
