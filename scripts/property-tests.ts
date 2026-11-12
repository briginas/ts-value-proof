import { encodeScalar, type EncodedValue, type Scalar } from "./numeric-values.ts";
import { stringArbitrary } from "./string-inputs.ts";
import { numberArbitrary } from "./number-inputs.ts";
import type { SolverLimits } from "./verification.ts";
import fc from "fast-check";
import { verifyProgram } from "./verification.ts";
import type { Expr } from "./ir.ts";
import type { TestRuntime } from "./test-runtime.ts";

export type PropertyOptions = { numRuns?: number; seed?: number; maxSkipsPerRun?: number; solverLimits?: SolverLimits };
export type PropertyResult = {
  function: string;
  sourceName: string;
  status: "passed" | "failed" | "inconsistent" | "insufficient-inputs" | "unknown";
  checked: number;
  skipped: number;
  seed?: number;
  counterexample?: EncodedValue[];
  counterexamplePath?: string;
  reason?: string;
};

function constants(expression: Expr, values: Set<bigint>): void {
  if (expression.kind === "bigint") values.add(BigInt(expression.value));
  else if (expression.kind === "unary") {
    if (expression.op === "-" && expression.operand.kind === "bigint") values.add(-BigInt(expression.operand.value));
    constants(expression.operand, values);
  } else if (expression.kind === "binary") {
    constants(expression.left, values); constants(expression.right, values);
  }
}

/** Rejection sampling uses the real requires predicate. Constants and adjacent
 * integers improve boundary coverage; arbitrary-precision random values explore
 * the wider domain. Exhausted sampling is an explicit non-success, not a proof.
 */
export async function checkProperties(runtime: TestRuntime, options: PropertyOptions = {}): Promise<PropertyResult[]> {
  const numRuns = options.numRuns ?? 100;
  const maxSkipsPerRun = options.maxSkipsPerRun ?? 100;
  if (!Number.isSafeInteger(numRuns) || numRuns < 1 || !Number.isSafeInteger(maxSkipsPerRun) || maxSkipsPerRun < 1)
    throw new Error("Property run and skip counts must be positive safe integers");
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < -2147483648 || options.seed > 2147483647))
    throw new Error("Property seed must be a signed 32-bit integer");
  const verification = await verifyProgram(runtime.ir, options.solverLimits);
  const results: PropertyResult[] = [];
  for (const fn of runtime.ir.functions.filter(fn => fn.contracts.length)) {
    const base = { function: fn.name, sourceName: fn.sourceName, checked: 0, skipped: 0 };
    const preconditions = verification.find(result => result.function === fn.name && result.kind === "preconditions");
    if (fn.contracts.some(c => c.kind === "requires") && (!preconditions || preconditions.status !== "satisfiable")) {
      results.push({ ...base, status: preconditions?.status === "inconsistent" ? "inconsistent" : "unknown",
        reason: preconditions && "reason" in preconditions ? preconditions.reason : "Precondition consistency was not established" });
      continue;
    }
    function hasInternalRequirement(name: string): boolean {
      return runtime.sites.filter(site => site.caller === name).some(site =>
        runtime.ir.functions.find(f => f.name === site.callee)!.contracts.some(c => c.kind === "requires") || hasInternalRequirement(site.callee));
    }
    const hasGuarantee = fn.contracts.some(c => c.kind === "ensures") || hasInternalRequirement(fn.name);
    if (!hasGuarantee) {
      results.push({ ...base, status: "unknown", reason: "No ensures or internal requires to test" });
      continue;
    }
    const values = new Set<bigint>([0n, 1n, -1n]);
    for (const contract of fn.contracts) constants(contract.predicate, values);
    const edges = new Set([...values].flatMap(value => [value - 1n, value, value + 1n]));
    const inputs: fc.Arbitrary<Scalar[]> = fc.tuple(...fn.params.map(p => p.sort === "string" ? stringArbitrary(fn)
      : p.sort === "float64" ? numberArbitrary(fn) : fc.oneof(fc.constantFrom(...edges), fc.bigInt())));
    let checked = 0;
    const property = fc.property(inputs, args => {
      fc.pre(runtime.accepts(fn.name, args));
      checked++;
      const execution = runtime.execute(fn.name, args);
      return execution.ensures !== false && execution.calls.every(call => call.accepted);
    });
    const run = fc.check(property, { numRuns, maxSkipsPerRun, seed: options.seed });
    const status = run.failed ? run.counterexample ? "failed" : "insufficient-inputs"
      : run.interrupted || checked < numRuns ? "insufficient-inputs" : "passed";
    results.push({ ...base, checked, skipped: run.numSkips, seed: run.seed, status,
      ...(run.counterexample ? { counterexample: run.counterexample[0].map(encodeScalar), counterexamplePath: run.counterexamplePath } : {}),
      ...(status === "passed" ? {} : { reason: status === "failed"
        ? "Actual implementation violated ensures or an internal call's requires"
        : "Not enough inputs satisfying requires were executed" }),
    });
  }
  return results;
}
