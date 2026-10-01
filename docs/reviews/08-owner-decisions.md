# Контур КП — решения по preflight Stage 08

**NEXT_STAGE = Stage 08 — «Требования, покрытие и решения»**

После фиксации решений ниже:

**STATUS = READY_FOR_STAGE_08**

Разрешаю начинать Stage 08.

---

# OD-08-1 — источники кандидатов в требования

## Решение

Кандидаты требований формируются **только из доказательств, уже доступных через принятую evidence-архитектуру**.

Разрешённые источники Stage 08:

1. проектные документы:
   - RDWeb;
   - локально распознанные документы Stage 05a;
2. договоры, допсоглашения и приложения Stage 06a;
3. письма Stage 07;
4. Q&A Stage 07;
5. переговоры Stage 07;
6. иные источники только если они уже представлены через нормативный `evidence_fragment`/эквивалентную принятую evidence-ветку.

TenderHub calculation revision может быть **контекстом**, но коммерческие строки сами по себе не превращать автоматически в нормативные требования, если это прямо не определено спецификацией Stage 08.

## Запрет

Модель не должна читать:

- произвольные файлы с диска;
- документы вне evidence scope;
- данные, к которым пользователь не имеет права;
- текущие внешние источники мимо зафиксированной revision.

---

# OD-08-2 — провайдер модели

## Решение

Stage 08 использует **provider abstraction (абстракцию провайдера модели)**.

Production-базовый режим:

**локальная модель / локальный inference (вывод модели).**

Облачный провайдер не является обязательным и не должен быть условием работоспособности Stage 08.

### Контракт модели фиксирует

Минимум:

- provider id;
- model id;
- model/version;
- prompt version;
- inference configuration;
- input evidence IDs;
- output schema version;
- started/finished timestamps.

Результат модели считается **proposal (предложением)**, а не утверждённым требованием.

## GPU

Отсутствие GPU на машине разработки не блокирует реализацию.

До целевого live-прогона использовать:

- deterministic fixtures;
- fake provider;
- при необходимости CPU-compatible тестовую модель.

Настоящий GPU-прогон нужен к live/pilot gate, а не к написанию основной архитектуры.

---

# OD-08-3 — объём фактов D-018

## Решение

**D-018 входит в Stage 08.**

Но факты не смешивать с требованиями.

Ввести отдельное понятие:

`fact`

Факт — утверждение о состоянии объекта/проекта/источника, подтверждённое evidence.

Примеры семантики:

- «в документе указано значение X»;
- «срок указан как Y»;
- «оборудование обозначено Z»;
- «источник содержит связь A→B».

Факт сам по себе не является:

- требованием;
- решением;
- рекомендацией;
- выводом о риске.

## Объём

Реализовать только те классы фактов, которые **явно предусмотрены D-018**.

Если D-018 не даёт закрытого перечня типов, хранить типизированный generic fact envelope (общую оболочку факта):

- kind;
- normalized value;
- source/evidence;
- provenance;
- confidence/status;
- version.

Не придумывать новые бизнес-классы фактов от имени владельца.

---

# OD-08-4 — закрытые договоры и письма

## Решение

Archive/closed status (архивный/закрытый статус) **не уничтожает историческую доказательную базу**.

Но он также **не выдаёт новых прав доступа**.

Для требования или факта, основанного на закрытом источнике:

- сам requirement/fact сохраняется;
- evidence link сохраняется;
- historical scope сохраняется;
- доступ к содержимому evidence по-прежнему требует текущего права на источник.

Например:

- закрытый договор → всё ещё нужен `contract.read`;
- архивное письмо → всё ещё нужен `mail.read`.

Если пользователь потерял право на исходный evidence:

- requirement metadata (метаданные требования) может оставаться видимой, если пользователь имеет право на реестр требований;
- содержимое защищённого evidence, snippet, citation и исходный текст не показывать.

Не копировать защищённый текст источника внутрь requirement так, чтобы обходить исходные ACL.

---

# OD-08-5 — подтверждение требований и решения

## Решение

Разделить три действия:

### 1. Proposal

ИИ или инженер может создать candidate requirement (кандидат требования).

### 2. Confirmation

Требование становится подтверждённым только после действия пользователя с capability:

`requirement.confirm`

### 3. Decision

Решение по требованию фиксируется отдельно пользователем с capability:

`requirement.decide`

или эквивалентным нормативным названием.

## Кто

Не привязывать бизнес-правило к строке роли в коде.

Использовать capability-based access (права через возможности).

По умолчанию:

- engineer может создавать/редактировать proposal;
- manager/ответственный пользователь с `requirement.confirm` подтверждает;
- пользователь с `requirement.decide` принимает решение.

Создатель требования **не получает автоматически право подтверждения**, если у него нет соответствующей capability.

Administrator сам по себе не получает содержательных прав.

---

