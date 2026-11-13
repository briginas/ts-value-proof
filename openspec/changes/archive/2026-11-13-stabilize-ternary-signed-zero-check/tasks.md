# Tasks

## 1. Stable scalar ternary regressions

- [x] 1.1 Share the choose implementation and split unrestricted NaN/equality and zero-only reciprocal proofs; run the scalar and resource-limit ternary tests and preserve native checks for both zero signs.
- [x] 1.2 Add a positive-zero mutation, require a contract-violation counterexample and replay it against native execution; run the targeted signed-zero test.

## 2. Integration validation

- [x] 2.1 Run npm run typecheck, npm test and npm run test:package; record outcomes and validate the OpenSpec change.

## Validation results

- Node.js 26.3.0: `npm run typecheck` passed.
- Targeted scalar, signed-zero mutation/replay and resource-limit tests: 3 passed; scalar case about 0.9 s, signed-zero case about 1.3 s including mutation and regression generation.
- `npm test`: all verifier scripts passed and all 110 runtime tests passed. The build stage had one native watch timeout in the sandbox; rerunning `npm run test:build` outside the sandbox passed all 21 tests.
- `npm run test:package` passed outside the sandbox, including isolated installation, CLI, declarations and Vite build. The initial sandbox attempt timed out during npm installation.
- `openspec validate stabilize-ternary-signed-zero-check --strict` passed. `openspec validate --specs` passed all 9 specs. Strict main-spec validation reports the pre-existing >500-character requirement description in source-analysis; that unchanged requirement is outside this fix.
- Main-spec ternary requirement matches the delta exactly; no delta section headers were introduced into the main spec. `git diff --check` passed.
- These results are regression evidence, not a formal proof of verifier correctness. GitHub CI has not been rerun for this local change.

## Workflow follow-up

- Sync the delta to the main specification, validate specifications, archive the completed change and commit the implementation with its OpenSpec artifacts.
