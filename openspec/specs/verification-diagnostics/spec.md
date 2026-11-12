# verification-diagnostics Specification


## Purpose

Определить переносимый формат результатов верификации, исходные позиции, диагностические причины и поведение программного API и CLI при успешных и неуспешных проверках.

## Requirements

### Requirement: Структура отчёта и обязательств

Отчёт SHALL содержать абсолютный input, semantics, общий status и массив results. Результаты SHALL различать preconditions, implementation и call. Каждый результат SHALL содержать идентификатор function, исходное sourceName, позицию source, читаемое condition и requires с условиями и позициями предикатов.

#### Scenario: Отчёт для связанного графа

- **WHEN** проверяется программа с обоими предикатами контракта и вызовом функции
- **THEN** отчёт содержит результаты совместимости, реализации и вызова с идентичностью исходных функций

#### Scenario: Одинаковые имена

- **WHEN** функции из разных модулей имеют одинаковое имя
- **THEN** результаты сохраняют разные function ID и исходные файлы при одинаковом sourceName

#### Scenario: Модель number в отчёте

- **WHEN** проверяется поддерживаемый однородный number-граф
- **THEN** semantics равен number-ieee754-binary64; bigint-граф сохраняет bigint-exact-integers, отказ от модели — unsupported

#### Scenario: Неуказанные условия

- **WHEN** проверяется requires-only либо ensures-only контракт
- **THEN** results не содержит фиктивных implementation либо preconditions соответственно; scope показывает заданные предикаты, моделируемые и исключённые параметры, число мест вызова

#### Scenario: Только логические условия

- **WHEN** ни одно проверяемое условие не требует числовых или строковых значений
- **THEN** semantics равен logical; при наличии одной числовой модели логические условия сохраняют её прежнюю semantics

### Requirement: Исходные позиции

Диагностические позиции SHALL содержать абсолютный file, line и column с единицы, start и end как смещения UTF-16 с нуля с исключённым концом диапазона. Позиция функции SHALL указывать на объявление, implementation.contractSource — на ensures, а позиции requires — на соответствующие исходные предикаты.

#### Scenario: Контракт в отдельном файле

- **WHEN** реализация и контракт находятся в разных модулях
- **THEN** source указывает на модуль реализации, а contractSource и requires.source — на модуль контракта

#### Scenario: Проверка диапазона

- **WHEN** из исходного файла выделяется диапазон start:end позиции предиката
- **THEN** он совпадает с исходным текстом соответствующей стрелочной функции

### Requirement: Диагностика вызовов

Результат call SHALL содержать callId, callSource, callee с ID, именем и позицией, contractSource для requires callee, arguments, checkedCondition с подставленными аргументами и pathCondition. Читаемое condition SHALL использовать исходное имя callee; requires SHALL описывать собственные предусловия caller.

#### Scenario: Подстановка выражения аргумента

- **WHEN** caller вызывает positive(x + 1n), а requires positive задаёт x > 0n
- **THEN** arguments содержит x: "(x + 1n)", checkedCondition показывает "((x + 1n) > 0n)", а callSource указывает на исходный вызов

#### Scenario: Раздельные места диагностики

- **WHEN** caller, callee и контракт находятся в трёх разных модулях
- **THEN** source, callee.source и contractSource указывают на соответствующие исходные модули

### Requirement: Раздельные результаты путей

Результаты копий одного исходного вызова SHALL сохранять общий callId и callSource, но отдельные pathCondition и статусы. Формирование отчёта SHALL NOT объединять их с потерей результатов конкретных путей.

#### Scenario: Один небезопасный путь

- **WHEN** общий вызов имеет proved на одном пути и disproved на другом
- **THEN** JSON содержит оба результата с одинаковым callId и различными условиями пути

### Requirement: Точные контрпримеры

Контрпример SHALL представлять bigint-аргументы десятичными строками с суффиксом n без потери точности. Number-аргументы SHALL представляться точной number-кодировкой. Ключами SHALL быть имена параметров проверяемой функции, включая __proto__; для call это параметры caller. Отчёт SHALL NOT обещать одинаковый выбор модели между независимыми запусками solver.

#### Scenario: Большие значения

- **WHEN** нарушающий вход содержит положительное или отрицательное bigint за пределами точности number
- **THEN** JSON сохраняет все цифры и знак входа

#### Scenario: Имя __proto__

- **WHEN** нарушающий аргумент принадлежит параметру __proto__
- **THEN** counterexample сохраняет собственное поле __proto__ после сериализации и чтения JSON

#### Scenario: Контрпример caller с особым значением

- **WHEN** нарушение вызова найдено на number-входе NaN, Infinity или -0
- **THEN** counterexample содержит точную кодировку аргумента caller, включая собственное поле __proto__ при таком имени параметра

### Requirement: Машинные причины результатов

Неуспешные результаты SHALL содержать reason и reasonCode: contract-violation, inconsistent-contract, solver-unknown, weak-callee-contract, unsupported-dependency или incomplete-counterexample. Ошибки входа SHALL различать unsupported-code, unsupported-numeric-model и type-error; прочие ошибки CLI SHALL иметь verification-error. Доступная позиция ошибки входа SHALL сохраняться в source.

#### Scenario: Слабый контракт callee

- **WHEN** caller не доказан из-за абстрактного результата callee
- **THEN** результат имеет weak-callee-contract и пояснение без counterexample

#### Scenario: Ошибка типов

- **WHEN** TypeScript сообщает ошибку с исходной позицией
- **THEN** CLI-отчёт содержит type-error, текст причины и позицию первой диагностики

