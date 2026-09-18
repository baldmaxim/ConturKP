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

## 4. LocalAI (индекс и смысловой поиск)

Факт: HTTP API на loopback, общий Bearer-токен, фильтр только по источнику, ID фрагмента из пути и номера чанка (`docs/discovery.md` §5).

```ts
type SourceUnitRef =                             // единица источника (ADR-008 §1)
  | { type: 'recognition_run'; id: string; documentRevisionId: string }
  | { type: 'communication'; id: string }
  | { type: 'transcript_revision'; id: string };

interface LocalAiIndex {                         // проект, X-04
  upsertFragments(input: {
    tenderId: string;
    sourceUnit: SourceUnitRef;                   // каждый фрагмент принадлежит ровно одной единице
    fragments: Array<{ portalFragmentId: string; text: string; page?: number; kind: string }>;
  }): Promise<AdapterResult<{ indexed: number; indexVersion: string }>>;

  search(input: {
    tenderId: string;
    query: string;
    allowedSourceUnitIds: string[];              // полная область: снимок минус единицы, недоступные пользователю; фильтр до top-k
    scopeHash: string;                           // для аудита и сверки ответа
    limit: number;
  }): Promise<AdapterResult<Array<{ portalFragmentId: string; sourceUnitId: string; score: number }>>>;

  status(): Promise<AdapterResult<{ available: boolean; indexVersion: string }>>;
}
```

- `allowedSourceUnitIds` строит сервер портала из снимка `evidence_scope` и прав пользователя в момент запроса (ADR-008 §3–4). Разные прогоны распознавания одного PDF — разные единицы, поэтому поздний прогон не попадает в исторический поиск (R01-02).
- Проверка ответа: для каждого `portalFragmentId` портал по своей БД проверяет, что фрагмент существует, принадлежит указанной единице и единица входит в `allowedSourceUnitIds`. Любое несовпадение — ответ отклоняется целиком и пишется в аудит; отбрасывание отдельных строк после top-k не применяется.
- До X-04 адаптер возвращает `UNAVAILABLE` для `search`, статус интеграции — `BLOCKED_EXTERNAL`; смысловой поиск в интерфейсе честно помечен недоступным (ADR-008 §9).
- Портал не использует генерацию ответов LocalAI и `linkedContractId`.

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
| `TenderHubReader` | NOT_IMPLEMENTED | ключ `tenders:read` и разрешённый тендер (U-04) |
| `TenderHubRevisionReader` | BLOCKED_EXTERNAL | X-01 |
| `RdwebExportImporter` | NOT_IMPLEMENTED | реализация этапа 04 на обезличенной фикстуре |
| `RdwebApiClient` | BLOCKED_EXTERNAL | X-05 |
| `LocalAiIndex` | BLOCKED_EXTERNAL | X-04, ответ владельца LocalAI (Q-13) |
| `MailHubReader` | BLOCKED_EXTERNAL | X-03 |
| `EmlImporter` | NOT_IMPLEMENTED | реализация этапа 07 |
| `NegotiationImporter` | NOT_IMPLEMENTED | схема manifest, затем Q-06 |
| `YandexDiskTarget`, `SmbTarget` | NOT_IMPLEMENTED | тестовые корни и учётные данные (Q-10) |
| `ModelGateway` | NOT_IMPLEMENTED | выбор провайдера на этапе 08 |
