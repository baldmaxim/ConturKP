# Контракты адаптеров интеграций

Этап 01. Сигнатуры даны как эскиз TypeScript и уточняются при реализации соответствующего этапа. Разделение: **факт** — подтверждено инвентаризацией (`docs/discovery.md`); **проект** — предложение портала, требующее доработки или подтверждения владельцем внешней системы.

## 1. Общие правила

```ts
type AdapterResult<T> =
  | { ok: true; value: T; raw: RawResponseRef }           // raw: ссылка на сохранённый ответ (blob) и время
  | { ok: false; error: AdapterError };

type AdapterError = {
  code: 'AUTH_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNAVAILABLE'
      | 'TIMEOUT_UNKNOWN_OUTCOME' | 'CONTRACT_MISMATCH' | 'INVALID_DATA' | 'CONFLICT';
  message: string;        // без секретов
  retryable: boolean;
  details?: Record<string, unknown>;
};
```

1. Секреты приходят из конфигурации процесса (ADR-006) и не попадают в логи, ответы API и MCP.
2. Каждый ответ, используемый как снимок или доказательство, сохраняется в `blob` вместе с версией контракта адаптера.
3. `TIMEOUT_UNKNOWN_OUTCOME` обязывает обработчик сначала свериться с состоянием внешней системы и только потом повторять (I14, A29).
4. Адаптер не меняет состояние внешней системы, если это не его назначение (размещение). Побочные эффекты чтения запрещены.
5. Каждый адаптер сообщает `status(): IntegrationStatus` для `integration_status`; `VERIFIED_LIVE` ставится только после разрешённого live-smoke с артефактом.

## 2. TenderHub (расчёт)

Факт (`docs/discovery.md` §4.1): заголовок `X-API-Key`, область `tenders:read`, маршруты `tenders/brief`, `overview`, `positions`, `positions/with-costs`, `boq-items-full`, `positions/{posId}/items`, лимит 120 запросов в минуту, кэш `with-costs` 30 с, курсор `positions` по `updated_at DESC`.

```ts
interface TenderHubReader {                      // факт
  listTenders(q: { search?: string; isArchived?: boolean }): Promise<AdapterResult<TenderBrief[]>>;
  getOverview(externalTenderId: string): Promise<AdapterResult<TenderOverview>>;
  listPositions(externalTenderId: string): Promise<AdapterResult<PositionPage[]>>;   // все страницы курсора
  getPositionsWithCosts(externalTenderId: string, opts: { noCache: boolean }): Promise<AdapterResult<PositionWithCosts[]>>;
  listBoqItemsFull(externalTenderId: string): Promise<AdapterResult<BoqItem[]>>;
}

interface TenderHubRevisionReader {              // проект, X-01
  getCalculationRevision(externalTenderId: string, revisionId: string): Promise<AdapterResult<CalculationSnapshot>>;
  getClosureState(externalTenderId: string): Promise<AdapterResult<{ closed: boolean; closedAt?: string; revisionId?: string }>>;
  listChanges(cursor: string | null): Promise<AdapterResult<{ events: CalculationChangeEvent[]; nextCursor: string }>>;
}
```

- До X-01 снимок собирает `PortalCaptureStrategy`: `overview` → `positions` (все страницы) → `positions/with-costs` (`Cache-Control: no-cache`) → `boq-items-full` → повторный `overview`; сверяются `updated_at`, итог, число позиций и строк. Расхождение — `inconsistent`, повтор (ADR-007 §5).
- Числа читаются без промежуточного `float` (ADR-005 §2). Поля `total_amount` трактуются как себестоимость, `total_commercial_*` — как коммерческая стоимость (`docs/discovery.md` §4.4).
- Что вид цены, НДС и состав итога требуют подтверждения — Q-05; адаптер сохраняет всё доступное и не выводит недостающее.

### Реализация (этап 06)

Пакет `packages/adapters/src/tenderhub/`, версия контракта адаптера `TENDERHUB_CONTRACT_VERSION = 'th-api-2026-09-02/adapter-1'` (документация API от 2026-09-02, OpenAPI `archive.yaml` 1.0.0). Один доменный адаптер, транспорт подменяемый (D-016):

