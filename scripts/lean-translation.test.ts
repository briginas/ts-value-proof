import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { translateLeanObligation } from "./lean-translation.ts";
import { enumerateObligations } from "./obligations.ts";

test("classifies the dependencies of each obligation separately", () => {
  const rows = enumerateObligations(adapt("examples/ternary-expressions.ts"));
  const translations = new Map(rows.map(row => [row.owner.sourceName, translateLeanObligation(row)]));
  expect(translations.get("safeDivide")).toMatchObject({
    goal: { goal: expect.stringContaining("Int.tdiv"), divisionChecks: [expect.stringContaining("≠ 0")] },
  });
  expect(translations.get("absolute")).toMatchObject({ goal: { variables: ["v0"], goal: expect.stringContaining("if") } });
  expect(translations.get("sign")).toHaveProperty("goal");
});

test("translates both occurrences of the square input as the same Lean integer", () => {
  const [row] = enumerateObligations(adapt("examples/multiplication.ts"));
  expect(translateLeanObligation(row)).toMatchObject({
    goal: { variables: ["v0"], goal: "((v0 * v0) >= (0 : Int))" },
  });
});

test.each(["examples/number-identity.ts", "examples/division-number.ts", "examples/string-basics.ts"])(
  "classifies floating-point and string obligations outside the fragment (%s)", file => {
    const rows = enumerateObligations(adapt(file));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(translateLeanObligation(row)).toHaveProperty("unsupported");
  },
);
