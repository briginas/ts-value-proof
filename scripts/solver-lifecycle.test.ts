import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("GC during solver queries preserves terms and repeated bigint verification", () => {
  // Isolate native crashes; kill a stuck WASM worker instead of hanging Vitest.
  const result = spawnSync(process.execPath, ["--expose-gc", "scripts/check-solver-gc.ts"], {
    encoding: "utf8", timeout: 30000, killSignal: "SIGKILL",
  });
  const details = [result.error?.message, result.signal, result.stdout, result.stderr].filter(Boolean).join("\n");
  expect(result.status, details).toBe(0);
  expect(result.stdout).toContain("PASS 20 solver GC rounds");
  expect(result.stdout).toContain("PASS 10 bigint verification rounds under GC");
}, 35000);