```ts
interface ITenderHubSource {                     // факт; реализация — TenderHubApiSource
  readonly transport: 'api';                     // второй транспорт ('db') встанет рядом той же формой
  brief(search: string): Promise<IRead<ISourceBrief[]>>;
  overview(tenderId: string): Promise<IRead<ISourceOverview>>;
  positions(tenderId: string): Promise<IRead<ISourcePositionPaged[]>>;          // все страницы курсора
  positionsWithCosts(tenderId: string): Promise<IRead<ISourcePositionCosts[]>>; // всегда Cache-Control: no-cache
  boqItems(tenderId: string): Promise<IRead<ISourceBoqItem[]>>;
  missingFields(): Record<string, number>;      // документированные поля, которых не было в ответах (R-06)
}
interface IRead<T> { value: T; raws: IRawResponse[] }   // raws — тело после распаковки gzip, путь, статус, Date
runPortalCapture(source, externalTenderId): Promise<IPortalCaptureResult>;  // PortalCaptureStrategy
interface ITenderHubRevisionReader { … }         // проект X-01: только интерфейс, реализации нет
```

Уточнения против эскиза этапа 01:

- **Транспорт `TenderHubHttpClient`.** Только `GET`; ключ — заголовок `X-API-Key`, заголовок `Authorization` не отправляется никогда (ключ в Bearer уходит в JWT-ветку TenderHub и даёт 401); `Accept-Encoding: gzip`; редирект — ошибка, а не следование (ключ не уходит на другой адрес); базовый адрес — `https` либо `http` только на loopback, без учётных данных и параметров. Собственный скользящий лимит `TENDERHUB_RATE_LIMIT_PER_MINUTE` (по умолчанию 100 при лимите ключа 120); на `429` Retry-After у TenderHub нет — запрос ждёт окно, после двух ожиданий — `RATE_LIMITED`. Размер распакованного ответа ограничен `TENDERHUB_MAX_RESPONSE_MB`, таймаут — `TENDERHUB_TIMEOUT_SECONDS` (серверный таймаут TenderHub — 5 мин).
- **Классы ошибок** (`ITenderHubError`: `code`, машинная причина `reason`, `retryable`; без секретов и данных ответа): 401 `invalid API key` → `AUTH_FAILED`/`auth_failed`; 401 `invalid or expired token` → `AUTH_FAILED`/`auth_header_rejected` (ключ не дошёл до TenderHub: прокси или сборка); 403 `API_KEY_SCOPE_DENIED` → `FORBIDDEN`/`forbidden_scope`; 403 `API_KEY_TENDER_DENIED` → `FORBIDDEN`/`forbidden_tender`; 404 → `NOT_FOUND`; 429 → `RATE_LIMITED`; 503 `ENDPOINT_DISABLED` → `UNAVAILABLE`/`endpoint_disabled` без повтора («не обходить»); прочие 5xx, обрыв и сбой сети → `UNAVAILABLE` с повтором; таймаут → `TIMEOUT_UNKNOWN_OUTCOME` с повтором; HTML вместо JSON, неизвестная валюта, чужой тендер в строке, зацикленный курсор, отсутствие обязательного поля → `CONTRACT_MISMATCH` без повтора. Повторяются только 429, сеть, 5xx и таймаут: чтение побочных эффектов не имеет, поэтому сверка внешнего состояния перед повтором (§1 п. 3) сводится к новой выгрузке целиком.
- **Числа.** Тело разбирается `JSON.parse` с доступом к исходному тексту числа (`context.source`, Node ≥ 21): значение не проходит через `float64`. Лексема приводится к канонической десятичной форме (`trim_scale` PostgreSQL), исходная лексема сохраняется в `raw_lexemes` (ADR-005 §2).
- **Пагинация.** `positions` читается с `limit=200` до пустого `next_cursor`; повтор курсора или больше 1000 страниц — `CONTRACT_MISMATCH`. Одна страница полным расчётом не считается.
- **`PortalCaptureStrategy` (`runPortalCapture`).** Порядок: `overview` → `brief` (поиск по `tender_number`: версия и `submission_deadline` есть только там) → все страницы `positions` → `positions/with-costs` (`no-cache`) → `boq-items-full` → повторный `overview`. Выгрузка `inconsistent`, если: признаки шапки до и после различаются (`cached_grand_total`, курсы, `position_count`, `boq_item_count`, `updated_at`); число позиций или строк расходится между маршрутами и шапкой; позиция встретилась на страницах дважды; наборы позиций постраничного маршрута и `with-costs` различаются; общие поля позиции различаются между маршрутами; `items_count` позиции не равен числу её строк; строка ссылается на позицию вне выгрузки; у строки или позиции `updated_at` не раньше начала выгрузки по часам источника (заголовок `Date`). Причины пишутся в попытку выгрузки; ревизия из `inconsistent` не создаётся.
- **`updated_at` шапки.** TenderHub отдаёт `COALESCE(updated_at, NOW())`: у тендера без собственного `updated_at` значение равно текущему времени источника и различается в двух чтениях. Если оба значения совпадают с заголовком `Date` своего ответа (±2 с), признак исключается из сравнения и это пишется в отчёт (`updatedAtIsSourceNow`); остальные признаки сверяются как обычно.
- **Нормализация.** Позиция = строка `with-costs` плюс поля постраничного маршрута (`is_section`, `section_number`, `position_name`, `cost_category_name`). `is_section` хранится и показывается как заголовок раздела, работой не считается; `cost_category_name` позиции — «самая частая категория строк», строкам не присваивается (категория строки — своя, из `boq-items-full`); `manual_volume`/`manual_note` хранятся как значения источника с семантикой «не подтверждена». Итог КП, правило итога, страхование, снижение и перераспределение не выводятся (Q-05): `kp_total` пуст, `kp_total_semantics = { status: 'rule_not_set', question: 'Q-05', unavailableComponents: [...] }`.
- **`ITenderHubRevisionReader`** (`revisionReader.ts`) — только интерфейс проекта X-01. Реализации нет, статус `BLOCKED_EXTERNAL`; `verified`-ревизия и события статуса у источника проверяются контрактными тестами на фикстурах доменной функцией `recordSourceRevision`/`recordRevisionStatus`, путь из продукта к ним отсутствует.
- **Live-smoke (U-04).** `scripts/tenderhub-live-smoke.ts` (`npm run tenderhub:live-smoke -- --tender <uuid>`), разбор — `tenderhub-live-smoke-observe.ts` и `tenderhub-live-smoke-report.ts`: тот же адаптер и та же `runPortalCapture`, что у worker, без БД портала; транспорт наблюдается подменой `fetch` (штатная опция `fetchImpl` клиента), production-код для этого не менялся. Журнал по разделам: доступ по `X-API-Key` без Bearer и версия API; список методов и маршрутов с `non_GET_requests`; пагинация `positions` (страницы, курсоры хэш-метками, повторы, уникальные id, `pagination_multi_page`, при одной рабочей странице — пробный обход малыми страницами `pagination_probe`); `with-costs` с `no-cache`, заголовками кэша и сверкой набора позиций; `boq-items-full` (строки, дубли, строки без позиции, `items_count`); вердикты согласованности рабочей стратегии; числовой контракт без значений; наличие полей Q-05; расхождения с контрактом 2026-09-02 и OpenAPI сборки (маршрут, ожидание, фактический статус или класс схемы, тип); безопасность журнала. В журнал попадают только счётчики, имена полей, коды, статусы и хэши: uuid маскируются, строки, совпавшие с ключом или значениями тендера, скрываются. Сценарий проверен на поддельном сервере (`tests/tenderhubLiveSmoke.test.ts`); живым прогоном это не является — до U-04 `NOT_RUN`.
- **Прямое чтение БД TenderHub** (второй транспорт D-016) на этапе 06 не реализовано: доступ read-only владельцем не подтверждён. Отсутствие транспорта дефектом не является; `transport` у выгрузки хранится (`api`).

