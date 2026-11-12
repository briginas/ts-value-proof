import { init, type Arith, type Bool, type Context } from "z3-solver";
import type { ProgramIR } from "./ir.ts";
import { numericSort, validateIR } from "./ir-integrity.ts";
import { verifyWithModel, type NumericModel, type SolverLimits } from "./verification-engine.ts";
export type { SolverLimits, ProofResult, VerificationResult } from "./verification-engine.ts";

type Value = Arith<"main"> | Bool<"main">;
let context: Promise<Context<"main">> | undefined;
export async function verifyIntegers(program: ProgramIR, limits: SolverLimits = {}) {
  validateIR(program);
  if (numericSort(program) !== "int") throw new Error("Integer backend requires bigint IR");
  const ctx = await (context ??= init().then(({ Context }) => new Context("main")));
  const boolean = (value: Value): Bool<"main"> => {
    if (!ctx.isBool(value)) throw new Error("Expected boolean expression: " + value.toString());
    return value;
  };
  const numeric = (value: Value): Arith<"main"> => {
    if (!ctx.isArith(value) || !ctx.isInt(value)) throw new Error("Expected integer expression");
    return value;
  };
  const model: NumericModel<Value> = {
    sort: "int", boolean, numeric,
    literal: expr => { if (expr.kind !== "bigint") throw new Error("Expected bigint literal"); return ctx.Int.val(expr.value); },
    variable: name => ctx.Int.const(name), truth: value => ctx.Bool.val(value),
    neg: value => numeric(value).neg(),
    add: (a,b) => numeric(a).add(numeric(b)), sub: (a,b) => numeric(a).sub(numeric(b)),
    lt: (a,b) => numeric(a).lt(numeric(b)), le: (a,b) => numeric(a).le(numeric(b)),
    gt: (a,b) => numeric(a).gt(numeric(b)), ge: (a,b) => numeric(a).ge(numeric(b)),
    eq: (a,b) => ctx.isBool(a) ? a.eq(boolean(b)) : numeric(a).eq(numeric(b)),
    Not: a => ctx.Not(boolean(a)), And: (...args) => ctx.And(...args.map(boolean)),
    Or: (...args) => ctx.Or(...args.map(boolean)), Implies: (a,b) => ctx.Implies(boolean(a),boolean(b)),
    If: (a,b,c) => ctx.If(boolean(a),numeric(b),numeric(c)),
    async solve(assumptions, variables, limits) {
      // Keep the high-level wrapper's original ownership policy. Its AST/model
      // finalizers manage references; the low-level FP backend owns refs itself.
      const solver = new ctx.Solver();
      solver.set("timeout", limits.timeoutMs ?? 5000);
      if (limits.resourceLimit !== undefined) solver.set("rlimit", limits.resourceLimit);
      solver.add(...assumptions.map(boolean));
      const status = await solver.check();
      if (status === "unknown") return { status, reason: solver.reasonUnknown() };
      if (status === "unsat") return { status };
      const counterexample: Record<string, string> = Object.create(null);
      const result = solver.model();
      for (const [name, variable] of variables) {
        const value = result.eval(numeric(variable), true);
        if (!ctx.isIntVal(value)) throw new Error("Noninteger value in integer counterexample");
        counterexample[name] = value.value().toString() + "n";
      }
      return { status, counterexample };
    },
  };
  return verifyWithModel(program, model, limits);
}
