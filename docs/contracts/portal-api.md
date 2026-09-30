# Контракт HTTP API портала

Этап 01: соглашения и перечень команд. Точные схемы запросов и ответов создаются вместе с реализацией этапов в `packages/contracts`; OpenAPI собирается из них.

## 1. Соглашения

| Тема | Правило |
|---|---|
| База | `/api/v1`, только HTTPS в LAN (ADR-006) |
| Аутентификация | серверная сессия в cookie для интерфейса; `Authorization: Bearer <api_token>` только для MCP (ADR-010) |
| CSRF | изменяющие запросы интерфейса требуют заголовок CSRF-токена и проверку `Origin` |
| Формат | JSON UTF-8; суммы — объект денег (ADR-005 §4); даты — ISO 8601 UTC |
| Ошибки | RFC 7807 `application/problem+json` с машинным `code` |
| Конкуренция | `GET` отдаёт `ETag`; изменяющая команда требует `If-Match`; нет заголовка — `428`, несовпадение — `412` |
| Идемпотентность | команды, создающие записи или запускающие внешние действия, принимают `Idempotency-Key`; сохранённый ответ выдаётся только после проверки текущих прав на объект (R02-01) |
| Пагинация | курсор `cursor` + `limit`; ответ содержит `nextCursor` и признак `hasMore` |
| Область | ресурсы тендера доступны только участникам; иначе `404` (ADR-006) |
| Аудит | каждая команда и каждый отказ пишут `audit_event` |

Коды ошибок (`code`): `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PRECONDITION_REQUIRED`, `VERSION_CONFLICT`, `STATE_CONFLICT`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`, `BLOCKER_PRESENT`, `RELEASE_IS_TEST`, `ENVIRONMENT_MISMATCH`, `INTEGRATION_UNAVAILABLE`, `INTEGRATION_BLOCKED`, `RATE_LIMITED`, `INTERNAL`.

Ответ `BLOCKER_PRESENT` содержит список блокеров с кодами из матрицы (`state-machines.md` §11.1), классом и пояснением.

## 2. Команды и чтение

Колонка «Право» — возможность из ADR-006. Колонка «Ключи» — `If-Match` (IM) и `Idempotency-Key` (IK).

### 2.1. Доступ и справочники

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /auth/login`, `POST /auth/logout` | — | — | вход и выход |
| `GET /me` | — | — | пользователь, роли, назначения, возможности |
| `POST /me/password` | — | — | смена своего пароля по текущему; прочие сессии отзываются (этап 02) |
| `GET /admin/users`, `POST /admin/users` | `admin.users` | IK | пользователи; открытой регистрации нет, первого администратора создаёт bootstrap с консоли сервера (этап 02) |
| `PATCH /admin/users/{id}`, `POST /admin/users/{id}/password` | `admin.users` | IM | имя, статус, роли, сброс пароля; отключение и сброс отзывают сессии; последнего администратора снять нельзя (этап 02) |
| `GET /admin/audit-events` | `admin.audit` | — | журнал событий вне тендеров: входы, пользователи, отказы Origin/CSRF (этап 02) |
| `POST /me/api-tokens`, `DELETE /me/api-tokens/{id}` | `mcp.propose` | IK | выпуск и отзыв MCP-токена; секрет показывается один раз |
| `GET /settings`, `PUT /settings/{key}` | `admin.settings` | IM | часовой пояс отображения, политика внешней обработки |
| `GET /tenders/{id}/intake-channels` | участник или `admin.tender` | — | каналы поступления, признак свежести `current`, последний успешный скан, ошибка, число файлов, ожидающих стабильности (этап 03) |
| `POST /tenders/{id}/intake-channels` | `admin.intake` | IK | наблюдаемая папка (`origin`: `local`/`yandex_disk`/`smb`) только внутри `INTAKE_ROOTS` (этап 03) |
| `PATCH /intake-channels/{id}` | `admin.intake` / `hold.resolve` (только отключение) | IM | настройки канала; отключение — с причиной, может руководитель тендера (state-machines §1.1) |
| `POST /intake-channels/{id}/scan` | `source.write` | — | внеочередной скан (одно активное задание на канал) |
| `GET /delivery-destinations`, `POST /delivery-destinations`, `POST /delivery-destinations/{id}/versions` | `admin.delivery` | IK | назначения; среда задаётся при создании и не меняется; корень и политика — новой версией (R01-05) |
| `GET /integrations/status` | `tender.read` | — | статусы интеграций и время последней проверки |
| `GET /health`, `GET /ready` | — | — | эксплуатация (ADR-011) |

