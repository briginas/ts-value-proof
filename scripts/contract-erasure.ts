import ts from "typescript";
import MagicString from "magic-string";
import type { PreparedSource } from "./adapter.ts";
import { canonicalFile, isContractModule } from "./source-graph.ts";

export function assertCurrentInputs(inputs: ReadonlyMap<string, string | undefined>): void {
  for (const [file, expected] of inputs) {
    const actual = ts.sys.readFile(file);
    if (actual !== expected) throw new Error(`Stale verification snapshot: ${file}. Rebuild from current sources.`);
  }
}

/** Only call after verifying this snapshot. Never rediscover contracts by their spelling. */
export function eraseContracts(snapshot: PreparedSource, source: ts.SourceFile, code: string = source.text) {
  if (!snapshot.sources.includes(source) || code !== source.text)
    throw new Error(`Verification source mismatch: ${source.fileName}. Run valueProof before source-changing plugins.`);
  const output = new MagicString(code);
  const edges = snapshot.edges.get(canonicalFile(source.fileName))!;
  const remove = (node: ts.Node) => output.remove(node.getStart(source), node.end);
  for (const statement of source.statements) {
    if (snapshot.contractStatements.has(statement)) { remove(statement); continue; }
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    const target = specifier && ts.isStringLiteral(specifier) ? edges.get(specifier.text) : undefined;
    if (target && isContractModule(target)) { remove(statement); continue; }

    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
    if (!bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))) continue;
    const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly;
    if (typeOnly) continue;
    const kept = bindings.elements.filter(element => element.isTypeOnly || !snapshot.isContract(element.name));
    if (kept.length === bindings.elements.length) continue;
    if (kept.length) {
      output.overwrite(bindings.getStart(source), bindings.end, `{ ${kept.map(e => e.getText(source)).join(", ")} }`);
    } else if (specifier) {
      // Preserve reachability of ordinary modules (including separate contract files).
      output.overwrite(statement.getStart(source), statement.end, `import ${specifier.getText(source)};`);
    } else {
      output.overwrite(statement.getStart(source), statement.end, "export {};");
    }
  }
  return {
    code: output.toString(),
    map: output.generateMap({ source: source.fileName, includeContent: true, hires: true }),
  };
}
