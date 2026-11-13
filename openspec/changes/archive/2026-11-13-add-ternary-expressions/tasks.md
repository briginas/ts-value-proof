# Tasks

## 1. Поддержка тернарных выражений

- [x] 1.1 Добавить адаптацию, разрешить чистые ternary в IR и сохранить result-зависимости; добавить тесты контекстов, ограничений, путей, деления, runtime и regression replay, обновить устаревшие отрицательные тесты; проверить typecheck и целевой test suite.
- [x] 1.2 Добавить runnable example, обновить README и оба руководства с ограничениями; проверить пример CLI и соответствие документации реализации.

## 2. Интеграция

- [x] 2.1 Выполнить npm test, проверку пакета и OpenSpec validation; зафиксировать результаты и устранить регрессии.

## Workflow follow-up

- Синхронизировать delta specs, проверить main specs, заархивировать change и создать Git-коммит.

## Validation results

- `npm run typecheck`: passed.
- Targeted ternary and string suites: 24 tests passed, including 10 ternary tests; native execution, property checks and exact counterexample replay are covered.
- `npm run verify -- examples/ternary-expressions.ts`: verified.
- `npm_config_offline=true npm run test:package`: passed isolated installation, CLI, declarations, Vite and executable bundle checks. The online attempt timed out during npm install.
- The Vite watch test timed out in the filesystem sandbox and passed outside it.
- One full-run attempt encountered the internal Z3 error `Expected boolean expression: (- 1)` in an existing division check. The next run passed that check. A similar error was already recorded in the archived add-division change; no solver-lifecycle fix is claimed here.
- The subsequent `npm test` passed all script checks and 106/108 runtime tests, including all ternary tests; two existing division tests encountered internal Z3 `Expected integer expression` errors. An isolated rerun of the complete division and build suites passed all 33 tests (12 division, 21 build). The corrected local-declaration rejection test also passed in its 8-test suite. Every suite passed across these runs, but a single fully green `npm test` run was not obtained; the intermittent solver failure remains a limitation.
- `openspec validate add-ternary-expressions` and `git diff --check`: passed. After sync, `openspec validate --specs`: 9 passed; the existing long source-analysis requirement retains its nonblocking length warning.
