# Design

## Context

See proposal.md for the CI failure. `choose(x)` returns `x!==x ? NaN : x===0 ? -0 : x`. Its original ensures combines classification/equality with `1/result===-Infinity` for zero inputs. Local exploration with Z3 5.4.1 verified the unrestricted NaN/equality condition in about 0.5 seconds and the zero-only reciprocal condition in about 0.3 seconds, using unchanged solver defaults.

## Goals / Non-Goals

**Goals:** Preserve the original logical coverage with simpler solver queries; demonstrate that the signed-zero assertion rejects a positive-zero mutation.

**Non-Goals:** Change verifier algorithms, supported syntax, dependency versions, default timeouts or the meaning of unknown.

## Decisions

- Reuse the exact same `choose` source in both fixtures. The unrestricted ensures checks `x!==x ? r!==r : r===x`, so every number input remains covered. A second fixture uses `requires:x=>x===0` and `ensures:r=>1/r===-Infinity`; JavaScript equality admits both zero signs. Together these conditions imply the original contract, including `r===0` from the unrestricted condition.
- Keep native execution checks over NaN, infinities, subnormal values, ordinary numbers and both zero signs. Explicitly check both zero signs in the restricted fixture too.
- Mutate the selected `-0` to `0`, assert refutation with a contract-violation counterexample, and replay that counterexample through the real function. Do not accept unknown as success or rely on a particular model's input zero sign.
- Retain the existing resource-limit test and the 5000 ms default. Raising timeouts merely increases the margin for the expensive combined query; splitting removes symbolic general division from the unrestricted proof instead.

## Risks / Trade-offs

- Separate fixtures could drift → share the implementation source and document why the proofs are separate.
- Solver timings vary across systems → use structural query simplification without timing assertions; run all CI commands and retain fail-closed timeout behavior.
- Passing tests do not formally prove verifier correctness → record results as regression evidence only.