### 2.2. Тендеры, этапы, участники

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /tenders`, `POST /tenders` | участник или `admin.tender` / `admin.tender` | IK | список и создание; участник видит свои тендеры, администратор — карточки всех |
| `GET /tenders/{id}`, `PATCH /tenders/{id}` | участник или `admin.tender` / `admin.tender` | IM | карточка; `capabilities` в ответе — права текущего пользователя по тендеру |
| `GET /tenders/{id}/members` | участник или `admin.tender` | — | участники и версия тендера |
| `PUT /tenders/{id}/members/{userId}`, `DELETE …` | `admin.tender` | IM (ETag тендера) | назначения; не более двух инженеров; роль назначения требует той же глобальной роли |
| `GET /tenders/{id}/stages`, `POST /tenders/{id}/stages` | `tender.read` / `stage.manage` | IK | этапы; создаёт руководитель тендера (этап 02) |
| `GET /stages/{id}`, `PATCH /stages/{id}` | `tender.read` / `stage.write` | IM | название и срок подачи этапа (этап 02) |
| `GET /stages/{id}/calculation-source`, `PUT …` | `tender.read` / `admin.tender` (участник тендера) | IM | связь этапа с тендером TenderHub (Q-03), этап 06 — см. §2.5 |

### 2.3. Источники и набор источников

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /stages/{id}/imports?name=<имя>` | `source.write` | IK | загрузка одного файла или ZIP: тело — сам файл (`application/octet-stream`); права проверяются до чтения тела; создаёт `import_batch`, событие `import_accepted` и задание разбора; ответ `202` (этап 03) |
| `GET /stages/{id}/imports` | `tender.read` | — | партии тендера со счётчиками элементов (этап 03) |
| `GET /imports/{id}` | `tender.read` | — | состав партии, отклонённые элементы с причинами и их исход, состояние заданий |
| `POST /jobs/{id}/cancel` | `source.write` | — | отмена задания тендера: `queued` — сразу, `running` — флаг для владельца (state-machines §2) |
| `POST /import-items/{id}/resolve` | `source.write` (повторный импорт) / `hold.resolve` (неприменимость) | IM, IK | исход отклонённого элемента: связь с элементом повторного импорта или решение руководителя о неприменимости с причиной (R01-09) |
| `GET /stages/{id}/documents`, `GET /documents/{id}` | `tender.read` | — | документы и редакции |
| `PATCH /documents/{id}` | `source.write` | IM | тип, код, область применения, группировка редакций; с этапа 05a — `recognitionRoute` (`auto`/`local`/`rdweb`): политика маршрута PDF (OD-1), для DOCX, XLSX, CSV не действует |
| `GET /document-revisions/{id}/content` | `tender.read` | — | оригинал по правам (ADR-003) |
| `GET /stages/{id}/source-sets` | `tender.read` | — | наборы, ревизии и состав последней ревизии |
| `POST /stages/{id}/source-set-revisions` | `source.write` | IK | новая `draft`-ревизия рабочего набора этапа от последней (набор создаётся при первом обращении; вместо `POST /source-sets/{id}/revisions` этапа 01 — набора до первого обращения ещё нет) |
| `PUT /source-set-revisions/{id}/items` | `source.write` | IM | состав `draft`-ревизии |
| `POST /source-set-revisions/{id}/freeze` | `source.write` | IM, IK | заморозка состава и `content_hash` (этап 04). Охранное условие: у каждой включённой редакции есть прогон распознавания `complete` или `partial`. Иначе `409 STATE_CONFLICT` с `current.blocking[]` (`documentRevisionId`, `documentTitle`, `revisionSeq`, `reason` ∈ `no_recognition`/`recognition_in_progress`/`recognition_failed`/`recognition_cancelled`). Событий барьера заморозка не порождает |
| `POST /stages/{id}/evidence-scopes` | `source.write` | IK | фиксация снимка области доказательств (R01-01; этап 05): из замороженной ревизии набора этапа (по умолчанию последней, либо `sourceSetRevisionId`) с выбранным для каждой включённой редакции предпочтительным прогоном (`recognition_preferred_run`, с этапа 05a: успешный RDWeb выше локального). `201` — новый снимок; `200` с `reused: true` — тот же состав уже зафиксирован; `409 STATE_CONFLICT` с `current.reason = no_frozen_source_set` — замороженной ревизии нет. Письма и редакции транскрипций добавит этап 07 |
| `GET /stages/{id}/evidence-scopes` | `tender.read` | — | снимки этапа, новые сверху, с числом единиц (этап 05) |
| `GET /evidence-scopes/{id}` | `tender.read` | — | состав снимка по типам и `content_hash`; письма из недоступных ящиков показываются только счётчиком без содержимого (этап 07) |
| `GET /stages/{id}/input-events` | `tender.read` | — | события барьера актуальности и решения по ним |

