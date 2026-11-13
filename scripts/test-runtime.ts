import { runtimeSort } from "./ir-integrity.ts";
import { runtimeType, type ScalarSort, type Scalar } from "./numeric-values.ts";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { prepareSource } from "./adapter.ts";
import type { Expr, FunctionIR } from "./ir.ts";

type RuntimeFunction = (...args: Scalar[]) => Scalar;
type RuntimeContract = {
  fn: RuntimeFunction;
  specification: {
    requires?: (...args: Scalar[]) => boolean;
    ensures?: (result: Scalar, ...args: Scalar[]) => boolean;
  };
};
export type CallSite = Extract<Expr, { kind: "call" }> & { caller: string; ordinal: number };
export type CallEvent = { site: CallSite; args: Scalar[]; accepted: boolean };
export type Execution = { result: Scalar; calls: CallEvent[]; ensures?: boolean };

export function callSites(fn: FunctionIR): CallSite[] {
  const found = new Map<string, Extract<Expr, { kind: "call" }>>();
  function visit(expr: Expr): void {
    if (expr.kind === "call") { found.set(expr.id, expr); expr.args.forEach(visit); }
    else if ((expr.kind === "unary" || expr.kind === "length")) visit(expr.operand);
    else if (expr.kind === "unsupported") expr.dependencies.forEach(visit);
    else if (expr.kind === "binary") { visit(expr.left); visit(expr.right); }
    else if (expr.kind === "sequence") { visit(expr.first); visit(expr.then); }
    else if (expr.kind === "ternary") { visit(expr.condition); visit(expr.then); visit(expr.else); }
  }
  visit(fn.body);
  return [...found.values()].sort((a, b) => a.source.start - b.source.start)
    .map((call, ordinal) => ({ ...call, caller: fn.name, ordinal }));
}

/** Execute original TypeScript bodies/predicates, never an interpretation of IR.
 * The validated, acyclic module graph is transpiled in memory. Hooks only capture
 * registrations and observe actual arguments before calling the original callee.
 * This is a test runner for trusted project code, not a security sandbox.
 */
