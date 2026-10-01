# Контур КП — решения по расхождениям Stage 08 перед миграцией

Рассмотрены Р-08-1…Р-08-8, OD-08-6 и расхождение нумерации AD.

**Статус после решений: READY_TO_CONTINUE_STAGE_08**

Миграцию разрешается проектировать и реализовывать после внесения этих решений в D-026 / архитектурный документ.

---

# 0. Нумерация AD-08-x

**Решение**

Нормативной считается нумерация:

- из preflight Stage 08;
- уже существующих `decisions.md`;
- ADR/spec проекта.

Номера `AD-08-x`, которые я использовал в предыдущей команде и которые обозначают другие темы, **не перенумеровывают preflight**.

В документации сделать таблицу соответствия:

`preflight AD → смысловое решение владельца → источник`

Без создания второго набора AD с теми же номерами.

Если решение владельца покрывает несколько preflight-AD — так и указать.

---

# Р-08-1 — Q&A как evidence

## Решение: предложение принимается

Q&A получает **собственные evidence fragments (фрагменты доказательств)**.

Не включать их автоматически в общий search index (поисковый индекс), если Stage 07 этого не предусматривал.

Модель:

`qa_item / qa_revision`
→ `evidence_fragment`

Фрагменты используются для:

- provenance;
- requirement candidates;
- facts;
- citations;
- completeness review.

## Важно

Q&A fragment должен ссылаться на конкретную immutable revision Q&A.

Изменение ответа:

- не переписывает старый fragment;
- создаёт новую revision;
- новый набор evidence.

Search indexing Q&A — отдельное решение будущего этапа, если оно понадобится.

---

# Р-08-2 — coverage

## Решение: предложение принимается с уточнением

Не использовать неопределённый тип:

`implementation_artifact`

на Stage 08.

Хранить:

1. оценку покрытия конкретной `requirement_revision`;
2. один или несколько **типизированных coverage objects (объектов покрытия)**.

Минимально допустимые типы только там, где они уже существуют в модели проекта:

- `evidence_fragment`;
- `calculation_revision`;
- `decision`;
- `manual_confirmation`;
- другие типы — только после нормативного определения.

## Для A05 / комплексного покрытия

Одно требование может иметь несколько coverage objects.

Например:

`requirement_revision`
→ несколько calculation/evidence/decision objects
→ итоговая оценка `partial / covered / uncovered / needs_review`.

Не требовать одного объекта на одно требование.

## История

Оценка coverage должна иметь собственную историчность.

Изменение покрытия **не изменяет requirement_revision**.

---

# Р-08-3 — decision

## Решение: не вводить параллельный decision_revision

Использовать уже принятую таблицу/сущность:

`decision`.

Каждая строка `decision` считается **immutable версией решения**.

Для замены решения использовать связь:

`supersedes_decision_id`

или уже существующий нормативный эквивалент.

То есть:

`decision A`
→ `decision B supersedes A`

а не UPDATE строки A.

## Stage 08

Разрешается добавить необходимые Stage 08 decision kinds (виды решений), но не создавать вторую систему:

`decision → decision_revision`

если существующая модель уже обеспечивает immutable rows.

## Кто решает

Сохраняется нормативное правило:

решение принимает только пользователь с соответствующей capability, нормативно соответствующей руководителю/уполномоченному.

Не привязывать проверку к строке роли, если проект уже использует capabilities.

---

# Р-08-4 — D-018 и типы фактов

## Решение

**Не брать отсутствующий перечень 13 типов из Locus как норматив Контур КП.**

Locus может быть:

- техническим reference (референсом);
- источником примеров;
- источником reusable code (переиспользуемого кода);

но не источником новых бизнес-требований, которых нет в репозитории Контур КП.

## Модель Stage 08

Разрешается реализовать generic typed fact (типизированный факт):

`fact`
→ immutable revisions

с полями минимум:

- `fact_kind`;
- normalized value;
- display value;
- status;
- evidence links;
- provenance;
- confidence/quality, если применимо.

`fact_kind` не должен быть CHECK со сфабрикованным списком 13 типов.

Использовать расширяемый справочник/код типа.

