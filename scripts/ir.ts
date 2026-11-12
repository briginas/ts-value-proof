import { decodeNumber, formatNumeric, type NumberValue, type ScalarSort } from "./numeric-values.ts";

export type SourceLocation = {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
};

export type ValueSort = ScalarSort | "opaque";

// Decimal strings preserve every digit and remain JSON serializable.
export type Expr =
  | { kind: "unsupported"; text: string; sort: ValueSort | "bool"; source: SourceLocation; dependencies: Expr[] }
  | { kind: "opaque"; text: string; source: SourceLocation }
  | { kind: "bigint"; value: string }
  | { kind: "number"; value: NumberValue }
  | { kind: "string"; value: string }
  | { kind: "length"; operand: Expr }
  | { kind: "literal"; value: boolean }
  | { kind: "ident"; name: string }
  | { kind: "result" }
  | { kind: "unary"; op: "-" | "!"; operand: Expr }
  | { kind: "binary"; op: "+" | "-" | "<" | "<=" | ">" | ">=" | "===" | "!==" | "&&" | "||"; left: Expr; right: Expr }
  | { kind: "ternary"; condition: Expr; then: Expr; else: Expr }
  | { kind: "call"; id: string; source: SourceLocation; callee: string; args: Expr[] };

export type Predicate = { kind: "requires" | "ensures"; predicate: Expr; source: SourceLocation };
export type FunctionIR = {
  name: string;
  sourceName: string;
  source: SourceLocation;
  params: { name: string; sort: ValueSort; type?: string; source?: SourceLocation }[];
  returnSort: ValueSort;
  body: Expr;
  contracts: Predicate[];
};
export type ProgramIR = {
  functions: FunctionIR[];
  // Collected from source declarations/calls before control-flow lowering.
  coverage: { functions: string[]; contracts: string[]; calls: string[]; inventory: string[] };
};

export function prettyExpr(expr: Expr): string {
  switch (expr.kind) {
    case "unsupported":
    case "opaque": return expr.text;
    case "bigint": return expr.value + "n";
    case "number": return formatNumeric(decodeNumber(expr.value));
    case "string": return JSON.stringify(expr.value);
    case "length": return `(${prettyExpr(expr.operand)}).length`;
    case "literal": return String(expr.value);
    case "ident": return expr.name;
    case "result": return "result";
    case "unary": return `(${expr.op}${prettyExpr(expr.operand)})`;
    case "binary": return `(${prettyExpr(expr.left)} ${expr.op} ${prettyExpr(expr.right)})`;
    case "ternary": return `(${prettyExpr(expr.condition)} ? ${prettyExpr(expr.then)} : ${prettyExpr(expr.else)})`;
    case "call": return `${expr.callee}(${expr.args.map(prettyExpr).join(", ")})`;
  }
}
