import type { LeanVerdict } from "./cross-check.ts";
import type { Expr } from "./ir.ts";
import { runLeanGoals, type LeanGoal, type LeanRunnerOptions } from "./lean-runner.ts";
import type { VerificationObligation } from "./obligations.ts";

type Term = { text: string; sort: "Int" | "Prop" };
type Bindings = ReadonlyMap<string, () => Term>;
type Translation = { goal: LeanGoal } | { unsupported: string };

class OutsideLeanFragment extends Error {}

const int = (text: string): Term => ({ text, sort: "Int" });
const prop = (text: string): Term => ({ text, sort: "Prop" });

function as(term: Term, sort: Term["sort"]): string {
  if (term.sort !== sort) throw new Error(`Expected ${sort} in Lean translation, got ${term.sort}`);
  return term.text;
}

function translate(expr: Expr, bindings: Bindings, result?: () => Term): Term {
  const visit = (child: Expr) => translate(child, bindings, result);
  switch (expr.kind) {
    case "bigint": {
      if (!/^(0|[1-9][0-9]*)$/.test(expr.value)) throw new Error("Invalid bigint in Lean translation");
      return int(`(${expr.value} : Int)`);
    }
    case "literal": return prop(expr.value ? "True" : "False");
    case "ident": {
      const binding = bindings.get(expr.name);
      if (!binding) throw new Error("Unbound identifier in Lean translation: " + expr.name);
      return binding();
    }
    case "result": {
      if (!result) throw new Error("Result outside implementation obligation");
      return result();
    }
    case "sequence":
      // A discarded initializer still executes. All operations in our fragment are total.
      visit(expr.first);
      return visit(expr.then);
    case "ternary": {
      const condition = as(visit(expr.condition), "Prop");
      const yes = visit(expr.then);
      return { sort: yes.sort, text: `(if ${condition} then ${yes.text} else ${as(visit(expr.else), yes.sort)})` };
    }
    case "unary": {
      const operand = visit(expr.operand);
      if (expr.op === "!") return prop(`(¬ ${as(operand, "Prop")})`);
      return int(`(-${as(operand, "Int")})`);
    }
    case "binary": {
      if (expr.op === "/") throw new OutsideLeanFragment("Lean does not model operator /");
      const left = visit(expr.left), right = visit(expr.right);
      switch (expr.op) {
        case "*":
        case "+":
        case "-": return int(`(${as(left, "Int")} ${expr.op} ${as(right, "Int")})`);
        case "<":
        case ">":
        case "<=":
        case ">=": return prop(`(${as(left, "Int")} ${expr.op} ${as(right, "Int")})`);
        case "&&":
        case "||": return prop(`(${as(left, "Prop")} ${expr.op === "&&" ? "∧" : "∨"} ${as(right, "Prop")})`);
        case "===":
        case "!==": {
          const equality = `(${left.text} ${left.sort === "Prop" ? "↔" : "="} ${as(right, left.sort)})`;
          return prop(expr.op === "===" ? equality : `(¬ ${equality})`);
        }
      }
    }
    case "call": throw new OutsideLeanFragment("Lean does not model abstract call results");
    case "opaque":
    case "unsupported": throw new OutsideLeanFragment(`Unsupported Lean dependency: ${expr.text}`);
    case "number":
    case "length":
    case "string": throw new OutsideLeanFragment(`Lean does not model ${expr.kind} expressions`);
  }
}

/** Bind only inputs the obligation reads. Source names and diagnostic text never enter Lean code. */
export function translateLeanObligation(obligation: VerificationObligation): Translation {
  const { owner, requirements, key, kind } = obligation;
  const used = new Set<string>();
  const inputs: Bindings = new Map(owner.params.map((param, index) => [param.name, () => {
    if (param.sort !== "int") throw new OutsideLeanFragment(`Lean does not model parameter ${param.name} of sort ${param.sort}`);
    const name = `v${index}`;
    used.add(name);
    return int(name);
  }]));
  try {
    const assumptions = requirements.map(req => as(translate(req.predicate, inputs), "Prop"));
    let goal = "True";
    if (obligation.kind === "implementation") {
      let result: Term | undefined;
      goal = as(translate(obligation.predicate.predicate, inputs, () => {
        if (owner.returnSort !== "int") throw new OutsideLeanFragment(`Lean does not model result sort ${owner.returnSort}`);
        return result ??= translate(owner.body, inputs);
      }), "Prop");
    }
    if (obligation.kind === "call") {
      assumptions.push(as(translate(obligation.path, inputs), "Prop"));
      const args: Bindings = new Map(obligation.callee.params.map((param, index) =>
        [param.name, () => translate(obligation.call.args[index], inputs)]));
      goal = as(translate(obligation.predicate.predicate, args), "Prop");
    }
    return { goal: { key, kind, variables: [...used], assumptions, goal } };
  } catch (error) {
    if (error instanceof OutsideLeanFragment) return { unsupported: error.message };
    throw error;
  }
}

export async function checkLeanObligations(obligations: readonly VerificationObligation[],
                                           options?: LeanRunnerOptions): Promise<Map<string, LeanVerdict>> {
  const goals: LeanGoal[] = [];
  const results = new Map<string, LeanVerdict>();
  for (const obligation of obligations) {
    const translation = translateLeanObligation(obligation);
    if ("goal" in translation) goals.push(translation.goal);
    else results.set(obligation.key, { status: "unsupported", reason: translation.unsupported });
  }
  if (goals.length) {
    const answers = await runLeanGoals(goals, options);
    for (const goal of goals) {
      const verdict = answers.get(goal.key);
      if (!verdict) throw new Error("Missing Lean verdict for obligation: " + goal.key);
      results.set(goal.key, verdict);
    }
  }
  return results;
}
