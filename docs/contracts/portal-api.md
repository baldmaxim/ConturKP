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
| Идемпотентность | команды, создающие записи или запускающие внешние действия, принимают `Idempotency-Key` |
| Пагинация | курсор `cursor` + `limit`; ответ содержит `nextCursor` и признак `hasMore` |
| Область | ресурсы тендера доступны только участникам; иначе `404` (ADR-006) |
| Аудит | каждая команда и каждый отказ пишут `audit_event` |

Коды ошибок (`code`): `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PRECONDITION_REQUIRED`, `VERSION_CONFLICT`, `STATE_CONFLICT`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`, `BLOCKER_PRESENT`, `INTEGRATION_UNAVAILABLE`, `INTEGRATION_BLOCKED`, `RATE_LIMITED`, `INTERNAL`.

Ответ `BLOCKER_PRESENT` содержит список блокеров с кодами из матрицы (`state-machines.md` §11.1), классом и пояснением.

## 2. Команды и чтение

Колонка «Право» — возможность из ADR-006. Колонка «Ключи» — `If-Match` (IM) и `Idempotency-Key` (IK).

### 2.1. Доступ и справочники

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /auth/login`, `POST /auth/logout` | — | — | вход и выход |
| `GET /me` | — | — | пользователь, роли, назначения, возможности |
| `POST /me/api-tokens`, `DELETE /me/api-tokens/{id}` | `mcp.propose` | IK | выпуск и отзыв MCP-токена; секрет показывается один раз |
| `GET /settings`, `PUT /settings/{key}` | `admin.settings` | IM | часовой пояс отображения, политика внешней обработки |
| `GET /integrations/status` | `tender.read` | — | статусы интеграций и время последней проверки |
| `GET /health`, `GET /ready` | — | — | эксплуатация (ADR-011) |

### 2.2. Тендеры, этапы, участники

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /tenders`, `POST /tenders` | `tender.read` / `admin.tender` | IK | список и создание |
| `GET /tenders/{id}`, `PATCH /tenders/{id}` | `tender.read` / `admin.tender` | IM | карточка |
| `PUT /tenders/{id}/members/{userId}`, `DELETE …` | `admin.tender` | IM | назначения; не более двух инженеров |
| `GET /tenders/{id}/stages`, `POST /tenders/{id}/stages` | `tender.read` / `admin.tender` | IK | этапы |
| `PUT /stages/{id}/calculation-source` | `admin.tender` | IM | связь с версией тендера TenderHub (Q-03) |

### 2.3. Источники и набор источников

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /stages/{id}/imports` | `source.write` | IK | загрузка файлов или архива; создаёт `import_batch` и задания |
| `GET /imports/{id}` | `tender.read` | — | состав партии, отклонённые элементы с причинами |
| `GET /stages/{id}/documents`, `GET /documents/{id}` | `tender.read` | — | документы и редакции |
| `PATCH /documents/{id}` | `source.write` | IM | тип, код, область применения, группировка редакций |
| `GET /document-revisions/{id}/content` | `tender.read` | — | оригинал по правам (ADR-003) |
| `GET /stages/{id}/source-sets` | `tender.read` | — | наборы и ревизии |
| `POST /source-sets/{id}/revisions` | `source.write` | IK | новая `draft`-ревизия от базовой |
| `PUT /source-set-revisions/{id}/items` | `source.write` | IM | состав `draft`-ревизии |
| `POST /source-set-revisions/{id}/freeze` | `source.write` | IM, IK | заморозка, `content_hash` |

