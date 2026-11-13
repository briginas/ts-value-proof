# Proposal

## Why

`z3-solver@4.16.0` can free native objects from JavaScript finalizers while a WASM solver worker is using the same context. This race reproduces in ordinary local bigint verification and can corrupt expression types, crash, or hang; a successful retry does not resolve it.

## What Changes

- Upgrade and pin `z3-solver` to `5.4.1`, which includes upstream concurrent-reference cleanup protection.
- Require verification to preserve live terms and usable solver state when garbage collection occurs during a query or between repeated queries.
- Add a bounded GC stress regression and repeated project-level verification checks; retain existing bigint, binary64, string, resource-limit, CLI, and package behavior.
- Document the dependency version and regression command for contributors.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `static-verification`: preserve solver state and valid results across garbage collection and repeated verification.

## Impact

`package.json`, `package-lock.json`, solver lifecycle tests, and contributor documentation. Backend compatibility changes will be made only if required by the upstream upgrade. No public API or supported TypeScript syntax changes are intended; no runtime monkey patch is introduced.
