import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { verifyIntegers } from "./bigint-backend.ts";
import { reconcile, type LeanVerdict } from "./cross-check.ts";
import { enumerateObligations } from "./obligations.ts";

const ir = adapt("examples/withdraw.ts");
const obligations = enumerateObligations(ir);
const rows = await verifyIntegers(ir, {}, obligations);
const agreed = new Map<string, LeanVerdict>(rows.map(row => {
  if (row.status === "unknown") throw new Error("Expected a definite Z3 verdict for withdraw");
  return [row.key, { status: row.status }];
}));

test("joins independently ordered results by obligation and preserves the Z3 counterexample", () => {
  const results = reconcile(obligations, [...rows].reverse(), new Map([...agreed].reverse()));
  expect(results.map(r => [r.sourceName, r.status, r.crossCheck.comparison])).toEqual([
    ["withdraw", "satisfiable", "agreed"], ["withdraw", "proved", "agreed"],
    ["payChecked", "proved", "agreed"], ["payUnchecked", "disproved", "agreed"],
  ]);
  expect(results[3]).toHaveProperty("counterexample", expect.objectContaining({ amount: expect.any(String) }));
  expect(results[3]).not.toHaveProperty("key");
  expect(() => reconcile(obligations, rows, new Map())).toThrow(/coverage/);
  expect(() => reconcile(obligations, [...rows, rows[0]], agreed)).toThrow(/coverage/);
  expect(() => reconcile(obligations, rows.slice(1), agreed)).toThrow(/Missing/);
});

test("opposite definite answers in either direction suppress a claim and its witness", () => {
  const verdicts = new Map(agreed);
  for (const row of rows) {
    if (row.status === "proved") verdicts.set(row.key, { status: "disproved" });
    if (row.status === "disproved") verdicts.set(row.key, { status: "proved" });
  }
  const results = reconcile(obligations, rows, verdicts);
  for (const row of results.slice(1)) {
    expect(row).toMatchObject({ status: "unknown", reasonCode: "backend-disagreement", crossCheck: { comparison: "disagreement" } });
    expect(row).not.toHaveProperty("counterexample");
  }
});

test("a dispute over satisfiability blocks only successful rows depending on those assumptions", () => {
  const verdicts = new Map(agreed).set(rows[0].key, { status: "inconsistent" });
  const results = reconcile(obligations, [...rows].reverse(), verdicts);
  expect(results.map(row => row.status)).toEqual(["unknown", "unknown", "proved", "disproved"]);
  expect(results[1]).toMatchObject({ crossCheck: { z3: { status: "proved" }, lean: { status: "proved" }, comparison: "agreed" },
    reasonCode: "backend-disagreement" });

  const contradictory = rows.filter(row => row.kind !== "implementation").map(row =>
    row.kind === "preconditions" ? { ...row, status: "inconsistent" as const } : row);
  expect(reconcile(obligations, contradictory, agreed).map(row => row.status)).toEqual(["unknown", "proved", "disproved"]);
});

test.each(["unknown", "unsupported", "unavailable"] as const)("Lean %s preserves every raw Z3 verdict", status => {
  const verdicts = new Map<string, LeanVerdict>(rows.map(row => [row.key, { status, reason: "test reason" }]));
  const results = reconcile(obligations, rows, verdicts);
  expect(results.map(row => row.status)).toEqual(rows.map(row => row.status));
  for (const row of results) expect(row.crossCheck).toEqual({
    z3: { status: row.status }, lean: { status, reason: "test reason" }, comparison: "unconfirmed",
  });
  expect(results.at(-1)).toHaveProperty("counterexample");
});

test("an inconclusive Z3 result stays unknown even when Lean proves a violation", () => {
  const row = rows.find(row => row.status === "disproved")!;
  if (row.status !== "disproved") throw new Error("Expected a violation");
  const { counterexample: _, ...metadata } = row;
  const unknown = { ...metadata, status: "unknown" as const, reasonCode: "solver-unknown" as const, reason: "timeout" };
  const limited = rows.map(r => r.key === row.key ? unknown : r);
  for (const verdict of [{ status: "disproved" }, { status: "unknown", reason: "timeout" }] as const) {
    const result = reconcile(obligations, limited, new Map(agreed).set(row.key, verdict)).at(-1);
    expect(result).toMatchObject({ status: "unknown", crossCheck: { lean: verdict, comparison: "unconfirmed" } });
    expect(result).not.toHaveProperty("counterexample");
  }
});
