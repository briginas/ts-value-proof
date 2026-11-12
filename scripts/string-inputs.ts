import fc from "fast-check";
import type { Expr, FunctionIR } from "./ir.ts";

export function stringPool(fn: FunctionIR): string[] {
  const values = new Set(["", "a", "\0", "😀", "\ud800", "\udfff", "e\u0301", "é"]);
  function visit(expr: Expr): void {
    if (expr.kind === "string") values.add(expr.value);
    else if (expr.kind === "unary" || expr.kind === "length") visit(expr.operand);
    else if (expr.kind === "binary") { visit(expr.left); visit(expr.right); }
    else if (expr.kind === "ternary") { visit(expr.condition); visit(expr.then); visit(expr.else); }
    else if (expr.kind === "call") expr.args.forEach(visit);
  }
  visit(fn.body);
  fn.contracts.forEach(c => visit(c.predicate));
  return [...values];
}

export function stringArbitrary(fn: FunctionIR): fc.Arbitrary<string> {
  return fc.oneof(fc.constantFrom(...stringPool(fn)),
    fc.array(fc.integer({min:0,max:65535}), {maxLength:64}).map(units => String.fromCharCode(...units)));
}
