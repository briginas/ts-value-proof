import type { ProgramIR } from "./ir.ts";
import { numericSort, validateIR } from "./ir-integrity.ts";
import { verifyIntegers } from "./bigint-backend.ts";
import { verifyNumbers } from "./number-backend.ts";
import type { SolverLimits } from "./verification-engine.ts";
import { enumerateObligations } from "./obligations.ts";
import { reconcile } from "./cross-check.ts";
import { checkLeanObligations } from "./lean-translation.ts";
export type { VerificationResult } from "./cross-check.ts";
export type { SolverLimits } from "./verification-engine.ts";

let pending: Promise<unknown> = Promise.resolve();

export async function verifyProgram(program: ProgramIR, limits: SolverLimits = {}) {
  validateIR(program);
  const obligations = enumerateObligations(program);
  // Backends share Z3 contexts. Do not overlap solver operations across builds/API callers.
  const result = pending.then(() => numericSort(program) === "int"
    ? verifyIntegers(program, limits, obligations) : verifyNumbers(program, limits, obligations));
  pending = result.catch(() => {});
  const [z3, lean] = await Promise.all([result, checkLeanObligations(obligations)]);
  return reconcile(obligations, z3, lean);
}
