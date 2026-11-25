import { callPaths } from "./dependencies.ts";
import type { Expr, FunctionIR, Predicate, ProgramIR } from "./ir.ts";
import { assertCoverage } from "./ir-integrity.ts";

export type VerificationObligation = {
  key: string;
  owner: FunctionIR;
  requirements: Predicate[];
} & (
  | { kind: "preconditions" }
  | { kind: "implementation"; predicate: Predicate }
  | { kind: "call"; predicate: Predicate; callee: FunctionIR; call: Extract<Expr, { kind: "call" }>; path: Expr }
);

// Both translators consume the same occurrences, before any solver-specific filtering.
export function enumerateObligations(program: ProgramIR): VerificationObligation[] {
  const functions = new Map(program.functions.map(fn => [fn.name, fn]));
  const obligations: VerificationObligation[] = [];
  const observedCalls = new Set<string>();
  const position = (p: Predicate) => [p.source.file, p.source.start, p.source.end];
  for (const owner of program.functions) {
    const requirements = owner.contracts.filter(p => p.kind === "requires");
    const base = { owner, requirements };
    if (requirements.length) {
      const key = JSON.stringify([owner.name, "preconditions", requirements.map(position)]);
      obligations.push({ ...base, key, kind: "preconditions" });
    }
    for (const [occurrence, { call, path }] of callPaths(owner.body).entries()) {
      observedCalls.add(call.id);
      const callee = functions.get(call.callee)!;
      for (const predicate of callee.contracts.filter(p => p.kind === "requires")) {
        const key = JSON.stringify([owner.name, "call", call.id, occurrence, position(predicate)]);
        obligations.push({ ...base, key, kind: "call", predicate, callee, call, path });
      }
    }
    for (const predicate of owner.contracts.filter(p => p.kind === "ensures")) {
      const key = JSON.stringify([owner.name, "implementation", position(predicate)]);
      obligations.push({ ...base, key, kind: "implementation", predicate });
    }
  }
  assertCoverage(program.coverage.calls, observedCalls, "Backend call");
  return obligations;
}
