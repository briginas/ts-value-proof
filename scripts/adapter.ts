import { dependencies } from "./dependencies.ts";
import { encodeNumber } from "./numeric-values.ts";
import ts from "typescript";
import type { Expr, FunctionIR, ProgramIR, SourceLocation, ValueSort } from "./ir.ts";
import { returnExpression, validateIR, sourceInventory, type SourceStatement } from "./ir-integrity.ts";
import { canonicalFile, sourceGraph, unsupported as error, type SourceFunction } from "./source-graph.ts";
import { InputDiagnostic, location, sourceLocation } from "./diagnostics.ts";
import { destructuring } from "./destructuring.ts";

export class UnsupportedNumericModel extends InputDiagnostic {
  constructor(message: string, source: SourceLocation) {
    super(`${source.file}:${source.line}:${source.column}: ${message}`, "unsupported-numeric-model", source);
  }
}

const operators = new Set(["+", "-", "*", "/", "<", "<=", ">", ">=", "===", "!==", "&&", "||"]);

type Predicate = ts.ArrowFunction & { body: ts.Expression };
type ParsedContract = { fn: SourceFunction; predicates: Map<string, Predicate> };
export type AdaptedSource = ProgramIR;

export function adapt(fileName: string): AdaptedSource {
  return prepareSource(fileName).ir;
}

export type PreparedSource = ReturnType<typeof prepareSource>;