## 3. RDWeb (распознавание)

Факт (`docs/discovery.md` §7.1): экспорт — PDF, `_results.md`, `_results.html`, `_blocks.json` (`schema_version` 1, `coordinate_space: normalized_page_top_left`, страницы с `rotation`, блоки с `block_id`, `page_index`, `page_label`, `block_type` ∈ {text, image, stamp}, `coords_norm`, `crop_url`).

```ts
interface RdwebExportImporter {                  // факт (формат по одному образцу)
  inspect(archive: BlobRef): Promise<AdapterResult<{ schemaVersion: number; documentName: string; pages: number; blocks: number }>>;
  import(archive: BlobRef, expect: { documentRevisionId: string; pdfSha256: string }): Promise<AdapterResult<RecognitionImport>>;
}

interface RdwebApiClient {                       // проект, X-05 — BLOCKED_EXTERNAL
  submit(document: BlobRef, idempotencyKey: string): Promise<AdapterResult<{ jobId: string }>>;
  getStatus(jobId: string): Promise<AdapterResult<{ state: 'queued' | 'running' | 'partial' | 'done' | 'failed'; progress?: number }>>;
  fetchResult(jobId: string): Promise<AdapterResult<{ archive: BlobRef; schemaVersion: number }>>;
}
```

- Импорт отклоняет архив, если SHA-256 PDF не совпадает с зарегистрированной редакцией: чужой результат не принимается.
- `page_label` трактуется как номер страницы файла, номер листа берётся из штампа (`docs/discovery.md` §7.1).
- Производные поля блоков (`Summary`, `Description`, `Entities`, `Verification`) сохраняются как `model_description` и отделяются от исходного текста (I06).
- `crop_url` сохраняется как справочная ссылка и не загружается (SSRF, A38).
- Неизвестный `block_type` импортируется с пометкой и предупреждением, а не отбрасывается.

