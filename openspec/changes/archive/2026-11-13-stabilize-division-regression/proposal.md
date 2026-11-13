# Proposal

## Why

GitHub CI на Node.js 24 и 26 падает в number-регрессии деления: свободный поиск контрпримера для `x/x === 1` возвращает `unknown`. Локально запрос приближается к стандартному таймауту Z3 в 5 секунд; тест сохранения и replay не должен зависеть от скорости такого поиска.

## What Changes

- Ограничить number-fixture предусловием `x === 0`, сохранив проверку нарушения, генерации manifest и replay.
- Выводить имя fixture и полный verification report при неожиданном статусе.
- Уточнить сценарий подтверждения number-контрпримера при делении нуля на ноль.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `regression-generation`: явный сценарий сохранения и воспроизведения нарушения для `x/x` при нулевом входе.

## Impact

Изменяются `scripts/division.test.ts` и артефакты OpenSpec. API, реализация верификатора и лимиты Z3 сохраняются. Проверки: целевой тест, typecheck, полный npm test и test:package; после отправки коммита — CI GitHub на Node.js 24 и 26.