# OD-08-7 — «обход реестра» для полноты

## Решение

Под «обходом реестра» понимать **детерминированную проверку полноты evidence scope против реестра требований**, а не второй способ извлечения требований.

Completeness pass (проход полноты):

1. берёт зафиксированный evidence scope;
2. проходит все допустимые evidence units;
3. проверяет, что каждая потенциально нормативная единица:
   - связана хотя бы с candidate/requirement;
   - либо явно помечена `not_requirement`;
   - либо остаётся `unreviewed`.

## Важно

Нельзя считать полноту доказанной только потому, что модель «ничего больше не нашла».

Полнота должна быть выражена как состояние покрытия:

- reviewed;
- covered;
- explicitly_not_requirement;
- unreviewed.

`unreviewed > 0` не позволяет объявить реестр полным.

---

# AD-08-1 — identity и revision требований

## Решение

Требование является собственной доменной сущностью.

Использовать:

`requirement`
→ `requirement_revision`

Не хранить только текущее изменяемое состояние.

Каждое содержательное изменение:

- текста;
- нормализованной формулировки;
- статуса;
- существенных атрибутов;

создаёт новую revision согласно принятому контракту.

Исторические revisions immutable.

---

# AD-08-2 — candidate ≠ confirmed requirement

## Решение

Разделить:

- `requirement_candidate`;
- `requirement`.

Модель пишет только candidate.

Candidate обязан хранить:

- model run;
- prompt version;
- evidence references;
- proposed text;
- rationale/structured output;
- confidence, если модель его даёт;
- status.

Только явное human confirmation (подтверждение человеком) создаёт или обновляет `requirement`.

Модель **не может** напрямую создавать confirmed requirement.

---

# AD-08-3 — evidence / provenance

## Решение

Требование и факт должны ссылаться на **конкретные immutable evidence revisions/fragments**, а не только на document/message ID.

Минимум:

`requirement_revision`
↔ `evidence_fragment`

many-to-many.

Для каждого evidence link хранить роль, например:

- supports;
- contradicts;
- clarifies;
- supersedes-context.

Не копировать evidence ownership внутрь требования.

Права на citation вычисляются через исходный source ACL.

---

# AD-08-5 — coverage model

## Решение

Coverage (покрытие) хранить отдельно от самого требования.

Минимальная модель:

`requirement_coverage`

Она связывает requirement revision с объектом, который считается покрытием.

Тип покрытия должен быть явным, например:

- document evidence;
- calculation revision;
- decision;
- implementation artifact;
- manual confirmation.

Не использовать одно булево:

`covered=true/false`

без объяснения, чем именно покрыто.

Coverage может иметь состояния:

- uncovered;
- partial;
- covered;
- not_applicable;
- needs_review.

Смена покрытия не переписывает историческую requirement revision.

---

# AD-08-6 — решения

## Решение

Decision (решение) является отдельной immutable/revisioned сущностью, а не полем requirement.

Минимум:

`decision`
→ `decision_revision`

Связь:

`requirement ↔ decision`

может быть 0..N.

Decision хранит:

- формулировку;
- status;
- decided_by;
- decided_at;
- evidence/provenance;
- supersedes, если новое решение заменяет старое.

Старое решение не удалять и не перезаписывать.

---

# AD-08-7 — facts D-018

Если AD-08-7 в preflight относится к фактам D-018:

## Решение

Ввести:

`fact`
→ `fact_revision`

или эквивалентную минимальную revisioned модель.

Fact candidate от модели ≠ confirmed fact.

Использовать тот же human confirmation pattern, что у requirements, но отдельные capabilities:

- `fact.create`;
- `fact.confirm`, если норматив требует подтверждение.

Не смешивать таблицу facts с requirements.

---

# Model run

Ввести отдельную сущность:

`analysis_run`

или нормативный эквивалент.

Она immutable и фиксирует:

- provider;
- model;
- prompt;
- configuration;
- evidence scope;
- input hash;
- output/raw structured result;
- status;
- timestamps.

Повтор с тем же:

`scope + model + prompt + configuration`

должен быть идемпотентным, если входы идентичны.

Изменение любого компонента создаёт новый run.

---

# Source scope

Model analysis (анализ модели) всегда работает по конкретному immutable:

`evidence_scope_id`

Не разрешать режим:

«возьми всё текущее по тендеру»

без фиксации scope.

Это необходимо для воспроизводимости.

---

# Permissions

Минимально предусмотреть capabilities:

- `requirement.read`;
- `requirement.create`;
- `requirement.confirm`;
- `requirement.decide`;
- `requirement.manage`;
- `analysis.run`.

Если facts имеют самостоятельное управление:

- `fact.read`;
- `fact.confirm`.

## Важно

Право видеть requirement не даёт право читать все его evidence sources.

Search/citation исходного evidence продолжает использовать ACL source-систем:

- tender;
- contract;
- mail.

---

# AI safety / deterministic boundary

Модель может:

- предложить requirement;
- предложить fact;
- предложить links;
- предложить coverage;
- предложить candidate decision wording.

Модель не может:

- подтвердить requirement;
- подтвердить fact, если требуется подтверждение;
- принять decision;
- снять production blocker;
- изменить calculation revision;
- изменить contract/mail source;
- объявить completeness самостоятельно.

---

# Completeness

Для каждого scope хранить состояние completeness review.

Например:

`requirement_registry_review`

с:

- evidence_scope_id;
- reviewed_units;
- total_units;
- covered_units;
- explicit_not_requirement_units;
- unreviewed_units;
- completed_by;
- completed_at.

Registry (реестр) считается полностью просмотренным только если:

`unreviewed_units = 0`.

Это не означает, что все требования автоматически корректны — только что scope пройден целиком.

---

# X-01

Stage 08 не снимает:

`CALCULATION_PROVISIONAL`.

Requirement/coverage может ссылаться на provisional calculation, но production blocker сохраняется.

Не превращать Stage 08 в обход X-01.

---

# Q-11 — эталон и пороги качества

Q-11 не блокирует реализацию.

До Q-11:

- модель оценивается на fixture corpus;
- качество хранится как experimental/fixture;
- production quality gate не объявляется достигнутым.

Для пилота/приёмки live-model части Q-11 должен быть закрыт либо явно разрешён другой gate владельцем.

---

# GPU

GPU не является DB/API архитектурным блокером.

До целевой машины:

- fake provider;
- deterministic model fixtures;
- contract tests.

Live inference на реальной модели — отдельный acceptance/pilot check.

---

# G1–G13

13 нормативных пробелов не закрывать «по здравому смыслу».

В Stage 08 report создать таблицу:

`Gap → временная трактовка → источник решения → влияет на start/acceptance/production`

Если любой G1–G13 в ходе реализации оказывается фундаментальным для:

- ownership;
- cardinality;
- revision identity;
- source of truth;
- permissions;
- state machine;

остановиться и вынести отдельный OD/AD до миграции этой части.

---

# DB invariants

Обязательные прямые DB-проверки минимум:

1. confirmed requirement не существует без valid revision;
2. model candidate не может стать confirmed только DB INSERT обходом нормативного transition;
3. requirement revision immutable;
4. evidence link указывает на существующий immutable evidence;
5. fact и requirement — разные сущности;
6. decision revision immutable;
7. decision supersession не удаляет старую revision;
8. coverage всегда указывает на конкретную requirement revision;
9. analysis run фиксирован на evidence scope;
10. completed completeness review невозможен при `unreviewed > 0`;
11. candidate другого scope нельзя подтвердить как requirement текущего scope без явной операции;
12. archived/closed evidence не уничтожает provenance;
13. revoked source permission не открывается через requirement citation;
14. concurrent confirmation идемпотентна/конфликтует предсказуемо;
15. A→B→A создаёт исторически различимые revisions.

---

# Acceptance tests

Добавить минимум:

- candidate → confirm;
- candidate rejected;
- duplicate model run;
- different prompt → new run;
- different evidence scope → new run;
- requirement A→B→A;
- fact A→B→A;
- decision superseded;
- partial coverage;
- full coverage;
- unreviewed scope;
- registry completeness;
- protected contract evidence;
- protected mail evidence;
- revoke source permission;
- admin without source read;
- concurrent confirm;
- model failure;
- malformed structured output;
- GPU/provider unavailable;
- worker restart;
- retryable inference failure;
- deterministic validation failure without useless retry;
- clean migration;
- upgrade from Stage 07;
- regression Stage 02–07.

---

# Итог решений

**OD-08-1: ACCEPTED**

**OD-08-2: ACCEPTED**

**OD-08-3: ACCEPTED**

**OD-08-4: ACCEPTED**

**OD-08-5: ACCEPTED**

**OD-08-7: ACCEPTED**

**AD-08-1: ACCEPTED**

**AD-08-2: ACCEPTED**

**AD-08-3: ACCEPTED**

**AD-08-5: ACCEPTED**

**AD-08-6: ACCEPTED**

**AD-08-7: ACCEPTED, если относится к D-018 facts**

Внешние ограничения:

- Q-11 — не блокирует старт, нужен к pilot/quality gate;
- GPU target machine — не блокирует старт;
- X-01 — остаётся production blocker расчёта.

# Статус

**Stage 08: READY_FOR_STAGE_08**

**GO Stage 08.**

Перед основной миграцией сначала представить migration matrix по requirements / candidates / facts / decisions / coverage / analysis runs.

Если точная формулировка любого AD-08-x из preflight противоречит зафиксированному здесь решению — остановиться до миграции и показать это расхождение.

Stage 09+ самостоятельно не начинать.