### Реализация (этап 04)

`RdwebExportImporter` реализован пакетом `packages/adapters` (`src/rdweb/*`) как **чистый разбор**: на вход — строки и SHA-256 членов архива, на выход — страницы, фрагменты и предупреждения. В адаптере нет `fetch`, `node:http/https/net` и `node:fs` (проверяется статически, `tests/adapters.test.ts`), поэтому загрузить внешнюю ссылку он не может физически. ZIP открывает worker существующим `readZip` (`apps/worker/src/archive.ts`).

Уточнения сигнатуры против эскиза этапа 01:

```ts
importRdwebExport(input: {
  archive: IRdwebArchive;                       // члены архива, уже прочитанные вызывающим
  expect: {
    pdfSha256: string;                          // SHA-256 зарегистрированной редакции
    pdfPageCount: number;                       // фактическое число страниц оригинала (R04-03)
  };
  limits?: Partial<IRdwebLimits>;
}): { ok: true; value: IRdwebImport } | { ok: false; error: { code: RdwebFailureCode; message: string } };

inspectRdwebBlocks(blocksJson: string): …      // счётчики без текста; CLI — scripts/rdweb-inspect.ts
```

- Коды отказа: `pdf_missing`, `pdf_mismatch`, `blocks_json_missing`, `blocks_json_invalid`, `results_md_missing`, `schema_version_unsupported`, `coordinate_space_unsupported`, `archive_unsafe`, `archive_corrupt`, `too_large`, `pdf_unreadable`, `export_group_mismatch`, `export_group_ambiguous`.
- Отказ допускается только там, где непонимание схемы сделало бы доказательство ложным: чужая `schema_version` и чужое `coordinate_space`. Всё остальное — предупреждение прогона (`quality.warnings`), потому что схема подтверждена одним образцом (R-05).
- Текст блоков берётся только из `_results.md` (в `_blocks.json` текста нет). Соответствие md ↔ JSON — по `block_id`; секция без блока сохраняется без координат с предупреждением `block_not_in_blocks_json`.
- Роль члена архива определяется по расширению, точное имя образца (`_blocks.json`, `_results.md`, `_results.html`) даёт приоритет. Если PDF в архиве несколько, выбирается тот, чей SHA-256 совпал с зарегистрированной редакцией: иначе верный результат отклонялся бы из-за порядка членов архива. Прочие кандидаты на роль попадают в предупреждение `duplicate_member_role`.
- Штампы: повторяющиеся строки `**Stamp:**` страницы дедуплицируются по тексту и привязываются к stamp-блокам страницы по `ordinal`, только если количества совпали; иначе — фрагменты уровня страницы с предупреждением `stamp_binding_ambiguous`. Текст штампа не теряется ни при каком исходе.
- `sheet_label` берётся разбором текста штампа («Лист N из M»); не распознали — `null`. Номер страницы файла в `page_label` им не подменяется.
- Пространство координат фиксируется явно (`bbox_space`): экспорт даёт растровое (`page_rotated`). Пространство хранится как факт, а не «нормализуется» по догадке (I18); пересчёт в рамку делает браузер.

