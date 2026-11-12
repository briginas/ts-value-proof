import type { ProgramIR } from "./ir.ts";
import { numericSort, validateIR } from "./ir-integrity.ts";
import { verifyIntegers } from "./bigint-backend.ts";
import { verifyNumbers } from "./number-backend.ts";
import type { SolverLimits } from "./verification-engine.ts";
export type { SolverLimits, VerificationResult } from "./verification-engine.ts";

let pending: Promise<unknown> = Promise.resolve();

export async function verifyProgram(program: ProgramIR, limits: SolverLimits = {}) {
  validateIR(program);
  // Backends share Z3 contexts. Do not overlap solver operations across builds/API callers.
  const result = pending.then(() => numericSort(program) === "int"
    ? verifyIntegers(program, limits) : verifyNumbers(program, limits));
  pending = result.catch(() => {});
  return result;
}
