# Tasks

## 1. Преобразование switch

- [x] 1.1 Добавить разбор switch/break и lowering с раздельными продолжениями; добавить shape и дифференциальные тесты выбора, default, fallthrough, вложенных выходов и граничных значений; проверить typecheck и целевые тесты.
- [x] 1.2 Проверить отказ для эффектов и неполных возвратов, unknown зависимостей, сохранение call ID и path guards; добавить интеграционные тесты solver/runtime/CLI и обновить русскую и английскую документацию; проверить целевые тесты.

## 2. Общая проверка

- [x] 2.1 Выполнить npm run typecheck, npm test и валидацию change; проверить итоговый diff и записать результаты проверок.

## Validation results

- `npm run typecheck`: passed.
- Целевые `scripts/switch.test.ts`: 11/11 passed; дифференциальные проверки 20 тел switch на 121 граничной паре и 200 случайных парах с seed 3517, отдельные bigint/UTF-16 случаи.
- `npm test`: passed, включая все script checks, 62 runtime-теста и 18 build-тестов.
- `openspec validate add-switch-lowering --strict`: passed.
- `openspec validate --specs`: 9/9 passed; прежнее предупреждение о длине требования управления потоком сохраняется, его текст не менялся.
- `git diff --check`: passed; проверен diff адаптера, lowering, тестов и документации.
- Успешные тесты не являются формальным доказательством корректности адаптера.

## Workflow follow-up

- Синхронизировать delta specs и проверить спецификации.
- Заархивировать завершённый change и создать Git-коммит.
