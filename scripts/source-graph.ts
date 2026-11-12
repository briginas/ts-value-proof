import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { InputDiagnostic, location } from "./diagnostics.ts";

const apiFile = fileURLToPath(new URL("../src/contract.ts", import.meta.url));
const reserved = new Set(["requires", "ensures", "output", "BigInt", "result"]);

export type SourceFunction = ts.FunctionDeclaration & { name: ts.Identifier; body: ts.Block };

export function unsupported(node: ts.Node, message: string): never {
  const source = location(node);
  throw new InputDiagnostic(`${source.file}:${source.line}:${source.column}: Unsupported: ${message}`, "unsupported-code", source);
}

/** Follow only the entry's explicit module graph; the API implementation is trusted.
 * Every other reachable module is validated, including side-effect imports and barrels.
 * Symbols, never signatures or exported names, identify the original declarations.
 */
export function sourceGraph(program: ts.Program, entry: ts.SourceFile) {
  const checker = program.getTypeChecker();
  function symbol(node: ts.Node): ts.Symbol {
    const value = checker.getSymbolAtLocation(node);
    if (!value) unsupported(node, "unresolved symbol");
    return value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value;
  }
  const isContract = (node: ts.Node): boolean => symbol(node).declarations?.some(d =>
    ts.isFunctionDeclaration(d) && path.resolve(d.getSourceFile().fileName) === apiFile &&
    d.name?.text === "contract") ?? false;
  const sources: ts.SourceFile[] = [];
  const seen = new Set<ts.SourceFile>();
  const active = new Set<ts.SourceFile>();
  function collect(source: ts.SourceFile): void {
    if (active.has(source)) unsupported(source, "cyclic module imports are not supported");
    if (seen.has(source)) return;
    if (source.isDeclarationFile || !source.fileName.endsWith(".ts"))
      unsupported(source, "only TypeScript source modules are supported");
    if (/@ts-(ignore|nocheck|expect-error)/.test(source.text))
      unsupported(source, "suppressed TypeScript diagnostics");
    seen.add(source);
    active.add(source);
    sources.push(source);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier) continue;
      if (!ts.isStringLiteral(specifier) || !/^\.{1,2}\//.test(specifier.text) || statement.attributes)
        unsupported(statement, "only relative module imports without attributes are supported");
      const typeOnly = ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly || (statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings) && !statement.importClause.name &&
          statement.importClause.namedBindings.elements.length > 0 && statement.importClause.namedBindings.elements.every(e => e.isTypeOnly))
        : statement.isTypeOnly || (statement.exportClause && ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 && statement.exportClause.elements.every(e => e.isTypeOnly));
      if (typeOnly) continue; // Already resolved and checked by TypeScript; never execute this edge.
      const target = symbol(specifier).declarations?.find(ts.isSourceFile);
      if (!target) unsupported(specifier, "module source not found");
      if (path.resolve(target.fileName) !== apiFile) collect(target);
    }
    active.delete(source);
  }
  collect(entry);

  const declarations = new Map<ts.Symbol, SourceFunction>();
  const aliases = new Map<ts.Symbol, ts.Identifier>();
  const identifiers = new Set<string>();
  const parameterNames = new Set<string>();
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) parameterNames.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        if (!statement.name || !statement.body) unsupported(statement, "named function implementation required; overloads are unsupported");
        const key = symbol(statement.name);
        if (declarations.has(key) || key.declarations?.length !== 1)
          unsupported(statement, "overloads / duplicate function");
        if (reserved.has(statement.name.text)) unsupported(statement, "reserved name");
        declarations.set(key, statement as SourceFunction);
      } else if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const) ||
            statement.modifiers?.some(m => m.kind !== ts.SyntaxKind.ExportKeyword))
          unsupported(statement, "function aliases must be const");
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.type || !declaration.initializer ||
              !ts.isIdentifier(declaration.initializer))
            unsupported(declaration, "only inferred const aliases of function identifiers are supported");
          aliases.set(symbol(declaration.name), declaration.initializer);
        }
      }
    }
  }
  function resolve(node: ts.Node, resolving = new Set<ts.Symbol>()): SourceFunction | undefined {
    const key = symbol(node);
    const fn = declarations.get(key);
    if (fn) return fn;
    const alias = aliases.get(key);
    if (!alias) return undefined;
    if (resolving.has(key)) unsupported(node, "cyclic function alias");
    return resolve(alias, new Set(resolving).add(key));
  }
  for (const alias of aliases.values())
    if (!resolve(alias)) unsupported(alias, "alias target must be a supported function declaration");

  function binding(node: ts.ModuleExportName): void {
    if (!ts.isIdentifier(node)) unsupported(node, "string-named imports/exports are unsupported");
    if (!isContract(node) && !resolve(node)) unsupported(node, "import/export must resolve to a supported function or contract API");
  }
  for (const source of sources) for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue; // Include and validate contract modules imported for side effects.
      if (clause.isTypeOnly) continue;
      if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings))
        unsupported(statement, "only named value imports are supported");
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        if (element.propertyName?.text === "default") unsupported(element, "type-only/default imports are unsupported");
        binding(element.name);
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if ((statement.exportClause && !ts.isNamedExports(statement.exportClause)))
        unsupported(statement, "only named value exports or export * are supported");
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          if (element.name.text === "default" || element.propertyName?.text === "default")
            unsupported(element, "type-only/default exports are unsupported");
          binding(element.name);
        }
    }
  }

  // Assign stable internal names without merging same-named declarations.
  // Keep them distinct from parameter names for unambiguous diagnostics.
  const counts = new Map<string, number>();
  for (const fn of declarations.values()) counts.set(fn.name.text, (counts.get(fn.name.text) ?? 0) + 1);
  const names = new Map<SourceFunction, string>();
  let serial = 0;
  for (const fn of declarations.values()) {
    let name = fn.name.text;
    if (counts.get(name)! > 1 || parameterNames.has(name)) {
      do { name = "__vc_" + serial++; } while (identifiers.has(name));
      identifiers.add(name);
    }
    names.set(fn, name);
  }
  return { sources, names, resolve, symbol, isContract };
}
