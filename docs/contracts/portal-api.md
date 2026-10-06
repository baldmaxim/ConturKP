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
| `POST /stages/{id}/evidence-scopes` | `source.write` | IK | фиксация снимка области доказательств (R01-01; этап 05): из замороженной ревизии набора этапа (по умолчанию последней, либо `sourceSetRevisionId`) с выбранным для каждой включённой редакции предпочтительным прогоном (`recognition_preferred_run`, с этапа 05a: успешный RDWeb выше локального). `201` — новый снимок; `200` с `reused: true` — тот же состав уже зафиксирован; `409 STATE_CONFLICT` с `current.reason = no_frozen_source_set` — замороженной ревизии нет. С этапа 07 в снимок входят письма с действующей связью с тендером и этапом — последней ревизией, и транскрипции тендера — последней редакцией |
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

Суммы — объект денег ADR-005 §4; `amount` — каноническая десятичная строка без потери точности, исходная лексема источника — в `rawLexemes`. С этапа 10 (D-030, таблица семантики §3, §3.1): себестоимость и её суммы — `cost`, RUB; коммерческие колонки и суммы — `commercial`, RUB как вывод из формулы (`source.derivation = derived_from_formula`); `unitRate` — валюта строки; НДС — `unknown` (Т-10-1); `materialCostTotal` / `workCostTotal` — коммерческие суммы (до этапа 10 ошибочно помечались `cost`); `source.fxRatesObservedAt` — дата наблюдения курса; `source.instanceId` — экземпляр TenderHub выгрузки; `quoteDatesStatus: not_received` — даты цены не получены. Курсоры выдаёт сервер и проверяет их форму до обращения к БД (`400 VALIDATION_FAILED`); ответы страниц содержат `hasMore` и `nextCursor`.

