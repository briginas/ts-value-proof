# Proposal

## Why

CI #10 fails on Node.js 24 and 26 after upgrading Z3 to 5.4.1: the combined ternary/NaN/signed-zero proof exceeds the default 5000 ms solver timeout. The same test passes locally but takes about 4.4 seconds, leaving little margin for CI runners.

## What Changes

- Split the scalar ternary regression into an unrestricted NaN/value proof and a signed-zero proof restricted to zero inputs, preserving the original coverage together.
- Check that replacing the selected negative zero with positive zero produces a real contract violation.
- Clarify the existing ternary scenario for special binary64 values. Keep solver defaults, timeout diagnostics and production behavior unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `source-analysis`: clarify preservation and observability of NaN and signed zero in nested ternaries.

## Impact

`scripts/ternary.test.ts` and OpenSpec artifacts. No API, dependency or production-code changes. Validation includes the targeted tests, the complete CI commands, and a pushed CI run if publication is authorized.
