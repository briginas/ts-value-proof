import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const project = process.cwd();
const cache = path.resolve("work/npm-cache");
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "ts-value-proof-consumer-"));
function run(command: string, args: string[], cwd = consumer, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180000,
    env: { ...process.env, npm_config_cache: cache, ...env }, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  fs.mkdirSync(path.resolve("work"), { recursive: true });
  run("npm", ["run", "build:package"], project);
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--pack-destination", "work", "--json"], project))[0];
  const tarball = path.resolve("work", packed.filename);
  fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"proof-consumer","private":true,"type":"module"}');
  run("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"]);
  fs.writeFileSync(path.join(consumer, "entry.ts"), `import { contract } from "ts-value-proof";
export function increment(value: bigint): bigint { let next = value; next += 1n; value = 0n; return next; }
contract(increment, { ensures: (result, value) => result > value });\n`);
  const isolatedBin = path.join(consumer, "bin");
  fs.mkdirSync(isolatedBin);
  fs.symlinkSync(process.execPath, path.join(isolatedBin, path.basename(process.execPath)));
  const withoutLean = { PATH: isolatedBin, ELAN_HOME: path.join(consumer, "empty-elan") };
  run(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import { contract } from 'ts-value-proof';
import { verify } from 'ts-value-proof/verify';
assert.throws(() => import.meta.resolve('vite'));
assert.equal(typeof contract, 'function');
const report = await verify('./entry.ts');
assert.equal(report.status, 'verified');
const row = report.results.find(result => result.kind === 'implementation');
assert.equal(row.status, 'proved');
assert.equal(row.crossCheck.z3.status, 'proved');
assert.equal(row.crossCheck.lean.status, 'unavailable');
assert.ok(row.crossCheck.lean.reason);
assert.equal(row.crossCheck.comparison, 'unconfirmed');
process.exit(0);
`], consumer, withoutLean);
  const cli = path.join(consumer, "node_modules/.bin/ts-value-proof");
  const stdout = run(cli, ["verify", "entry.ts"], consumer, withoutLean);
  assert.equal(stdout, fs.readFileSync(path.join(consumer, "work/verification.json"), "utf8"));
  const cliReport = JSON.parse(stdout);
  assert.equal(cliReport.status, "verified");
  assert.equal(cliReport.results[0].crossCheck.lean.status, "unavailable");
  run("npm", ["install", "--save-dev", "vite@8.3.8", "--ignore-scripts", "--no-audit", "--no-fund"]);
  fs.writeFileSync(path.join(consumer, "vite.config.ts"), `import { defineConfig } from "vite";
import { valueProof } from "ts-value-proof/vite";
export default defineConfig({ plugins: [valueProof({ entries: ["entry.ts"] })],
  build: { target: "es2022", minify: false, lib: { entry: "entry.ts", formats: ["es"], fileName: "bundle" },
    rolldownOptions: { treeshake: false } } });\n`);
  fs.writeFileSync(path.join(consumer, "report-types.ts"), `import type { VerificationReport } from "ts-value-proof/verify";
export function comparison(report: VerificationReport): "agreed" | "disagreement" | "unconfirmed" {
  return report.results[0].crossCheck.comparison;
}
`);
  run(path.join(consumer, "node_modules/.bin/tsc"), ["--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "entry.ts", "vite.config.ts", "report-types.ts"]);
  run(path.join(consumer, "node_modules/.bin/vite"), ["build"]);
  const code = fs.readFileSync(path.join(consumer, "dist/bundle.js"), "utf8");
  assert.doesNotMatch(code, /contract|ensures|specification|z3-solver/);
  run(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import { increment } from './dist/bundle.js';
assert.equal(increment(10n), 11n);
`]);
  console.log("Package smoke passed: isolated npm install, API and CLI without Lean or Vite, declarations, Vite config, executable bundle.");
} finally {
  fs.rmSync(consumer, { recursive: true, force: true });
}
