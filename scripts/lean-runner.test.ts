import { access, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runLeanGoals, type LeanGoal } from "./lean-runner.ts";

const goal: LeanGoal = { key: "post", kind: "implementation", variables: [], assumptions: [], goal: "True" };
let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lean-runner-test-")); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function fakeCompiler(path: string, body: string): Promise<string> {
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return path;
}

const versionCheck = 'if (process.argv[2] === "--version") { console.log("Lean (version 4.19.0, test)"); process.exit(0); }';

it("reports an absent pinned compiler as unavailable", async () => {
  const verdict = (await runLeanGoals([goal], { executable: join(dir, "absent") })).get(goal.key);
  expect(verdict).toMatchObject({ status: "unavailable", reason: expect.any(String) });
});

it.skipIf(process.platform === "win32")("skips elan proxies and incompatible standalone compilers", async () => {
  const paths = [];
  for (const name of ["shim", "old", "matching"]) {
    const bin = join(dir, name, "bin");
    await mkdir(bin, { recursive: true });
    paths.push(bin);
    await mkdir(join(dir, name, "lib/lean"), { recursive: true });
    await writeFile(join(dir, name, "lib/lean/Init.olean"), "");
    const marker = JSON.stringify(join(dir, name + "-ran"));
    const version = name === "old" ? "3" : "4.19.0";
    const fake = await fakeCompiler(join(bin, "lean"), `
      require("node:fs").writeFileSync(${marker}, "");
      if (process.argv[2] === "--version") console.log("Lean (version ${version}, test)");
      else console.log("malformed proof response");
    `);
    if (name === "shim") await link(fake, join(bin, "elan"));
  }
  vi.stubEnv("ELAN_HOME", join(dir, "elan-home"));
  vi.stubEnv("PATH", paths.join(delimiter));
  expect((await runLeanGoals([goal])).get(goal.key)?.status).toBe("unknown");
  await expect(access(join(dir, "shim-ran"))).rejects.toThrow();
  await access(join(dir, "old-ran"));
  await access(join(dir, "matching-ran"));
});

it.skipIf(process.platform === "win32")("rejects a wrong version and malformed output, even on successful exit", async () => {
  const executable = await fakeCompiler(join(dir, "lean"), 'console.log("Lean (version 4.19.0-rc1, test)")');
  expect((await runLeanGoals([goal], { executable })).get(goal.key)?.status).toBe("unavailable");
  await fakeCompiler(executable, versionCheck + '\nconsole.log("proved")');
  expect((await runLeanGoals([goal], { executable })).get(goal.key)?.status).toBe("unknown");
});

it.skipIf(process.platform === "win32")("kills a stalled process and cleans its isolated workspace", async () => {
  const marker = join(dir, "cwd");
  const executable = await fakeCompiler(join(dir, "lean"), `${versionCheck}
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd());
    setInterval(() => {}, 1000);
  `);
  const result = await runLeanGoals([goal], { executable, timeoutMs: 1000 });
  expect(result.get(goal.key)).toMatchObject({ status: "unknown", reason: "Lean process timed out" });
  await expect(access(await readFile(marker, "utf8"))).rejects.toThrow();
});
