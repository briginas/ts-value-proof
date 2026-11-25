import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { runLeanGoals, type LeanGoal } from "./lean-runner.ts";

const goal: LeanGoal = { key: "g", kind: "call", variables: ["v0"], assumptions: [], goal: "v0 = v0" };

it("checks proofs against the pinned toolchain and keeps concurrent batches isolated", async () => {
  expect((await readFile(new URL("../lean-toolchain", import.meta.url), "utf8")).trim()).toBe("leanprover/lean4:v4.19.0");
  const calls = await Promise.all([
    runLeanGoals([goal]),
    runLeanGoals([{ ...goal, goal: "v0 < v0" }]),
  ]);
  expect(calls.map((m) => m.get("g")?.status)).toEqual(["proved", "disproved"]);
  expect((await runLeanGoals([goal])).get("g")?.status).toBe("proved");
});

it("keeps open, exhausted and malformed goals inconclusive", async () => {
  const batch = await runLeanGoals([
    goal,
    { ...goal, key: "open", kind: "preconditions", assumptions: ["v0 = 7"] },
    { ...goal, key: "malformed", goal: "NotAProposition" },
    { ...goal, key: "hole", goal: "(by sorry : Prop)" },
  ]);
  expect(batch.get("g")?.status).toBe("proved");
  for (const key of ["open", "malformed", "hole"]) {
    expect(batch.get(key)).toMatchObject({ status: "unknown", reason: expect.any(String) });
  }
  expect((await runLeanGoals([goal], { maxHeartbeats: 1 })).get("g")).toMatchObject({ status: "unknown" });
});
