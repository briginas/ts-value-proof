import { contract } from "../../src/contract.js";
import { identityAlias } from "./identity.js";

contract(identityAlias, {
  requires: value => value >= 0n,
  ensures: (result, value) => result === value,
});