#### Экономика (этап 10; D-030; `docs/architecture/10-economics-design.md` §7)

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /calculation-revisions/{id}/economics` | `tender.read` | — | отчёт ревизии (пишется при первом запросе, далее неизменен): `totals`, `linesWithoutCommercial`, `foreignCurrency`, `delivery`, `positionsUnitPriceUndefined`, `lineCheck` (метод и допуск десятичного пересчёта), `deviations` (по видам §5.9), `rates` (с датой наблюдения), `reconciliation` (цель `cached_grand_total`, подтверждённая часть, неподтверждённый остаток, допуск `0.01`, `isKpTotal: false`), `components` (контракт `adapter-2`) |
| `GET /calculation-revisions/{id}/economics/deviations?flag=&after=&limit=` | `tender.read` | — | строки с отклонениями от ограничений источника: количество, выведенное количество (диагностика), себестоимость, пересчёт, флаги |
| `POST /stages/{id}/comparisons` | `economics.compare` | IK | тело `{ leftRevisionId, rightRevisionId }` — две разные ревизии тендера этапа; одной транзакцией: предложения пар (система подтверждает только `source_lineage` одного экземпляра, тендера и версии), закреплённое сопоставление, разложение, `201` со статусом `ready` / `failed` и `proposals { systemConfirmed, proposed, ambiguous }` |
| `GET /stages/{id}/comparisons`, `GET /comparisons/{id}` | `tender.read` | — | список; сравнение: метод (`order`, `jointEffectRule`), `totals`, `summary` вкладов по мерам и компонентам с уровнем тендера, `resultSha256`, вычисляемый признак `outdated` (новые решения по парам, изменившиеся основания причин) |
| `GET /comparisons/{id}/units?kind=&changed=&after=&limit=` | `tender.read` | — | `changed=true` — несопоставленные и несопоставимые единицы, неравные суммы и причина-изменение строки у «без разложения» (`unit_changed`, `formula_differs`; R10-04); единицы: стороны, суммы и дельты по мерам, сопоставимость с причиной, вклады в порядке метода (`lineRefs`; у «без разложения» — `lineRefs.notes[]`: пара строк и причина `unit_changed` с `fromUnit`/`toUnit`, `formula_differs`, `formula_not_applicable`, `fx_rate_missing`, `markup_missing`, `cost_missing`; R10-02), действующая причина, гипотезы модели; производный текст — только при чтении всех оснований (`restricted`) |
| `GET /comparisons/{id}/lineage` | `tender.read` | — | позиции обеих ревизий, действующие записи по парам (метод, статус, решение системы), неоднозначные группы, `ETag: "<comparisonId>:<lineage_seq>"` |
| `POST /comparisons/{id}/lineage-decisions` | `calculation.capture` | IM | тело `{ decisions: [{ fromPositionId, toPositionId, status }] }` (1–2000); подтверждение предложения — его методом, ручная пара — `manual`; устаревший If-Match — `412` |
| `GET /comparison-units/{id}/explanations` | `tender.read` | — | история версий причины |
| `PUT /comparison-units/{id}/explanation` | `change_reason.confirm` | IM | тело `{ reasonKind, reasonStatus, rationale?, fragmentIds[], decisionIds[] }`; If-Match `"<unitId>:<версия>"`; «подтверждена» вида документ / ответ / поставщик — только с основанием подходящего происхождения (БД, `409`); основания должен читать автор; заменённое основание (новая редакция документа, письма, транскрипции или ответа заказчика, новое распознавание той же редакции, исключение из состава источников, следующее решение) — `409 basis_superseded` с `superseded[] { fragmentId, decisionId, cause }` (R10-01; вторая линия — 0027) |
| `POST /comparisons/{id}/reason-runs`, `GET /comparisons/{id}/reason-runs`, `GET /reason-runs/{id}` | `economics.compare` / `tender.read` | IK | прогон гипотез причин: вход закрепляется при запуске (единицы и кандидаты-основания из снимка области); `409`: `no_scope`, `no_units`, `comparison_not_ready` |
| `POST /change-reason-suggestions/{id}/accept`, `…/reject` | `change_reason.confirm` | IM | решение человека по гипотезе; принятие создаёт версию причины `confirmed` с основаниями гипотезы; `409`: `suggestion_expired`, `suggestion_decided`, `restricted_fragments`, `basis_superseded` (R10-01) |

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

Этап 07 (D-025). Ящик — контекст доступа: письма, тему, адреса, тело, вложения, фрагменты и цитаты видит только пользователь с `mail.read` на ящик (выдача строкой `mail_access` при роли инженера или руководителя); связь письма с тендером и включение в снимок права читать не дают. Невидимый ящик или письмо — `404`, видимый ящик без нужной возможности — `403`. Администратор ящиков (`admin.mailbox`) ведёт ящики и выдачи и видит только служебные сведения. События связи и импорта пишутся в журнал без темы, тела, адресов и имени файла; связь — без `tender_id` (тендер — в деталях).

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /mailboxes` | выдача по ящику или `admin.mailbox` | — | ящики (`capabilities` — мои возможности), `isMailboxAdmin`, `integrations` — состояние MailHub (`BLOCKED_EXTERNAL`, X-03) и сервиса переговоров (`BLOCKED_EXTERNAL`, Q-06) |
| `POST /mailboxes` | `admin.mailbox` | IK | тело `{ system: 'manual' \| 'mailhub', externalAccountId, displayName }`; `201`; тот же адрес — `409 mailbox_exists` |
| `GET /mailboxes/{id}`, `PATCH /mailboxes/{id}` | выдача или `admin.mailbox` / `admin.mailbox` или `mail.manage` | IM | служебная карточка; тело `{ displayName?, status? }` — архив без удаления |
| `GET /mailboxes/{id}/access`, `PUT /mailboxes/{id}/access/{userId}` | `admin.mailbox` | IM (ETag ящика) | тело `{ capabilities: ('mail.read' \| 'mail.import' \| 'mail.link' \| 'mail.manage')[] }` — полный набор; пользователю без роли инженера или руководителя — `409` |
| `GET /mailboxes/{id}/messages` | `mail.read` | — | письма ящика с последней ревизией |
| `POST /mailboxes/{id}/imports?name=&direction=&folder=&tenderId=&stageId=` | `mail.import`; связь — ещё `mail.link` и `source.write` по тендеру | IK | тело — файл `.eml` (`application/octet-stream`); `202` и запись импорта `queued`, разбирает worker (`mail.import`); архивный ящик — `409`; не письмо — `400` |
| `GET /mailboxes/{id}/imports`, `GET /mail-imports/{id}` | `mail.read` или `mail.import` (свой импорт — всегда) | — | исход: `done` (письмо, ревизия, `createdRevision`) или `failed` (`mail_empty`, `mail_malformed`, `mail_too_large`) |
| `GET /mail-messages/{id}` | `mail.read` | — | текущая ревизия (шапка, тело по блокам с признаком `quoted`, вложения со статусом распознавания), `revisionList`, `siblings` — копии коммуникации только в читаемых ящиках, `tenderLinks` — связи с видимыми тендерами, `candidates` — с `mail.link` |
| `GET /mail-message-revisions/{id}` | `mail.read` | — | прежняя ревизия письма целиком |
| `POST /mail-messages/{id}/tender-links` | `mail.read`, `mail.link`, `source.write` по тендеру | IK | тело `{ tenderId, stageId? }`; `201` — новая связь, `200` — возврат снятой или смена этапа, действующая — `409`; событие барьера `communication_linked` |
| `POST /mail-messages/{id}/tender-links/{tenderId}/unlink` | то же | IK | статус `unlinked`; письмо, ревизии и снимки не меняются |
| `GET /tenders/{id}/mail-messages` | `tender.read` | — | письма с действующей связью только из читаемых ящиков; остальные не показываются и не считаются |
| `GET /mail-attachments/{id}/content` | `mail.read` | — | байты принятого вложения; тип — по содержимому; отклонённое — `409` |
| `POST /tenders/{id}/qa-imports?name=&stageId=` | `source.write` | IK | manifest `kontur.qa.v1`; `201` — импорт (`newRevisions`), `200` с `reused` — тот же файл подряд; ошибка формата — `400` |
| `GET /tenders/{id}/qa-threads`, `GET /qa-threads/{id}` | `tender.read` | — | треды; вопросы треда (`questions`) с текущей ревизией и историей |
| `POST /tenders/{id}/negotiation-imports?name=&stageId=` | `source.write` | IK | manifest `kontur.negotiation.v1`; `createdRevision: false` — транскрипция не изменилась |
| `GET /tenders/{id}/negotiation-sessions`, `GET /negotiation-sessions/{id}?revisionId=` | `tender.read` | — | сессии; участники, редакции и сегменты (`speech` / `hint` раздельно) |

