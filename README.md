# ts-value-proof

TypeScript statically checks types. **ts-value-proof adds a layer of static checking
for properties of values.** A function's return type can tell you that its result is
a `bigint`; a value contract can additionally require that the result is greater
than the input—and have that property checked before your code runs.

You describe valid inputs with `requires` and expected results with `ensures`.
This experimental verifier uses Z3 to attempt a mathematical proof that those
conditions hold for all inputs satisfying the preconditions, within its supported
model, without executing your code.

For example:

```ts
import { contract } from "../src/contract.ts"; // ts-value-proof API, from examples/

// TypeScript checks the return type.
function increment(value: bigint): bigint {
  return value + 1n; // Try - 1n: types pass, contract fails.
}

contract(increment, {
  // Z3 proves this for every bigint input.
  ensures: (result, value) => result > value,
});
```

[Runnable example](examples/bigint-exact.ts).

It also finds counterexamples and generates regression and property-based tests.

🔴 **Limited support:**

- **`bigint` / `number`:** addition (`+`), subtraction (`-`), unary minus (`-x`), and comparisons.
- **UTF-16 strings:** concatenation (`+`), strict equality (`===`), strict inequality (`!==`), and `.length`.
- **Unsupported arithmetic:** multiplication (`*`) and division (`/`).

## Try it

Node.js `^24.12.0 || >=26.0.0`. From the repository root:

```sh
npm ci --ignore-scripts
npm run verify -- examples/bigint-exact.ts
```

The CLI prints JSON: `verified` (exit 0), `refuted` / `inconsistent` (1),
or `unknown` (2). Try `examples/withdraw.ts` for an intentional contract violation.

Only a limited TypeScript subset is supported; contracts do not enforce runtime
checks. Verification covers the declared contracts, not arbitrary program correctness.

[Usage & limitations (Russian)](docs/usage.ru.md) ·
[Examples](examples/) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
