# Контур КП — архитектурные решения Stage 07 после migration stop

Точка остановки рассмотрена.

**Stage 07 остаётся разрешённым к реализации после фиксации решений ниже.**

---

# AD-07-1a — текст письма в evidence/search

## Решение: вариант A — типизированная почтовая ветка в существующей цепочке evidence/search

Не создавать отдельный почтовый поиск.

Не отказываться от поиска писем на Stage 07.

Письмо остаётся самостоятельной сущностью:

`mailbox`
→ `mail_message`
→ `mail_message_revision`

и **не превращается в document**.

Но существующий evidence/search расширяется типизированной mail-веткой.

## Принцип

На уровне evidence должен существовать ровно один источник фрагмента:

- document revision;
- либо mail message revision.

Не вводить универсальный:

`owner_type + owner_id`

без FK.

Использовать явные nullable FK с DB CHECK:

`num_nonnulls(document_revision_id, mail_message_revision_id) = 1`

или эквивалентную типизированную модель.

Если существующая contract/tender ownership уже хранится отдельными колонками, migration matrix должна показать минимальную итоговую комбинацию и исключить неоднозначные состояния.

## Что допускается изменить

Разрешается изменить только те таблицы Stage 05/06a, где mail source необходим для:

- evidence fragment;
- scope membership;
- search document/chunk/index;
- projection/citation;
- permission filtering.

Не добавлять `mailbox_id` и `mail_message_id` во все таблицы механически.

Mailbox/message должны выводиться через:

`mail_message_revision → mail_message → mailbox`.

## Search

Search остаётся один.

Не создавать:

- отдельный FTS для почты;
- отдельный vector index для почты;
- отдельный ranking engine.

Существующие exact / FTS / vector branches должны работать с новым source kind.

## Permission invariant

Для mail evidence результат допустим только при одновременном выполнении:

1. revision входит в допустимый evidence scope;
2. пользователь имеет `mail.read` на mailbox/message;
3. при поиске в tender context письмо связано с этим tender;
4. пользователь имеет доступ к tender.

Проверка:

- до ranking/limit;
- повторно при projection/citation.

Revoked `mail.read` должен закрывать уже индексированные результаты немедленно, без обязательной переиндексации.

## Historical evidence

Scope фиксирует конкретный:

`mail_message_revision_id`.

Новая ревизия сообщения не заменяет историческую автоматически.

---

# AD-07-2a — вложения

## Решение: вариант A, но ограниченный — attachment-backed document subtype

Вложение должно продолжать переиспользовать Stage 05a.

Отдельный `attachment_text` pipeline запрещён.

Recognition без source document/revision также не вводить.

### Модель

`mail_message_revision`
→ `mail_attachment`
→ `document`
→ `document_revision`
→ Stage 05a recognition
→ evidence/search

Но для attachment-document разрешается новый **типизированный mail ownership branch**.

Это исключение относится только к вложениям.

## Важно

Не превращать mailbox в третьего универсального owner всей document-модели.

Owner вложения определяется через конкретную связь:

`document → mail_attachment → mail_message_revision → mail_message → mailbox`.

Если для декларативного FK необходим прямой `mail_attachment_id`/`mail_message_id` в `document`, это допускается.

Не добавлять `mailbox_id` напрямую, если он выводится через FK.

## Document invariant

Для document должно существовать ровно одно происхождение:

- tender-owned;
- contract-owned;
- mail-attachment-owned.

То есть допустима типизированная трёхветочная модель, например семантически:

`num_nonnulls(tender_id, contract_id, mail_attachment_id) = 1`

но **не** универсальный `owner_type/owner_id`.

## Downstream

Как и на Stage 06a:

не распространять mail attachment ownership во все downstream-таблицы, если owner однозначно выводится через `document_revision → document`.

Новая колонка разрешается только там, где она нужна для собственного FK/unique/permission invariant.

До миграции сделать отдельную matrix:

`таблица → зачем сейчас tender/contract owner → можно ли вывести mail-owner через existing FK → нужна ли новая колонка`.

Если реально изменение снова касается около десяти таблиц, это допустимо только при обосновании каждой.

---

# Почему не B/C/D

## B — recognition без document

Отклоняется.

Это создаёт второй вид input identity для Stage 05a и ломает принятый контракт:

`document_revision → recognition_run`.

Потом пришлось бы дублировать:

- fingerprint;
- idempotency;
- source units;
- preferred run;
- quality state;
- historical recognition.

## C — attachment становится tender document после решения человека

Отклоняется.

Письмо может:

- ещё не быть связано с tender;
- быть связано с двумя tenders.

Вложение не должно менять source identity в зависимости от будущей business-link.

## D — attachment_text внутри mail branch

Отклоняется.

Это дублирует Stage 05a parsers/OCR и создаёт второй recognition pipeline.

---

# И-07-1 — одна коммуникация с двумя происхождениями

**CONFIRMED с уточнением.**

Нельзя заставлять один source message принадлежать двум mailbox.

Использовать два уровня:

### Source occurrence

`mail_message`

Это конкретная импортированная копия в конкретном mailbox.

Она принадлежит ровно одному mailbox.

### Logical communication

Добавить сущность уровня:

`mail_communication`

или эквивалентную canonical grouping entity.

Она объединяет 1..N source occurrences, если доказано, что они являются одной коммуникацией.

Например одно письмо оказалось:

- во входящих одного ящика;
- в копии другого ящика.

Хранятся две immutable source copies.

UI может показывать их как одну communication с двумя provenance (источниками).

## Важно

Автоматическое объединение не должно уничтожать исходные occurrences.

Даже если grouping ошибочно, source snapshots остаются раздельными.

---

# И-07-2 … И-07-5 и И-07-7