### 2.4. Распознавание, доказательства, поиск

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /document-revisions/{id}/recognition-imports?name=<имя>.zip` | `source.write` | IK | импорт экспортного архива RDWeb: тело — сам ZIP (`application/octet-stream`); права и имя проверяются до чтения тела. `202` — создан прогон `queued` и поставлено задание; `200` с `reused: true` — для этой пары «редакция + архив» прогон уже есть; `400` — тело не ZIP или нет ключа; `409 STATE_CONFLICT` — по этой редакции уже идёт распознавание (история версий линейна, R04-12); `413` — больше лимита загрузки (этап 04) |
| `POST /document-revisions/{id}/local-recognitions` | `source.write`; редакция договора — `contract.read` и `contract.manage` | IK | явная команда локального распознавания (этап 05a, OD-1, OD-2). Тела нет. `202` — создан прогон `local_ocr` в `queued` и поставлено задание; `200` с `reused: true` — прогон той же идентичности (редакция, оригинал, распознаватель, версия, конфигурация) уже поставлен, выполняется или завершён — нового не создано. Ответ — только `{ reused, run: { id, documentRevisionId, engine, status, outcome, createdAt } }`, без текста и качества. `409 STATE_CONFLICT` с `current.reason`: `unsupported_format` (не PDF, DOCX, XLSX, CSV — OD-4), `route_rdweb` (у редакции есть прогон RDWeb или документ помечен «только RDWeb»), `recognition_in_progress` (идёт другой прогон; `current.runId`, `engine`, `status`). Аудит `recognition.local.request` без содержимого. Распознавание договора права чтения не выдаёт (OD-3) |
| `GET /recognition-runs/{id}` | `tender.read` | — | прогон: движок и версия схемы, статус (`queued`/`running`/`complete`/`partial`/`failed`/`cancelled`), `pagesTotal`/`pagesRecognized`, `missingPages[]`, `quality` (счётчики и предупреждения разбора), страницы, `supersedesRunId`/`supersededByRunId`, `contentUrl` оригинала (этап 04). `pagesTotal` — фактическое число страниц оригинала (R04-03). С этапа 05a: `outcome` (`queued`/`running`/`complete`/`needs_review`/`failed`/`cancelled`; `needs_review` — прогон `partial`), `preferred` (прогон выбирается в снимок и текущую область), `mediaType` оригинала, `trigger` (`auto`/`command`/`import`), `recognizer`, `recognizerFingerprint`, `recognizerConfigHash`, `reviewUnits[]`; у единицы — `unitKind` (`pdf_page`/`xlsx_sheet`/`csv_table`/`docx_body`), статус `needs_review`, у логической единицы размеров нет |
| `GET /document-revisions/{id}/recognition-runs` | `tender.read` | — | история прогонов редакции, новые сверху (A10, этап 04) |
| `GET /recognition-runs/{id}/fragments?pageIndex=&cursor=&limit=` | `tender.read` | — | фрагменты прогона постранично; курсор по (`page_index`, `ordinal`, `part_index`, `id`), `limit` ≤ 500 (этап 04). Курсор выдаёт сервер; его четвёртый компонент проверяется как UUID до обращения к БД, поэтому подделанный курсор даёт `400 VALIDATION_FAILED`, а не внутреннюю ошибку (R04-16). У фрагмента есть `partIndex`/`partTotal`: длинный текст блока хранится частями и не усекается (R04-06) |
| `GET /evidence/{fragmentId}` | `tender.read` | — | фрагмент: текст, происхождение, страница и её номер листа, `bboxNorm` с `bboxSpace`, поворот, `externalCropUrl` (только как текст), `contentUrl` оригинала (этап 04). С этапа 05a — `locator` (структурный якорь: `pdf_text`, `xlsx_cells`, `csv_rows`, `docx_paragraph`, `docx_table_row`), `unitKind`, `engine` прогона и тип файла оригинала; у локального фрагмента координат нет, интерфейс пишет это прямо |
| `GET /evidence/{fragmentId}/preview` | `tender.read` | — | превью страницы с выделением. На этапе 04 **не реализован и маршрут не зарегистрирован**: превью строит браузер на pdf.js поверх `GET /document-revisions/{id}/content`, серверного рендера PDF в портале нет |
| `POST /search` | `tender.read` (вид `tender`), `contract.read` (вид `contract`) | — | поиск по области с созданием прогона `search_run` (этап 05; ADR-008, ADR-012 §14, `state-machines.md` §21). Вход: `context` — объединение по виду: `{ kind: 'tender', tenderId, mode: 'working' \| 'review' \| 'release', stageId? \| evidenceScopeId? \| releaseId? }`; вид `{ kind: 'contract', contractId }` — этап 06a: право `contract.read`, текущий корпус договора, режим `working`; режим `comparison` — для этапа 15; единицы договоров в тендерном контексте без `contract.read` исключаются до ранжирования и считаются в `scope.excludedByAcl`; `query`, `limit` ≤ 50. Ответ `200`: `searchRunId`, `status` (`pending`/`complete`/`degraded`), `scopeHash`, `scope` (единицы по типам, исключено по правам — только число, страницы распознано из всего, не проиндексировано активной версией), `lexical` — ранги точной и полнотекстовой веток с пометкой `preliminary: true`, `semantic` — `{ status: queued \| complete \| unavailable, reason? }`, `fused` — итог RRF, если прогон уже терминален, иначе `null`. Каждый результат: `fragmentId`, документ, редакция, прогон, страница, координаты, `origin`, `matchedVia`; с этапа 05a — `engine` и `runOutcome` прогона, `unitKind`, `locator`; в `scope` — `localUnits` и `localNeedsReview` (единицы локального распознавания и из них требующие проверки). Пустой итог формулируется как «не найдено в области: N единиц, M страниц распознано из K» (I07) |
| `GET /search-runs/{id}` | `tender.read`, автор прогона | — | чтение прогона: статус, закреплённые область и версия индекса, ранги веток, итог `fused` (для терминального прогона), причина деградации, тайминги. Прогон `pending` после `deadline_at` терминализуется этим чтением как `degraded` (`semantic_timeout`). Права проверяются заново: нет доступа к тендеру — `404`; закреплённые единицы шире допустимых сейчас — `409 STATE_CONFLICT` с `reason = scope_changed` без результатов. Терминальный прогон неизменен: повторное чтение возвращает те же ранги |

Внешние `crop_url` из экспорта портал не загружает ни при импорте, ни при показе: они хранятся и отдаются как текст (A38, SSRF).

### 2.5. Расчёт

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /stages/{id}/calculation-source` | `tender.read` | — | связи этапа: `primary`, `references[]`, `version` и `ETag: "<stageId>:<version>"` (сумма `row_version` связей), `integration[]` — статусы компонентов TenderHub (`TenderHubReader`, `TenderHubRevisionReader` с `blockedBy: 'X-01'`) без секретов (этап 06) |
| `PUT /stages/{id}/calculation-source` | `admin.tender` и назначение на тендер | IM | тело `{ externalTenderId: uuid, externalVersion?: int \| null }`; задаёт основную связь, прежняя основная с другим тендером TenderHub становится `reference`; этап в архиве — `409`. Ответ — как у `GET` (этап 06) |
| `POST /stages/{id}/calculation-captures` | `calculation.capture` | IK | тело `{}`; `202` — выгрузка `capturing` и задание worker; `409 STATE_CONFLICT` с `current.reason`: `no_calculation_source`, `capture_in_progress` (+ `captureId`), этап в архиве. Сервер в TenderHub не ходит (этап 06) |
| `GET /stages/{id}/calculation-captures` | `tender.read` | — | последние 50 выгрузок этапа, новые сверху (этап 06) |
| `GET /calculation-captures/{id}` | `tender.read` | — | статус (`capturing`/`complete`/`inconsistent`/`failed`), `trigger`, `transport`, журнал `attempts` (исход, причины расхождения, SHA-256 сырых ответов), `consistency` (признаки до/после, счётчики, сверка агрегатов с допуском), `sourceObserved`, `rawBundleSha256`, `contractVersion`, `revisionId`, `failure { code, detail }` (этап 06) |
| `GET /stages/{id}/calculation-revisions` | `tender.read` | — | ревизии этапа, новые сверху (этап 06) |
| `GET /calculation-revisions/{id}` | `tender.read` | — | `seq`, `kind` (`provisional`/`verified`), `externalTenderId`, `externalVersion`, `externalRevisionRef`, `supersedesRevisionId`, `contentHash`, `counts`, `source` (номер, срок подачи, `grandTotal` — объект денег `cached_grand_total` с `currency: UNKNOWN`, курсы), `kpTotal { value: null, rule: null, semantics: { status: 'rule_not_set', question: 'Q-05', … } }`, `productionGate { mode: 'production', allowed, blockers }` (`CALCULATION_PROVISIONAL` у `provisional`), `sourceStatus[]` и `closureAvailable` (только `verified`, X-01), `aggregates`, `raw { bundleSha256, contractVersion }` (этап 06) |
| `GET /calculation-revisions/{id}/positions?cursor=&limit=` | `tender.read` | — | позиции в порядке (`position_number`, внешний ID), `limit` ≤ 500; у позиции `isSection`, `isAdditional`, `manualVolume { value, note, semantics: 'unconfirmed' }`, `dominantCostCategory`, суммы объектами денег, `rawLexemes`, число строк (этап 06) |
| `GET /calculation-revisions/{id}/lines?positionId=&cursor=&limit=` | `tender.read` | — | строки ревизии или одной позиции, `limit` ≤ 500; `unitRate` в валюте строки источника, остальные суммы с `currency: UNKNOWN`; `parentWorkExternalItemId` у комплексной строки материала (этап 06) |
| `GET /calculation-revisions/{id}/lineage` | `tender.read` | — | записи сопоставления позиций в эту ревизию, `version` и `ETag: "<revisionId>:<число записей>"` (этап 06) |
| `POST /calculation-revisions/{id}/lineage` | `calculation.capture` | IM | тело `{ fromRevisionId, links: [{ fromPositionId, toPositionId, status: 'confirmed' \| 'rejected' }] }` (1–500); решение человека, `method = manual`, только дописывание; ревизия-источник — другая ревизия того же тендера, иначе `400`; позиции проверяет БД. Автоматического сопоставления на этапе 06 нет (этап 10) |

