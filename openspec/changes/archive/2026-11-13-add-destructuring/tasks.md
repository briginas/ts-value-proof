# Tasks

## 1. Поддержка локального destructuring

- [x] 1.1 Реализовать lowering literals/patterns, mutable binding elements и диагностику; добавить solver/runtime tests для вложенности, snapshots, defaults, eager evaluation, ветвей, вызовов и отказов; проверить targeted suite и typecheck.
- [x] 1.2 Добавить runnable example, обновить README и оба usage guide, подключить тесты к test:runtime; проверить пример через CLI.

## 2. Интеграция

- [x] 2.1 Выполнить npm test, npm run typecheck и проверку OpenSpec; зафиксировать результаты и ограничения.

## Workflow follow-up

- Синхронизировать delta specs и проверить main specs.
- Заархивировать завершённый change и создать Git-коммит.

## Validation results

- `npm run typecheck`: passed.
- Targeted destructuring/local-variables/assignments suite: 24/24 passed; after shorthand symbol review, destructuring suite again passed 7/7.
- `npm run verify -- examples/destructuring.ts`: verified both contracts.
- `npm test`: API, bigint/source, binary64/source checks and 117 runtime tests passed. Build stage passed 20/21; native watch timed out in the sandbox, matching the documented environment limitation.
- `npm run test:build` outside the sandbox: all 21 tests passed, including native watch.
- `openspec validate add-destructuring --strict` and `git diff --check`: passed.
- Scope: literal object/array sources only; no structural parameters, rest/spread, aggregate aliases or runtime-dependent undefined. Tests do not constitute a formal proof of verifier correctness.
- Main specs validation: 9/9 passed; only the pre-existing long-description warning for the expression/control-flow requirement remains. Delta contents were compared with the synchronized main spec.