В текущем сообщении их точный текст не приведён.

Поэтому **не считать их подтверждёнными ревьюером автоматически**.

Сохранить их в отчёте как:

`PENDING_REVIEW_TEXT`

и перед Review 07-1 привести формулировки дословно.

Не превращать их в новый кодовый блокер, если они не меняют миграцию.

Если любая из них изменяет:

- ownership;
- permission;
- revision identity;
- evidence scope;
- linkage cardinality;

остановиться до реализации соответствующей части.

---

# И-07-6 / OD-07-7 — автоматическое предложение связи письмо ↔ tender

Текст OD-07-7 действительно отсутствовал в предыдущей передаче.

Фиксирую сейчас.

## OD-07-7 — автоматическая связь

**Решение: автоматическое подтверждение связи запрещено.**

Система может только **предлагать** tender candidates (кандидатов тендера).

Фактическая запись:

`mail_message_tender`

создаётся только:

- вручную пользователем с `mail.link`;
- либо отдельным явно подтверждённым действием пользователя.

### Допустимые сигналы предложения

На Stage 07 использовать только детерминированные признаки:

- точный номер/ID тендера;
- внешний TenderHub ID;
- явно сохранённый reference;
- точный структурированный идентификатор из manifest/source.

Не делать fuzzy/AI semantic matching (нечёткое/ИИ-сопоставление) основанием для автоматической связи.

Можно показать рекомендацию, но она не становится relation без подтверждения.

### До реализации candidate engine

Ручные связи полностью допустимы.

Отсутствие auto-suggestion не блокирует старт Stage 07.

Если prompt Stage 07 требует сам механизм suggestions — реализовать минимальный deterministic candidate engine.

---

# Ручной EML и дубликаты представления

После Stage 07 `.eml` должен иметь один нормативный ingest path:

`EML → mailbox → mail_message`

Не создавать одновременно tender document.

Legacy `.eml`, импортированный Stage 03 до Stage 07:

- не удалять;
- не переписывать автоматически;
- не превращать молча в mail_message.

Если один и тот же blob позже импортируется через mail path:

допускается хранение общего blob по SHA-256, но domain records остаются разными до отдельной миграционной политики.

---

# Migration matrix перед кодом

Перед написанием миграции разработчик должен дополнить `07-mail-model-design.md` двумя матрицами.

## A. Mail evidence

Для каждой затрагиваемой таблицы:

| Таблица | Почему сейчас document/tender/contract only | Нужен mail branch | Новая колонка/FK | Можно вывести через существующий FK | DB invariant |

## B. Attachment document

| Таблица | Почему attachment сейчас невозможен | Нужна новая колонка | Owner выводится через document | Изменение unique/FK | Негативный тест |

Главное правило:

**минимизировать новые ownership columns.**

---

# Обязательные DB invariants

Минимум:

1. mail message имеет ровно один mailbox;
2. message revision принадлежит одному message;
3. communication может содержать несколько occurrences;
4. occurrence нельзя перепривязать к другому mailbox;
5. mail evidence fragment имеет ровно один source revision;
6. document evidence и mail evidence одновременно невозможны;
7. attachment принадлежит одной message revision;
8. attachment document принадлежит ровно одному mail attachment;
9. attachment document не может одновременно иметь tender/contract owner;
10. attachment revision не может сменить attachment owner;
11. tender link не меняет source owner;
12. удаление tender link не удаляет message/revision;
13. evidence scope фиксирует mail revision immutable;
14. scope inclusion не выдаёт `mail.read`;
15. revoke `mail.read` закрывает search result;
16. same communication across two mailboxes не объединяет source records;
17. same blob attachment across two messages не объединяет access;
18. direct SQL не может создать ambiguous ownership.

---

# Обязательные search leakage tests

Проверить минимум:

- no mail.read → нет exact result;
- no mail.read → нет FTS;
- no mail.read → нет vector result;
- нет snippet;
- нет citation;
- нет attachment result;
- после revoke результат исчезает без reindex;
- tender A не видит message, связанный только с B;
- A+B message виден в каждом context только при соответствующих правах;
- admin без mail.read не видит body/subject/snippets;
- communication grouping не даёт доступ к sibling occurrence другого mailbox.

---

# Недостающий конец предыдущего текста решений

Предыдущая команда завершалась следующей логикой:

- `X-03 = BLOCKED_EXTERNAL`, но не блокирует Stage 07;
- `Q-06 = BLOCKED_EXTERNAL` для автоматизации, но не блокирует Stage 07;
- MailHub auto-ingest не имитировать browser automation;
- manual EML является штатным fallback;
- Stage 07 не является почтовым клиентом;
- после принятых OD/AD статус был:

`Stage 07: READY_FOR_STAGE_07`

`GO Stage 07`

и действовал стоп:

> если attachment/document или mail evidence требуют фундаментальной переделки ownership Stage 03–06a — остановиться до изменения схемы и вынести новый AD.

Именно этот стоп сейчас был выполнен корректно.

---

# Итог после новых решений

**AD-07-1a: ACCEPTED — mail branch в общем evidence/search**

**AD-07-2a: ACCEPTED — attachment-backed document subtype**

**И-07-1: CONFIRMED**

**OD-07-7 / И-07-6: ACCEPTED — suggestions allowed, auto-link prohibited**

**И-07-2…5, И-07-7: PENDING_REVIEW_TEXT**

Stage 07:

**READY_TO_CONTINUE**

Разрешается:

1. обновить D-025;
2. дополнить migration matrix;
3. после проверки matrix писать миграцию;
4. реализовывать Stage 07.

Если migration matrix показывает ещё одно фундаментальное изменение вне описанных AD-07-1a/2a — снова остановиться.

Stage 08+ не начинать.
