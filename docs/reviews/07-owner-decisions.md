# Контур КП — решения по preflight Stage 07

**NEXT_STAGE = Stage 07 — «MailHub, вопросы–ответы и переговоры»**

После решений ниже:

**STATUS = READY_FOR_STAGE_07**

Разрешаю начинать Stage 07.

---

# AD-07-1 — ownership письма

## Решение

**Письмо не является документом с owner=tender/contract.**

Не расширять принятую модель D-023 третьим вариантом:

`owner = mailbox`

в таблицах `document`, `document_revision`, `evidence_fragment`, search index и далее.

Ввести самостоятельную доменную сущность письма:

`mailbox`
→ `mail_message`

и отдельную many-to-many связь:

`mail_message_tender`

Один mail message (почтовое сообщение):

- принадлежит ровно одному mailbox (почтовому ящику);
- может быть связано с 0..N тендерами;
- может существовать до привязки к тендеру;
- не получает фиктивный `tender_id`.

## Почему

Mailbox — источник и security-context (контекст доступа), а tender — бизнес-контекст.

Это разные оси.

Не смешивать их в одном owner discriminator (признаке владельца).

## Evidence/search

Для текста письма использовать отдельный mail evidence path (путь доказательств письма), не заставляя письмо становиться `document`.

Допускается новый `evidence_source_kind = mail_message` или эквивалентная типизированная связь, если текущий evidence contract этого требует.

Но:

- не добавлять `mailbox_id` механически во все старые таблицы;
- не ломать document ownership Stage 06a;
- не превращать mail_message в фиктивный document.

Если для интеграции с текущим search потребуется фундаментальное изменение `evidence_fragment`, сначала составить migration matrix (матрицу миграции). Если затрагивается больше минимально необходимых таблиц — остановиться на отдельное AD.

---

# AD-07-2 — вложения

## Решение

**Вложение становится обычным document/document_revision.**

Не создавать отдельный parallel parser (параллельный парсер) `attachment_text`.

Путь:

`mail_message`
→ `mail_attachment`
→ `document`
→ `document_revision`
→ Stage 05a recognition
→ evidence/search

## Правила

Attachment (вложение) хранит:

- имя;
- MIME type (MIME-тип);
- размер;
- SHA-256;
- message attachment id / ordinal;
- ссылку на `document_revision`.

Одинаковый blob допустимо дедуплицировать на уровне существующего storage, но attachment relation (связь вложения) остаётся отдельной.

## Ownership/access

Attachment document не получает фиктивный tender owner.

Его доступ определяется через mail message/mailbox и связь письма с тендерами.

Если текущая `document`-схема не позволяет создать такой attachment document без tender/contract owner, **не добавлять третий owner в document автоматически**.

В этом случае:

- остановиться до migration;
- представить узкое AD-07-2a:
  - либо attachment-document subtype;
  - либо external document relation;
  - либо иной минимальный способ переиспользовать Stage 05a без разрушения D-023.

Самостоятельный `attachment_text` pipeline не разрешён.

---

# AD-07-3 — ручной импорт EML

## Решение

EML импортируется **в конкретный mailbox**, а не напрямую в tender.

Обязательный контекст импорта:

`mailbox_id`

Связь с тендером:

- может быть задана при импорте;
- может быть добавлена позже;
- не является owner письма.

## Existing Stage 03 `.eml` import

Текущий общий импорт `.eml` как обычного tender document не должен продолжать создавать второе представление того же письма.

Для Stage 07:

- `.eml` маршрутизировать в mail import;
- не создавать одновременно обычный tender document и mail_message;
- исторические уже созданные `.eml` Stage 03 не переписывать автоматически.

Если есть старые `.eml` documents:

- считать legacy (наследием);
- миграцию содержания автоматически не делать;
- при необходимости позже отдельная migration/import utility (утилита миграции), но не в Stage 07 без требования.

Идентичность EML:

минимум по:

- raw blob SHA-256;
- Message-ID, если присутствует;
- mailbox;
- transport/source id, если есть.

Message-ID сам по себе не считать глобально достаточным ключом.

---

# OD-07-1 — можно ли хранить копии писем и вложений

## Решение

**Да.**

Портал может хранить локальные копии:

- raw EML;
- normalized message (нормализованное письмо);
- вложения;
- распознанный текст вложений;
- evidence/search artifacts.

Это необходимо для:

- исторической воспроизводимости;
- поиска;
- цитирования;
- аудита;
- работы без живого MailHub.

## Ограничения

Хранить только в локальной инфраструктуре Контур КП.

Не отправлять содержимое писем или вложений во внешние облачные сервисы.

Копия письма после импорта считается immutable source snapshot (неизменяемым снимком источника).

Если то же письмо изменилось во внешней системе — создаётся новая source revision/event, а старая копия не переписывается.

---

# OD-07-3 — кто видит письмо

## Решение

Использовать отдельные права mailbox/mail.

Минимальные capabilities:

- `mail.read`
- `mail.import`
- `mail.link`
- `mail.manage`

Можно разбить точнее, если уже есть нормативные имена.

## Основной принцип

**Связь письма с tender не выдаёт право читать письмо.**

Для доступа нужны одновременно:

1. пользователь имеет право на mailbox/message;
2. если запрос идёт в tender context (контексте тендера), message связан с этим tender.

## Письмо без тендера

Видят только пользователи, имеющие `mail.read` для соответствующего mailbox.

Tender users его не видят.

## Письмо связано с двумя тендерами

Письмо одно.

Не создавать две копии.

Пользователь получает его в конкретном tender context только если:

- имеет `mail.read` для mailbox/message;
- имеет доступ к этому tender;
- существует `mail_message_tender`.

## Administrator

Системный admin сам по себе **не получает содержимое писем**.

Без `mail.read` ему доступны только минимальные служебные метаданные:

- mailbox id/name;
- технический status;
- integration health (состояние интеграции);
- timestamps;
- размер;
- идентификаторы, необходимые для администрирования.

Не показывать:

- subject (тему);
- body (тело);
- sender/recipient addresses, если это не требуется нормативно для администрирования;
- attachments;
- extracted text;
- search snippets;
- citations.

Если разработчик считает, что адрес отправителя/получателя нужен admin UI — вынести как отдельную интерпретацию на review.

---

# OD-07-2 — какие ящики импортируются

**Решение для Stage 07: только явно зарегистрированные mailbox.**

Не сканировать автоматически все доступные ящики пользователя/организации.

Каждый mailbox:

- создаётся/регистрируется явно;
- имеет свой access policy (политику доступа);
- имеет integration status (статус интеграции);
- может использовать manual EML import до X-03.

Production scope (боевой охват) конкретных ящиков настраивается конфигурацией/правами, не хардкодится.

Это не блокирует start.

---

# OD-07-4 — можно ли принять Stage 07 без X-03

## Решение

**Да, можно принять Stage 07 без X-03, но только как manual/fixture-complete (завершённый для ручного/фикстурного режима).**

Условия:

- EML import работает;
- mailbox/message model работает;
- rights/security работают;
- attachments работают;
- Q&A/negotiation import работает в файловом режиме;
- historical evidence/search работает;
- X-03 явно остаётся `BLOCKED_EXTERNAL`.

Не объявлять MailHub integration:

`VERIFIED_LIVE`

пока нет машинного read API.

Для Stage 07 допустим статус:

`BLOCKED_EXTERNAL`

для MailHub auto-ingest.

## «Чтение реального примера»

Для приёмки достаточно:

- реальный EML, экспортированный из настоящей почты;
- импортированный через manual path;
- без необходимости живого MailHub API.

Если норматив требует именно live MailHub — показать источник до Review 07-1.

---

# OD-07-6 — формат вопрос–ответ

## Решение

На Stage 07 использовать **структурированную сущность Q&A**, а не хранить форму только как произвольный файл.

Минимум:

`qa_thread`
→ `qa_item`

Поля item:

- question;
- answer nullable;
- status;
- asked_at;
- answered_at nullable;
- source/provenance;
- tender_id;
- external_ref nullable.

File manifest (файловый манифест) Q-06 импортируется в эту модель.

Не фиксировать сейчас конкретный UI-template (шаблон формы), если спецификация его не определяет.

Import format должен быть versioned (версионирован).

---

# Q-06 — сервис переговоров

Остаётся OPEN/BLOCKED_EXTERNAL для автоматизации.

Stage 07 реализует:

- file manifest import;
- normalized negotiation/Q&A model;
- provenance;
- revisions/history;
- search/evidence при необходимости спецификации.

Meridian сейчас **не исследовать**.

Подключение Meridian — отдельное внешнее решение, если оно будет принято позже.

