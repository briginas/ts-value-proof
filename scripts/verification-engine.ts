import { prettyExpr, type Expr, type FunctionIR, type ProgramIR, type SourceLocation, type ValueSort } from "./ir.ts";
import { callPaths, truth, and, not } from "./dependencies.ts";
import { assertCoverage, validateIR } from "./ir-integrity.ts";
import { encodeScalar, type EncodedValue, type NumericSort } from "./numeric-values.ts";

/** The traversal owns paths and obligations; a model owns terms and solver resources. */
export type NumericModel<V> = {
  sort: NumericSort;
  literal(expr: Extract<Expr, {kind: "bigint" | "number" | "string"}>): V;
  variable(name: string, sort?: ValueSort): V;
  supports?(sort: ValueSort): boolean;
  length?(value: V): V;
  truth(value: boolean): V;
  boolean(value: V): V;
  numeric(value: V): V;
  neg(value: V): V;
  add(left: V, right: V): V;
  sub(left: V, right: V): V;
  lt(left: V, right: V): V;
  le(left: V, right: V): V;
  gt(left: V, right: V): V;
  ge(left: V, right: V): V;
  eq(left: V, right: V): V;
  Not(value: V): V;
  And(...values: V[]): V;
  Or(...values: V[]): V;
  Implies(left: V, right: V): V;
  If(condition: V, yes: V, no: V): V;
  solve(assumptions: V[], variables: ReadonlyMap<string, V>, limits: SolverLimits): Promise<SolveResult>;
};
export type SolveResult =
  | { status: "sat"; counterexample: Record<string, EncodedValue> }
  | { status: "unsat" }
  | { status: "unknown"; reason: string };

export type SolverLimits = { timeoutMs?: number; resourceLimit?: number };
export type ProofResult =
  | { status: "proved" }
  | { status: "disproved"; reasonCode: "contract-violation"; reason: string; counterexample: Record<string, EncodedValue> }
  | { status: "unknown"; reasonCode: "solver-unknown" | "weak-callee-contract" | "unsupported-dependency" | "incomplete-counterexample"; reason: string; dependencySource?: SourceLocation };
type FunctionReference = { function: string; sourceName: string; source: SourceLocation };
type Requirement = { condition: string; source: SourceLocation };
type Obligation = FunctionReference & {
  condition: string;
  requires: Requirement[];
} & (
  | { kind: "implementation"; contractSource: SourceLocation }
  | { kind: "call"; contractSource: SourceLocation; callId: string; callSource: SourceLocation;
      callee: FunctionReference; arguments: Record<string, string>; checkedCondition: string; pathCondition: string }
);
export type VerificationResult =
  | (FunctionReference & { kind: "preconditions"; condition: string; requires: Requirement[];
      status: "satisfiable" | "inconsistent" | "unknown";
      reasonCode?: "inconsistent-contract" | "solver-unknown" | "unsupported-dependency"; reason?: string; dependencySource?: SourceLocation })
  | (Obligation & ProofResult);
type Pending<V> = {
  obligation: Obligation;
  abstractCalls?: boolean;
  incomplete?: SourceLocation;
  defaults: Record<string, EncodedValue>;
  assumptions: V[]; goal: V; variables: Map<string, V>;
};

const reference = (ir: FunctionIR): FunctionReference =>
  ({ function: ir.name, sourceName: ir.sourceName, source: ir.source });
class UnsupportedDependency extends Error {
  source: SourceLocation;
  constructor(reason: string, source: SourceLocation) { super(reason); this.source = source; }
}
const unsupportedResult = (error: unknown): ProofResult => {
  if (!(error instanceof UnsupportedDependency)) throw error;
  return { status: "unknown", reasonCode: "unsupported-dependency", reason: error.message, dependencySource: error.source };
};
function substitute(expr: Expr, bindings: ReadonlyMap<string, Expr>): Expr {
  switch (expr.kind) {
    case "ident": return bindings.get(expr.name) ?? expr;
    case "length":
    case "unary": return { ...expr, operand: substitute(expr.operand, bindings) };
    case "binary": return { ...expr, left: substitute(expr.left, bindings), right: substitute(expr.right, bindings) };
    default: return expr; // Contract predicates contain no calls, ternaries or nested bindings.
  }
}

