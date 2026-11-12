# Tasks

## 1. Общее ядро и удаление контрактов

- [x] 1.1 Выделить общее ядро отчётов, дополнить снимок исходников и разрешение API пакета; проверить совместимость CLI и диагностики тестами и typecheck.
- [x] 1.2 Реализовать удаление по AST со source maps, aliases и re-exports; проверить сохранение рабочего кода, отказ при несовпадении снимка и описать API/границы в документации.

## 2. Vite и установка

- [x] 2.1 Реализовать production-плагин Vite с entries, gating, watch и фиксированным разрешением зависимостей; проверить настоящие сборки, ошибки, повторные сборки и source maps, документировать конфигурацию.
- [x] 2.2 Добавить JS/declaration сборку, exports/bin и зависимости пакета; проверить npm pack и установку в отдельный проект с CLI и Vite, документировать локальную установку.

## 3. Проверка интеграции

- [x] 3.1 Выполнить typecheck, полный npm test, build:package и строгую OpenSpec-валидацию; записать существенные результаты и проверить diff.

## Workflow follow-up

- Синхронизировать delta specs, проверить main specs, архивировать change.
- Создать Git-коммит со всей проверенной реализацией и артефактами OpenSpec.

## Validation results

- `npm run typecheck`, `npm run build:package`, `git diff --check` — passed.
- `npm test` — passed: verifier/API/diagnostic suites, 51 runtime tests and 18 Vite build tests.
- `npm run test:package` — passed: isolated tarball installation, CLI without Vite, consumer declarations and real Vite build with executable output.
- `openspec validate add-vite-contract-erasure --strict` — passed.
- Native Vite watch requires filesystem watching outside this session sandbox; its failure inside the sandbox was reproduced without the plugin. The full suite passed outside the sandbox on Node 26.3.0. CI runs Node 24 and 26.
- Passing tests do not formally prove the verifier or the downstream compiler pipeline correct.
- Main specs: `openspec validate --specs` passed all 9; `verified-build --strict` passed. Global strict validation reports the existing 535-character source-analysis requirement (unchanged in this change); no unrelated requirement was rewritten.
