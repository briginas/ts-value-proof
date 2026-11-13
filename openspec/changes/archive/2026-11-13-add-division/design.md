# Design

## Context

See proposal.md for motivation. Numeric operations share a typed IR and lazy dependency-directed verification engine. The bigint backend uses Z3 integers; number uses low-level binary64 terms. The runtime executes the original TypeScript. Contract results describe selected dependencies, not total program safety.

## Goals / Non-Goals

**Goals:** preserve exact division semantics and prevent total SMT division from proving conditions that depend on a JavaScript exception.

**Non-Goals:** remainder, exponentiation, coercion, exception contracts, arbitrary runtime safety, new result formats or integer shortcuts for number division.

## Decisions

- Extend the existing binary operator union, parser and integrity validation. Use the existing dependency traversal and native runtime.
- Compute bigint magnitude as `abs(a) div abs(b)` and restore the sign. Direct signed Z3 `div` differs from JavaScript for negative dividends. ECMAScript specifies truncation and RangeError at zero: https://tc39.es/ecma262/2025/multipage/ecmascript-data-types-and-values.html#sec-bigint::divide . SMT integer division uses Euclidean semantics: https://smt-lib.org/theories-Ints.shtml .
- Add `div` to the model API; number uses `mk_fpa_div` with RNE, with no integer metadata shortcut.
- Collect guarded nonzero conditions during bigint expression translation. Check them before solving the predicate. Requires definedness is checked before assuming requires itself; implementation and call checks may assume already checked caller requires. Capture only facts available before each division, preventing later guarantees from circularly justifying it. Preserve branch and short-circuit paths when instantiating callee predicates and arguments.
- Return existing `unknown/unsupported-dependency` with an explanation for reachable zero divisors and existing `unknown/solver-unknown` on resource exhaustion. Avoid introducing exception counterexamples that regression replay cannot represent.
- Maintain selective checking: only translated dependencies are subject to definedness checks. Do not turn this arithmetic addition into whole-program exception analysis.

## Risks / Trade-offs

- Symbolic division and binary64 constraints can be expensive → retain solver limits and unknown, exercise deterministic constant/guarded examples.
- Circular safety assumptions or lost evaluation paths can produce false proofs → adversarial tests for unsafe requires/ensures, nested divisions, guards, call arguments, and modular guarantees.
- Additional solver calls for bigint safety → perform them only for division expressions; other operators retain their path.
- Tests are evidence, not a formal proof of the verifier → compare exact native results and replay counterexamples alongside negative cases.

## Migration Plan

No data or API migration. Update documentation and examples, run the full suite and package checks, sync specifications, archive and commit. Revert the change to restore the previous unsupported-division behavior.
