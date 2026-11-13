# Tasks

## 1. Поддержка локальных значений

- [x] 1.1 Реализовать последовательный разбор const/let, lexical scopes и sequence в IR, dependency analysis, solver и runtime; добавить тесты областей видимости, eager evaluation, call paths, отказов и целостности IR, обновить README/usage и пример; проверить typecheck, новый test suite и CLI-пример.

## 2. Интеграционная проверка

- [x] 2.1 Выполнить npm test, npm run test:package, проверку OpenSpec change и diff; зафиксировать существенные результаты.

## Проверки

- `npm run typecheck` — успешно.
- Новый suite: 8 тестов, включая таблицы отказов и сравнение с исходным JavaScript; повтор после уточнения cross-clause regression — успешно.
- `npm test`: contract API, core/number/CLI checks и все 89 runtime-тестов успешны. В build-suite обновлён устаревший отказ на const; native watch в sandbox завершился timeout.
- Повтор `npm run test:build` вне sandbox: все 19 тестов успешны, включая новый local declarations build и native watch.
- `npm run test:package`: первая установка остановилась по timeout из-за недоступного registry; повтор с `npm_config_offline=true` успешен, включая CLI, declarations и Vite bundle.
- `npm run verify -- examples/local-variables.ts` — verified.
- `openspec validate add-local-variables --strict` и `git diff --check` — успешно.
- Тесты проверяют наблюдаемое поведение и регрессии, но не являются формальным доказательством корректности верификатора.

## Workflow follow-up

- Синхронизировать delta specs с основными спецификациями и проверить их.
- Заархивировать завершённый change и создать Git-коммит.