### 2.4. Распознавание, доказательства, поиск

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /document-revisions/{id}/recognition-imports` | `source.write` | IK | импорт экспортного архива RDWeb |
| `GET /recognition-runs/{id}` | `tender.read` | — | статус, полнота, страницы |
| `GET /evidence/{fragmentId}` | `tender.read` | — | фрагмент: текст, происхождение, страница, координаты |
| `GET /evidence/{fragmentId}/preview` | `tender.read` | — | превью страницы оригинала с выделением |
| `POST /search` | `tender.read` | — | поиск по области (ADR-008); ответ содержит `scopeHash`, признаки неполноты и доступность смыслового поиска |

### 2.5. Расчёт

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `POST /stages/{id}/calculation-captures` | `calculation.capture` | IK | запрос выгрузки из TenderHub |
| `GET /calculation-captures/{id}` | `tender.read` | — | статус и результат сверки до/после |
| `GET /calculation-revisions/{id}` | `tender.read` | — | шапка ревизии, вид (`provisional`/`verified`), итог, курсы |
| `GET /calculation-revisions/{id}/positions`, `…/lines` | `tender.read` | — | позиции и строки (пагинация) |
| `POST /calculation-revisions/{id}/lineage` | `calculation.capture` | IM | подтверждение сопоставления позиций между ревизиями |

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
| `POST /stages/{id}/review-runs`, `GET /review-runs/{id}` | `review.run` / `tender.read` | IK | запуск проверки и результаты с охватом |
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
| `POST /stages/{id}/release-candidates` | `candidate.create` | IK | сборка кандидата из закреплённых входов |
| `GET /release-candidates/{id}` | `tender.read` | — | состав, манифест, файлы, блокеры |
| `GET /candidate-files/{id}/content` | `tender.read` | — | просмотр именно того файла, который согласуется |
| `POST /release-candidates/{id}/approve` | `candidate.approve` | IM, IK | согласование руководителем |
| `POST /release-candidates/{id}/return` | `candidate.approve` | IM, IK | возврат на доработку с причиной |
| `POST /approvals/{id}/revoke` | `candidate.approve` | IM, IK | отзыв согласования до выпуска |
| `POST /release-candidates/{id}/release` | `candidate.release` | IM, IK | выпуск назначенным инженером |
| `GET /stages/{id}/holds`, `POST /holds/{id}/resolve` | `tender.read` / `hold.resolve` | IM, IK | удержания готовности (I04) |
| `GET /releases/{id}`, `GET /releases/{id}/manifest` | `tender.read` | — | выпуск и манифест |

### 2.10. Размещение, отправка, сравнение

| Метод и путь | Право | Ключи | Назначение |
|---|---|---|---|
| `GET /releases/{id}/deliveries` | `tender.read` | — | состояние по каждому назначению |
| `POST /deliveries/{id}/retry` | `delivery.manage` | IM, IK | повтор одного назначения |
| `POST /deliveries/{id}/resolve-conflict` | `delivery.manage` | IM, IK | решение по конфликту имени и хэша |
| `POST /releases/{id}/send-events` | `send.register` | IK | регистрация отправки с основанием |
| `POST /send-events/{id}/verify` | `send.register` | IM, IK | сверка состава вложений с манифестом |
| `POST /comparisons`, `GET /comparisons/{id}` | `tender.read` | IK | сравнение двух выпусков |
| `POST /change-explanations/{id}/confirm` | `finding.write` | IM, IK | подтверждение причины изменения человеком |
| `GET /tenders/{id}/audit-events` | `audit.read` | — | журнал действий |

## 3. Правила ответов

1. Любой ответ с суммой содержит валюту, признак НДС и вид цены. Несопоставимые величины помечаются `incomparable` с причиной.
2. Любой ответ проверки содержит охват: число документов, страниц, распознанных страниц, недоступные источники. При неполноте — признак `incomplete`, а не «пройдено» (I18).
3. Любая ссылка на доказательство — стабильный ID фрагмента портала плюс документ, редакция, страница, координаты.
4. Отсутствие данных различается: `not_found_in_scope`, `not_provided`, `no_data`, `incomplete_processing`, `confirmed_discrepancy` (I07).
5. Ответ на чтение исторического выпуска строится только из его закреплённых входов; поздние документы не попадают (I05).
