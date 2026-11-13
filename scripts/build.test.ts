import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SourceMap } from "node:module";
import { expect, test } from "vitest";
import { build, createServer, type Plugin, type InlineConfig } from "vite";
import { valueProof } from "../src/vite.ts";
import { prepareSource } from "./adapter.ts";
import { verify, verifyPrepared } from "./verifier.ts";
import { assertCurrentInputs, eraseContracts } from "./contract-erasure.ts";

const valid = `export function f(x: bigint): bigint { return x + 1n; }
contract(f, { ensures: (r, x) => r > x });\n`;
function fixture(name: string, body = valid) {
  const root = path.resolve("work/build", name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const entry = path.join(root, "entry.ts");
  const api = path.relative(root, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import { contract } from ${JSON.stringify(api)};\n${body}`);
  return { root, entry, api };
}
function config(root: string, entry: string, plugins: Plugin[] = [valueProof({ entries: [entry] })]): InlineConfig {
  return { configFile: false, root, logLevel: "silent", plugins,
    build: { target: "es2022", write: false, minify: false, sourcemap: true,
      lib: { entry, formats: ["es"], fileName: "bundle" }, rolldownOptions: { treeshake: false } } };
}
async function bundle(options: InlineConfig) {
  const result = await build(options);
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("Expected one-shot build");
  const chunk = output.output.find(file => file.type === "chunk" && file.isEntry);
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing entry chunk");
  return chunk;
}
async function execute(code: string): Promise<{ f: (x: bigint) => bigint }> {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("shared verifier preserves CLI reports and serializes concurrent callers", async () => {
  const { entry } = fixture("cli");
  const [report, concurrent] = await Promise.all([verify(entry), verifyPrepared(prepareSource(entry))]);
  expect(concurrent).toEqual(report);
  const cli = spawnSync(process.execPath, ["scripts/verify.ts", entry], { encoding: "utf8" });
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(report);
  expect(fs.existsSync(entry.replace(/\.ts$/, ".js"))).toBe(false);
});

test("erasure preserves source positions, original files and function behavior", async () => {
  const { entry } = fixture("erasure");
  const snapshot = prepareSource(entry);
  const original = fs.readFileSync(entry, "utf8");
  expect((await verifyPrepared(snapshot)).status).toBe("verified");
  const source = snapshot.sources[0];
  const result = eraseContracts(snapshot, source);
  expect(result.code).not.toMatch(/contract|ensures/);
  expect(result.code).toContain("return x + 1n");
  const lines = result.code.split("\n");
  const line = lines.findIndex(value => value.includes("return"));
  const mapping = new SourceMap(JSON.parse(result.map.toString())).findEntry(line, lines[line].indexOf("return"));
  if (!("originalLine" in mapping)) throw new Error("Missing source mapping");
  expect(mapping.originalLine).toBe(1);
  expect(mapping.originalColumn).toBe(original.split("\n")[1].indexOf("return"));
  expect(fs.readFileSync(entry, "utf8")).toBe(original);
  expect(() => eraseContracts(snapshot, source, original + "\n")).toThrow(/source mismatch/);
  fs.writeFileSync(entry, original.replace("+ 1n", "- 1n"));
  expect(() => assertCurrentInputs(snapshot.inputs)).toThrow(/Stale verification snapshot/);
});

test("real Vite build removes contracts without tree shaking and keeps source maps", async () => {
  const { root, entry } = fixture("vite");
  const chunk = await bundle(config(root, entry));
  expect(chunk.code).not.toMatch(/contract|ensures|specification|z3-solver/);
  expect((await execute(chunk.code)).f(12n)).toBe(13n);
  expect(chunk.map?.sources.some(file => file.endsWith("entry.ts"))).toBe(true);
});

test("Vite verifies and executes functions with local declarations", async () => {
  const { root, entry } = fixture("locals", `export function f(x:bigint):bigint {
    const next = x+1n; let doubled:bigint = next*2n; return doubled;
  } contract(f,{ensures:(r,x)=>r===(x+1n)*2n});`);
  const chunk = await bundle(config(root, entry));
  expect(chunk.code).not.toMatch(/contract|ensures/);
  expect((await execute(chunk.code)).f(12n)).toBe(26n);
});

test("Vite verifies assignments and preserves their executable behavior", async () => {
  const { root, entry } = fixture("assignments", `export function f(x:bigint):bigint {
    let y=x; if(y<0n)y=-y; switch(x){case 0n:y=1n;break;default:y+=1n;} x=0n;return y;
  } contract(f,{ensures:(r,x)=>r>0n && (r===x+1n || r===1n-x)});`);
  const chunk = await bundle(config(root, entry));
  expect(chunk.code).not.toMatch(/contract|ensures/);
  const { f } = await execute(chunk.code);
  for (const x of [-12n,0n,12n]) expect(f(x)).toBe((x<0n?-x:x)+1n);
});

test("aliases, mixed imports, local exports and star re-exports retain working functions", async () => {
  const { root, entry, api } = fixture("barrels");
  fs.writeFileSync(path.join(root, "impl.ts"), "export function f(x: bigint): bigint { return x + 1n; }");
  fs.writeFileSync(path.join(root, "api.ts"), `export * from ${JSON.stringify(api)};`);
  fs.writeFileSync(path.join(root, "barrel.ts"), 'export { f } from "./impl.js"; export { contract as bind } from "./api.js";');
  fs.writeFileSync(entry, 'import { f, bind as proof } from "./barrel.js";\nexport { f, proof };\nproof(f, { ensures: (r, x) => r > x });');
  const chunk = await bundle(config(root, entry));
  expect(chunk.code).not.toMatch(/contract|ensures|specification|\bproof\b|\bbind\b/);
  expect((await execute(chunk.code)).f(3n)).toBe(4n);
});

test("an ordinary function named contract is not erased", async () => {
  const { root, entry, api } = fixture("same-name");
  fs.writeFileSync(entry, `import { contract as proof } from ${JSON.stringify(api)};
export function contract(x: bigint): bigint { return x + 1n; }
proof(contract, { ensures: (r, x) => r > x });`);
  const chunk = await bundle(config(root, entry));
  expect(chunk.code).toMatch(/function contract\(/);
  expect(chunk.code).not.toMatch(/ensures|specification|proof\(/);
});

test("externalizing the contract API cannot bypass the scope error", async () => {
  const { root, entry } = fixture("external");
  const app = path.join(root, "app.ts");
  fs.writeFileSync(app, 'export { contract } from "ts-value-proof";');
  const options = config(root, app, [valueProof({ entries: [entry] })]);
  options.build!.rolldownOptions!.external = ["ts-value-proof"];
  await expect(bundle(options)).rejects.toThrow(/cannot be external/);
});

test.each([
  ["refuted", valid.replace("r > x", "r < x"), /refuted/],
  ["inconsistent", valid.replace("ensures:", "requires: x => x > 0n && x < 0n, ensures:"), /inconsistent/],
  ["unknown", valid.replace("x + 1n", "x % 2n"), /unknown/],
  ["types", valid.replace("return x + 1n", 'return "bad"'), /not assignable/],
  ["syntax", valid.replace("return x + 1n", "let y = x; return y += 1n"), /Unsupported/],
  ["bound", valid.replace("contract(f,", "const bound = contract(f,"), /Unsupported/],
])("Vite rejects %s before emitting new output", async (name, body, error) => {
  const { root, entry } = fixture(name, body);
  let emitted = false;
  const options = config(root, entry, [valueProof({ entries: [entry] }),
    { name: "observe-output", generateBundle() { emitted = true; } }]);
  await expect(bundle(options)).rejects.toThrow(error);
  expect(emitted).toBe(false);
});

test("normal application outside entries is left to Vite; uncovered API imports fail", async () => {
  const { root, entry, api } = fixture("application");
  const app = path.join(root, "app.ts");
  fs.writeFileSync(app, 'import { f } from "./entry.ts"; export const values = [1n, 2n].map(f);');
  const chunk = await bundle(config(root, app, [valueProof({ entries: [entry] })]));
  expect(chunk.code).toContain(".map(f)");
  fs.writeFileSync(app, `import { contract } from ${JSON.stringify(api.replace(/\.js$/, ".ts"))}; export { contract };`);
  await expect(bundle(config(root, app, [valueProof({ entries: [entry] })]))).rejects.toThrow(/Contract API reached/);
});

test("earlier transforms, query variants and changed type-only inputs cannot reuse proof", async () => {
  const { root, entry } = fixture("stale");
  const before: Plugin = { name: "change-before-proof", enforce: "pre",
    transform: { order: "pre", handler(code, id) { if (id === entry) return code.replace("+ 1n", "- 1n"); } } };
  await expect(bundle(config(root, entry, [before, valueProof({ entries: [entry] })]))).rejects.toThrow(/source mismatch/);
  const app = path.join(root, "app.ts");
  fs.writeFileSync(app, 'import code from "./entry.ts?raw"; export { code };');
  await expect(bundle(config(root, app, [valueProof({ entries: [entry] })]))).rejects.toThrow(/Unsupported query/);
  const types = path.join(root, "types.ts");
  fs.writeFileSync(types, "export type Label = string;");
  fs.appendFileSync(entry, '\nimport type { Label } from "./types.js";\nexport function label(x: Label): Label { return x; }');
  const changeTypes: Plugin = { name: "change-types", renderStart() { fs.appendFileSync(types, "\n// modified"); } };
  await expect(bundle(config(root, entry, [valueProof({ entries: [entry] }), changeTypes]))).rejects.toThrow(/Stale verification snapshot/);
});

test("reused plugin checks each build and pins TS module resolution", async () => {
  const { root, entry } = fixture("repeat");
  const plugin = valueProof({ entries: [entry] });
  await bundle(config(root, entry, [plugin]));
  const original = fs.readFileSync(entry, "utf8");
  fs.writeFileSync(entry, original.replace("+ 1n", "- 1n"));
  await expect(bundle(config(root, entry, [plugin]))).rejects.toThrow(/refuted/);
  fs.writeFileSync(entry, original);
  const app = path.join(root, "app.ts");
  fs.writeFileSync(app, 'export { f } from "./entry.js";');
  // Put the checked edge in another verification root; aliases must not replace its target.
  fs.appendFileSync(app, `\nimport { contract } from ${JSON.stringify(path.relative(root, path.resolve("src/contract.js")))};
import { f } from "./entry.js"; export function g(x: bigint): bigint { return f(x); }
contract(g, { ensures: (r, x) => r > x });`);
  const wrong = path.join(root, "wrong.ts");
  fs.writeFileSync(wrong, "export function f(x: bigint): bigint { return x - 1n; }");
  const options = config(root, app, [valueProof({ entries: [app] })]);
  options.resolve = { alias: { "./entry.js": wrong } };
  const chunk = await bundle(options);
  expect((await execute(chunk.code)).f(4n)).toBe(5n);
});

test("dev server does not invoke verification or erasure", async () => {
  const { root, entry } = fixture("dev", valid.replace("r > x", "r < x"));
  const server = await createServer({ configFile: false, root, logLevel: "silent",
    plugins: [valueProof({ entries: [entry] })], server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true } });
  try {
    expect((await server.transformRequest("/entry.ts"))?.code).toContain("ensures");
  } finally { await server.close(); }
});

test("empty verification scope is rejected", () => {
  expect(() => valueProof({ entries: [] })).toThrow(/non-empty/);
});

test("Vite watch observes separate contracts and type-only inputs, and recovers after failures", async () => {
  const { root, entry, api } = fixture("watch");
  const types = path.join(root, "types.ts");
  const contracts = path.join(root, "contracts.ts");
  fs.writeFileSync(types, "export type Amount = bigint;");
  fs.writeFileSync(entry, 'import type { Amount } from "./types.js"; export function f(x: Amount): Amount { return x + 1n; }');
  const contractCode = `import { contract } from ${JSON.stringify(api)}; import { f } from "./entry.js"; contract(f, { ensures: (r, x) => r > x });`;
  fs.writeFileSync(contracts, contractCode);
  const options = config(root, entry, [valueProof({ entries: [contracts] })]);
  options.build = { ...options.build, watch: {}, write: true, outDir: "dist" };
  const watcher = await build(options);
  if (Array.isArray(watcher) || !("on" in watcher)) throw new Error("Expected watcher");
  type Outcome = { code: "success" } | { code: "error"; message: string };
  const queued: Outcome[] = [];
  let receive: ((value: Outcome) => void) | undefined;
  const next = () => new Promise<Outcome>((resolve, reject) => {
    const value = queued.shift();
    if (value) { resolve(value); return; }
    const timer = setTimeout(() => { receive = undefined; reject(new Error("Watch event timed out")); }, 15000);
    receive = value => { clearTimeout(timer); receive = undefined; resolve(value); };
  });
  watcher.on("event", async event => {
    if (event.code !== "BUNDLE_END" && event.code !== "ERROR") return;
    const value: Outcome = event.code === "ERROR" ? { code: "error", message: String(event.error) } : { code: "success" };
    if (receive) receive(value); else queued.push(value);
    await event.result.close();
  });
  try {
    expect(await next()).toEqual({ code: "success" });
    fs.writeFileSync(contracts, contractCode.replace("r > x", "r < x"));
    expect(await next()).toMatchObject({ code: "error", message: expect.stringContaining("refuted") });
    fs.writeFileSync(contracts, contractCode);
    expect(await next()).toEqual({ code: "success" });
    fs.writeFileSync(types, "export type Amount = boolean;");
    expect(await next()).toMatchObject({ code: "error", message: expect.stringContaining("Operator") });
    fs.writeFileSync(types, "export type Amount = bigint;");
    expect(await next()).toEqual({ code: "success" });
    const code = fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8");
    expect(code).not.toContain("contract");
    expect((await execute(code)).f(5n)).toBe(6n);
  } finally { await watcher.close(); }
});