#### Поправки после ревью 04-1

- **Полнота меряется по оригиналу.** `pagesTotal` — это `expect.pdfPageCount`, а не число записей в `pages[]` файла `_blocks.json`. Считает страницы вызывающий (`apps/worker/src/pdfPages.ts` на `pdfjs-dist`): адаптер в файловую систему и в сеть не ходит по построению, и это проверяется статически. Не удалось получить достоверное число — отказ `pdf_unreadable`, полнота не объявляется (R04-03, D-012).
- **Признак распознанной страницы содержательный:** хотя бы один фрагмент с непустым текстом либо блок с явно указанным `status`/`export_status` = `recognized` (сравнение без учёта регистра). Заголовок `## Page N` сам по себе выводом не считается, отсутствие статуса у блока «распознано» не означает.
- **Новые предупреждения:** `blocks_page_count_mismatch` (состав экспорта не сошёлся с числом страниц PDF), `page_index_out_of_range` (страница экспорта за пределами оригинала), `page_output_empty` (заголовок страницы без содержимого), `text_split` (длинный текст блока сохранён частями). Предупреждение `text_truncated` больше не выдаётся: усечения нет.
- **Доказательство не теряет текст (R04-06).** Текст длиннее `maxFragmentChars` разбивается детерминированно — по границе строки, иначе по кодовой точке (суррогатная пара не рвётся), — на части с ключами `<ключ>#p1…#pN`, полями `partIndex`/`partTotal` и собственным `text_sha256`. Склейка частей по порядку возвращает исходный текст. Превышение общего бюджета `maxTotalTextChars` по-прежнему даёт явный `too_large`.
- **Комплект экспорта (R04-08).** PDF и его metadata приходят одним набором с общим именем (`A.pdf`, `A_blocks.json`, `A_results.md`, `A_results.html`). Ключ комплекта — путь члена без суффикса роли; `_blocks.json` и `_results.md` берутся только из комплекта того PDF, чей SHA-256 совпал с редакцией. Metadata чужого комплекта — отказ `export_group_mismatch`: проверка SHA-256 покрывает PDF, но не принадлежность разбора этому PDF. Если файла роли в архиве нет вовсе, причина прежняя и точнее — `blocks_json_missing` / `results_md_missing`. Следствие, названное явно: архив, не следующий этому соглашению имён, принят не будет — сверять такой экспорт нужно скриптом `rdweb-inspect`.
- **Неоднозначный комплект отклоняется (R04-08).** После выбора комплекта у каждой обязательной роли должен быть ровно один кандидат. Совпало по SHA-256 несколько PDF архива или в комплекте несколько `_blocks.json` (`_results.md`) — отказ `export_group_ambiguous`. Выбор «по наибольшему совпадению имени» или по порядку членов архива здесь недопустим: это молчаливое решение за инженера, а доказательство должно быть объяснимым.
- **Координаты не подправляются (R04-09).** Значение вне `[0,1]` означает, что пространство экспорта не то, за которое мы его принимаем. Такой `bbox`/`polygon` отбрасывается целиком с предупреждением `coords_out_of_range`, текст фрагмента сохраняется, страница открывается без выделения. Обрезка превратила бы ошибку источника в правдоподобную, но ложную область оригинала.
- **Страница фрагмента существует (R04-10).** Блок или секция, ссылающиеся на страницу за пределами оригинала, сохраняются без `pageIndex` и с предупреждением `page_index_out_of_range`: ложной ссылки на несуществующую страницу не остаётся.
- **Предел числа страниц — по оригиналу (R04-11).** `maxPages` сверяется с `expect.pdfPageCount` до построения страниц и фрагментов, а не с длиной `pages[]` в экспорте; превышение — `too_large`.
- **Ресурсный контур архива — на стороне worker (R04-01).** `readRdwebArchive` применяет те же ограничения, что и обычный импорт: число элементов, размер элемента, суммарный распакованный объём (по фактически прочитанным байтам), коэффициент сжатия и отдельный бюджет памяти для буферизуемых metadata-файлов. Повтор имени элемента — отказ `archive_corrupt`, а не молчаливая подмена кандидата.