## На Stage 08

Реализовать только fact kinds, которые реально нужны:

- нормативным acceptance cases;
- D-018;
- fixtures Stage 08.

Если точный закрытый список 13 типов позже будет найден в нормативном источнике — добавить его отдельным решением/миграцией.

**Отсутствие списка 13 типов больше не блокирует старт Stage 08.**

---

# Р-08-5 — формулировка требования и закрытые источники

## Решение: консервативная модель доступа

Формулировка requirement **не считается безопасными метаданными автоматически**.

Она может сама раскрывать содержание:

- договора;
- письма;
- переговоров;
- другого защищённого evidence.

## Правило полного отображения

Полный текст requirement revision показывается пользователю только если:

1. есть `requirement.read`;
2. пользователь имеет право читать **все supporting evidence**, которые помечены как содержательные основания этой revision.

Если хотя бы одно обязательное основание закрыто:

показывать только safe shell (безопасную оболочку), например:

- ID требования;
- статус;
- наличие закрытого основания;
- количество оснований;
- workflow metadata.

Не показывать:

- полную формулировку;
- rationale;
- цитаты;
- snippets;
- значения, выведенные из закрытого источника.

## Необязательные/дополнительные основания

Если evidence имеет роль `clarifies`, но не является обязательным для формулировки, его закрытие не обязательно должно скрывать весь requirement.

Поэтому evidence link должен иметь семантическую роль.

---

# Р-08-6 — какой evidence scope является текущим

## Решение: не вычислять «текущий» просто как MAX(created_at)

Для каждого `tender_stage` существует **один active requirement registry (активный реестр требований)**.

Registry фиксируется на конкретном:

`evidence_scope_id`.

При появлении нового scope старый registry не мутирует автоматически.

## Перенос

Переход:

`scope A → scope B`

выполняется явной операцией:

`create/migrate registry to new scope`

с:

- audit;
- пользователем;
- временем;
- ссылкой на предыдущий registry.

Новый registry может перенести существующие requirements как candidates/current revisions, но перенос должен быть явным и трассируемым.

## Active registry

На `tender_stage` хранить явный указатель:

`active_requirement_registry_id`

или нормативный эквивалент.

Не определять active registry исключительно:

`ORDER BY created_at DESC`.

Это устраняет гонки и неоднозначность.

---

# Р-08-7 — единица completeness review

## Решение: базовая единица — evidence fragment

Минимальная атомарная единица проверки полноты:

`evidence_fragment`.

Именно fragment:

- кандидатно рассматривается моделью;
- связывается с requirement/fact;
- может быть помечен `not_requirement`;
- может оставаться `unreviewed`.

## Пакетная работа

Разрешены batch actions (пакетные отметки):

- по PDF page;
- document revision;
- mail message revision;
- Q&A item;
- другой source unit.

Но пакетная операция должна **детерминированно развернуться в конкретный набор evidence_fragment IDs**.

В completeness registry хранить состояние именно по fragments.

Это позволяет доказать:

`total = reviewed + explicitly_not_requirement + unreviewed`

без зависимости от того, как UI группирует элементы.

## Пустые source units

Если source unit не породил ни одного evidence fragment, он должен иметь отдельный технический статус обработки и не исчезать молча из completeness.

---

# Р-08-8 — права и DB enforcement

## Решение: capabilities из существующей role/access model + централизованная DB-функция

Не создавать отдельный ACL Stage 08, если существующая система roles/capabilities уже покрывает scope.

Права выдаются через существующую модель:

`user → role/access → capability`.

Для Stage 08 добавить необходимые capabilities.

## Проверка

Использовать одну централизованную DB-функцию/предикат разрешения для критичных операций, например семантически:

`has_stage_capability(user_id, tender_stage_id, capability)`

или существующий нормативный механизм проекта.

API выполняет проверку первой линией.

DB обеспечивает вторую линию для:

- confirm;
- decide;
- переходов состояния;
- иных критичных mutations (изменений).

## Не надо

Не дублировать роли отдельной таблицей требований.

Не хранить:

`is_manager=true`

в requirement.

---

