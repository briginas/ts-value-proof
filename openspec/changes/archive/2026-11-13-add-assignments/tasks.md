# Tasks

## 1. Поддержка присваиваний

- [x] 1.1 Реализовать разбор, подстановку значений на путях и проверку call IDs; добавить тесты последовательности, снимков, scopes, if/switch/break, чисел/строк, диагностики и запрещённых форм; проверить typecheck и целевые тесты.
- [x] 1.2 Добавить пример assignments, обновить README и оба usage-руководства; проверить пример через CLI.

## 2. Интеграция

- [x] 2.1 Проверить assignments с контрактными вызовами, runtime/property testing, replay и Vite build; выполнить полный npm test и проверку пакета, зафиксировать результаты.

## Workflow follow-up

- Синхронизировать delta specs, проверить спецификации, архивировать change и создать Git-коммит.

## Validation results

- `npm run typecheck` и `git diff --check`: успешно.
- Целевой Vitest (assignments, local variables, switch): 28/28 тестов.
- `npm run verify -- examples/assignments.ts`: verified.
- `npm test`: contract API, bigint/source, binary64/source и CLI проверки успешны; runtime suite — 98/98 тестов. Старые отрицательные тесты присваиваний обновлены на формы, которые остаются неподдерживаемыми.
- `npm run test:build`: 20/20 тестов вне sandbox, включая assignments и native watch. В sandbox watch получает известный timeout; остальные 19 тестов проходят.
- `npm_config_offline=true npm run test:package`: успешно — изолированная установка tarball, CLI без Vite, declarations, Vite config и исполняемый bundle с присваиваниями. Обычная попытка остановилась по timeout после ENOTFOUND npm registry.
- `openspec validate --all`: успешно; сохраняется прежнее предупреждение о длине требования управления потоком (>500 символов).
- Успешные проверки не являются формальным доказательством корректности верификатора.
