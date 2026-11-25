# Spec Delta

## ADDED Requirements

### Requirement: Сравнение движков в отчёте

Каждая запись results SHALL содержать crossCheck с z3.status, lean.status и comparison. comparison SHALL принимать agreed для одинаковых определённых вердиктов, disagreement для противоположных, unconfirmed во всех остальных случаях. Lean SHALL различать unknown (без доказательства), unsupported (вне фрагмента) и unavailable (нет совместимого Lean). Все три SHALL сопровождаться причиной. Публичный counterexample SHALL предоставлять только Z3 при итоговом disproved.

#### Scenario: Одинаковое место вызова на двух путях

- **WHEN** один callId встречается на двух путях с разными результатами
- **THEN** каждый путь получает собственный crossCheck в соответствующем результате с прежними callSource, contractSource и pathCondition; различие статусов разных путей не считается конфликтом движков

#### Scenario: Программа опровергнута обоими движками

- **WHEN** оба движка подтверждают нарушение одного обязательства
- **THEN** оба исходных статуса равны disproved, comparison равен agreed, доступен обычный counterexample Z3; от Lean не требуется выдавать или сравнивать значения

#### Scenario: Запуск без установленного Lean

- **WHEN** подходящий бинарный файл Lean отсутствует, а Z3 доказал поддерживаемое условие
- **THEN** соответствующая запись содержит локальный proved, lean.status unavailable с причиной и comparison unconfirmed; stdout и сохранённый JSON совпадают

#### Scenario: Обе проверки неопределённы

- **WHEN** оба исходных статуса равны unknown
- **THEN** comparison равен unconfirmed

## MODIFIED Requirements

### Requirement: Машинные причины результатов

Неуспешные результаты SHALL содержать reason и reasonCode: contract-violation, inconsistent-contract, solver-unknown, weak-callee-contract, unsupported-dependency либо incomplete-counterexample, а при конфликте движков — backend-disagreement. Ошибки входа SHALL различать unsupported-code, unsupported-numeric-model и type-error; прочие ошибки CLI SHALL иметь verification-error. Доступная позиция ошибки входа SHALL сохраняться в source.

#### Scenario: Слабый контракт callee

- **WHEN** caller не доказан из-за абстрактного результата callee
- **THEN** результат имеет weak-callee-contract и пояснение без counterexample

#### Scenario: Ошибка типов

- **WHEN** TypeScript сообщает ошибку с исходной позицией
- **THEN** CLI-отчёт содержит type-error, текст причины и позицию первой диагностики

#### Scenario: Неподдерживаемая зависимость

- **WHEN** условие зависит от непрозрачного аргумента
- **THEN** unknown содержит reasonCode unsupported-dependency, объяснение и исходную позицию зависимости

#### Scenario: Движки дали противоположные вердикты

- **WHEN** определённые вердикты одного обязательства расходятся
- **THEN** локальный результат содержит unknown, reasonCode backend-disagreement, пояснение и оба исходных статуса с comparison disagreement
