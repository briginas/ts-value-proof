import type { VerificationObligation } from "./obligations.ts";
import type { VerificationResult as Z3Result } from "./verification-engine.ts";

type DefiniteStatus = Exclude<Z3Result["status"], "unknown">;
export type LeanVerdict =
  | { status: DefiniteStatus }
  | { status: "unknown" | "unsupported" | "unavailable"; reason: string };

type CrossCheck = {
  z3: { status: Z3Result["status"] };
  lean: LeanVerdict;
  comparison: "agreed" | "disagreement" | "unconfirmed";
};

export type VerificationResult = Z3Result<"backend-disagreement"> & { crossCheck: CrossCheck };

function compare(z3: Z3Result["status"], lean: LeanVerdict): CrossCheck {
  const uncertain = z3 === "unknown" || lean.status === "unknown" || lean.status === "unsupported" || lean.status === "unavailable";
  return { z3: { status: z3 }, lean, comparison: uncertain ? "unconfirmed" : z3 === lean.status ? "agreed" : "disagreement" };
}

/** Reconcile by source occurrence, including the Z3 short circuit for inconsistent requires. */
export function reconcile(obligations: readonly VerificationObligation[], rows: readonly (Z3Result & { key: string })[],
                          lean: ReadonlyMap<string, LeanVerdict>): VerificationResult[] {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const expected = new Set(obligations.map(o => o.key));
  if (expected.size !== obligations.length || byKey.size !== rows.length || lean.size !== expected.size ||
      rows.some(r => !expected.has(r.key)))
    throw new Error("Invalid cross-check obligation coverage");

  const disputed = new Set<string>();
  const inconsistent = new Set(rows.filter(r => r.kind === "preconditions" && r.status === "inconsistent").map(r => r.function));
  for (const row of rows) {
    if (row.kind !== "preconditions") continue;
    const verdict = lean.get(row.key);
    if (verdict && compare(row.status, verdict).comparison === "disagreement") disputed.add(row.function);
  }

  const results: VerificationResult[] = [];
  for (const item of obligations) {
    const verdict = lean.get(item.key);
    if (!verdict) throw new Error("Missing Lean verdict for " + item.key);
    if (!("reason" in verdict) && (item.kind === "preconditions") !==
        (verdict.status === "satisfiable" || verdict.status === "inconsistent"))
      throw new Error("Invalid Lean verdict for " + item.key);
    const row = byKey.get(item.key);
    if (!row && item.kind !== "preconditions" && inconsistent.has(item.owner.name)) continue;
    if (!row || row.kind !== item.kind || row.function !== item.owner.name)
      throw new Error("Missing or mismatched Z3 verdict for " + item.key);

    const { key, ...result } = row;
    const crossCheck = compare(result.status, verdict);
    const conflict = crossCheck.comparison === "disagreement";
    if (conflict || (result.status === "proved" && disputed.has(result.function))) {
      const { counterexample: _, ...details } = "counterexample" in result ? result : { ...result, counterexample: undefined };
      results.push({ ...details, crossCheck, status: "unknown", reasonCode: "backend-disagreement",
        reason: conflict ? "Z3 and Lean returned opposite verdicts for this obligation"
          : "Z3 and Lean disagree on the consistency of this function's preconditions" });
    } else {
      results.push({ ...result, crossCheck });
    }
  }
  return results;
}
