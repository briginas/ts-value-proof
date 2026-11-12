import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { adapt } from "./adapter.ts";
import { verify, type VerificationReport } from "./verify.ts";
import { assertLocation } from "./check-diagnostics.ts";

const api = 'import { contract } from "../../../../src/contract.js";\n';
const identity = 'export function f(x: bigint): bigint { return x; }\n';
const spec = 'contract(f, { requires: x => x >= 0n, ensures: (r,x) => r === x });\n';
type Files = Record<string, string>;

function fixture(name: string, files: Files): string {
  const directory = path.resolve("work/cases/bindings", name);
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text);
  return path.join(directory, "entry.ts");
}

export async function checkBindings(): Promise<Array<VerificationReport & { test: string }>> {
  const reports: Array<VerificationReport & { test: string }> = [];
  async function checked(name: string, files: Files) {
    const report = await verify(fixture(name, files));
    reports.push({ test: name, ...report });
    return report;
  }
  const aliases = await checked("local-aliases", {
    "entry.ts": api + identity + "const alias = f; const again = alias;\n" +
      spec.replace("contract(f,", "contract(again,") +
      "function caller(x: bigint): bigint { return alias(x); }\n" + spec.replace("contract(f,", "contract(caller,"),
  });
  assert.equal(aliases.status, "verified");
  assert.equal(aliases.results.filter(r => r.kind === "call").length, 1);

  const modules: Files = {
    "entry.ts": api + 'import { invoke } from "./barrel.js";\n' +
      'import "./contracts.js";\n' +
      "export function caller(x: bigint): bigint { return invoke(x); }\n" + spec.replace("contract(f,", "contract(caller,"),
    "impl.ts": identity + "export const alias = f;\n",
    "barrel.ts": 'export { alias as invoke } from "./impl.js";\n',
    "contracts.ts": 'import { contract as specify } from "./api.js";\n' +
      'import { invoke as target } from "./barrel.js";\n' +
      'specify(target, { requires: value => value >= 0n, ensures: (answer,value) => answer === value });\n',
    "api.ts": 'export { contract } from "../../../../src/contract.js";\n',
  };
  const imported = await checked("imported-contracts", modules);
  assert.equal(imported.status, "verified");
  assert.equal(imported.results.filter(r => r.kind === "implementation").length, 2);
  assert.equal(imported.results.filter(r => r.kind === "call").length, 1);
  const importedIR = adapt("work/cases/bindings/imported-contracts/entry.ts");
  const importedFunction = importedIR.functions.find(fn => fn.sourceName === "f")!;
  assert.equal(importedFunction.source.file, path.resolve("work/cases/bindings/imported-contracts/impl.ts"));
  assert.equal(importedFunction.source.line, 1);
  for (const contract of importedFunction.contracts) {
    assert.equal(contract.source.file, path.resolve("work/cases/bindings/imported-contracts/contracts.ts"));
    assert.equal(contract.source.line, 3);
  }
  const importedCall = importedIR.functions.find(fn => fn.sourceName === "caller")!.body;
  assert.ok(importedCall.kind === "call");
  assert.equal(importedCall.callee, importedFunction.name);
  assert.equal(importedCall.source.file, path.resolve("work/cases/bindings/imported-contracts/entry.ts"));
  assert.equal(importedCall.source.line, 4);
  const broken = await checked("broken-imported-implementation", {
    ...modules, "impl.ts": modules["impl.ts"].replace("return x;", "return x + 1n;"),
  });
  assert.equal(broken.status, "refuted");
  assert.equal(broken.results.find(r => r.kind === "implementation" && r.function === "f")?.status, "disproved");
  const unsafe = await checked("imported-call-precondition", {
    ...modules, "entry.ts": modules["entry.ts"].replace("x => x >= 0n", "() => true"),
  });
  assert.equal(unsafe.status, "refuted");
  assert.ok(unsafe.results.some(r => r.kind === "call" && r.status === "disproved"));
  const unsafeCall = unsafe.results.find(r => r.kind === "call" && r.status === "disproved")!;
  assert.ok(unsafeCall.kind === "call");
  assert.equal(unsafeCall.sourceName, "caller");
  assert.equal(unsafeCall.callee.sourceName, "f");
  assert.equal(unsafeCall.pathCondition, "true");
  assert.equal(unsafeCall.checkedCondition, "(x >= 0n)");
  assert.deepEqual(unsafeCall.arguments, { x: "x" });
  assert.equal(path.basename(unsafeCall.source.file), "entry.ts");
  assert.equal(path.basename(unsafeCall.callee.source.file), "impl.ts");
  assert.equal(path.basename(unsafeCall.contractSource.file), "contracts.ts");
  assertLocation(unsafeCall.source, "export function caller(x: bigint): bigint { return invoke(x); }");
  assertLocation(unsafeCall.callee.source, identity.trim());
  assertLocation(unsafeCall.callSource, "invoke(x)");
  assertLocation(unsafeCall.contractSource, "value => value >= 0n");
  const importedPost = unsafe.results.find(r => r.kind === "implementation" && r.sourceName === "f")!;
  assert.ok(importedPost.kind === "implementation");
  assertLocation(importedPost.contractSource, "(answer,value) => answer === value");
  const importedPre = unsafe.results.find(r => r.kind === "preconditions" && r.sourceName === "f")!;
  assert.equal(importedPre.condition, "(x >= 0n)");
  assertLocation(importedPre.requires[0].source, "value => value >= 0n");
  const weak = await checked("weak-imported-contract", {
    ...modules, "contracts.ts": modules["contracts.ts"].replace("answer === value", "answer >= 0n"),
  });
  assert.equal(weak.status, "unknown");

  // Different declarations with exactly the same name and signature must not share contracts.
  const distinct = await checked("same-name-modules", {
    "entry.ts": api + 'import { f as first } from "./first.js";\n' +
      'import { f as second } from "./second.js";\n' +
      "function caller(x: bigint): bigint { return first(x) + second(x); }\n" +
      "contract(caller, { requires: x => x >= 0n, ensures: (r,x) => r === x + x });\n",
    "first.ts": api + identity + spec,
    "second.ts": api + identity.replace("return x;", "return x + 1n;") + spec,
  });
  assert.equal(distinct.status, "refuted");
  const implementations = distinct.results.filter(r => r.kind === "implementation");
  assert.equal(implementations.length, 3);
  assert.equal(new Set(implementations.map(r => r.function)).size, 3);
  assert.equal(implementations.filter(r => r.status === "disproved").length, 1);
  const named = implementations.filter(r => r.sourceName === "f");
  assert.equal(named.length, 2);
  assert.equal(new Set(named.map(r => r.function)).size, 2);
  assert.deepEqual(named.map(r => [path.basename(r.source.file), r.status]),
    [["first.ts", "proved"], ["second.ts", "disproved"]]);
  const namedCalls = distinct.results.filter(r => r.kind === "call");
  assert.equal(namedCalls.length, 2);
  for (const call of namedCalls) {
    assert.equal(call.callee.sourceName, "f");
    assert.equal(call.condition, "f: (x >= 0n)");
    assert.ok(named.some(r => r.function === call.callee.function && r.source.file === call.callee.source.file));
    assert.equal(call.contractSource.file, call.callee.source.file);
  }
  const distinctCorrect = await checked("same-name-distinct-contracts", {
    "entry.ts": api + 'import { f as first } from "./first.js";\n' +
      'import { f as second } from "./second.js";\n' +
      "function caller(x: bigint): bigint { return first(x) + second(x); }\n" +
      "contract(caller, { requires: x => x >= 0n, ensures: (r,x) => r === x + x + 1n });\n",
    "first.ts": api + identity + spec,
    "second.ts": api + identity.replace("return x;", "return x + 1n;") + spec.replace("r === x", "r === x + 1n"),
  });
  assert.equal(distinctCorrect.status, "verified");
  const distinctIR = adapt("work/cases/bindings/same-name-distinct-contracts/entry.ts");
  const namesakes = distinctIR.functions.filter(fn => fn.sourceName === "f");
  assert.equal(namesakes.length, 2);
  assert.equal(new Set(namesakes.map(fn => fn.name)).size, 2);
  assert.deepEqual(namesakes.map(fn => path.basename(fn.source.file)).sort(), ["first.ts", "second.ts"]);

  const shadowed = await checked("flattening-name-capture", {
    "entry.ts": api + 'import { f as invoke } from "./impl.js";\n' +
      "function caller(f: bigint): bigint { return invoke(f); }\n" +
      "contract(caller, { requires: value => value >= 0n, ensures: (r,value) => r === value });\n",
    "impl.ts": api + identity + spec,
  });
  assert.equal(shadowed.status, "verified");
  const star = await checked("star-and-local-exports", {
    ...modules,
    "barrel.ts": 'export * from "./local.js";\n',
    "local.ts": 'import { alias } from "./impl.js";\nconst invoke = alias; export { invoke };\n',
  });
  assert.equal(star.status, "verified");

  // A contract in another file carries its own literal offsets and symbols.
  const literals = await checked("cross-file-predicate-literals", {
    "entry.ts": api + 'import { f } from "./impl.js";\n' +
      "contract(f, { requires: value => value === 9007199254740993n, ensures: answer => answer === 9007199254740994n });\n",
    "impl.ts": identity.replace("return x;", "return x + 1n;"),
  });
  assert.equal(literals.status, "verified");

  function rejected(name: string, files: Files, reason: RegExp): void {
    assert.throws(() => adapt(fixture(name, files)), reason, name);
  }
  rejected("duplicate-alias-contract", {
    "entry.ts": api + identity + "const alias = f;\n" + spec + spec.replace("contract(f,", "contract(alias,"),
  }, /duplicate contract/);
  rejected("duplicate-imported-contract", {
    ...modules, "impl.ts": api + modules["impl.ts"] + spec,
  }, /duplicate contract/);
  rejected("missing-imported-contract", { ...modules, "contracts.ts": 'export {};\n' }, /contracted functions/);
  rejected("same-signature-missing-contract", {
    "entry.ts": 'import "./first.js"; import { f } from "./second.js";\n' +
      'export function caller(x: bigint): bigint { return f(x); }\n',
    "first.ts": api + identity + spec,
    "second.ts": identity,
  }, /contracted functions/);
  assert.equal((await checked("unsupported-imported-body", {
    ...modules, "impl.ts": modules["impl.ts"].replace("return x;", "return x * x;"),
  })).status, "unknown");
  rejected("suppressed-imported-types", {
    ...modules, "impl.ts": "// @ts-nocheck\n" + modules["impl.ts"],
  }, /suppressed TypeScript/);
  rejected("imported-type-error", {
    ...modules, "impl.ts": modules["impl.ts"].replace("return x;", 'return "wrong";'),
  }, /not assignable to type 'bigint'/);
  rejected("module-side-effect", {
    ...modules, "impl.ts": modules["impl.ts"] + "console.log('side effect');\n",
  }, /Unsupported/);
  rejected("module-cycle", {
    ...modules, "impl.ts": 'import "./entry.js";\n' + modules["impl.ts"],
  }, /cyclic module/);
  rejected("declaration-only-module", {
    "entry.ts": api + 'import { f } from "./external.js";\n' + spec,
    "external.d.ts": "export declare function f(x: bigint): bigint;\n",
  }, /source modules/);
  rejected("namespace-import", {
    "entry.ts": api + 'import * as lib from "./impl.js";\n' + spec.replace("contract(f,", "contract(lib.f,"),
    "impl.ts": identity,
  }, /named value imports/);
  rejected("default-import", {
    "entry.ts": api + 'import f from "./impl.js";\n' + spec,
    "impl.ts": identity.replace("export function", "export default function"),
  }, /named value imports/);
  for (const [name, declaration] of [
    ["optional", "function f(x?: bigint): bigint { return 0n; }"],
    ["default-parameter", "function f(x: bigint = 0n): bigint { return x; }"],
    ["rest", "function f(...x: bigint[]): bigint { return 0n; }"],
    ["generic", "function f<T extends bigint>(x: T): bigint { return x; }"],
    ["overload", "function f(x: bigint): bigint; function f(x: bigint): bigint { return x; }"],
    ["this", "function f(this: bigint, x: bigint): bigint { return x; }"],
    ["async", "async function f(x: bigint): Promise<bigint> { return x; }"],
    ["inferred-result", "function f(x: bigint) { return x; }"],
  ]) rejected("signature-" + name, {
    "entry.ts": api + declaration + "\ncontract(f, { requires: () => true, ensures: () => true });\n",
  }, /Unsupported/);
  for (const [name, declaration] of [
    ["mutable", "let alias = f;"],
    ["annotated", "const alias: (x: bigint) => bigint = f;"],
    ["asserted", "const alias = f as (x: bigint) => bigint;"],
  ]) rejected("alias-" + name, {
    "entry.ts": api + identity + declaration + spec.replace("contract(f,", "contract(alias,"),
  }, /Unsupported/);
  rejected("alias-recursion", {
    "entry.ts": api + identity.replace("return x;", "return alias(x);") + "const alias = f;\n" + spec,
  }, /recursive call cycle/);
  rejected("explicit-contract-type", {
    "entry.ts": api + identity + spec.replace("contract(f,", "contract<typeof f>(f,"),
  }, /inferred type arguments/);
  rejected("fake-contract-api", {
    "entry.ts": "function contract(fn: (x: bigint) => bigint, spec: { requires: (x: bigint) => boolean; " +
      "ensures: (r: bigint, x: bigint) => boolean }): void {}\n" + identity + spec,
  }, /expected a function declaration/);
  const lostBranch = fixture("imported-lost-branch", {
    "entry.ts": api + 'import { f } from "./impl.js";\n' + spec,
    "impl.ts": identity.replace("return x;", "if (x > 0n) { if (x > 1n) return 2n; } return 0n;"),
  });
  assert.equal((await verify(lostBranch)).status, "refuted");
  console.log("PASS aliases, cross-file symbol identity, imported contracts and unsupported signatures");
  return reports;
}
