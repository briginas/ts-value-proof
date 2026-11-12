import fc from "fast-check";
import type { Expr, FunctionIR } from "./ir.ts";
import { decodeNumber, encodeNumber } from "./numeric-values.ts";

/** Adjacent representable values in numerical order; both zero signs share
 * the same numerical neighbours. Infinities have one finite neighbour. */
export function nextNumber(value: number, direction: -1 | 1): number {
  if (Number.isNaN(value) || value === direction * Infinity) return value;
  if (value === 0) return direction * Number.MIN_VALUE;
  const encoded = encodeNumber(value);
  if (!("bits" in encoded)) return NaN;
  const bits = BigInt("0x" + encoded.bits) + BigInt(value > 0 ? direction : -direction);
  return decodeNumber({kind:"number",bits:bits.toString(16).padStart(16,"0")});
}
export function numberPool(fn: FunctionIR): number[] {
  const values = [NaN,Infinity,-Infinity,0,-0,1,-1,Number.MIN_VALUE,-Number.MIN_VALUE,
    2**-1022,-(2**-1022),Number.MAX_VALUE,-Number.MAX_VALUE,2**53,-(2**53)];
  function constants(expr: Expr): void {
    if (expr.kind === "number") values.push(decodeNumber(expr.value));
    else if (expr.kind === "unary") {
      if (expr.op === "-" && expr.operand.kind === "number") values.push(-decodeNumber(expr.operand.value));
      constants(expr.operand);
    } else if (expr.kind === "binary") { constants(expr.left); constants(expr.right); }
  }
  for (const contract of fn.contracts) constants(contract.predicate);
  const unique = new Map<string,number>();
  for (const value of values) for (const edge of [value,nextNumber(value,-1),nextNumber(value,1)])
    unique.set(JSON.stringify(encodeNumber(edge)),edge);
  return [...unique.values()];
}
export function numberArbitrary(fn: FunctionIR): fc.Arbitrary<number> {
  return fc.oneof(fc.constantFrom(...numberPool(fn)),
    fc.double({noNaN:false,noDefaultInfinity:false,noInteger:false}));
}
