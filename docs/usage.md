# ts-value-proof usage guide

[Overview](../README.md) · [Русский](usage.ru.md)

A prototype for static verification of TypeScript contracts with Z3. It checks
call preconditions (`requires`) and function postconditions (`ensures`), finds
counterexamples, and generates regression and property-based tests.
It supports exact `bigint` arithmetic, JavaScript `number` (IEEE-754 binary64),
and basic operations on `string` values (UTF-16).

## Contracts

```ts
import { contract } from "../src/contract.js";

export function withdraw(balance: bigint, amount: bigint): bigint {
  return balance - amount;
}

contract(withdraw, {
  requires: (balance, amount) => balance >= 0n && amount > 0n && amount <= balance,
  ensures: (result, balance, amount) => result >= 0n && result === balance - amount,
});
```

This example is intended for a file in `examples/`. Predicate types are inferred
from the function: `requires` receives its arguments; `ensures` receives the result
first, followed by the arguments. You can specify either predicate or both.
Without `requires`, inputs are unrestricted; without `ensures`, there is no
guarantee about the result. `contract()` itself only stores the description and
does not perform checks when the function is called.

## Running the verifier

Node.js `^24.12.0 || >=26.0.0` is required. Run all commands from the repository root.

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache ./work/npm-cache
npm run verify -- examples/bigint-exact.ts    # verified, exit 0
npm run verify -- examples/withdraw.ts        # refuted, exit 1
npm run verify -- examples/number-identity.ts # verified, exit 0
npm run verify -- examples/withdraw-number.ts # refuted, exit 1
npm run verify -- examples/string-basics.ts   # verified, exit 0
```

`withdraw.ts` intentionally includes a call without checking for sufficient funds.
The errors in `withdraw-number.ts` involve NaN and Infinity.
Other examples: [contracts across modules](../examples/modules/index.ts),
[requires-only contracts](../examples/selective-requires.ts),
[multiplication](../examples/multiplication.ts),
[bigint division](../examples/division.ts), [number division](../examples/division-number.ts),
and [selective verification](../examples/selective-mixed.ts).

The CLI prints JSON and saves the same report to `work/verification.json`.
For JSON-only stdout, use `npm run --silent verify -- <file>`.

| Overall `status` | Exit code | Meaning |
| --- | --- | --- |
| `verified` | 0 | All checked conditions have been proved. |
| `refuted` | 1 | A postcondition or call precondition violation was found. |
| `inconsistent` | 1 | Preconditions are contradictory. |
| `unknown` | 2 | No proof was obtained, the code is unsupported, or an error occurred. |

Check the overall status of the report. The `scope` field describes the scope of
verification; `results` contains individual conditions, their source locations,
reasons, and counterexamples. `verified` applies only to the declared contracts
and calls within the checked graph; callers outside that graph are not checked
for compliance with preconditions.

## Generating tests

```sh
npm run generate-tests -- examples/withdraw.ts work/generated
npx vitest run work/generated/contracts.test.ts --maxWorkers=1
```

The generator writes `cases.json` with counterexamples confirmed by execution
and `contracts.test.ts` to replay them and run property-based checks using
fast-check. Regenerating replaces both files.

For `withdraw.ts`, the `payUnchecked` regression is expected to fail. After adding
an `amount > balance` check before the call, the test passes without regenerating.
Keep `cases.json` to check fixes against the original inputs.
The `work/` directory is ignored by Git; choose another directory to keep tests
in the repository. After changes to signatures or call structure, stored cases
may become `inapplicable`, which counts as a test failure.

Generator exit code 0 means the files were written successfully, even if there
are no counterexamples; exit code 2 means an error or an unconfirmed counterexample.
This is not a verification result. Passing property-based tests is not a proof
either. Test mode executes source code and is intended for trusted projects;
the static verifier does not execute the code.

## Limitations

- Before analysis, source files are checked by TypeScript with fixed `strict`,
  `noImplicitReturns`, ES2022, and NodeNext settings, regardless of the user's
  `tsconfig.json`. Type errors stop analysis; `@ts-ignore`, `@ts-nocheck`, and
  `@ts-expect-error` directives are not allowed.
- Supported constructs include named synchronous functions with explicit types
  for required parameters and the return value; `return`, `if/else`, blocks, `switch`;
  `+`, `-`, `*`, `/`, unary minus, comparisons, `===`, `!==`, `&&`, `||`, and `!`.
- `switch` supports `case`, `default` in any position, fallthrough, nested switches,
  and unlabeled `break`, including inside `if`. Selection uses strict equality:
  `NaN` never matches and `+0` matches `-0`. Selectors and case expressions must
  have no calls, mutations, or property access except primitive string `.length`.
  Existing type/model restrictions apply; missing return paths and labeled breaks
  are not supported.
- Local `const` and `let` support plain names and required initializers, with or
  without type annotations, including multiple declarations and block shadowing.
  Values can be used in returns, conditions, and call arguments. Initializers
  cannot contain calls or property access except primitive string `.length`.
  Locals declared in a `switch` clause cannot be read from another clause.
  When checking a result or a later call, preceding initializers are included
  even if their values are unused: a later guard cannot protect earlier division.
  Independent predicates that do not use the body retain selective checking.
  See [the local variables example](../examples/local-variables.ts).
- Mutations, `var`, destructuring, uninitialized locals, `using`, loops, recursion, `async`, generics, overloads,
  optional/rest/default parameters, and the ternary operator are not yet supported.
  Remainder, exponentiation, and other unsupported operations in a
  checked condition produce `unknown`.
- A contract must be an inline object with expression-bodied arrow predicates.
  Only one contract per function is allowed. Calls are allowed within return
  expressions; the called function must have a contract. Calls in `if` conditions,
  `switch` selectors or case expressions,
  contract predicates, or arguments to other calls are not supported.
- Verification covers the module graph reachable from the entry file. Relative
  named imports, re-exports, and function aliases are supported. External runtime
  packages, default/namespace value imports, and module cycles are not supported.
- `bigint` and `number` cannot be combined in checked dependencies.
  `string` can be combined with `number`, but not yet with `bigint`.
  Opaque parameters do not prevent checking an independent condition, but a
  dependency on them produces `unknown`. Test mode supports `bigint` graphs or
  `string`/`number` graphs and rejects opaque types.
- For `string`, supported operations include literals, template literals without
  substitutions, `===`, `!==`, `string + string`, and `.length`, including in
  arguments to internal calls. Length counts UTF-16 code units:
  `"😀".length === 2`. Indexing, string methods, regular expressions, `<`/`>`
  comparisons, and implicit conversions are not yet supported. Signatures must
  use `string`, without literal types or unions.
- `bigint` division discards the fractional part: `-7n / 3n === -2n`.
  A divisor must be nonzero on each evaluated path in the checked dependencies.
  Use `requires: (x, y) => y !== 0n` or guard the division with a branch or
  short-circuit expression. A potentially zero divisor produces
  `unknown/unsupported-dependency`; solver limits produce `unknown/solver-unknown`.
  In `requires`, put the guard before division: `y !== 0n && x / y > 0n`.
  Verification remains selective; this is not an exception-safety check of unused code.
- `number` division uses binary64 rounding: `1 / 0 === Infinity`,
  `1 / -0 === -Infinity`, and `0 / 0` is `NaN`. No nonzero guard is required.
- `number` includes NaN, Infinity, and both signs of zero. If inputs need
  restrictions, specify them in `requires`. In JSON, a `bigint` is stored as a
  string such as `"123n"`, and a `number` as an object with exact bits or a NaN marker.
- Strings in JSON use `{ "kind": "string", "value": "text" }`, preserving NUL and
  lone surrogates. String reports use `string-utf16-number-binary64`; regressions
  use manifest v3 with signature types. Earlier v1/v2 manifests remain compatible.
  If a string counterexample exceeds 65536 code units per argument, the result is
  `unknown`; this limit does not restrict the scope of the proof.
- A weak postcondition on a called function may produce `unknown`; an abstract
  model found by the solver is not treated as a confirmed error. Each Z3 query
  has a default timeout of 5 seconds. Multiplication and division constraints can
  reach this limit and return `unknown`; supporting an operator does not guarantee a proof.

Proofs assume that actual arguments match their declared TypeScript types.
The project supports a limited subset of the language; tests are not a formal
proof of the verifier's own correctness. String verification covers normal
completion; it does not prove compliance with a particular JavaScript engine's
memory limits or maximum allocatable string size.

## Development

```sh
npm run typecheck    # type checking
npm test             # full suite, including type checks and runtime tests
npm run test:runtime # runtime, replay, and property-based tests only
```

- [Specifications](../openspec/specs/) — current behavior and detailed limitations (in Russian).
- [Static verification](../openspec/specs/static-verification/spec.md) and
  [source analysis](../openspec/specs/source-analysis/spec.md) — supported language and semantics.
- [Diagnostics](../openspec/specs/verification-diagnostics/spec.md) — report fields and error reasons.
- [Regression replay](../openspec/specs/regression-replay/spec.md) and
  [property-based testing](../openspec/specs/property-testing/spec.md) — test mode rules.
- [AGENTS.md](../AGENTS.md) — contribution rules.