Письма и транскрипции участвуют в общих путях: `POST /search` (почтовая единица — только при `mail.read`, доступе к тендеру и связи письма с тендером: в `working` — действующей, в `review` — зафиксированной снимком; исключённые — числом `excludedByAcl`), `GET /search-runs/{id}` (отзыв `mail.read` или снятие связи для рабочего прогона — `409 scope_changed`), `GET /evidence/{id}` (`sourceKind`, `mail`, `transcript`), `POST /stages/{id}/evidence-scopes` (письма с действующей связью и транскрипции тендера входят сами; вложение — только включённое в состав этапа, при снятой связи — `409 attachment_link_inactive`), `PUT /source-set-revisions/{id}/items` (вложение — только письма, связанного с тендером этапа, новый элемент — с `mail.read`). Документ вложения распознаётся путём 05a: `POST /document-revisions/{id}/local-recognitions` требует `mail.import` на ящик письма. `.eml` в `POST /stages/{id}/imports` — отказ элемента `type_not_allowed` с пояснением (AD-07-3).

### 2.7. Требования, проверки, решения

Этап 08 (D-026), этап 09 (D-029; проект — `docs/architecture/09-review-checks-design.md`): инженер и руководитель — `review.run`, `finding.write`; руководитель — `finding.accept_risk`, `source_priority.manage`. Права этапа 08 — возможности тендера из роли участника (Р-08-8): инженер — `requirement.read`, `requirement.create`, `analysis.run`, `fact.read`, `fact.create`; руководитель — дополнительно `requirement.confirm`, `requirement.decide`, `requirement.manage`, `fact.confirm`. Текст требования, кандидата, факта, решения, допущения, вопроса заказчику, причина и объекты оценки покрытия, пояснения и имя параметра конфликта выдаются целиком, только если пользователь читает все фрагменты замыкания закрытости объекта — основания любой роли самого объекта и всего, из чего его текст мог быть унаследован (Р-08-5, R08-02; ADR-006); иначе — безопасная оболочка: ID, код, статус, служебные данные, число оснований по ролям, признаки `contradicted`, `conflicts` (коды), `coverageUnitMismatch` / `unitMismatch`, `restricted: true`, `visible: false`. Результат прогона — если читаются все фрагменты входа. Цитата — только `GET /evidence/{id}` по правам источника. Изменения — только в активном реестре этапа (иначе `409 registry_not_active`). Цитировать, подтверждать и отмечать можно только читаемые фрагменты, команды над скрытым объектом запрещены (`409 restricted_fragments`).

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /stages/{id}/requirement-registry` | `requirement.read` | — | активный реестр, история реестров, счётчики полноты, последняя запись завершения, настроена ли модель |
| `POST /stages/{id}/requirement-registries` | `requirement.manage` | IK | реестр на снимке области; при действующем — переход с переносом (ответ — `carry`); тот же снимок — `409 same_scope` |
| `GET /requirement-registries/{id}/completeness`, `GET …/fragments?scopeItemId=&state=` | `requirement.read` | — | счётчики (`total = reviewed + explicit_not_requirement + unreviewed`), единицы снимка с техническим статусом, состояния фрагментов (текст — по правам источника) |
| `POST /requirement-registries/{id}/marks` | `requirement.create` | IK | отметка `not_requirement` (с причиной) или `cleared` по селектору: `fragments`, `page`, `document_revision`, `mail_message_revision`, `qa_item_revision`, `transcript_revision`; ответ — развёрнутые ID |
| `POST /requirement-registries/{id}/reviews` | `requirement.manage` | IK | завершение прохода полноты; `409 unreviewed` при непросмотренных; `409 restricted_fragments`, если часть фрагментов недоступна |
| `POST /requirement-registries/{id}/analysis-runs`, `GET …/analysis-runs`, `GET /analysis-runs/{id}` | `analysis.run` / `requirement.read` | IK | прогон модели (`requirement_extraction`, `fact_extraction`) по снимку и читаемым фрагментам; повтор — тот же прогон (`reused`); `409 model_not_configured`; результат виден, если читаются все фрагменты входа. С этапа 08a — поле `method`: `model` (по умолчанию) или `rules` — кандидаты требований из фактов графа D-018 девяти типов (провайдер `rules`, задание `analysis.rules`, класс `default`, модель не нужна; только `requirement_extraction`, иначе `400`) |
| `GET /requirement-registries/{id}/candidates?kind=requirement|fact&status=&runId=` | `requirement.read` / `fact.read` | — | кандидаты |
| `POST /requirement-registries/{id}/requirement-candidates`, `…/fact-candidates`; `GET /requirement-candidates/{id}`, `/fact-candidates/{id}` | `requirement.create` / `fact.create` | IK | предложение человека (правка — `derivedFromCandidateId`, ревизия требования — `targetRequirementId`) |
| `POST /requirement-candidates/{id}/confirm`, `/fact-candidates/{id}/confirm` | `requirement.confirm` / `fact.confirm` | IM, IK | подтверждение (формулировку можно уточнить); ответ — ID требования или факта и ревизии. Конфликт с действующим требованием реестра (тот же параметр, другое значение, пересекающаяся область) или основание `contradicts` — только с `conflictNote`, иначе `409 requirement_conflict` (`current.conflicts` — коды, `current.contradicted`); `conflictNote` без конфликта — `409 conflict_note_unexpected` (R08-01) |
| `POST /requirement-candidates/{id}/reject`, `/fact-candidates/{id}/reject` | `requirement.confirm` / `fact.confirm` | IM | отклонение с причиной |
| `POST /requirement-candidates/{id}/rebase`, `/fact-candidates/{id}/rebase` | `requirement.create` / `fact.create` | IK | явный перенос предложения прежнего реестра в активный |
| `GET /requirement-registries/{id}/requirements`, `GET /requirements/{id}` | `requirement.read` | — | реестр; карточка с ревизиями, основаниями, историей покрытия, решениями, допущениями и вопросами |
| `POST /requirements/{id}/supersede`, `POST /facts/{id}/supersede` | `requirement.manage` / `fact.confirm` | IM | замена другим требованием или фактом этапа |
| `POST /requirement-revisions/{id}/coverage` | `requirement.confirm` | IK | оценка покрытия текущей ревизии: состояние и объекты (`evidence_fragment`, `calculation_revision` с позицией и строкой или `complex_rate`, `decision`, `manual_confirmation`). Единица требования не совпадает с единицей объекта расчёта — `covered` / `partial` только с `unitMismatchReason`, иначе `409 unit_mismatch` (`current.objects` — индекс, единицы требования и расчёта); пояснение без несовпадения — `409 unit_mismatch_reason_unexpected` (R08-01) |
| `POST /requirements/{id}/decisions` | `requirement.decide` | IK | решение по требованию (замена — `supersedesDecisionId`); событие барьера `decision_recorded` |
| `GET /requirement-registries/{id}/facts`, `GET /facts/{id}`, `GET /fact-kinds` | `fact.read` | — | факты, ревизии, справочник видов |
| `GET/POST /stages/{id}/assumptions`, `GET /assumptions/{id}`, `POST /assumptions/{id}/revisions` | `requirement.read` / `requirement.create`; подтверждение и отклонение — `requirement.confirm` | IK, IM | допущения ПД |
| `GET/POST /stages/{id}/customer-questions`, `PATCH /customer-questions/{id}` | `requirement.read` / `requirement.create` | IK, IM | вопросы заказчику: статусы, ответ — ревизия Q&A или пояснение; отправки нет |
| `GET/POST /stages/{id}/notes` | `requirement.read` / `requirement.create` | IK | пометки этапа |
| `POST /stages/{id}/review-runs`, `GET /stages/{id}/review-runs`, `GET /review-runs/{id}` | `review.run` / `tender.read` | IK | этап 09: запуск проверки — закрепление снимка области (активного реестра), реестра, последней ревизии расчёта, приоритета источников, версий правил и модели; активный прогон этапа возвращается повторно (`reused`); нет снимка — `409 no_scope`. Вход прогона — правил и модели — закрепляется при запуске неизменяемым снимком (`inputs.inputSha256`, Review 09-1); реестр или записи этапа изменились во время сборки — `409 inputs_changed`. Отчёт: входы, исходы 12 проверок с причинами и счётчиками, замечания прогона по статусам, гипотезы модели, `freshness` (устарел: источники после снимка, расчёт после запуска, изменения реестра и записей этапа), `summary` (`clean` — только завершённый прогон без пробелов, нерешённого, гипотез и принятого риска при актуальных входах) |
| `GET /stages/{id}/findings?status=&kind=&severity=&runId=`, `GET /findings/{id}` | `tender.read` | — | этап 09: замечания; карточка — стороны (`left`, `right`, `context`) с цитатами по правам источника, позиции и строки расчёта, требования, факты; события, обнаружения прогонами, отметки недействительности, решения, разногласие с осями; `canWrite`, `canAcceptRisk`, `canDecide`. Текст замечания, решений и осей — только читающему все основания, иначе `restricted: true` |
| `POST /stages/{id}/findings` | `finding.write` | IK | этап 09: замечание человека с основаниями (фрагменты снимков этапа, объекты расчёта этапа) |
| `POST /findings/{id}/transitions` | `finding.write`; `accepted_risk` — `finding.accept_risk` | IM, IK | этап 09 (команды решений сначала обрабатывают поступившие события этапа; по «устаревшему» замечанию — `409 finding_stale`, Review 09-1): `in_progress` (с ответственным), `resolved` (формулировка и причина — решение `finding_resolution`), `accepted_risk` (руководитель, решение `finding_risk_acceptance`; технические виды — `409 risk_not_acceptable`), `rejected` (с причиной), `open` (из `stale`); иначе `409 transition_not_allowed`; при действующем замечании того же условия повторное открытие — `409` |
| `PATCH /findings/{id}` | `finding.write` | IM, IK | этап 09: критичность (`critical` — только человек), уверенность, ответственный, действие, влияние; каждое изменение — событие |
| `POST /findings/{id}/discrepancy`, `GET /stages/{id}/discrepancies` | `finding.write` / `tender.read` | IK | этап 09: разногласие по замечанию (одно); оси — по умолчанию до первого события |
| `POST /discrepancies/{id}/status-events` | `finding.write` | IK | этап 09: изменение одной оси с причиной и основаниями (`fragment`, `qa_item_revision`, `mail_message_revision`, `document_revision`, `decision`); значение не из словаря оси — `400`; подсказка переговоров — `409 hint_not_basis`; `agreed_in_writing` / `rejected_by_customer` без письменного основания — `409 written_basis_required`; `fixed_in_tz` / `fixed_in_contract` — основание из ТЗ / договора (вторая линия — `409`) |
| `POST /discrepancies/{id}/decisions` | `requirement.decide`; граф — `fact.confirm` (тендер) или `contract.manage` (договор) | IK | этап 09: решение по разногласию (`discrepancy_decision`); у «устаревшего» замечания — `409 finding_stale` (и ось, и новое разногласие — тоже). Обе стороны замечания — факты D-018: обязательно `graph` (`prevails` с `prevailingFactId` или `distinct`), ребро графа и пересчёт — той же транзакцией (D-029 В-09-2), без `graph` — `409 graph_decision_required`; стороны без фактов и `graph` — `409 no_fact_link` |
| `POST /model-suggestions/{id}/accept`, `POST /model-suggestions/{id}/reject` | `finding.write` | IK | этап 09: гипотезы модели (в отчёте прогона); принятие — замечание `origin = model_suggestion`, критичность выбирает человек; решённая или истекшая — `409 suggestion_not_open` |
| `GET /tenders/{id}/source-priority`, `POST /tenders/{id}/source-priority` | `tender.read` / `source_priority.manage` | IK | этап 09: приоритет источников — восемь видов по порядку, ревизии с причиной; действует последняя, без ревизий — порядок по умолчанию (D-029 В-09-1). Только подсказка предлагаемой стороны конфликта |
| `POST /risk-acceptances` | `risk.accept` | IK | этап 13: принятие бизнес-риска (только руководитель) |

### 2.8. Приложения

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /application-templates?tenderId=`, `POST /application-templates` | содержательная роль / `admin.templates` (компании), `template.manage` (заказчика) | IK | шаблоны компании и заказчиков своих тендеров; `isDemo` неизменен (этап 11, D-031) |
| `GET /application-templates/{id}`, `POST /application-templates/{id}/revisions` | то же | IK | ревизии; тело `{ schema, sample? }` — схема forms/1 проверяется ядром (`400` с перечнем), образец — по SHA загруженного файла |
| `GET /template-revisions/{id}`, `POST /template-revisions/{id}/approve`, `…/retire` | то же | IM | схема, отличия от прежней ревизии (добавленные, удалённые, изменённые поля); утверждение (прежняя утверждённая выбывает); заказчика — только с основанием (`409 basis_required`) |
| `POST /form-samples?name=&tenderId=` | `admin.templates` / `template.manage` | IK | образец формы (`application/octet-stream`) → `{ sha256, name, sizeBytes }` |
| `GET /approved-wordings?tenderId=&q=&tag=&status=`, `POST /approved-wordings`, `GET /approved-wordings/{id}`, `POST /approved-wordings/{id}/versions` | содержательная роль; заказчика — `application.fill` | IK | библиотека формулировок: последние версии, история, предложение новой версии |
| `POST /wording-versions/{id}/decision` | `wording.approve` (компании) / `template.manage` (заказчика) | IM | `{ status: approved | retired }`; новая утверждённая выводит прежнюю |
| `GET /stages/{id}/application-drafts`, `POST /stages/{id}/application-drafts` | `tender.read` / `application.fill` | IK | приложения этапа с прогрессом и числом незавершённых пунктов; создание по утверждённой ревизии |
| `GET /application-drafts/{id}` | `tender.read` | — | разделы и поля: определение, применимость и обязательность, последняя версия (происхождение, основания с проблемами, «устарело»), предложения системы из фактов и модели; список незавершённых пунктов; производный текст — только при чтении всех оснований |
| `PUT /application-drafts/{id}/fields/{key}` | `application.fill` | IM `"<fieldId>:<версия>"` | действие: `set` (значение и основания), `choose_wording`, `accept_fact`, `confirm`, `discuss` (комментарий, ответственный, черновик вопроса заказчику), `clear`; `412` — поле изменил другой; `409`: `basis_superseded` (в том числе заменённый исходный документ требования, решения или факта, R11-03), `basis_conflict`, `restricted_fragments` (основание или значение, источник которого пользователь не читает целиком: `set`, `confirm`, `discuss` — R11-01, R11-02; текст не возвращается), `decision_basis_unsupported` (основание-решение — только решение по требованию), `draft_superseded`, `wording_not_approved`, `fact_not_applicable`, `fact_value_unavailable` (единица, масштаб или валюта факта не определены или отличаются от поля, R11-04). Значение версии, комментарий и текст оснований — только при чтении всех источников всех оснований, включая версию, значение которой повторено (`valueFromVersionId`); иначе `restricted: true`, `value: null`, `comment: null` |
| `GET /application-drafts/{id}/fields/{key}/history` | `tender.read` | — | версии поля: автор, время, происхождение, состояние, основания |
| `POST /application-drafts/{id}/complete` | `application.fill` | IM | «заполнено» только без блокирующих пунктов (`409 incomplete` с перечнем); вторая линия — БД |
| `POST /application-drafts/{id}/migrate` | `application.fill` | IM | перенос на новую ревизию (D-031 В-11-8): новый черновик, значения «перенесено — подтвердите», отчёт переноса |
| `GET /stages/{id}/application-issues` | `tender.read` | — | незавершённые пункты всех действующих приложений этапа |
| `POST /application-drafts/{id}/suggestion-runs`, `GET …/suggestion-runs`, `GET /field-suggestion-runs/{id}` | `application.fill` / `tender.read` | IK | прогон предложений модели с закреплённым входом; охват: предложения, отброшенные гейтом цитат («ложная цитата») |
| `POST /field-suggestions/{id}/accept`, `…/reject` | `application.fill` | IM | решение человека; принятие — версия поля с цитатами-основаниями; `409`: `suggestion_expired`, `suggestion_decided`, `basis_superseded`, `restricted_fragments`, `suggestion_invalid` (в том числе число не из цитаты в единицах поля, R11-04) |

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

