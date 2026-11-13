# Design

## Context

Adapter связывает символы TypeScript с временными SourceStatement.bind; returnExpression удаляет привязки с сохранением sequence и снимков. Публичный IR скалярный. Мотивация описана в proposal.md; пользователь выбрал локальные patterns без структурных параметров.

## Goals / Non-Goals

**Goals:** использовать существующий lowering, проверять порядок, ошибки и пути через solver и исполнение исходного TypeScript.

**Non-Goals:** добавление heap/object/iterator модели, aggregate aliases, rest/spread, destructuring параметров, изменение публичного IR и backends.

## Decisions

- Разбирать literal RHS во временное дерево object/array/scalar/undefined. Каждый скаляр заранее сохранять в уникальный bind, включая неиспользуемые значения. Затем обходить pattern. Прямая подстановка выражений без снимков неверна для обмена переменных.
- Defaults структурно проверять всегда, но добавлять их вычисления только при статически известном undefined. Поддержать nested literal defaults. Неизвестные optional/union значения не моделировать как undefined: отклонять их, поскольку скалярный IR не содержит этой семантики.
- Объединить binding и assignment patterns через рекурсивный обход с callback для targets. Для let BindingElement определять изменяемость по enclosing VariableDeclarationList.
- Имена object keys брать из синтаксиса, shorthand RHS разрешать по value-symbol TypeScript. Не обращаться к прототипам JavaScript при поиске полей: использовать Map. Отсутствующие prototype keys отклонять; __proto__ property assignment в RHS запрещать. Несоответствие формы object/array отклонять.
- Вынести разбор patterns и литералов в отдельный внутренний модуль с адаптерными callbacks. Это изолирует AST-логику без расширения остальных проходов.

## Risks / Trade-offs

- Потеря раннего деления или unsupported dependency → сохранять каждый скаляр RHS через bind и проверять unused/omitted cases.
- Неверные snapshots и defaults → differential tests против исходного TypeScript, swap и repeated targets, последовательные defaults и ветвления.
- Ошибочная трактовка undefined либо inherited keys → принимать только синтаксически известное отсутствие, проверять символ глобального undefined и отклонять неоднозначные источники.
- Узкий набор источников → явно документировать ограничения; структурные параметры требуют отдельного change.

## Migration Plan

Добавить поддержку и тесты, обновить пример и guides, выполнить typecheck и полный test suite. Синхронизировать specs, проверить и заархивировать change, закоммитить. Изменений API и данных нет; rollback — revert коммита.