/** One validated source snapshot shared by verification and compilation. */
export function prepareSource(fileName: string, onInput?: (file: string) => void) {
  fileName = canonicalFile(fileName);
  const options: ts.CompilerOptions = {
    strict: true, noImplicitReturns: true, noEmit: true, skipLibCheck: true,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const inputs = new Map<string, string | undefined>();
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = file => {
    const key = canonicalFile(file);
    if (!inputs.has(key)) {
      onInput?.(key);
      inputs.set(key, read(file));
    }
    return inputs.get(key);
  };
  const program = ts.createProgram([fileName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    const first = diagnostics[0];
    throw new InputDiagnostic(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
    }), "type-error", first.file && first.start !== undefined
      ? sourceLocation(first.file, first.start, first.start + (first.length ?? 0)) : undefined);
  }
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error("Source file not found");
  for (const source of program.getSourceFiles())
    if (!source.isDeclarationFile && /@ts-(ignore|nocheck|expect-error)/.test(source.text))
      error(source, "suppressed TypeScript diagnostics");
  const checker = program.getTypeChecker();
  const { sources, names, resolve, symbol, isContract, edges: moduleEdges } = sourceGraph(program, sourceFile);
  const funcs = new Map([...names].map(([fn, name]) => [name, fn]));
  const contracts = new Map<string, ParsedContract>();
  const contractStatements = new Set<ts.Statement>();
  for (const source of sources) for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ||
        ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
        !ts.isIdentifier(statement.expression.expression) || !isContract(statement.expression.expression))
      error(statement, "expected a function declaration, const alias or contract(fn, {...})");
    const call = statement.expression;
    if (call.arguments.length !== 2 || call.typeArguments)
      error(call, "contract needs exactly two arguments and inferred type arguments");
    const [target, spec] = call.arguments;
    if (!ts.isIdentifier(target)) error(target, "contract target must be a function identifier");
    const fn = resolve(target);
    if (!fn) error(target, "contract target must resolve to a supported function declaration");
    const name = names.get(fn)!;
    if (contracts.has(name)) error(call, "duplicate contract for the same function symbol");
    if (!ts.isObjectLiteralExpression(spec)) error(spec, "inline contract object required");
    const predicates = new Map<string, Predicate>();
    for (const prop of spec.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) ||
          !["requires", "ensures"].includes(prop.name.text) || predicates.has(prop.name.text) ||
          !ts.isArrowFunction(prop.initializer) || ts.isBlock(prop.initializer.body) ||
          prop.initializer.modifiers?.length || prop.initializer.typeParameters)
        error(prop, "requires/ensures must be expression arrow functions");
      predicates.set(prop.name.text, prop.initializer as Predicate);
    }
    if (!predicates.size) error(spec, "at least one predicate is required");
    contracts.set(name, { fn, predicates });
    contractStatements.add(statement);
  }
  if (!contracts.size) throw new InputDiagnostic("No contracts found", "unsupported-code", location(sourceFile));
  function valueSort(node: ts.Node): ValueSort {
    const type = checker.getTypeAtLocation(node);
    if (type.flags & ts.TypeFlags.Number) return "float64";
    if (type.flags & ts.TypeFlags.BigInt) return "int";
    if (type.flags & ts.TypeFlags.String) return "string";
    return "opaque";
  }
  function expressionSort(node: ts.Expression): ValueSort | "bool" {
    const type = checker.getTypeAtLocation(node);
    const members = type.isUnion() ? type.types : [type];
    if (members.every(t => t.flags & ts.TypeFlags.BooleanLike)) return "bool";
    if (members.every(t => t.flags & ts.TypeFlags.NumberLike)) return "float64";
    if (members.every(t => t.flags & ts.TypeFlags.BigIntLike)) return "int";
    if (members.every(t => t.flags & ts.TypeFlags.StringLike)) return "string";
    return "opaque";
  }
  for (const fn of funcs.values()) {
    if (fn.typeParameters || fn.asteriskToken ||
        fn.modifiers?.some(m => m.kind !== ts.SyntaxKind.ExportKeyword) || !fn.type)
      error(fn, "only synchronous, non-generic functions with explicit types are supported");
    for (const p of fn.parameters) {
      if (!ts.isIdentifier(p.name) || !p.type || p.dotDotDotToken || p.questionToken || p.initializer ||
          ["this", "requires", "ensures", "output", "BigInt", "result"].includes(p.name.text))
        error(p, "required explicitly typed parameters with plain names only");
    }
  }
  const edges = new Map<string, string[]>();
  const irs = new Map<string, FunctionIR>();
  const callIds: string[] = [];
  function requireBoolean(node: ts.Expression): void {
    if (!(checker.getTypeAtLocation(node).flags & ts.TypeFlags.BooleanLike)) error(node, "explicit boolean condition required");
  }
  function stringLength(node: ts.Node): node is ts.PropertyAccessExpression {
    return ts.isPropertyAccessExpression(node) && !node.questionDotToken && node.name.text === "length" &&
      expressionSort(node.expression) === "string";
  }
  function expression(node: ts.Expression, allowed: ReadonlyMap<ts.Symbol, Expr>, calls: string[] | false): Expr {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "string", value: node.text };
    if (stringLength(node)) return { kind: "length", operand: expression(node.expression, allowed, calls) };
    if (ts.isNumericLiteral(node)) {
      return { kind: "number", value: encodeNumber(Number(node.text.replaceAll("_", ""))) };
    }
    if (ts.isIdentifier(node)) {
      const binding = valueSymbol(node);
      const value = allowed.get(binding);
      if (value) return value;
      if (["NaN", "Infinity"].includes(node.text) &&
          binding.declarations?.some(d => program.isSourceFileDefaultLibrary(d.getSourceFile())))
        return { kind: "number", value: encodeNumber(node.text === "NaN" ? NaN : Infinity) };
      error(node, "free identifier");
    } else if (ts.isBigIntLiteral(node)) {
      return { kind: "bigint", value: BigInt(node.text.slice(0, -1).replaceAll("_", "")).toString() };
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "literal", value: node.kind === ts.SyntaxKind.TrueKeyword };
    } else if (ts.isParenthesizedExpression(node)) return expression(node.expression, allowed, calls);
    else if (ts.isConditionalExpression(node)) {
      requireBoolean(node.condition);
      if (expressionSort(node.whenTrue) !== expressionSort(node.whenFalse))
        error(node, "conditional branches must have the same value kind");
      return { kind: "ternary", condition: expression(node.condition, allowed, false),
        then: expression(node.whenTrue, allowed, calls), else: expression(node.whenFalse, allowed, calls) };
    } else if (ts.isBinaryExpression(node) && operators.has(node.operatorToken.getText())) {
      if (["&&", "||"].includes(node.operatorToken.getText())) {
        requireBoolean(node.left); requireBoolean(node.right);
      }
      const leftSort = expressionSort(node.left), rightSort = expressionSort(node.right);
      if ((leftSort === "string" || rightSort === "string") &&
          !(["+", "===", "!=="].includes(node.operatorToken.getText()) && leftSort === "string" && rightSort === "string"))
        return { kind: "unsupported", text: node.getText(), sort: expressionSort(node), source: location(node),
          dependencies: [expression(node.left, allowed, calls), expression(node.right, allowed, calls)] };
      return { kind: "binary", op: node.operatorToken.getText() as Extract<Expr, { kind: "binary" }>["op"],
        left: expression(node.left, allowed, calls), right: expression(node.right, allowed, calls) };
    } else if (ts.isPrefixUnaryExpression(node) &&
               [ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken].includes(node.operator)) {
      if (node.operator === ts.SyntaxKind.ExclamationToken) requireBoolean(node.operand);
      return { kind: "unary", op: node.operator === ts.SyntaxKind.MinusToken ? "-" : "!",
        operand: expression(node.operand, allowed, calls) };
    } else if (calls && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.typeArguments) error(node, "explicit call type arguments are unsupported");
      const fn = resolve(node.expression);
      const name = fn && names.get(fn);
      if (!name || !contracts.has(name))
        error(node, "only calls to supported contracted functions are allowed");
      calls.push(name);
      const source = location(node);
      const id = `${source.file}:${source.start}`;
      callIds.push(id);
      function argument(arg: ts.Expression): Expr {
        function noGetter(node: ts.Node): void {
          if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !stringLength(node)) error(node, "property access in call arguments is unsupported");
          ts.forEachChild(node, noGetter);
        }
        noGetter(arg);
        return expression(arg, allowed, false);
      }
      return { kind: "call", callee: name, source, id, args: node.arguments.map(argument) };
    } else if (node.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: "opaque", text: node.getText(), source: location(node) };
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (calls) error(node, "property access in function bodies is unsupported");
      // A predicate dependency may be reported, but never evaluated as a getter.
      return { kind: "unsupported", text: node.getText(), sort: expressionSort(node), source: location(node),
        dependencies: [expression(node.expression, allowed, false),
          ...(ts.isElementAccessExpression(node) ? [expression(node.argumentExpression, allowed, false)] : [])] };
    } else if (ts.isBinaryExpression(node) &&
        ["%", "**", "==", "!=", "&", "|", "^", "<<", ">>", ">>>"].includes(node.operatorToken.getText())) {
      return { kind: "unsupported", text: node.getText(), sort: expressionSort(node), source: location(node),
        dependencies: [expression(node.left, allowed, calls), expression(node.right, allowed, calls)] };
    } else if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.TildeToken].includes(node.operator)) {
      return { kind: "unsupported", text: node.getText(), sort: expressionSort(node), source: location(node),
        dependencies: [expression(node.operand, allowed, calls)] };
    } else error(node, ts.SyntaxKind[node.kind]);
  }
  function pureBodyExpression(node: ts.Expression, allowed: ReadonlyMap<ts.Symbol, Expr>): Expr {
    // Reusing selectors or local values must not duplicate calls or getters.
    function noGetter(part: ts.Node): void {
      if ((ts.isPropertyAccessExpression(part) || ts.isElementAccessExpression(part)) && !stringLength(part))
        error(part, "property access in switch selection, local initializers or assignments is unsupported");
      ts.forEachChild(part, noGetter);
    }
    noGetter(node);
    return expression(node, allowed, false);
  }
  function valueSymbol(node: ts.Identifier): ts.Symbol {
    // Only the shorthand name denotes a property symbol. Its default RHS
    // (e.g. x in {a = x}) must resolve as an ordinary value reference.
    return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol(node) : symbol(node);
  }
  function assignmentBinding(node: ts.Identifier, allowed: ReadonlyMap<ts.Symbol, Expr>): Extract<Expr, {kind: "ident"}> {
    const target = valueSymbol(node);
    const binding = allowed.get(target);
    const mutable = target.declarations?.some(declaration => {
      let owner: ts.Node = declaration;
      while (ts.isBindingElement(owner) || ts.isObjectBindingPattern(owner) || ts.isArrayBindingPattern(owner)) owner = owner.parent;
      return ts.isParameter(owner) || (ts.isVariableDeclaration(owner) &&
        ts.isVariableDeclarationList(owner.parent) && !!(owner.parent.flags & ts.NodeFlags.Let));
    });
    if (!mutable || binding?.kind !== "ident") error(node, "assignment target must be a local let variable or parameter");
    return binding;
  }
  function destructure(
    pattern: ts.BindingPattern | ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
    initializer: ts.Expression, allowed: Map<ts.Symbol, Expr>, declaration: boolean,
  ): SourceStatement {
    return destructuring(pattern, initializer, {
      scalar: node => {
        const type = checker.getTypeAtLocation(node);
        const members = type.isUnion() ? type.types : [type];
        if (!members.every(t => t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike |
          ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null)))
          error(node, "destructuring sources require literals with scalar leaves and statically known undefined");
        return pureBodyExpression(node, allowed);
      },
      isUndefined: node => node.text === "undefined" && !allowed.has(valueSymbol(node)) &&
        !!(checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined) &&
        !valueSymbol(node).declarations?.length,
      target: (node, value) => {
        const name = declaration ? `local:${node.getStart()}` : assignmentBinding(node, allowed).name;
        if (declaration) allowed.set(symbol(node), {kind: "ident", name});
        return {kind: "bind", name, value};
      },
    });
  }
  function statements(nodes: readonly ts.Statement[], allowed: ReadonlyMap<ts.Symbol, Expr>, calls: string[], inSwitch: boolean): SourceStatement {
    const scope = new Map(allowed);
    return { kind: "block", statements: nodes.map(node => statement(node, scope, calls, inSwitch)) };
  }
  function statement(node: ts.Statement, allowed: Map<ts.Symbol, Expr>, calls: string[], inSwitch = false): SourceStatement {
    if (ts.isBlock(node)) return statements(node.statements, allowed, calls, inSwitch);
    else if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      if (!(flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) || (flags & ts.NodeFlags.Using) || node.modifiers?.length)
        error(node, "only local const/let declarations are supported");
      return { kind: "block", statements: node.declarationList.declarations.map(declaration => {
        if (!declaration.initializer || declaration.exclamationToken)
          error(declaration, "local variables need an initializer");
        if (!ts.isIdentifier(declaration.name))
          return destructure(declaration.name, declaration.initializer, allowed, true);
        const value = pureBodyExpression(declaration.initializer, allowed);
        // A source-only name preserves snapshots and shadowing until the
        // statements are lowered. ':' cannot occur in a TypeScript identifier.
        const name = `local:${declaration.getStart()}`;
        allowed.set(symbol(declaration.name), { kind: "ident", name });
        return { kind: "bind", name, value };
      }) };
    } else if (ts.isExpressionStatement(node)) {
      let assignment = node.expression;
      while (ts.isParenthesizedExpression(assignment)) assignment = assignment.expression;
      if (ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isArrayLiteralExpression(assignment.left) || ts.isObjectLiteralExpression(assignment.left)))
        return destructure(assignment.left, assignment.right, allowed, false);
      if (!ts.isBinaryExpression(assignment) || !ts.isIdentifier(assignment.left) ||
          !["=", "+=", "-=", "*=", "/="].includes(assignment.operatorToken.getText()))
        error(node, "only standalone assignments to local let variables or parameters are supported");
      const binding = assignmentBinding(assignment.left, allowed);
      const right = pureBodyExpression(assignment.right, allowed);
      const operator = assignment.operatorToken.getText();
      let value = right;
      if (operator !== "=") {
        const op = operator.slice(0, -1) as "+" | "-" | "*" | "/";
        const leftSort = expressionSort(assignment.left), rightSort = expressionSort(assignment.right);
        value = (leftSort === "string" || rightSort === "string") &&
          !(op === "+" && leftSort === "string" && rightSort === "string")
          ? { kind: "unsupported", text: assignment.getText(), sort: expressionSort(assignment),
              source: location(assignment), dependencies: [binding, right] }
          : { kind: "binary", op, left: binding, right };
      }
      return { kind: "bind", name: binding.name, value };
    } else if (ts.isReturnStatement(node) && node.expression)
      return { kind: "return", value: expression(node.expression, allowed, calls) };
    else if (ts.isIfStatement(node)) {
      requireBoolean(node.expression);
      return { kind: "if", condition: expression(node.expression, allowed, false),
        then: statement(node.thenStatement, new Map(allowed), calls, inSwitch),
        else: node.elseStatement ? statement(node.elseStatement, new Map(allowed), calls, inSwitch) : undefined };
    } else if (ts.isSwitchStatement(node)) {
      return { kind: "switch", value: pureBodyExpression(node.expression, allowed),
        clauses: node.caseBlock.clauses.map(clause => ({
          test: ts.isCaseClause(clause) ? pureBodyExpression(clause.expression, allowed) : undefined,
          body: statements(clause.statements, allowed, calls, true),
        })) };
    } else if (ts.isBreakStatement(node) && !node.label && inSwitch) {
      return { kind: "break" };
    } else error(node, ts.SyntaxKind[node.kind]);
  }
  for (const [name, fn] of funcs) {
    const calls: string[] = [];
    const bindings = new Map<ts.Symbol, Expr>(fn.parameters.map(p =>
      [symbol(p.name), { kind: "ident", name: p.name.getText() }]));
    const body = returnExpression(statement(fn.body, bindings, calls));
    if (!body) error(fn, "function may fall through without returning a value");
    irs.set(name, { name, sourceName: fn.name.text, source: location(fn), params: fn.parameters.map(p => ({ name: p.name.getText(), sort: valueSort(p.type!),
        type: checker.typeToString(checker.getTypeAtLocation(p.type!)), source: location(p) })),
      returnSort: valueSort(fn.type!), body, contracts: [] });
    edges.set(name, calls);
  }
  function acyclic(name: string, active: ReadonlySet<string> = new Set()): void {
    if (active.has(name)) error(funcs.get(name)!, "recursive call cycle");
    const next = new Set(active).add(name);
    for (const target of edges.get(name) ?? []) acyclic(target, next);
  }
  for (const name of funcs.keys()) acyclic(name);
  for (const [name, { fn, predicates }] of contracts) {
    for (const [kind, arrow] of predicates) {
      const bindings = new Map<ts.Symbol, Expr>();
      arrow.parameters.forEach((p, i) => {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer)
          error(p, "plain callback parameters required");
        const parameter = fn.parameters[i - (kind === "ensures" ? 1 : 0)];
        if (!(kind === "ensures" && i === 0) && (!parameter || !ts.isIdentifier(parameter.name)))
          error(p, "no corresponding function parameter");
        bindings.set(symbol(p.name), kind === "ensures" && i === 0
          ? { kind: "result" } : { kind: "ident", name: parameter.name.getText() });
      });
      requireBoolean(arrow.body);
      irs.get(name)!.contracts.push({ kind: kind as "requires" | "ensures",
        predicate: expression(arrow.body, bindings, false), source: location(arrow) });
    }
  }
  const programIR: ProgramIR = { functions: [...irs.values()],
    coverage: { functions: [...funcs.keys()], contracts: [...contracts.keys()], calls: callIds, inventory: [] } };
  programIR.coverage.inventory = sourceInventory(programIR);
  validateIR(programIR);
  const sorts = dependencies(programIR).sorts;
  if (sorts.has("int") && sorts.size > 1)
    throw new UnsupportedNumericModel("Mixed bigint with number/string dependencies is unsupported (mixed numeric model)", location(sourceFile));
  return { input: fileName, ir: programIR, sources, names, inputs, contractStatements, isContract, edges: moduleEdges };
}