`RdwebApiClient` на этапе 04 **не реализуется**: объём этапа сужен владельцем до импорта экспортного архива, API RDWeb не подтверждён (Q-02) и остаётся `BLOCKED_EXTERNAL` по X-05.

## 4. Локальная модель (эмбеддинги и переранжирование)

После D-013 внешнего адаптера индекса нет: Locus закрыт, индекс и поиск живут в портале (ADR-012). Наружу обращается только шлюз модели — за векторами и, при необходимости, за переранжированием. Реализация вызывается из worker заданием класса `gpu` (ADR-004, ADR-009 §6).

```ts
interface ModelGatewayEmbeddings {         // портал, локальный провайдер
  embed(input: {
    texts: string[];                       // пачка ограниченного размера
    purpose: 'index' | 'query';
  }): Promise<AdapterResult<{ vectors: Float32Array[]; model: string; modelVersion: string; dim: number }>>;

  rerank?(input: {                         // необязателен; сервис не заводится до замеров (ADR-012 §16)
    query: string;
    candidates: Array<{ id: string; text: string }>;
  }): Promise<AdapterResult<Array<{ id: string; score: number }>>>;

  status(): Promise<AdapterResult<{ available: boolean; model: string; modelVersion: string; dim: number }>>;
}
```

- Провайдер локальный по умолчанию (ADR-009 §5); удалённый маршрут не реализуется (D-013). Автоматического облачного запасного пути нет.
- Область поиска строит сервер портала из снимка `evidence_scope` и прав пользователя; шлюз модели её не видит и не может расширить. Тексты передаются как данные, системные инструкции задаёт сервер (I16).
- Размерность и имя модели пишутся в версию индекса: смена модели даёт новую версию, поскольку прежние векторы несопоставимы (ADR-012 §5).
- **Конкретный провайдер этапа 05 (ADR-012 §25, AR05-10):** HTTP-клиент OpenAI-совместимого `/v1/embeddings` локального сервера модели; адрес — только loopback или LAN из настройки, облачного запасного пути нет. Поддельный детерминированный провайдер остаётся для тестов конвейера и не заменяет конкретный.
- **Размерность проверяется до записи:** длина каждого вектора равна `dim`, заявленной провайдером; `dim` равна `embedding_dim` версии индекса; `dim` не больше 4000 (предел хранения `halfvec` при `STORAGE PLAIN`, ADR-012 §6). Нарушение — `dimension_mismatch`, в БД ничего не пишется.
- **Отпечаток модели:** хэш имени модели, размерности и ревизии из настройки плюс пробный вектор фиксированной строки. `status()` сравнивает новый пробный вектор с сохранённым в версии индекса (косинус ≥ 0,999); расхождение — `model_fingerprint_mismatch`, смысловая ветка недоступна до новой версии.
- **Реализация (этап 05):** `packages/adapters/src/embeddings/` — `OpenAiCompatibleEmbeddings` (порядок векторов по полю `index`, классы отказов: 401/403 — `AUTH_FAILED` без повтора, 429 и 5xx — повторяемые, таймаут — `TIMEOUT_UNKNOWN_OUTCOME`, соединение отклонено — `UNAVAILABLE`; ключ только в заголовке, в сообщениях его нет), `FakeEmbeddings` (хэш-мешок слов, управляемые отказы). Каждый отказ несёт причину деградации смысловой ветки (`model_unavailable`, `dimension_mismatch`, `semantic_failed`).
- **Вход модели версионируется:** шаблон входа (префикс `query`/`passage`, нормализация, обрезка) — `embedding_input_version`; он входит в ключ кеша эмбеддингов вместе с назначением (`index`/`query`), моделью, отпечатком и размерностью (ADR-012 §9).
- Недоступность модели даёт признак недоступности смысловой ветки с причиной; точный и полнотекстовый поиск продолжают работать, тихого перехода к поиску по всему индексу нет (A42).
- Недоступность переранжирования сохраняет прежний порядок кандидатов и помечает ответ явным признаком, никогда молча.
- Для машины без GPU предусмотрен детерминированный поддельный провайдер (псевдовектор от хэша текста): он проверяет конвейер, фильтр области и проверку цитат, но не качество, и так и помечается (U-08).