Суммы — объект денег ADR-005 §4; `amount` — каноническая десятичная строка без потери точности, исходная лексема источника — в `rawLexemes`. Валюта сумм TenderHub, кроме цены единицы строки, источником не подтверждена (`UNKNOWN`), НДС — `unknown` (Q-05). Курсоры выдаёт сервер и проверяет их форму до обращения к БД (`400 VALIDATION_FAILED`); ответы страниц содержат `hasMore` и `nextCursor`.

### 2.5a. Договорной контур (этап 06a; D-017, D-022, D-023)

Невидимый договор — `404`, видимый без нужной возможности — `403`. Возможности договора — строки `contract_access` при роли инженера или руководителя; `admin.contract` (роль `admin`) видит карточки и ведёт строки доступа, содержимого не открывает. Без `contract.read` карточка — только `number`, `title`, `status`, даты, автор и `restricted: true`.

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /contracts` | выдача по договору или `admin.contract` | — | видимые договоры (`capabilities` — мои возможности, `restricted`), `canCreate`, `isContractAdmin` |
| `POST /contracts` | `contract.create` | IK | тело `{ number, title, counterparty?, signedOn? }`; `201`, создатель получает `contract.read` и `contract.manage` |
| `GET /contracts/{id}` | выдача или `admin.contract` | — | карточка и `ETag` |
| `PATCH /contracts/{id}` | `contract.manage`; `counterparty`, `signedOn` — ещё и `contract.read` | IM | правка карточки |
| `POST /contracts/{id}/archive`, `POST /contracts/{id}/restore` | `contract.manage` | IM | архив и возврат; физического удаления нет (OD-5) |
| `GET /contracts/{id}/access` | `admin.contract` | — | действующие выдачи по договору и `contractRowVersion` |
| `PUT /contracts/{id}/access/{userId}` | `admin.contract` | IM (ETag договора) | тело `{ capabilities: ('contract.read' \| 'contract.link' \| 'contract.manage')[] }` — полный набор: недостающие выдаются, лишние отзываются; пользователю без роли инженера или руководителя — `409` |
| `GET /admin/contract-creators`, `PUT` и `DELETE /admin/contract-creators/{userId}` | `admin.contract` | — | глобальная выдача и отзыв `contract.create` |
| `GET /contracts/{id}/tenders` | выдача или `admin.contract` | — | связи договора с тендерами, карточка которых видна пользователю |
| `POST /contracts/{id}/tenders` | `contract.link` и `source.write` по тендеру | IK | тело `{ tenderId, stageId?, note? }`; `201` — новая связь, `200` — возврат архивной; действующая — `409`; архивный договор — `409` |
| `PATCH /contract-tender-links/{id}` | `contract.link` и `source.write` | IM | тело `{ stageId?, note? }` |
| `POST /contract-tender-links/{id}/archive` | `contract.link` и `source.write` | IM | тело `{ reason }`; исторические снимки не меняются |
| `GET /tenders/{id}/contracts` | `tender.read` | — | связи тендера только с договорами, по которым у пользователя есть выдача |
| `GET /contracts/{id}/documents` | `contract.read` | — | документы договора: `role` (`contract`/`addendum`/`appendix`), `mainDocumentId`, последняя редакция и статус её распознавания |
| `POST /contracts/{id}/documents?name=&role=&mainDocumentId=&title=` | `contract.read` и `contract.manage` | IK | тело — файл (`application/octet-stream`); `201` — новый документ, `200` — такое содержимое уже есть (`status: duplicate`); `409` с `current.reason`: `main_document_exists`, `main_document_missing`; архив и ZIP не принимаются |
| `GET /contract-documents/{id}` | `contract.read` | — | документ и его редакции |
| `PATCH /contract-documents/{id}` | `contract.manage` | IM | тело `{ title?, recognitionRoute? }`, хотя бы одно поле; `recognitionRoute` — политика маршрута PDF (этап 05a, OD-1) |
| `POST /contract-documents/{id}/revisions?name=` | `contract.read` и `contract.manage` | IK | новая редакция; то же содержимое другим документом — `409 content_in_other_document` |
| `GET /stages/{id}/contract-candidates` | `tender.read` | — | последние редакции документов договоров, действующе связанных с тендером и читаемых пользователем, — кандидаты в состав этапа |

Редакции договора обслуживают те же пути, что и редакции тендера: `GET /document-revisions/{id}/content`, `…/recognition-runs`, `POST …/recognition-imports` и `POST …/local-recognitions` (`contract.manage`; редакция видна только с `contract.read`), `GET /recognition-runs/{id}`, `GET /evidence/{id}` — всё с `contract.read`. Имя файла при выдаче — название документа с расширением типа (происхождений у договора нет).

### 2.6. Коммуникации и переговоры

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /communications/imports` | `source.write` | IK | импорт EML или выгрузки MailHub |
| `GET /tenders/{id}/communications`, `GET /communications/{id}` | `tender.read` + доступ к ящику | — | письма, цепочка, вложения |
| `POST /communications/{id}/tender-links` | `source.write` | IM, IK | подтверждение или отклонение связи с тендером |
| `POST /qa-forms/imports`, `GET /qa-forms/{id}` | `source.write` / `tender.read` | IK | формы вопрос–ответ |
| `POST /negotiations/imports`, `GET /negotiation-sessions/{id}` | `source.write` / `tender.read` | IK | сессии, редакции транскрипции, сегменты (речь и подсказки раздельно) |

