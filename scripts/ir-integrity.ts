import { dependencies } from "./dependencies.ts";
import { decodeNumber, type ScalarSort, type NumericSort } from "./numeric-values.ts";
import type { Expr, ProgramIR, SourceLocation, ValueSort } from "./ir.ts";

export type SourceStatement =
  | { kind: "return"; value: Expr }
  | { kind: "block"; statements: SourceStatement[] }
  | { kind: "if"; condition: Expr; then: SourceStatement; else?: SourceStatement };

// Both branches inherit the remaining statements; return ends its path.
// Continuations can share a source call, whose ID survives this lowering.
export function returnExpression(statement: SourceStatement, continuation?: Expr): Expr | undefined {
  switch (statement.kind) {
    case "return": return statement.value;
    case "block": {
      let result = continuation;
      for (let i = statement.statements.length - 1; i >= 0; i--)
        result = returnExpression(statement.statements[i], result);
      return result;
    }
    case "if": {
      const yes = returnExpression(statement.then, continuation);
      const no = statement.else ? returnExpression(statement.else, continuation) : continuation;
      if (!yes || !no) return undefined;
      return { kind: "ternary", condition: statement.condition, then: yes, else: no };
    }
  }
}

function requireIR(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("Invalid IR: " + message);
}
export function assertCoverage(expected: string[], actual: Iterable<string>, kind: string): void {
  const values = [...actual];
  requireIR(new Set(expected).size === expected.length && new Set(values).size === values.length &&
    expected.length === values.length && expected.every(name => values.includes(name)), kind + " coverage changed");
}

// Validate the language and coverage before any solver query. This checks IR
// invariants, not semantic equivalence to the source; translation has separate
// shape regressions and differential tests against native JavaScript.
export function runtimeSort(program: ProgramIR): ScalarSort {
  const sorts = new Set(program.functions.flatMap(fn => [fn.returnSort, ...fn.params.map(p => p.sort)]));
  requireIR(!sorts.has("opaque") && !(sorts.has("int") && sorts.size > 1), "mixed or invalid runtime model");
  return sorts.has("string") ? "string" : sorts.has("float64") ? "float64" : "int";
}

// Keep the complete source-bound representation separate from the dependency
// projection. This snapshot detects accidental edits/drops during later passes;
// it is not a proof that the original TypeScript translation was correct.
export function sourceInventory(program: ProgramIR): string[] {
  return program.functions.map(fn => JSON.stringify([fn.name, fn.params, fn.returnSort,
    fn.contracts.map(c => [c.kind, c.source, c.predicate]), fn.body]));
}