export async function verifyWithModel<V>(program: ProgramIR, ctx: NumericModel<V>, limits: SolverLimits = {}): Promise<VerificationResult[]> {
  for (const value of [limits.timeoutMs, limits.resourceLimit])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff))
      throw new Error("Solver limits must be positive 32-bit integers");
  validateIR(program);
  const irs = program.functions;
  type Env = ReadonlyMap<string, () => V>;
  const functions = new Map(irs.map(ir => [ir.name, ir]));
  const results: VerificationResult[] = [];
  const observedCalls = new Set<string>();
  let fresh = 0;
  const bool = ctx.boolean;
  const numeric = ctx.numeric;
  const supports = (sort: ValueSort) => ctx.supports?.(sort) ?? sort === ctx.sort;
  const predicates = (ir: FunctionIR, kind: "requires" | "ensures"): Expr[] =>
    ir.contracts.filter(c => c.kind === kind).map(c => c.predicate);

  for (const ir of irs) {
    const name = ir.name;
    const requirements = ir.contracts.filter(c => c.kind === "requires");
    const details = { ...reference(ir), requires: requirements.map(p =>
      ({ condition: prettyExpr(p.predicate), source: p.source })) };
    const variables = new Map(ir.params.filter(p => supports(p.sort)).map(p => [p.name, ctx.variable(name + "::arg::" + p.name, p.sort)]));
    const defaults = Object.fromEntries(ir.params.filter(p => p.sort !== "opaque" && !supports(p.sort))
      .map(p => [p.name, encodeScalar(p.sort === "string" ? "" : p.sort === "int" ? 0n : 0)]));
    const incomplete = ir.params.find(p => p.sort === "opaque");
    const env: Env = new Map(ir.params.map(p => [p.name, () => {
      if (!supports(p.sort)) throw new UnsupportedDependency(`Unsupported parameter ${p.name}: ${p.type ?? p.sort}`, p.source ?? ir.source);
      return variables.get(p.name)!;
    }]));
    const facts: V[] = [];
    let abstractCalls = false;
    let pre: V[] = [];

    function evaluate(expr: Expr, bindings: Env, output?: () => V,
                      path = ctx.truth(true), allowCalls = false, pathExpr: Expr = truth): V {
      switch (expr.kind) {
        case "opaque":
        case "unsupported": throw new UnsupportedDependency(`Unsupported dependency: ${expr.text}`, expr.source);
        case "length":
          if (!ctx.length) throw new Error("String length in incompatible backend");
          return ctx.length(evaluate(expr.operand, bindings, output, path, allowCalls, pathExpr));
        case "string":
        case "number":
        case "bigint": return ctx.literal(expr);
        case "result":
          if (output !== undefined) return output();
          throw new Error("Result outside postcondition");
        case "literal": return ctx.truth(expr.value);
        case "ident": {
          const v = bindings.get(expr.name);
          if (!v) throw new Error("Unbound IR identifier: " + expr.name);
          return v();
        }
        case "unary": {
          const v = evaluate(expr.operand, bindings, output, path, allowCalls, pathExpr);
          if (expr.op === "!") return ctx.Not(bool(v));
          if (expr.op === "-") return ctx.neg(numeric(v));
          throw new Error("Unsupported unary operation: " + expr.op);
        }
        case "binary": {
          const left = evaluate(expr.left, bindings, output, path, allowCalls, pathExpr);
          const rightPath = expr.op === "&&" ? ctx.And(path, bool(left))
            : expr.op === "||" ? ctx.And(path, ctx.Not(bool(left))) : path;
          const rightExpr = expr.op === "&&" ? and(pathExpr, expr.left)
            : expr.op === "||" ? and(pathExpr, not(expr.left)) : pathExpr;
          const right = evaluate(expr.right, bindings, output, rightPath, allowCalls, rightExpr);
          switch (expr.op) {
            case "+": return ctx.add(left, right);
            case "-": return ctx.sub(numeric(left), numeric(right));
            case "<": return ctx.lt(numeric(left), numeric(right));
            case "<=": return ctx.le(numeric(left), numeric(right));
            case ">": return ctx.gt(numeric(left), numeric(right));
            case ">=": return ctx.ge(numeric(left), numeric(right));
            case "&&": return ctx.And(bool(left), bool(right));
            case "||": return ctx.Or(bool(left), bool(right));
            case "===":
            case "!==": {
              const equal = ctx.eq(left, right);
              return expr.op === "===" ? equal : ctx.Not(equal);
            }
            default: throw new Error("Unsupported binary operation");
          }
        }
        case "ternary": {
          const condition = bool(evaluate(expr.condition, bindings, output, path, false));
          const yes = evaluate(expr.then, bindings, output, ctx.And(path, condition), allowCalls, and(pathExpr, expr.condition));
          const no = evaluate(expr.else, bindings, output, ctx.And(path, ctx.Not(condition)), allowCalls, and(pathExpr, not(expr.condition)));
          return ctx.If(condition, yes, no);
        }
        case "call": {
          if (!allowCalls) throw new Error("Unsupported call in pure predicate: " + expr.callee);
          const callee = functions.get(expr.callee)!;
          if (!supports(callee.returnSort))
            throw new UnsupportedDependency("Unsupported callee result: " + callee.sourceName, expr.source);
          const callEnv: Env = new Map(callee.params.map((p, i) => [p.name, () => evaluate(expr.args[i], bindings)]));
          // An untranslatable requires must never authorize using a guarantee.
          for (const requirement of predicates(callee, "requires")) evaluate(requirement, callEnv);
          const result = ctx.variable(name + "::call::" + fresh++, callee.returnSort);
          abstractCalls = true;
          for (const guarantee of predicates(callee, "ensures"))
            facts.push(ctx.Implies(path, bool(evaluate(guarantee, callEnv, () => result))));
          return result;
        }
        default: throw new Error("Unsupported IR expression");
      }
    }

    const paths = callPaths(ir.body);
    for (const {call} of paths) observedCalls.add(call.id);
    let preFailure: ProofResult | undefined;
    let inconsistent = false;
    if (requirements.length) {
      const base = { ...details, kind: "preconditions" as const,
        condition: prettyExpr(requirements.reduce((expr, p) => and(expr, p.predicate), truth)) };
      try {
        pre = predicates(ir, "requires").map(p => bool(evaluate(p, env)));
        const consistency = await ctx.solve(pre, new Map(), limits);
        inconsistent = consistency.status === "unsat";
        if (consistency.status === "unknown") preFailure = { status: "unknown", reasonCode: "solver-unknown", reason: consistency.reason };
        results.push({ ...base, status: consistency.status === "sat" ? "satisfiable" : inconsistent ? "inconsistent" : "unknown",
          ...(consistency.status === "unknown" ? { reasonCode: "solver-unknown" as const, reason: consistency.reason }
            : inconsistent ? { reasonCode: "inconsistent-contract" as const, reason: "Preconditions are contradictory; no inputs satisfy this contract" } : {}) });
      } catch (error) {
        const failure = unsupportedResult(error);
        if (failure.status !== "unknown" || failure.reasonCode !== "unsupported-dependency") throw error;
        preFailure = failure;
        results.push({ ...base, ...failure, reasonCode: "unsupported-dependency" });
      }
    }
    if (inconsistent) continue;
    async function check(obligation: Obligation, goal: () => V, path?: Expr): Promise<void> {
      if (preFailure) { results.push({ ...obligation, ...preFailure }); return; }
      facts.length = 0;
      abstractCalls = false;
      try {
        const assumptions = [...pre];
        if (path) assumptions.push(bool(evaluate(path, env)));
        const value = bool(goal());
        const task: Pending<V> = { obligation, assumptions: [...assumptions, ...facts], goal: value, variables,
          abstractCalls, incomplete: incomplete ? incomplete.source ?? ir.source : undefined, defaults };
        results.push({ ...obligation, ...await prove(ctx, task, limits) });
      } catch (error) { results.push({ ...obligation, ...unsupportedResult(error) }); }
    }
    for (const {call, path} of paths) {
      const callee = functions.get(call.callee)!;
      const argumentExprs = new Map(callee.params.map((p, i) => [p.name, call.args[i]]));
      const callEnv: Env = new Map(callee.params.map((p, i) => [p.name, () => evaluate(call.args[i], env)]));
      for (const requirement of callee.contracts.filter(c => c.kind === "requires")) {
        await check({ ...details, kind: "call", condition: callee.sourceName + ": " + prettyExpr(requirement.predicate),
          contractSource: requirement.source, callId: call.id, callSource: call.source,
          callee: reference(callee), arguments: Object.fromEntries([...argumentExprs].map(([key, value]) => [key, prettyExpr(value)])),
          checkedCondition: prettyExpr(substitute(requirement.predicate, argumentExprs)), pathCondition: prettyExpr(path) },
          () => evaluate(requirement.predicate, callEnv), path);
      }
    }
    for (const post of ir.contracts.filter(c => c.kind === "ensures")) {
      let body: V | undefined;
      await check({ ...details, kind: "implementation", condition: prettyExpr(post.predicate), contractSource: post.source },
        () => evaluate(post.predicate, env, () => {
          if (ir.returnSort === "opaque") throw new UnsupportedDependency("Unsupported result type: " + ir.sourceName, ir.source);
          return body ??= evaluate(ir.body, env, undefined, ctx.truth(true), true);
        }));
    }
  }
  assertCoverage(program.coverage.calls, observedCalls, "Backend call");
  return results;
}

async function prove<V>(ctx: NumericModel<V>, task: Pending<V>, limits: SolverLimits): Promise<ProofResult> {
  const answer = await ctx.solve([...task.assumptions, ctx.Not(task.goal)], task.abstractCalls ? new Map() : task.variables, limits);
  if (answer.status === "unsat") return { status: "proved" };
  if (answer.status === "unknown") return { status: "unknown", reasonCode: "solver-unknown", reason: answer.reason };
  // Abstract call results need not be executable by the actual callee.
  if (task.abstractCalls)
    return { status: "unknown", reasonCode: "weak-callee-contract", reason: "Callee contracts permit a violating model; strengthen their postconditions to prove this caller" };
  if (task.incomplete) return { status: "unknown", reasonCode: "incomplete-counterexample",
    reason: "A violating numeric model has no complete concrete input for the opaque parameters", dependencySource: task.incomplete };
  return { status: "disproved", reasonCode: "contract-violation",
    reason: task.obligation.kind === "call" ? "Call arguments violate the callee precondition on this path"
      : "The implementation violates its postcondition for these inputs", counterexample: Object.assign(Object.create(null), task.defaults, answer.counterexample) };
}