### 2.7. Требования, проверки, решения

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /stages/{id}/requirements`, `POST /stages/{id}/requirements` | `tender.read` / `requirement.write` | IK | реестр и создание |
| `POST /requirements/{id}/revisions` | `requirement.write` | IM | новая формулировка с сохранением цитат |
| `POST /requirements/{id}/transitions` | `requirement.write` | IM | подтверждение, отклонение, замена |
| `POST /requirements/{id}/coverage-links`, `POST /coverage-links/{id}/transitions` | `requirement.write` | IM, IK | покрытие расчётом |
| `POST /stages/{id}/review-runs`, `GET /review-runs/{id}` | `review.run` / `tender.read` | IK | запуск проверки на снимке области (создаётся или переиспользуется в той же транзакции) и результаты с охватом |
| `GET /model-suggestions`, `POST /model-suggestions/{id}/accept`, `…/reject` | `tender.read` / `finding.write` | IM, IK | гипотезы модели; принимает только человек |
| `GET /stages/{id}/findings`, `POST /findings`, `POST /findings/{id}/transitions` | `tender.read` / `finding.write` | IM, IK | замечания и переходы |
| `POST /discrepancies/{id}/status-events` | `finding.write` | IK | изменение одной оси статуса с основанием |
| `POST /decisions` | `finding.write` | IK | решение человека |
| `POST /questions`, `PATCH /questions/{id}` | `finding.write` | IM, IK | вопросы заказчику |
| `POST /risk-acceptances` | `risk.accept` | IK | принятие бизнес-риска (только руководитель) |

### 2.8. Приложения

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /template-revisions`, `POST /template-revisions` | `tender.read` / `admin.templates` | IK | версии форм компании и заказчика |
| `POST /stages/{id}/application-drafts` | `application.write` | IK | создать заполнение |
| `PATCH /draft-field-values/{id}` | `application.write` | IM | значение, принятие предложения, ручная правка |
| `GET /application-drafts/{id}` | `tender.read` | — | поля, происхождение, устаревшие подтверждения |