export function validateIR(program: ProgramIR): void {
  const functions = new Map(program.functions.map(fn => [fn.name, fn]));
  assertCoverage(program.coverage.functions, program.functions.map(fn => fn.name), "function");
  assertCoverage(program.coverage.contracts, program.functions.filter(fn => fn.contracts.length).map(fn => fn.name), "contract");
  const calls = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  function location(source: SourceLocation): void {
    requireIR(source && typeof source.file === "string" && source.file.length &&
      Number.isSafeInteger(source.start) && source.start >= 0 &&
      Number.isSafeInteger(source.end) && source.end > source.start &&
      Number.isSafeInteger(source.line) && source.line > 0 &&
      Number.isSafeInteger(source.column) && source.column > 0, "missing source location");
  }
  for (const fn of program.functions) {
    location(fn.source);
    requireIR(fn.name && fn.sourceName && ["int", "float64", "string", "opaque"].includes(fn.returnSort), "function signature");
    const params = new Set(fn.params.map(p => p.name));
    requireIR(params.size === fn.params.length && fn.params.every(p => p.name && ["int", "float64", "string", "opaque"].includes(p.sort)), "parameters");
    requireIR(fn.contracts.length <= 2 && new Set(fn.contracts.map(c => c.kind)).size === fn.contracts.length &&
      fn.contracts.every(c => ["requires", "ensures"].includes(c.kind)), "unique requires/ensures");
    const targets = new Set<string>();
    edges.set(fn.name, targets);
    function expression(expr: Expr, allowCalls: boolean, allowResult: boolean): ValueSort | "bool" {
      requireIR(expr && typeof expr === "object", "missing expression");
      const pure = (child: Expr) => expression(child, false, allowResult);
      const child = (value: Expr) => expression(value, allowCalls, allowResult);
      switch (expr.kind) {
        case "opaque": location(expr.source); requireIR(typeof expr.text === "string", "opaque description"); return "opaque";
        case "unsupported":
          location(expr.source);
          requireIR(typeof expr.text === "string" && ["int", "float64", "string", "opaque", "bool"].includes(expr.sort) && Array.isArray(expr.dependencies), "unsupported dependency");
          expr.dependencies.forEach(child);
          return expr.sort;
        case "string": requireIR(typeof expr.value === "string", "string literal"); return "string";
        case "length": requireIR(child(expr.operand) === "string", "string length operand"); return "float64";
        case "number":
          try { decodeNumber(expr.value); } catch { requireIR(false, "exact number literal"); }
          return "float64";
        case "bigint":
          requireIR(typeof expr.value === "string" && /^(0|[1-9][0-9]*)$/.test(expr.value), "exact integer literal");
          return "int";
        case "literal": requireIR(typeof expr.value === "boolean", "boolean literal"); return "bool";
        case "ident": requireIR(params.has(expr.name), "unbound identifier"); return fn.params.find(p => p.name === expr.name)!.sort;
        case "result": requireIR(allowResult, "result outside ensures"); return fn.returnSort;
        case "unary": {
          requireIR(expr.op === "-" || expr.op === "!", "unary operator");
          const value = child(expr.operand);
          requireIR(value === "opaque" || (expr.op === "!" ? value === "bool" : value === "int" || value === "float64"), "unary operand");
          return expr.op === "!" ? "bool" : value;
        }
        case "binary": {
          const left = child(expr.left), right = child(expr.right);
          requireIR(left === right || left === "opaque" || right === "opaque" ||
            (["<", "<=", ">", ">="].includes(expr.op) && [left, right].every(s => s === "int" || s === "float64")), "mixed operand sorts");
          if (expr.op === "===" || expr.op === "!==") return "bool";
          if (expr.op === "&&" || expr.op === "||") {
            requireIR((left === "bool" || left === "opaque") && (right === "bool" || right === "opaque"), "boolean operands"); return "bool";
          }
          if (left === "string" || right === "string") {
            requireIR(expr.op === "+" && left === "string" && right === "string", "string concatenation operands");
            return "string";
          }
          requireIR(["+", "-", "<", "<=", ">", ">="].includes(expr.op) && ["int", "float64", "opaque"].includes(left), "numeric operator/operands");
          return expr.op === "+" || expr.op === "-" ? left : "bool";
        }
        case "ternary": {
          requireIR(allowCalls && !allowResult, "branch outside function body");
          const condition = pure(expr.condition), yes = child(expr.then), no = child(expr.else);
          requireIR((condition === "bool" || condition === "opaque") && (yes === no || fn.returnSort === "opaque"), "branch sorts");
          return yes === no ? yes : "opaque";
        }
        case "call": {
          requireIR(allowCalls, "call outside return expression");
          location(expr.source);
          requireIR(expr.id === `${expr.source.file}:${expr.source.start}`, "call identity");
          const target = functions.get(expr.callee);
          requireIR(target && program.coverage.contracts.includes(expr.callee), "uncontracted call target");
          requireIR(expr.args.length === target.params.length && expr.args.every((arg, i) => { const sort = pure(arg); return target.params[i].sort === "opaque" || sort === target.params[i].sort; }), "call arguments");
          const shape = JSON.stringify([fn.name, expr]);
          requireIR(!calls.has(expr.id) || calls.get(expr.id) === shape, "conflicting call identity");
          calls.set(expr.id, shape);
          targets.add(expr.callee);
          return target.returnSort;
        }
        default: throw new Error("Invalid IR: unsupported expression");
      }
    }
    const bodySort = expression(fn.body, true, false);
    requireIR(bodySort === fn.returnSort || fn.returnSort === "opaque", "return value");
    for (const contract of fn.contracts) {
      location(contract.source);
      requireIR(["bool", "opaque"].includes(expression(contract.predicate, false, contract.kind === "ensures")), "predicate sort");
    }
  }
  assertCoverage(program.coverage.calls, calls.keys(), "call");
  requireIR(Array.isArray(program.coverage.inventory), "missing source inventory");
  assertCoverage(program.coverage.inventory, sourceInventory(program), "source inventory");
  const done = new Set<string>();
  function acyclic(name: string, active = new Set<string>()): void {
    requireIR(!active.has(name), "recursive call cycle");
    if (done.has(name)) return;
    for (const target of edges.get(name) ?? []) acyclic(target, new Set(active).add(name));
    done.add(name);
  }
  for (const name of functions.keys()) acyclic(name);
}

export function numericSort(program: ProgramIR): NumericSort {
  const { sorts } = dependencies(program);
  requireIR(!(sorts.has("int") && sorts.size > 1), "mixed numeric model dependencies");
  return sorts.has("float64") || sorts.has("string") ? "float64" : "int";
}