Контракт `LocalAiIndex` (`upsertFragments` / `search` / `status`) удалён вместе с блокировками X-04 и Q-13: индексация и поиск стали внутренними операциями портала, а не вызовом соседней системы.


## 5. MailHub (переписка)

Факт (`docs/discovery.md` §6): `/api/v1`, cookie-сессия человека и CSRF, общая лента скрывает отправленные, цепочка отдаётся одной страницей до 200 писем, `POST /messages/{id}/opened` меняет прочитанность, в ответе нет Message-ID и хэшей вложений, ACL по ящикам.

```ts
interface MailHubReader {                        // проект, X-03
  listMailboxes(): Promise<AdapterResult<Array<{ id: string; address: string }>>>;
  listChanges(input: { cursor: string | null; limit: number }): Promise<AdapterResult<{
    items: Array<{ externalItemId: string; changeKind: 'created' | 'updated' | 'moved' | 'attachment_changed' }>;
    nextCursor: string;
  }>>;
  getMessage(externalItemId: string): Promise<AdapterResult<MailMessage>>;   // Message-ID, In-Reply-To, References, направление, папка, UTC
  getThread(threadId: string, cursor: string | null): Promise<AdapterResult<{ items: MailMessage[]; nextCursor: string | null }>>;
  getAttachment(attachmentId: string): Promise<AdapterResult<{ blob: BlobRef; sha256: string; filename: string }>>;
}

interface EmlImporter {                          // факт: работает без доработок MailHub
  importEml(file: BlobRef, mailboxHint?: string): Promise<AdapterResult<CommunicationImport>>;
}
```

- Адаптер не вызывает `opened`, не перемещает письма и не создаёт черновики.
- Отсутствие письма в общей ленте не доказывает отсутствие отправки (A33): отправленные читаются отдельным путём, а при его отсутствии основание регистрируется вручную.
- Ограничения ACL ящиков сохраняются в портале (ADR-006 §10).

## 6. Сервис переговоров

Проект (Q-06). До ответа владельца поддерживается импорт manifest.

```ts
interface NegotiationImporter {                  // проект
  importManifest(input: {
    manifest: {
      sessionId: string; tenderHint?: string; startedAt: string;
      participants: Array<{ speakerLabel: string; name?: string; side?: 'customer' | 'contractor' | 'unknown' }>;
      audio?: { ref: string; sha256?: string };
      transcript: { revision: number; segments: Array<{ no: number; speakerLabel: string; startMs: number; endMs: number; kind: 'speech' | 'hint'; text: string }> };
    };
    files: BlobRef[];
  }): Promise<AdapterResult<NegotiationImport>>;
}
```

Подсказка участнику и реплика — разные `kind`; подсказка не становится позицией заказчика (I08, A03).

