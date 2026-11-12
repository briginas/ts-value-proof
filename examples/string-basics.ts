import { contract } from "../src/contract.js";

export function concat(left: string, right: string): string {
  return left + right;
}

contract(concat, {
  ensures: (result, left, right) =>
    result === left + right && result.length === left.length + right.length,
});

export function nonempty(value: string): string {
  return value;
}

contract(nonempty, {
  requires: value => value !== "",
  ensures: (result, value) => result === value,
});

export function withFallback(value: string): string {
  if (value === "") return "😀";
  return nonempty(value);
}

contract(withFallback, {
  ensures: result => result !== "",
});

export function utf16Length(value: string): number {
  return value.length;
}

contract(utf16Length, {
  ensures: (result, value) => result === value.length && result >= 0,
});
