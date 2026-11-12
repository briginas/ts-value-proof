import type { ProgramIR } from "./ir.ts";
import { numericSort, validateIR } from "./ir-integrity.ts";
import { verifyIntegers } from "./bigint-backend.ts";
import { verifyNumbers } from "./number-backend.ts";
import type { SolverLimits } from "./verification-engine.ts";
export type { SolverLimits, VerificationResult } from "./verification-engine.ts";

export async function verifyProgram(program: ProgramIR, limits: SolverLimits = {}) {
  validateIR(program);
  return numericSort(program) === "int" ? verifyIntegers(program, limits) : verifyNumbers(program, limits);
}