### 2.11. Диалоги и ответное ядро (этап 08a; D-019, D-027)

Контекст диалога — контекст поиска `POST /search` (§2.4): права и область разрешаются тем же кодом. Диалог, его сообщения и ходы видит только автор; чужой диалог и прогон — `404` (существование не раскрывается), в том числе администратору. Стриминга нет: ответ получают опросом прогона.

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /dialogs` | как у поиска: `tender.read` (вид `tender`, режимы `working` и `review`), `contract.read` (вид `contract`) | IK | диалог в контексте. Вход: `{ context, title? }` (`title` ≤ 200, по умолчанию «Вопросы к документам»). `201` — карточка диалога (как `GET /dialogs/{id}`). Контекст фиксируется при создании и не меняется. Аудит `dialog.create` |
| `GET /dialogs?tenderId=&stageId=` / `?contractId=` | автор | — | свои диалоги контекста, новые сверху: `id`, `title`, `contextKind`, `tenderId`, `contractId`, `stageId`, `mode`, `createdAt` |
| `GET /dialogs/{id}` | автор; действующее право на контекст | — | диалог: контекст, `messages[]` (`id`, `seq`, `role` `user`/`assistant`, `text`, `hidden`, `answerRunId`, `createdAt`), `runs[]` (как `GET /answer-runs/{id}`). Сообщение ответа скрыто (`hidden: true`, `text: null`), если автор сейчас не читает все процитированные основания |
| `POST /dialogs/{id}/messages` | автор; права контекста — на момент вопроса | IK | вопрос: `{ text }` (≤ 4000). Одной транзакцией — сообщение, прогон поиска по области (`search_run`), прогон ответа `answer_run` (`queued`) и задание `answer.generate` (класс `gpu`, приоритет 90). `201` — `{ runId, messageId, dialog }`. `409 STATE_CONFLICT` с `current.reason = answer_pending` и `current.runId` — предыдущий вопрос диалога ещё обрабатывается; `409` с `search_index_not_ready` — как у поиска. Аудит `answer.request` с намерением, признаком уточнения и хэшем области, без текста |
| `GET /answer-runs/{id}` | автор; действующее право на контекст | — | опрос хода: `status` (`queued`/`running`/`completed`/`failed`), `answerStatus`, `incompleteReason`, `plan` (намерение, сущности, политика редакции, `followUp`), `verifierMode`, `verificationLevel` (`none`/`hard_checks`/`model`), `model`, `repairs`, `searchRunId`, `questionMessageId`, `failureCode`, время. До `completed` — `answer: null`: черновик модели не показывается. При `completed` — `coverage` (охват: кандидаты, исключено по правам — числом, пакет, перекрытые и спорные основания, утверждения, проверка моделью) и `answer`: `visible`, `text`, `citations[]` (`number`, `label`, `fragmentId`, `versionNote` `current`/`superseded`/`conflict`, `restricted`, `origin`, `text`, `place`), `conflictCitations`, `claims[]` (только показанные: вид, текст, метки), `shownClaims`, `droppedClaims`, `droppedIssues` (коды проблем → число; текста отклонённых утверждений нет и в БД), `foundFragments[]` (основания пакета без цитаты в ответе). `visible = false` — автор сейчас не читает хотя бы одно процитированное основание: текста, цитат и утверждений нет, статус и счётчики остаются |

### 2.12. Граф фактов D-018 (этап 08a; D-018, D-028)

Факты читают правила (`rules/1-kontur`, 13 типов) из прогонов распознавания документов тендера и договора; вложения писем — нет. Производное состояние (действует / перекрыт / конфликт) считает функция графа: семья — явная связь 06a, у документов тендера — ссылка «к договору № … от …»; допсоглашения — по дате документа из заголовка. Неоднозначность — замечание человеку. Решение человека — неизменяемое ребро графа, граф пересчитывается в той же транзакции.

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /contracts/{id}/fact-graph` | `contract.read` (невидимый договор — `404`) | — | граф договора: `documents[]` (вид, номер, дата документа, роль 06a, связь `amends` / `appendix_of` / `unknown` с источником `06a` / `text`), `facts[]` (тип, название, судьба, значение, исходная фраза, единица, условие, пункт, `amends`, документ, редакция, `fragmentIds`, `retired` — факт прежней редакции, `state`: `status`, `supersededReason` `amendment` / `human` / `document_revision`, `supersededByFactId`, `validFrom`, `validTo`, `decidedBy` `rule` / `human`, `decisionId`), `parties[]` (стороны — судьба `contract_card`; поля карточки договора не меняются), `remarks[]` (`parent_not_found`, `parent_ambiguous`, `undated_amendment`, `amendment_target_ambiguous`, `value_conflict`; `open` / `resolved`), `decisions[]`, `coverage`, `graphHash`, `canDecide` |
| `GET /tenders/{id}/fact-graph` | `fact.read` (не участник — `404`) | — | то же для документов тендера |
| `POST /evidence-facts/{id}/decisions` | договор — `contract.manage`; тендер — `fact.confirm` | IK | решение человека по паре: `{ otherFactId, kind: prevails \| distinct \| rule, reason }` (`prevails` — факт `{id}` действует вместо `otherFactId`; `distinct` — значения независимы: ни перекрытия, ни конфликта; `rule` — пара возвращена правилу). `201` — `{ decisionId, graph }`; `409` с `fact_pair_invalid` — факты разных владельцев или один и тот же. Аудит `fact.decision` с хэшем графа |

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
| `POST /comparisons`, `GET /comparisons/{id}` | `tender.read` | IK | сравнение двух выпусков — этап 15, поверх сравнения ревизий расчёта этапа 10 (§2.5) |
| `POST /change-explanations/{id}/confirm` | `finding.write` | IM, IK | заменено этапом 10: причина — `PUT /comparison-units/{id}/explanation` и решение по гипотезе (§2.5) |
| `GET /tenders/{id}/audit-events` | `audit.read` | — | журнал действий; руководитель тендера — все события, администратор без назначения — только действия с карточкой и участниками (R02-02) |

