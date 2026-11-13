import ts from "typescript";
import type { Expr } from "./ir.ts";
import type { SourceStatement } from "./ir-integrity.ts";
import { unsupported as error } from "./source-graph.ts";

type Value =
  | { kind: "scalar"; value: Expr }
  | { kind: "undefined" }
  | { kind: "array"; elements: Value[] }
  | { kind: "object"; properties: Map<string, Value> };

type Context = {
  scalar: (node: ts.Expression) => Expr;
  isUndefined: (node: ts.Identifier) => boolean;
  target: (node: ts.Identifier, value: Expr) => SourceStatement;
};

const missing: Value = { kind: "undefined" };
// These inherited properties are not absent from an ordinary object literal.
const inheritedKeys = new Set([
  "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "__proto__", "__defineGetter__",
  "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);

function key(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text.replaceAll("_", "")));
  return error(node, "destructuring requires static property names");
}

/** Literal aggregates exist only during source lowering; public IR stays scalar. */
export function destructuring(
  pattern: ts.BindingPattern | ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
  initializer: ts.Expression,
  context: Context,
): SourceStatement {
  const statements: SourceStatement[] = [];
  let temporary = 0;
  function literal(node: ts.Expression, output: SourceStatement[]): Value {
    if (ts.isParenthesizedExpression(node)) return literal(node.expression, output);
    if (ts.isIdentifier(node) && context.isUndefined(node)) return missing;
    if (ts.isArrayLiteralExpression(node)) {
      return { kind: "array", elements: node.elements.map(element => {
        if (ts.isOmittedExpression(element)) return missing;
        if (ts.isSpreadElement(element)) error(element, "spread in destructuring sources is unsupported");
        return literal(element, output);
      }) };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map<string, Value>();
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = key(property.name);
          if (name === "__proto__") error(property, "prototype setters in destructuring sources are unsupported");
          properties.set(name, literal(property.initializer, output));
        } else if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) {
          properties.set(property.name.text, literal(property.name, output));
        } else error(property, "destructuring sources require data properties without spread, methods or getters");
      }
      return { kind: "object", properties };
    }
    const value = context.scalar(node);
    const name = `destructure:${pattern.getStart()}:${temporary++}`;
    output.push({ kind: "bind", name, value });
    return { kind: "scalar", value: { kind: "ident", name } };
  }
  function property(value: Value, name: ts.PropertyName): Value {
    if (value.kind !== "object") error(name, "object destructuring requires an object literal source");
    const text = key(name);
    if (value.properties.has(text)) return value.properties.get(text)!;
    if (inheritedKeys.has(text)) error(name, "inherited properties in destructuring are unsupported");
    return missing;
  }
  function bind(node: ts.Node, value: Value, fallback?: ts.Expression): void {
    if (fallback) {
      // Validate even an unselected default, but retain its evaluation only
      // when the source is statically absent. Earlier targets are visible here.
      const evaluation: SourceStatement[] = [];
      const defaultValue = literal(fallback, evaluation);
      if (value.kind === "undefined") {
        statements.push(...evaluation);
        value = defaultValue;
      }
    }
    if (ts.isIdentifier(node)) {
      if (value.kind !== "scalar") error(node, "destructuring leaves require scalar values; undefined needs a default");
      statements.push(context.target(node, value.value));
    } else if (ts.isArrayBindingPattern(node) || ts.isArrayLiteralExpression(node)) {
      if (value.kind !== "array") error(node, "array destructuring requires an array literal source");
      node.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        const selected = value.elements[index] ?? missing;
        if (ts.isBindingElement(element)) {
          if (element.dotDotDotToken) error(element, "rest in destructuring is unsupported");
          bind(element.name, selected, element.initializer);
        } else bind(element, selected);
      });
    } else if (ts.isObjectBindingPattern(node)) {
      if (value.kind !== "object") error(node, "object destructuring requires an object literal source");
      for (const element of node.elements) {
        if (element.dotDotDotToken) error(element, "rest in destructuring is unsupported");
        const name = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
        if (!name) error(element, "nested object patterns need a property name");
        bind(element.name, property(value, name), element.initializer);
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      if (value.kind !== "object") error(node, "object destructuring requires an object literal source");
      for (const element of node.properties) {
        if (ts.isPropertyAssignment(element)) bind(element.initializer, property(value, element.name));
        else if (ts.isShorthandPropertyAssignment(element))
          bind(element.name, property(value, element.name), element.objectAssignmentInitializer);
        else error(element, "unsupported destructuring assignment property");
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      bind(node.left, value, node.right);
    } else error(node, "destructuring targets must be local names or nested patterns");
  }
  const value = literal(initializer, statements);
  bind(pattern, value);
  return { kind: "block", statements };
}
