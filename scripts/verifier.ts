import { dependencies, verificationScope } from "./dependencies.ts";
import { numericSort } from "./ir-integrity.ts";
import { semanticsFor, type Semantics } from "./numeric-values.ts";
import path from "node:path";
import { prepareSource, UnsupportedNumericModel, type PreparedSource } from "./adapter.ts";
import { verifyProgram } from "./verification.ts";
import type { VerificationResult, SolverLimits } from "./verification.ts";
import { InputDiagnostic, type InputReasonCode } from "./diagnostics.ts";
import type { SourceLocation } from "./ir.ts";
export type { VerificationResult, SolverLimits } from "./verification.ts";

export type VerificationReport = {
  input: string;
  semantics: Semantics | "unsupported" | "logical";
  status: "verified" | "refuted" | "inconsistent" | "unknown";
  reason?: string;
  reasonCode?: InputReasonCode | "verification-error";
  source?: SourceLocation;
  results: VerificationResult[];
  scope?: ReturnType<typeof verificationScope>;
};
export async function verify(input: string, limits: SolverLimits = {}): Promise<VerificationReport> {
  let adapted;
  try { adapted = prepareSource(input); }
  catch (error) {
    if (!(error instanceof UnsupportedNumericModel)) throw error;
    return failureReport(input, error);
  }
  return verifyPrepared(adapted, limits);
}
export async function verifyPrepared(snapshot: PreparedSource, limits: SolverLimits = {}): Promise<VerificationReport> {
  const { input, ir: adapted } = snapshot;
  const results = await verifyProgram(adapted, limits);
  const status = results.some(r => r.status === "inconsistent") ? "inconsistent"
    : results.some(r => r.status === "disproved") ? "refuted"
    : results.some(r => r.status === "unknown") ? "unknown" : "verified";
  return { input: path.resolve(input),
    semantics: dependencies(adapted).sorts.size ? semanticsFor(dependencies(adapted).sorts.has("string") ? "string" : numericSort(adapted)) : "logical",
    scope: verificationScope(adapted), status, results };
}
export function failureReport(input: string, error: unknown): VerificationReport {
  return { input: path.resolve(input), semantics: "unsupported", status: "unknown",
    reason: error instanceof Error ? error.message : String(error),
    reasonCode: error instanceof InputDiagnostic ? error.reasonCode : "verification-error",
    ...(error instanceof InputDiagnostic && error.source ? { source: error.source } : {}), results: [] };
}
