import type { Expr, ProgramIR } from "./ir.ts";
import type { ScalarSort } from "./numeric-values.ts";

export const truth: Expr = { kind: "literal", value: true };
export const and = (left: Expr, right: Expr): Expr =>
  left.kind === "literal" && left.value ? right : { kind: "binary", op: "&&", left, right };
export const not = (operand: Expr): Expr => ({ kind: "unary", op: "!", operand });

/** Enumerate every lowered path, retaining the original call identity. */
export function callPaths(body: Expr, path: Expr = truth): { call: Extract<Expr, {kind:"call"}>; path: Expr }[] {
  switch (body.kind) {
    case "sequence":
      // Evaluate initializers under the preceding path, before later guards.
      return callPaths(body.then, and(path, { kind: "sequence", first: body.first, then: truth }));
    case "call": return [{ call: body, path }];
    case "ternary": return [...callPaths(body.then, and(path, body.condition)), ...callPaths(body.else, and(path, not(body.condition)))];
    case "binary": return [...callPaths(body.left, path), ...callPaths(body.right,
      body.op === "&&" ? and(path, body.left) : body.op === "||" ? and(path, not(body.left)) : path)];
    case "length":
    case "unary": return callPaths(body.operand, path);
    case "unsupported": return body.dependencies.flatMap(e => callPaths(e, path));
    default: return [];
  }
}

/** Follow positional bindings on demand. Unused arguments and unused results
 * never select a numeric backend. This is analysis only, not source execution. */
export function dependencies(program: ProgramIR) {
  const sorts = new Set<ScalarSort>();
  const parameters = new Map<string, Set<string>>(program.functions.map(f => [f.name, new Set()]));
  const functions = new Map(program.functions.map(f => [f.name, f]));
  type Env = Map<string, () => void>;
  function sort(value: string): void { if (value === "int" || value === "float64" || value === "string") sorts.add(value); }
  function visit(expr: Expr, env: Env, result?: () => void): void {
    switch (expr.kind) {
      case "sequence": visit(expr.first, env, result); visit(expr.then, env, result); break;
      case "bigint": sort("int"); break;
      case "string": sort("string"); break;
      case "length": sort("float64"); visit(expr.operand, env, result); break;
      case "number": sort("float64"); break;
      case "ident": env.get(expr.name)!(); break;
      case "result": result?.(); break;
      case "unary": visit(expr.operand, env, result); break;
      case "binary": visit(expr.left, env, result); visit(expr.right, env, result); break;
      case "ternary": visit(expr.condition, env, result); visit(expr.then, env, result); visit(expr.else, env, result); break;
      case "unsupported": expr.dependencies.forEach(e => visit(e, env, result)); break;
      case "call": {
        const callee = functions.get(expr.callee)!;
        const args = new Map(callee.params.map((p, i) => [p.name, () => visit(expr.args[i], env)]));
        sort(callee.returnSort);
        for (const c of callee.contracts) visit(c.predicate, args, () => sort(callee.returnSort));
        break;
      }
    }
  }
  for (const fn of program.functions) {
    const env: Env = new Map(fn.params.map(p => [p.name, () => {
      parameters.get(fn.name)!.add(p.name); sort(p.sort);
    }]));
    for (const c of fn.contracts) visit(c.predicate, env, () => visit(fn.body, env));
    for (const {call, path} of callPaths(fn.body)) {
      const callee = functions.get(call.callee)!;
      for (const c of callee.contracts.filter(c => c.kind === "requires")) {
        visit(path, env);
        visit(c.predicate, new Map(callee.params.map((p, i) => [p.name, () => visit(call.args[i], env)])));
      }
    }
  }
  return { sorts, parameters };
}

export function verificationScope(program: ProgramIR) {
  const { parameters } = dependencies(program);
  return program.functions.map(fn => ({ function: fn.name, sourceName: fn.sourceName,
    predicates: fn.contracts.map(c => c.kind),
    parameters: fn.params.map((p, index) => ({ name: p.name, index, type: p.type ?? p.sort,
      status: p.sort === "opaque" ? "opaque" : parameters.get(fn.name)!.has(p.name) ? "modeled" : "unused" })),
    callSites: new Set(program.functions.flatMap(f => callPaths(f.body)).filter(c => c.call.callee === fn.name).map(c => c.call.id)).size,
  }));
}