## 7. Назначения размещения

```ts
interface DeliveryTarget {                       // проект контракта портала; детали API — этап 14
  prepare(release: { id: string; manifest: Manifest }): Promise<AdapterResult<{ stagingRef: string }>>;
  putFile(stagingRef: string, file: { path: string; blob: BlobRef; sha256: string }): Promise<AdapterResult<{ remoteFingerprint?: string }>>;
  commit(stagingRef: string): Promise<AdapterResult<{ committedAt: string }>>;
  verify(release: { id: string; manifest: Manifest }): Promise<AdapterResult<Array<{ path: string; state: 'verified' | 'mismatch' | 'absent'; remoteFingerprint?: string }>>>;
  inspectExisting(path: string): Promise<AdapterResult<{ exists: boolean; remoteFingerprint?: string }>>;
}
```

- Реализации: `YandexDiskTarget` (API и способ сверки содержимого уточняются по официальной документации на этапе 14), `SmbTarget` (UNC-путь, служебная учётная запись).
- Адаптер получает корень и политику только из закреплённой `delivery_destination_version` доставки, а не из текущей настройки назначения (R01-05).
- Загружаются точные байты файлов кандидата; повторная генерация запрещена (I02).
- Существующий файл с другим отпечатком — `CONFLICT`, без перезаписи (A30).
- Публичные ссылки не создаются; внутренние материалы размещаются только если это разрешено настройкой назначения.

## 8. Шлюз модели

```ts
interface ModelGateway {                         // проект; провайдер и API — этап 08
  complete<T>(input: {
    task: 'requirement_extraction' | 'discrepancy_hypothesis' | 'change_reason' | 'field_draft' | 'question_draft';
    promptVersion: string;
    evidence: Array<{ fragmentId: string; text: string; origin: string }>;
    schema: JsonSchema;                        // ответ обязан пройти схему
    limits: { maxOutputTokens: number; timeoutMs: number };
  }): Promise<AdapterResult<{ value: T; citedFragmentIds: string[]; modelRef: string; promptHash: string }>>;
}
```

Ответ отклоняется, если он не проходит схему или ссылается на фрагмент вне области (ADR-009 §2).

## 9. Сводка статусов на этап 01

| Адаптер | Статус | Что нужно для следующего шага |
|---|---|---|
| `TenderHubReader` (`TenderHubApiSource` + `PortalCaptureStrategy`) | VERIFIED_FIXTURE (этап 06) | contract-тесты против поддельного HTTP-сервера TenderHub (`scripts/tenderhub-fake.ts`, `tests/tenderhubAdapter.test.ts`, `tests/calculation*.test.ts`); live-smoke — после ключа `tenders:read` и разрешённого тендера (U-04) |
| `TenderHubRevisionReader` | BLOCKED_EXTERNAL | X-01; на этапе 06 — только интерфейс проекта и фикстурные тесты доменной модели |
| `RdwebExportImporter` | VERIFIED_FIXTURE (этап 04) | разрешённый live-smoke на настоящем экспорте (`scripts/rdweb-inspect.ts`) |
| `RdwebApiClient` | BLOCKED_EXTERNAL | X-05 |
| `ModelGatewayEmbeddings` | VERIFIED_FIXTURE (этап 05) | `OpenAiCompatibleEmbeddings` проверен контрактными тестами против поддельного HTTP-сервера (`tests/embeddings.test.ts`), `FakeEmbeddings` — в тестах конвейера; живой прогон с моделью — `NOT_RUN` до целевого ПК |
| `MailHubReader` | BLOCKED_EXTERNAL | X-03 |
| `EmlImporter` | NOT_IMPLEMENTED | реализация этапа 07 |
| `NegotiationImporter` | NOT_IMPLEMENTED | схема manifest, затем Q-06 |
| `YandexDiskTarget`, `SmbTarget` | NOT_IMPLEMENTED | тестовые корни и учётные данные (Q-10) |
| `ModelGateway` | NOT_IMPLEMENTED | выбор провайдера на этапе 08 |