# OD-08-6 — допущения ПД, вопросы заказчику и пометки этапа

## Решение

Разделить три типизированные сущности/типа записи.

### 1. Assumption (допущение)

Рабочее предположение инженера при недостаточности данных.

Оно:

- не является fact;
- не является requirement;
- не является decision;
- обязательно имеет автора и состояние.

Минимальные состояния:

- open;
- confirmed;
- rejected;
- superseded.

### 2. Customer question (вопрос заказчику)

Отдельная запись:

- question text;
- status;
- asked_at;
- answered_at;
- answer/evidence link;
- owner/responsible.

Ответ заказчика может породить:

- fact;
- requirement;
- decision;

но сам вопрос ими не является.

### 3. Stage note (пометка этапа)

Неформальная рабочая заметка.

Не участвует автоматически в:

- completeness;
- facts;
- requirements;
- model evidence.

Если note должна стать evidence — требуется явная операция/другой нормативный источник.

## Итого OD-08-6

Принимаю вариант, при котором эти три категории **не смешиваются с требованиями и фактами** и имеют собственные типы.

Если это соответствует варианту A из preflight — считать:

`OD-08-6 = ACCEPTED, option A`.

---

# Candidate confirmation

Уточнение к предыдущему решению.

Candidate от модели или человека может быть:

- requirement candidate;
- fact candidate.

Confirmation всегда выполняется явно.

Нельзя подтверждать candidate:

- из другого evidence scope;
- из старого registry;

в новый active registry молча.

Нужна явная операция переноса/rebase (переноса на новый scope).

---

# Requirement visibility — DB/API/UI

Обязательные тесты:

1. requirement с только открытыми основаниями → полный текст виден;
2. requirement с contract evidence без `contract.read` → текст скрыт;
3. requirement с mail evidence без `mail.read` → текст скрыт;
4. revoke после создания requirement → текст становится скрыт без изменения requirement;
5. возврат права → текст снова доступен;
6. safe shell не содержит производных чувствительных данных;
7. citation никогда не открывается через requirement ACL.

---

# Coverage tests

Добавить:

- одно требование + один coverage object;
- одно требование + несколько объектов;
- partial;
- covered;
- uncovered;
- object удалён/архивирован;
- новая calculation revision;
- A→B→A coverage history;
- complex pricing A05.

---

# Completeness tests

Добавить:

- fragment covered by requirement;
- fragment linked to fact only;
- `not_requirement`;
- unreviewed;
- batch page mark;
- batch document mark;
- новый fragment после нового evidence scope;
- старый registry не изменяется;
- новый registry создаётся явно;
- completed невозможно при `unreviewed > 0`.

---

# D-018

D-018 считать включённым в Stage 08 на уровне:

- fact model;
- evidence links;
- revisions;
- confirmation.

Но **не утверждать**, что реализованы все «13 типов фактов», пока нормативный перечень не найден.

В отчёте Stage 08 писать:

`D-018 structural model implemented; closed fact taxonomy unavailable in repository`.

Это честный статус, а не дефект реализации.

---

# Migration разрешение

После фиксации этих решений разрешено писать миграцию Stage 08.

Перед кодом проверить migration matrix для:

- requirement registry;
- candidates;
- requirement/revisions;
- evidence links;
- facts;
- coverage;
- decisions;
- assumptions;
- customer questions;
- stage notes;
- analysis runs;
- completeness fragments/statuses.

Если matrix обнаружит необходимость фундаментально менять:

- Stage 05 evidence;
- Stage 06 calculation revisions;
- Stage 06a ownership;
- Stage 07 mail ACL;

остановиться на новом AD.

---

# Статус

**Р-08-1: RESOLVED**

**Р-08-2: RESOLVED**

**Р-08-3: RESOLVED**

**Р-08-4: RESOLVED**

**Р-08-5: RESOLVED**

**Р-08-6: RESOLVED**

**Р-08-7: RESOLVED**

**Р-08-8: RESOLVED**

**OD-08-6: ACCEPTED**

**Stage 08: READY_TO_CONTINUE**

Разрешается продолжать Stage 08 и писать миграцию.

Stage 09+ самостоятельно не начинать.
