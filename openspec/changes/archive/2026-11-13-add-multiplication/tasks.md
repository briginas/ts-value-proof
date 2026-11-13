# Tasks

## 1. Поддержка умножения

- [x] 1.1 Добавить `*` в адаптер, IR и оба backend; дополнить числовые и source/runtime проверки, перенести unsupported fixtures на деление; подтвердить через typecheck и целевые тесты.
- [x] 1.2 Обновить README и оба usage guide, добавить runnable bigint-пример; проверить пример CLI и согласованность ограничений.

## 2. Интеграция

- [x] 2.1 Выполнить полный npm test, test:package и валидацию OpenSpec; проверить diff и зафиксировать результаты.

## Workflow follow-up

- Синхронизировать delta specs, проверить основные спецификации, архивировать выполненный change и создать Git-коммит.

## Verification results

- `npm run typecheck`: passed.
- Targeted multiplication/selective/switch tests: 34 passed.
- Binary64 differential corpus: passed, including signed zero, NaN, overflow and halfway subnormal products.
- `npm test`: API, bigint/source, binary64/source and all 69 runtime tests passed. Build stage had 17 passes and one filesystem-watch timeout inside the sandbox; `npm run test:build` outside the sandbox passed all 18 tests.
- `npm_config_offline=true npm run test:package`: passed (isolated install, CLI, declarations, Vite bundle). Initial online run timed out on unavailable registry DNS.
- `npm run verify -- examples/multiplication.ts`: verified.
- `openspec validate add-multiplication --strict`: passed.
- `git diff --check`: passed.
- Tests provide regression coverage, not a formal proof of verifier correctness.
