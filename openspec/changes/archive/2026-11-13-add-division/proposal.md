# Proposal

## Why

Value operations currently exclude division, preventing verification of quotients and ratios. Supporting `/` requires preserving JavaScript's distinct bigint and binary64 semantics, especially zero divisors.

## What Changes

- Accept numeric `/` in bodies, predicates, guards and call arguments.
- Model bigint quotients exactly with the fractional part discarded, without converting to number.
- Require nonzero bigint divisors on evaluated paths in checked dependencies; otherwise return unknown without a fabricated counterexample.
- Model number division with binary64 rounding and all special values.
- Extend regression/runtime coverage, examples and both usage guides; `%` and `**` remain unsupported.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `source-analysis`: supported division expressions with existing type and structural restrictions.
- `static-verification`: exact quotient semantics and conservative handling of potentially throwing bigint division.

## Impact

IR, adapter, integrity checks, both numerical backends and the shared verification engine. Native runtime execution and existing regression formats remain unchanged. No new dependencies or public contract API changes.