## 3. Правила ответов

1. Любой ответ с суммой содержит валюту, признак НДС и вид цены. Несопоставимые величины помечаются `incomparable` с причиной.
2. Любой ответ проверки содержит охват: число документов, страниц, распознанных страниц, недоступные источники. При неполноте — признак `incomplete`, а не «пройдено» (I18).
3. Любая ссылка на доказательство — стабильный ID фрагмента портала плюс документ, редакция, страница, координаты.
4. Отсутствие данных различается: `not_found_in_scope`, `not_provided`, `no_data`, `incomplete_processing`, `confirmed_discrepancy` (I07). Словарь статусов ответа (этап 08a, AD-08a-2) — объединение этого набора, `needs_clarification` и двух положительных итогов `confirmed_by_citations`, `citations_disagree`; `not_provided` и `confirmed_discrepancy` ответное ядро не присваивает (отсутствие условия не выводится из ненайденного; разногласие подтверждает человек на этапе 09). Статус ответа не совпадает ни с одним результатом регламентной проверки (`review_check_result.outcome`): «подтверждено цитатами» не означает «проверено по регламенту»; недостаток оснований, отказ, ошибка формата и отключение модели — `incomplete_processing` с причиной (I18).
5. Ответ на чтение исторического выпуска строится только из его закреплённых входов; поздние документы не попадают (I05).
6. Ответ ответного ядра (этап 08a, D-027) показывает только утверждения, прошедшие правила: каждая метка цитаты существует в пакете хода и входит в область; каждое число утверждения есть в процитированном фрагменте документального происхождения с той же единицей (проценты не смешиваются с днями и годами; `B30`, `КС-2`, номера пунктов числами не считаются); значение перекрытой редакции не выдаётся за текущее. Конфликт оснований показывается обоими значениями с пометкой, а не разрешается. Непроверенный текст модели не хранится (только SHA-256) и не показывается.