---

# X-03 — MailHub

Остаётся OPEN/BLOCKED_EXTERNAL.

Stage 07 сейчас не реализует фальшивый polling (опрос) MailHub, если API не даёт:

- machine-readable mailbox/messages;
- stable Message-ID/source id;
- change cursor/delta.

Не парсить UI MailHub.

Не использовать browser automation (автоматизацию браузера) как production integration.

Manual EML — штатный fallback до X-03.

---

# ARCHITECTURE PRINCIPLE 07

Stage 07 вводит три отдельные сущности:

1. `mailbox` — security/integration scope;
2. `mail_message` — immutable imported communication;
3. `mail_message_tender` — business association.

Не смешивать:

`mailbox ownership`

и:

`tender ownership`.

---

# Evidence/search

Для письма должны сохраняться:

- raw source snapshot;
- normalized message;
- immutable revision/source version;
- fragments;
- provenance.

Search должен проверять права минимум дважды:

1. на query/filter stage;
2. при projection/result read stage.

Пользователь, потерявший `mail.read` после индексации, немедленно перестаёт видеть:

- сообщение;
- snippet;
- citation;
- attachment evidence.

Связь с tender не заменяет `mail.read`.

---

# Historical model

После импорта письмо не переписывать.

Если импортируется изменённая копия с тем же external identity:

- новая message revision/source revision;
- прежняя остаётся доступной historical scope.

Если содержимое побайтно идентично:

- импорт идемпотентен;
- новая ревизия не создаётся без причины.

---

# Mail attachments

Attachment document:

- не индексируется автоматически, пока recognition не завершён;
- права наследует от mail message;
- не расширяет tender evidence_scope автоматически;
- может быть явно включён в scope согласно правилам этапа.

Stage 05a parser переиспользуется.

---

# DB invariants

До основной миграции разработчик должен предоставить migration matrix для:

- mailbox;
- mail access;
- mail_message;
- message revision/source identity;
- mail_message_tender;
- attachment;
- evidence/search links;
- Q&A/negotiations.

Особенно доказать:

- mailbox имеет одного владельца security-context;
- message принадлежит ровно одному mailbox;
- tender links 0..N;
- removal link не удаляет historical message;
- duplicate import идемпотентен;
- права нельзя получить через tender link;
- attachment нельзя перепривязать к чужому message;
- historical revision immutable.

Если для этого требуется массово менять ownership Stage 03–06a — остановиться на отдельный AD-07-4.

---

# Mandatory security tests

Минимум:

1. unlinked message + no mail.read → invisible;
2. unlinked message + mail.read → visible in mailbox context;
3. message linked to tender A + tender access but no mail.read → invisible;
4. mail.read but no tender access → invisible in tender A context;
5. both rights → visible;
6. message linked A+B → no duplication;
7. revoke mail.read after indexing → no search/snippet/citation;
8. admin without mail.read → no content;
9. attachment cannot leak through document search;
10. remove tender link → historical evidence remains, current tender context hides it;
11. duplicate EML → idempotent;
12. same Message-ID but different content → not silently overwrite;
13. attachment hash duplicate across messages → storage may dedupe, access must not merge;
14. malformed EML;
15. huge attachment limits;
16. worker restart;
17. deterministic parse failure no useless retry;
18. concurrent import same EML;
19. Q&A manifest duplicate;
20. Q&A A→B→A;
21. revoked permission;
22. audit contains no forbidden body/snippets.

---

# UI minimum

Stage 07 UI минимум:

- mailboxes;
- message list;
- message detail;
- tender links;
- attachments;
- Q&A / negotiation import and list;
- blocked external status for MailHub.

Не делать полноценный email client (почтовый клиент):

- compose;
- reply;
- send;
- folders management;
- SMTP;
- mailbox administration уровня Outlook.

Stage 07 — read/import/evidence, не почтовый клиент.

---

# Итог

**AD-07-1: ACCEPTED**

**AD-07-2: ACCEPTED**

**AD-07-3: ACCEPTED**

**OD-07-1: ACCEPTED**

**OD-07-2: ACCEPTED**

**OD

---

*Текст получен 2026-09-30 оборванным на этом месте раздела «Итог». Решения OD-07-3, OD-07-4, OD-07-6, Q-06 и X-03 приведены выше полностью; статус READY_FOR_STAGE_07 и разрешение начать этап 07 — в начале документа.*
