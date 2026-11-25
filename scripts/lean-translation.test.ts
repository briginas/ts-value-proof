import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { translateLeanObligation } from "./lean-translation.ts";
import { enumerateObligations } from "./obligations.ts";

test("classifies the dependencies of each obligation separately", () => {
  const rows = enumerateObligations(adapt("examples/ternary-expressions.ts"));
  const translations = new Map(rows.map(row => [row.owner.sourceName, translateLeanObligation(row)]));
  expect(translations.get("safeDivide")).toMatchObject({ unsupported: expect.stringContaining("/") });
  expect(translations.get("absolute")).toMatchObject({ goal: { variables: ["v0"], goal: expect.stringContaining("if") } });
  expect(translations.get("sign")).toHaveProperty("goal");
});

test.each(["examples/number-identity.ts", "examples/string-basics.ts", "examples/multiplication.ts"])(
  "classifies non-linear, floating-point and string obligations outside the fragment (%s)", file => {
    const rows = enumerateObligations(adapt(file));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(translateLeanObligation(row)).toHaveProperty("unsupported");
  },
);