export function createTestRuntime(input: string) {
  const prepared = prepareSource(input);
  const { ir, sources, names } = prepared;
  let sort: ScalarSort;
  try {
    sort = runtimeSort(ir);
    function supported(expr: Expr): void {
      if (expr.kind === "opaque" || expr.kind === "unsupported") throw new Error("Unsupported expression: " + expr.text);
      if ((expr.kind === "unary" || expr.kind === "length")) supported(expr.operand);
      if (expr.kind === "binary") { supported(expr.left); supported(expr.right); }
      if (expr.kind === "sequence") { supported(expr.first); supported(expr.then); }
      if (expr.kind === "ternary") { supported(expr.condition); supported(expr.then); supported(expr.else); }
      if (expr.kind === "call") expr.args.forEach(supported);
    }
    for (const fn of ir.functions) { supported(fn.body); fn.contracts.forEach(c => supported(c.predicate)); }
  } catch (error) {
    throw new Error("Unsupported test runtime graph: " + (error instanceof Error ? error.message : String(error)));
  }
  const functions = new Map<string, RuntimeFunction>();
  const contracts = new Map<RuntimeFunction, RuntimeContract["specification"]>();
  const sites = ir.functions.flatMap(callSites);
  const siteById = new Map(sites.map(site => [site.id, site]));
  const sourceByFile = new Map(sources.map(source => [path.resolve(source.fileName), source]));
  const apiFile = fileURLToPath(new URL("../src/contract.ts", import.meta.url));
  sourceByFile.set(apiFile, ts.createSourceFile(apiFile, fs.readFileSync(apiFile, "utf8"), ts.ScriptTarget.ES2022, true));
  const identifiers = new Set<string>();
  for (const source of sourceByFile.values()) {
    const scan = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      ts.forEachChild(node, scan);
    };
    scan(source);
    // CommonJS reserves these top-level bindings. Reject rather than silently
    // changing the meaning of a valid ESM module during test compilation.
    for (const node of source.statements) {
      const bindings = ts.isFunctionDeclaration(node) ? [node.name]
        : ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name)
        : ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements.map(e => e.name) : [];
      if (bindings.some(b => b && ts.isIdentifier(b) &&
        ["require", "exports", "module", "Object", "__createBinding", "__exportStar", "__esModule"].includes(b.text)))
        throw new Error("Test runtime does not support CommonJS-reserved top-level bindings: " + source.fileName);
    }
  }
  let hook = "__vc_runtime";
  while (identifiers.has(hook)) hook += "_";
  let events: CallEvent[] | undefined;
  const hooks = {
    register(name: string, fn: RuntimeFunction): void { functions.set(name, fn); },
    capture(bound: RuntimeContract): void { contracts.set(bound.fn, bound.specification); },
    call(id: string, fn: RuntimeFunction, args: Scalar[]): Scalar {
      const site = siteById.get(id);
      const specification = contracts.get(fn);
      if (!site || !specification || functions.get(site.callee) !== fn || !events)
        throw new Error("Runtime call binding is missing or mismatched: " + id);
      binding(site.callee, args);
      events.push({ site, args: [...args], accepted: specification.requires?.(...args) ?? true });
      return fn(...args);
    },
  };
  const context = vm.createContext({});
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  function load(file: string): Record<string, unknown> {
    const cached = modules.get(file);
    if (cached) return cached.exports;
    const source = sourceByFile.get(file);
    if (!source) throw new Error("Module outside validated graph: " + file);
    const edits: { start: number; end: number; text: string }[] = [];
    for (const site of sites.filter(site => site.source.file === file)) {
      const original = source.text.slice(site.source.start, site.source.end);
      // Locate the AST call, retaining the source's alias and argument expressions.
      let call: ts.CallExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.getStart(source) === site.source.start) call = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!call || call.getText(source) !== original) throw new Error("Source call mismatch: " + site.id);
      edits.push({ start: site.source.start, end: site.source.end,
        text: `${hook}.call(${JSON.stringify(site.id)}, ${call.expression.getText(source)}, [${call.arguments.map(a => a.getText(source)).join(", ")}])` });
    }
    if (file !== apiFile) for (const statement of source.statements) {
      // The adapter accepts only contract(...) as a top-level expression.
      if (ts.isExpressionStatement(statement)) edits.push({
        start: statement.expression.getStart(source), end: statement.expression.end,
        text: `${hook}.capture(${statement.expression.getText(source)})`,
      });
    }
    let text = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    for (const [fn, name] of names) if (path.resolve(fn.getSourceFile().fileName) === file)
      text += `\n${hook}.register(${JSON.stringify(name)}, ${fn.name.text});\n`;
    const compiled = ts.transpileModule(text, { fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: Object.create(null) as Record<string, unknown> };
    modules.set(file, module);
    const requireModule = (specifier: string): Record<string, unknown> => {
      const resolved = ts.resolveModuleName(specifier, file, {
        moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext,
      }, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) throw new Error("Cannot resolve runtime import: " + specifier);
      return load(path.resolve(resolved));
    };
    const execute = new vm.Script(`(function(exports, require, module, ${hook}) {\n${compiled}\n})`, { filename: file }).runInContext(context);
    execute(module.exports, requireModule, module, hooks);
    return module.exports;
  }
  load(path.resolve(input));
  if (functions.size !== ir.functions.length) throw new Error("Incomplete runtime function coverage");
  for (const fn of ir.functions)
    if (Boolean(fn.contracts.length) !== contracts.has(functions.get(fn.name)!))
      throw new Error("Incomplete runtime contract coverage: " + fn.name);

  function binding(name: string, args: Scalar[]) {
    const info = ir.functions.find(fn => fn.name === name);
    const fn = functions.get(name);
    if (!info || !fn || args.length !== info.params.length || args.some((arg, i) => typeof arg !== runtimeType(info.params[i].sort as ScalarSort)))
      throw new Error("Invalid runtime function or arguments: " + name);
    return { fn, info, specification: contracts.get(fn) };
  }
  return {
    ir, sites, sort,
    accepts(name: string, args: Scalar[]): boolean {
      const { specification } = binding(name, args);
      return specification?.requires?.(...args) ?? true;
    },
    execute(name: string, args: Scalar[]): Execution {
      const { fn, info, specification } = binding(name, args);
      if (specification?.requires && !specification.requires(...args)) throw new Error("Input does not satisfy requires: " + name);
      if (events) throw new Error("Reentrant test execution");
      events = [];
      try {
        const result = fn(...args);
        if (typeof result !== runtimeType(info.returnSort as ScalarSort)) throw new Error("Unexpected runtime result type");
        return { result, calls: events, ensures: specification?.ensures?.(result, ...args) };
      } finally { events = undefined; }
    },
  };
}

export type TestRuntime = ReturnType<typeof createTestRuntime>;