### 2.9. Кандидат, согласование, выпуск

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /stages/{id}/release-candidates` | `candidate.create` | IK | сборка кандидата из закреплённых входов; обязательный `mode` (`production`/`test`), дальше неизменен; проверки должны быть на одном снимке области |
| `GET /release-candidates/{id}` | `tender.read` | — | состав, манифест, файлы, блокеры |
| `GET /candidate-files/{id}/content` | `tender.read` | — | просмотр именно того файла, который согласуется |
| `POST /release-candidates/{id}/approve` | `candidate.approve` | IM, IK | согласование руководителем |
| `POST /release-candidates/{id}/return` | `candidate.approve` | IM, IK | возврат на доработку с причиной |
| `POST /approvals/{id}/revoke` | `candidate.approve` | IM, IK | отзыв согласования до выпуска |
| `POST /release-candidates/{id}/release` | `candidate.release` | IM, IK | выпуск назначенным инженером |
| `GET /stages/{id}/holds`, `POST /holds/{id}/resolve` | `tender.read` / `hold.resolve` | IM, IK | удержания по событиям входов для конкретного кандидата: «не влияет» или «требуется новый кандидат» (I04, R01-03) |
| `GET /releases/{id}`, `GET /releases/{id}/manifest` | `tender.read` | — | выпуск и манифест |

### 2.10. Размещение, отправка, сравнение

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /releases/{id}/deliveries` | `tender.read` | — | состояние по каждому назначению |
| `POST /deliveries/{id}/retry` | `delivery.manage` | IM, IK | повтор одного назначения |
| `POST /deliveries/{id}/resolve-conflict` | `delivery.manage` | IM, IK | решение по конфликту имени и хэша |
| `POST /deliveries/{id}/redirect` | `delivery.manage` | IM, IK | новая доставка на текущую версию назначения той же среды; старая → `superseded` |
| `POST /releases/{id}/send-events` | `send.register` | IK | регистрация отправки с основанием; только для выпуска `mode = production`, иначе `RELEASE_IS_TEST`; под барьером актуальности |
| `POST /releases/{id}/compliance-incidents` | `send.register` | IK | учёт недопустимой отправки, совершённой вне системы; не создаёт отправку |
| `POST /send-events/{id}/verify` | `send.register` | IM, IK | сверка состава вложений с манифестом |
| `POST /comparisons`, `GET /comparisons/{id}` | `tender.read` | IK | сравнение двух выпусков |
| `POST /change-explanations/{id}/confirm` | `finding.write` | IM, IK | подтверждение причины изменения человеком |
| `GET /tenders/{id}/audit-events` | `audit.read` | — | журнал действий; руководитель тендера — все события, администратор без назначения — только действия с карточкой и участниками (R02-02) |

## 3. Правила ответов

1. Любой ответ с суммой содержит валюту, признак НДС и вид цены. Несопоставимые величины помечаются `incomparable` с причиной.
2. Любой ответ проверки содержит охват: число документов, страниц, распознанных страниц, недоступные источники. При неполноте — признак `incomplete`, а не «пройдено» (I18).
3. Любая ссылка на доказательство — стабильный ID фрагмента портала плюс документ, редакция, страница, координаты.
4. Отсутствие данных различается: `not_found_in_scope`, `not_provided`, `no_data`, `incomplete_processing`, `confirmed_discrepancy` (I07).
5. Ответ на чтение исторического выпуска строится только из его закреплённых входов; поздние документы не попадают (I05).
