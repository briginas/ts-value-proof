# ts-value-proof

**Verify constraints on argument and return values in TypeScript.** Define allowed
inputs and conditions the result must satisfy. Z3 proves those conditions hold for
every allowed input—without running your code.
This experimental verifier works within a limited set of supported operations and value models.

```ts
import { contract } from "../src/contract.ts"; // ts-value-proof API, from examples/

function increment(value: bigint): bigint {
  return value + 1n; // Try - 1n: types pass, contract fails.
}

contract(increment, {
  // Z3 proves this for every bigint input.
  ensures: (result, value) => result > value,
});
```

[Runnable example](examples/bigint-exact.ts).

`requires` defines valid inputs; `ensures` defines expected results. Here, the
contract proves that the result is greater than the input for every `bigint`.
The verifier also finds counterexamples and generates regression and property-based tests.

🔴 **Limited support:**

**Code structure**

- **Supported:** local `const`/`let` with initializers, `return`, `if/else`, blocks, and `switch`
  with fallthrough and unlabeled `break`.
- **Local variables:** plain names, nested scopes, and shadowing; no calls in initializers.
  See [example](examples/local-variables.ts) and [full limits](docs/usage.md#limitations).
- **Assignments:** standalone `=`, `+=`, `-=`, `*=`, `/=` to local `let` variables
  and parameters, including across branches; string `+=` is supported.
  No calls on the right-hand side. See [example](examples/assignments.ts).
- **Unsupported:** property writes, assignments inside expressions, `++`/`--`, other compound assignments, `var`, destructuring, loops,
  ternary expressions (`?:`), and `try/catch/finally`.

**Value operations**

- **`bigint` / `number`:** addition (`+`), subtraction (`-`), multiplication (`*`), division (`/`), unary minus (`-x`), and comparisons.
- **UTF-16 strings:** concatenation (`+`), strict equality (`===`), strict inequality (`!==`), and `.length`.
- **Division:** `bigint` discards the fractional part; checked dependencies must exclude a zero divisor. `number` follows JavaScript binary64, including `NaN`, infinities and signed zero.
- **Unsupported arithmetic:** remainder (`%`) and exponentiation (`**`).

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

For production builds, the [Vite plugin](docs/vite.md) verifies selected modules
and removes their contracts before JavaScript generation. The same verifier is
available separately through the CLI. See the guide for local package installation.

Usage & limitations: [English](docs/usage.md) · [Русский](docs/usage.ru.md) ·
[Examples](examples/) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
