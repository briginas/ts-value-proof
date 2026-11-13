# Proposal

## Why

Локальный destructuring сейчас отклоняется даже для литералов с известной структурой. Его поддержка позволит разбирать значения и обменивать переменные без расширения моделей входных объектов и массивов.

## What Changes

- Поддержать object/array patterns в локальных const/let и отдельных присваиваниях из литералов, включая вложенность, переименование, пропуски и defaults.
- Сохранить порядок вычислений, снимок RHS перед присваиваниями и ленивое выполнение defaults.
- Отклонять rest/spread, computed keys, getters/methods, произвольные источники объектов, структурные параметры и значения undefined без default.
- Добавить проверки solver/runtime, примеры и документацию ограничений.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `source-analysis`: локальные объявления и присваивания с destructuring и сохранением семантики вычислений.

## Impact

Source adapter и его тесты, README, usage guides и runnable example. Публичный IR, solver backends и модели входных значений остаются скалярными; новых зависимостей нет.