#### Scenario: Неподдерживаемая зависимость

- **WHEN** условие зависит от непрозрачного аргумента
- **THEN** unknown содержит reasonCode unsupported-dependency, объяснение и исходную позицию зависимости

### Requirement: JSON и коды завершения CLI

CLI SHALL выводить отчёт в JSON в stdout и сохранять тот же отчёт в work/verification.json относительно текущей директории. Код завершения SHALL быть 0 для verified, 1 для refuted или inconsistent и 2 для unknown или ошибки. При отсутствии аргумента входным файлом SHALL быть examples/withdraw.ts.

#### Scenario: Проверенные примеры

- **WHEN** запускается CLI для bigint-exact.ts, withdraw.ts и withdraw-number.ts
- **THEN** он возвращает соответственно verified/0, refuted/1 и refuted/1

#### Scenario: Совпадение сохранённого отчёта

- **WHEN** CLI завершил проверку
- **THEN** JSON из stdout совпадает с текущим work/verification.json

#### Scenario: Поддерживаемый положительный number-пример

- **WHEN** CLI проверяет number identity с requires: x => x === x и ensures: (result, x) => result === x
- **THEN** отчёт имеет semantics number-ieee754-binary64, verified и код 0

#### Scenario: Неподдерживаемое сочетание моделей

- **WHEN** CLI получает корректно типизированный граф с проверяемыми зависимостями обеих моделей bigint/number
- **THEN** отчёт имеет unknown/unsupported-numeric-model и код 2

### Requirement: Замена устаревшего отчёта

CLI SHALL заменять сохранённый отчёт текущим unknown-отчётом также при ошибках типов, неподдерживаемом коде и ошибках верификатора. Успешный отчёт предыдущего запуска SHALL NOT сохраняться как результат неуспешного текущего запуска.

#### Scenario: Ошибка после успеха

- **WHEN** после успешной проверки запускается файл с неподдерживаемым циклом или ошибкой типов
- **THEN** CLI возвращает код 2, а stdout и work/verification.json описывают ошибку нового входного файла

### Requirement: Отличие программных ошибок от отчётов

Программный verify() SHALL возвращать unknown-отчёт для неподдерживаемой числовой модели, но SHALL выбрасывать ошибки типов, остальные ошибки адаптера и нарушения целостности IR. CLI SHALL преобразовывать такие исключения в диагностический unknown-отчёт с кодом 2.

#### Scenario: Программная проверка number

- **WHEN** verify() получает корректно типизированный граф с проверяемыми зависимостями обеих моделей bigint/number
- **THEN** Promise завершается unknown-отчётом с unsupported-numeric-model

#### Scenario: Программная ошибка адаптера

- **WHEN** verify() получает неподдерживаемый цикл или ошибку типов
- **THEN** Promise отклоняется, а соответствующий запуск CLI возвращает диагностический unknown-отчёт

#### Scenario: Программная проверка поддерживаемого number

- **WHEN** verify() получает однородный number-граф с поддерживаемым синтаксисом
- **THEN** Promise завершается отчётом number-ieee754-binary64 по фактическим обязательствам, без безусловного unsupported-numeric-model

#### Scenario: Локальное unknown не является исключением

- **WHEN** отдельное обязательство имеет unsupported-dependency либо incomplete-counterexample
- **THEN** verify() возвращает отчёт с остальными результатами; CLI сохраняет тот же отчёт и выбирает exit code по общему статусу

### Requirement: Точная number-кодировка

JSON number-значения SHALL кодироваться объектом { kind: "number", bits: <16 lowercase hex digits> } для всех не-NaN binary64 или { kind: "number", special: "NaN" }. Bits SHALL хранить big-endian IEEE-754, включая знак нуля и бесконечности. NaN SHALL иметь единую canonical форму без сохранения payload. Обычные JSON number и null SHALL NOT заменять эту кодировку.

#### Scenario: Round-trip особых значений

- **WHEN** JSON записывается и читается для +0, -0, обеих бесконечностей, минимального subnormal и NaN
- **THEN** декодированные значения совпадают с исходными по Object.is, в частности -0 не становится +0 или null

#### Scenario: Неоднозначная или повреждённая кодировка

- **WHEN** декодер получает bits неверной длины, не-hex текст, NaN-биты, объект с bits и special одновременно, JSON number либо null
- **THEN** он отклоняет значение без coercion или исполнения строки

### Requirement: Читаемые number-условия

Читаемые condition, arguments, checkedCondition и pathCondition SHALL сохранять смысл number-литералов и явно различать -0, NaN и обе бесконечности. Точное восстановление входов SHALL выполняться из counterexample, а не из текстов условий.

#### Scenario: Знаковый ноль в формуле

- **WHEN** исходное выражение сравнивает x с -0
- **THEN** читаемая диагностика показывает -0, сохраняя позиции исходного выражения

### Requirement: Строковая модель отчёта

Отчёт с проверяемыми строковыми зависимостями SHALL иметь semantics string-utf16-number-binary64. Строковые аргументы SHALL кодироваться как { kind: "string", value: <строка> }, отличаясь от bigint-строк. JSON round-trip SHALL сохранять все кодовые единицы. Читаемые литералы SHALL экранироваться; scope SHALL считать используемый string моделируемым.

#### Scenario: Точный строковый вход
- **WHEN** вход содержит NUL, кавычки, обратный слеш, emoji, одиночный суррогат или текст "12n"
- **THEN** отчёт сохраняет исходную строку после JSON round-trip, не трактуя её как bigint
