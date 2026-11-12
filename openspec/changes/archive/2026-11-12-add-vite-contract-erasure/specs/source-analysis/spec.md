## MODIFIED Requirements

### Requirement: Явный граф локальных модулей

Анализатор SHALL включать входной .ts-файл и runtime-модули, достижимые через относительные value imports и re-exports, включая side-effect imports. Type-only зависимости SHALL проверяться TypeScript без добавления реализаций в runtime-граф. API src/contract.ts и API этого экземпляра пакета (import из ts-value-proof) SHALL распознаваться по модулю и символу. Неимпортированные файлы SHALL NOT автоматически включаться в проверяемый граф.

#### Scenario: Контракт в отдельном модуле

- **WHEN** входной файл импортирует реализацию и подключает модуль её контракта через side-effect import
- **THEN** анализатор связывает контракт с импортированной функцией и включает её реализацию в проверку

#### Scenario: Ошибочная функция вне графа

- **WHEN** соседний .ts-файл не достижим из входного файла
- **THEN** его функции не добавляются в проверяемый граф

#### Scenario: Установленный API

- **WHEN** исходник импортирует contract из установленного ts-value-proof, в том числе через переименование или barrel
- **THEN** анализатор распознаёт доверенный API; другой модуль с одноимённой функцией доверенным не становится

### Requirement: Поддерживаемые формы модулей

Анализатор SHALL поддерживать относительные named value imports, named/star re-exports, локальные named exports, type/interface declarations и относительные type-only imports/exports. Type-only зависимости SHALL проверяться TypeScript без исполнения. Default/namespace value imports, сторонние runtime-пакеты кроме доверенного API ts-value-proof, import attributes, runtime-циклы, .d.ts вместо реализации кроме доверенного API и произвольный исполняемый top-level код SHALL отклоняться.

#### Scenario: Цепочка re-exports

- **WHEN** вызов разрешается через named re-export и export * до поддерживаемой функции
- **THEN** целью вызова остаётся исходное объявление этой функции

#### Scenario: Неподдерживаемый достижимый модуль

- **WHEN** граф содержит циклический импорт, declaration-only модуль вместо runtime-реализации, namespace import или top-level console.log
- **THEN** анализатор отклоняет программу

#### Scenario: Именованный непрозрачный тип

- **WHEN** параметр использует type/interface из локального .ts или .d.ts через import type
- **THEN** тип разрешается, но type-only модуль не исполняется и не считается реализацией
