# Tasks

## 1. Dependency and GC regression

- [x] 1.1 Pin and install z3-solver 5.4.1, confirm upstream GC protection in the installed package, and pass typecheck for both backends.
- [x] 1.2 Add bounded child-process GC stress and repeated bigint verification checks, integrate test:solver/default tests, document the command, and demonstrate failure with isolated 4.16.0 and success with 5.4.1.

## 2. Integration verification

- [x] 2.1 Pass the full npm test suite, repeated GC/division runs, package build and isolated package smoke; validate the OpenSpec change and record results.

## Validation results

- Installed `5.4.1`; confirmed concurrent decref and asynchronous cleanup coordination in the distributed binding. Both backends pass `npm run typecheck` without compatibility edits.
- `npm run test:solver` passed. Five additional child-process runs passed all 100 stress rounds and 50 project verification rounds. In the first run, all 40,000 tracked collectible wrappers finalized during pending queries; retained terms, exact models, proofs, refutations, and resource limits were checked.
- The same check copied into an isolated `4.16.0` installation hung before finishing the stress phase and was killed by the diagnostic runner's 20-second deadline. This intentionally failing comparison did not modify the project's installed dependency.
- `npm run test:package` passed, including package compilation, a fresh consumer install, standalone CLI/API, declarations, Vite config and executable bundle.
- Full `npm test` passed in one uninterrupted run: contract API, bigint, binary64 and source/CLI checks; 109 runtime tests across 11 files; 21 build tests including native Vite watch. An earlier run was stopped because Vitest discovered diagnostic copies of old tests under `work/`; those copies were removed before the successful run.
- Five additional ordinary local runs of `scripts/division.test.ts` all passed (12 tests each), without instrumentation or cleanup patches. `openspec validate upgrade-z3-gc-safety --strict` and `git diff --check` passed. Passing these checks is regression evidence, not a formal proof of verifier correctness.

## Workflow follow-up

- Sync delta specs, validate main specs, archive the completed change, and commit the implementation with its OpenSpec artifacts.
