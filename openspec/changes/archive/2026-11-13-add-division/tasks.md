# Tasks

## 1. Division semantics

- [x] 1.1 Add `/` to source/IR validation, both backends and guarded bigint definedness checks; add tests for signed and large quotients, zero divisors, predicates, paths, calls, number special values, invalid IR and remaining unsupported operators; verify typecheck and the division test suite.
- [x] 1.2 Update README and both usage guides and add runnable bigint/number examples; verify example CLI results and documentation consistency.

## 2. Integration verification

- [x] 2.1 Verify native runtime, property tests and regression generation/replay for division, then run the full tests, package checks and OpenSpec validation; record outcomes and review the diff.

## Workflow follow-up

- Sync delta specs, validate the resulting specifications, archive the completed change and create a Git commit.

## Validation results

- `npm run typecheck`: passed.
- Contract API, bigint checks, number codec/backend and number source/CLI scripts: passed.
- `npm run test:runtime`: 81 tests passed, including 12 division tests, native differential checks, property checks and exact regression replay.
- `npm run test:build`: 18 tests passed outside the filesystem sandbox. Inside the sandbox the watch test timed out waiting for a filesystem event; the other 17 passed.
- `npm_config_offline=true npm run test:package`: passed isolated installation, CLI, declarations, Vite and executable bundle checks. The online attempt timed out accessing the npm registry.
- Both division examples: CLI status `verified`.
- `openspec validate add-division --strict` and `git diff --check`: passed.
- One intermediate long-running check encountered an internal Z3 `Expected boolean expression: #b0` error. Subsequent bigint and binary64 runs passed; its cause was not established and no solver-lifecycle fix is claimed by this change.
- After synchronization, `openspec validate --specs`: 9 specs passed; the existing long source-analysis requirement still emits a nonblocking length warning.
