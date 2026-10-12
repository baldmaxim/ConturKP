# Этап 15a — аудит сохранённых ответов команд (S15-14)

Дата: 2026-10-12. Основание — решение владельца D-036 (`docs/reviews/15-owner-decisions.md`) и Review 15-2 (`docs/reviews/15-review-2.md`, раздел «Решения владельца и остаточные задачи»). Ветка `stage-15a` от `main` = `9e57f44` (этап 15 принят по `fd41a4a`). Отдельного задания в `docs/spec/prompts/` у этапа нет: объём задан ревью и D-036.

Этот документ — проект до кода. Миграций этап не добавляет.

## 0. Границы

Входит:
- инвентаризация всех команд с ключом идемпотентности и чувствительных полей их ответов (§2);
- исправление общего механизма: сохранённый ответ не отдаётся после изменения прав (§3);
- записи идемпотентности, созданные до обновления (§3.3);
- исполняемые доказательства на командах с закрытым текстом в ответе (§5);
- сохранение защиты от второго выполнения и от коллизии ключей (§3.4).

Не входит:
- этап 16 (MCP) — после этого этапа;
- S15-08 — решения владельца нет;
- изменение прав, ролей, представлений чтения и состава ответов команд;
- блокеры боевого выпуска Q-01/X-01, Q-05, Q-08 — сохраняются;
- реальные интеграции: этап их не касается. Все проверки — на поддельных данных.

## 1. Дефект

Обёртка команд (`apps/server/src/http/command.ts`): `authorize` → запись идемпотентности по ключу → при совпадении хэша запроса сохранённое тело ответа отдаётся без `run`. `authorize` проверяет право на команду и область объекта (R02-01). Права на содержимое, попавшее в ответ (письмо, договор, фрагмент-основание, причина решения), проверяет `run` и представление ответа — при повторе они не выполняются.

Следствие (R15-01, класс S15-14): пользователь выполнил команду, получив в ответе текст, который тогда читал; право отозвали; повтор с тем же ключом возвращает тот же текст. Чтение тем же пользователем этот текст уже скрывает.

Этап 15 исправил четыре команды механизмом `replay` (ответ строится заново по текущим правам). Остальные команды сохраняют тело целиком.

## 2. Инвентаризация

Таблица — §7 (заполняется по коду до исправления; классы: A — в ответе нет текста, зависящего от прав; B — есть, но то же право проверяет `authorize`; C — есть, право проверяет только `run` или представление).

Вывод инвентаризации для выбора решения: команд много, состав ответов меняется с каждым этапом, класс команды — свойство её представления, а не обёртки. Исправление по одной команде оставляет дефект для каждой новой команды, автор которой забудет `replay`. Нужна защита в самой обёртке, действующая по умолчанию.

## 3. Решение — сохранённый ответ привязан к правам

### 3.1. Отпечаток прав

`accessFingerprint(ctx)` (`packages/db/src/access.ts`) — SHA-256 от нормализованного снимка прав пользователя: роли, действующие назначения на тендеры (тендер → роль), выдачи по договорам, глобальная выдача `contract.create`, выдачи по почтовым ящикам. Это весь `IAccessContext`, кроме личности и номера запроса: других источников прав у сервера нет. Контекст загружается заново на каждый запрос.

### 3.2. Запись и повтор

- При первом выполнении в записи идемпотентности рядом с телом ответа сохраняется отпечаток прав (`access`).
- При повторе с тем же ключом и тем же запросом, после `authorize`:
  - отпечаток записи равен текущему — сохранённый ответ отдаётся, как раньше (`Idempotent-Replayed: true`);
  - отпечаток другой — `409 STATE_CONFLICT`, `current.reason = replay_unavailable`: команда уже выполнена, сохранённый ответ недоступен, объект нужно перечитать. `run` не выполняется, второй записи нет, тела ответа в отказе нет.
- Команды с `replay` (этап 15) не меняются: они строят ответ заново по текущим правам и от отпечатка не зависят.

Отказ вместо ограниченного представления: обёртка не знает, как построить представление каждой команды; чтение объекта уже делает это правильно. Review 15-1 допускает оба варианта.

Отказ при любом изменении прав, в том числе при расширении: сравнение «права не уменьшились» потребовало бы хранить и сопоставлять сам снимок; выигрыш мал — повтор нужен при обрыве связи, сразу после первого запроса. Цена ложного отказа — одно перечитывание объекта.

### 3.3. Записи, созданные до обновления

У записи без отпечатка права первого выполнения неизвестны: сохранённое тело не отдаётся — тот же отказ `replay_unavailable`. Срок жизни записи — 7 дней; после обновления установки повторы команд, выполненных до него, получают отказ, а не старое тело. Миграции нет: отпечаток хранится в JSON записи.

### 3.4. Что сохраняется

- Второго выполнения нет: запись найдена — `run` не вызывается при любом исходе сравнения.
- Ключ с другим запросом — `422 IDEMPOTENCY_KEY_REUSED`, как раньше (проверка — до сравнения отпечатков).
- Запись — своя у каждого пользователя: чужой ключ ничего не находит.
- Параллельные повторы сериализуются блокировкой ключа, как раньше.
- `authorize` выполняется до всего: отзыв роли или назначения даёт `403` / `404`, как раньше (R02-01).

### 3.5. Чего решение не закрывает

- Закрытость, изменившаяся без изменения прав пользователя (к объекту добавили основание из закрытого для него источника): отпечаток прежний, сохранённый ответ отдаётся. В нём только то, что пользователь уже получил законно при первом выполнении; нового закрытого текста в нём нет. Это не отзыв права и в объём аудита не входит.
- Текст в самой записи идемпотентности в БД: он там остаётся до истечения срока. Доступа к таблице у пользователей нет; те же данные лежат в основных таблицах.

## 4. Изменения

| Что | Где |
|---|---|
| отпечаток прав | `packages/db/src/access.ts` — `accessFingerprint` |
| сохранение отпечатка, сравнение при повторе, отказ | `apps/server/src/http/command.ts` |
| отклонение гипотезы только при читаемых основаниях (S15a-01) | `apps/server/src/routes/discrepancies.ts` |
| контракт | `docs/contracts/portal-api.md` §1 (идемпотентность), ошибки `replay_unavailable`, `restricted_fragments` у отклонения гипотезы |
| интерфейс | повтор запроса клиентом после `409 replay_unavailable` не нужен: сообщение об ошибке предлагает обновить данные |

Представления, права и миграции не меняются; из маршрутов меняется один — отклонение гипотезы (§7.1).

## 5. Проверки

Файл `tests/replayAccess.test.ts`, данные поддельные:

1. Повтор без изменения прав — тот же ответ, `Idempotent-Replayed: true`, одна запись (контроль).
2. Отзыв `mail.read` после команды, в ответе которой текст письма, — повтор: `409 replay_unavailable`, текста письма в ответе нет, второй записи нет; до исправления тест падает.
3. Сценарий — `assumption.create` (№ 78 инвентаризации): допущение по требованию, закрытому вместе с договором-основанием; отзывается доступ к договору. Отзыв `mail.read` меняет тот же отпечаток прав и проверяется расширением и сужением выдач по ящику.
4. Снятие назначения и роли — `403` / `404` от `authorize` (контроль R02-01).
5. Запись без отпечатка (создана до обновления) — `409 replay_unavailable`.
6. Расширение прав — тоже `409 replay_unavailable` (зафиксированное поведение §3.2).
7. Ключ с другим запросом — `422`; тот же ключ у другого пользователя — своя запись.
8. Команды этапа 15 с `replay` — прежнее поведение (`tests/reviewRegressions15.test.ts`).
9. `accessFingerprint`: не зависит от порядка, меняется от каждого вида права.

Файл `tests/suggestionRejectAccess.test.ts` (S15a-01): чтение прогона закрывает гипотезу тому, кто не читает письмо-основание; отклонение им — `409 restricted_fragments`, гипотеза остаётся открытой; читающий основания отклоняет как раньше.

Плюс полный набор, typecheck, build, smoke, проверка интерфейса 15 и регрессия интерфейса 02–14.

## 6. Риски

| Риск | Мера |
|---|---|
| ложный отказ повтора после несвязанного изменения прав | редкое совпадение по времени; отказ безопасен и объясняет, что делать |
| существующие тесты опираются на повтор после изменения прав | полный набор; такие тесты правятся только если они закрепляли дефект |
| новая команда с закрытым текстом в ответе | защищена по умолчанию; `replay` — улучшение удобства, а не условие безопасности |

## 7. Инвентаризация команд

Снято по коду `9e57f44` чтением маршрутов (два независимых прохода, без запуска). Объявлений `idempotent: true` — 79, маршрутов — 82: два объявления в цикле «требование / факт» дают по два маршрута, одно объявление импорта обслуживает два маршрута. Вне `routes/` объявлений нет; `http/upload.ts` только проверяет наличие заголовка.

Итог по маршрутам: **A — 31, B — 21, C — 26, с `replay` — 4.**

- **A** — в ответе ID, статусы, счётчики или повтор собственного ввода: отзыв права ничего не раскрывает.
- **B** — в ответе есть текст, зависящий от прав, но то же право проверяет `authorize`: повтор после отзыва получает `403` / `404`.
- **C** — в ответе есть текст, зависящий от прав, а право проверяет только `run` или представление: до исправления повтор после отзыва возвращал сохранённый текст.
- Команда с `replay` строит ответ заново.

Чувствительные поля класса C:

| Команды | Что возвращал повтор | Право, отзыв которого важен |
|---|---|---|
| карточка комплекта (№ 2–6, 8, 52) | названия приложений и вложений, пути файлов, пункты блокеров, причины принятия рисков, причины решений по удержаниям, комментарий согласования | `mail.read`, `contract.read` на основания закреплённых значений; видимость предмета решения |
| диалог (№ 25) | прежние ответы, утверждения, цитаты, названия документов и темы писем | `mail.read`, `contract.read` в контексте тендера |
| замечания и разногласия (№ 26–29, 69–71) | название, описание, текст фрагментов-оснований, значения фактов, причины событий, решения | `mail.read`, `contract.read`; закрытость требования и вопроса |
| гипотеза модели (№ 30) | текст и обоснование гипотезы | читаемость фрагментов-оснований |
| снимок источников (№ 34) | названия документов договора, темы и даты писем | `contract.read`, `mail.read` |
| кандидаты и карточка требования (№ 56–63) | формулировка, параметры, обоснование, текст оснований, решения, допущения, вопросы и ответы | `contract.read`, `mail.read`; замыкание закрытости этапа 08 |
| допущение (№ 78) | текст оснований, код требования | то же |

Класс определён чтением кода; исполняемое доказательство — на `assumption.create` (№ 78, названа в Review 15-2) и на № 30. Остальные команды класса C проходят через ту же обёртку: исправление §3 действует на них одинаково, отдельного теста на каждую нет.

### 7.1. Найдено инвентаризацией — S15a-01

`POST /model-suggestions/:id/reject` (№ 30) отвечал `suggestionView(…, true)`: текст и обоснование гипотезы отдавались тому, кто не читает её основания, уже в первом ответе, а не только при повторе. Проверки читаемости оснований не было ни в `authorize`, ни в `run`; чтение прогона те же поля закрывает. Попутно пользователь решал по гипотезе, которую не мог прочитать (нарушение правила R08-02).

Исправление: отклонение требует, чтобы все фрагменты-основания гипотезы читались, иначе `409 restricted_fragments` — тот же код, что у замечания с закрытыми основаниями. Принятие гипотезы уже было защищено: созданное замечание проверяется на видимость, отказ откатывает транзакцию.

На границе, не дефект: `POST /holds/:id/resolve` (№ 7) строит ответ без маски, но видимость предмета события проверяет `run` до записи; в ответе — собственная причина и имена элементов импорта тендера.

### 7.2. Полная таблица

| № | Маршрут (`apps/server/src/routes/`) | Действие | `authorize` проверяет | Тело ответа | Класс |
|---|---|---|---|---|---|
| 1 | `admin.ts` POST /admin/users | admin.user.create | `admin.users` | пользователь: свой ввод | A |
| 2 | `approvals.ts` POST /release-candidates/:id/risk-acceptances | release.risk.accept | tender.read + `risk.accept` | карточка комплекта целиком | **C** |
| 3 | `approvals.ts` POST /release-candidates/:id/approve | release.candidate.approve | tender.read + `candidate.approve` | карточка комплекта | **C** |
| 4 | `approvals.ts` POST /release-candidates/:id/return | release.candidate.return | то же | карточка комплекта | **C** |
| 5 | `approvals.ts` POST /approvals/:id/revoke | release.approval.revoke | то же | карточка комплекта | **C** |
| 6 | `approvals.ts` POST /release-candidates/:id/release | release.candidate.release | tender.read + `candidate.release` | карточка комплекта с выпуском | **C** |
| 7 | `approvals.ts` POST /holds/:id/resolve | release.hold.resolve | tender.read + `hold.resolve` | удержание: своя причина, имена элементов импорта | A (на границе) |
| 8 | `approvals.ts` POST /release-candidates/:id/holds/resolve | release.hold.resolve | то же | карточка комплекта | **C** |
| 9 | `calculations.ts` POST /stages/:id/calculation-captures | calculation.capture.request | этап + `calculation.capture` | ID, статус | A |
| 10 | `communications.ts` POST /tenders/:id/qa-imports | qa.import | tender.read + `source.write` | ID, счётчики | A |
| 11 | `communications.ts` POST /tenders/:id/negotiation-imports | negotiation.import | то же | ID, признаки | A |
| 12 | `contractDocuments.ts` POST /contracts/:id/documents | contract.document.upload | `contract.read` + `contract.manage` | документ договора | B |
| 13 | `contractDocuments.ts` POST /contract-documents/:id/revisions | contract.document.upload | то же | документ договора | B |
| 14 | `contractLinks.ts` POST /contracts/:id/tenders | contract.tender.link | `contract.link` + `source.write` | связь: номер договора, тендер | B |
| 15 | `contracts.ts` POST /contracts | contract.create | выдача `contract.create` | договор: свой ввод | A |
| 16 | `deliveries.ts` POST /delivery-destinations | delivery.destination.create | `admin.delivery` | назначение: свой ввод | A |
| 17 | `deliveries.ts` POST /delivery-destinations/:id/versions | delivery.destination.version | `admin.delivery` | версии назначения, пути | B |
| 18 | `deliveries.ts` POST /delivery-destinations/:id/probe | delivery.destination.probe | `admin.delivery` | то же | B |
| 19 | `deliveries.ts` POST /releases/:id/deliveries | delivery.place | видимый выпуск + `delivery.manage` | доставки: пути, ошибки | B |
| 20–23 | `deliveries.ts` POST /deliveries/:id/retry, /resolve-conflict, /redirect, /confirm-cloud | delivery.* | то же | доставка | B |
| 24 | `dialogs.ts` POST /dialogs | dialog.create | контекст поиска | новый диалог: свой ввод | A |
| 25 | `dialogs.ts` POST /dialogs/:id/messages | answer.request | свой диалог + право на контекст | диалог: прежние ответы, цитаты, названия документов и темы писем | **C** |
| 26 | `discrepancies.ts` POST /findings/:id/discrepancy | discrepancy.create | тендер + `finding.write` | замечание целиком | **C** |
| 27 | `discrepancies.ts` POST /discrepancies/:id/status-events | discrepancy.axis | то же | замечание целиком | **C** |
| 28 | `discrepancies.ts` POST /discrepancies/:id/decisions | discrepancy.decision | тендер + `requirement.decide` | замечание целиком | **C** |
| 29 | `discrepancies.ts` POST /model-suggestions/:id/accept | model_suggestion.accept | тендер + `finding.write` | новое замечание | **C** |
| 30 | `discrepancies.ts` POST /model-suggestions/:id/reject | model_suggestion.reject | то же | гипотеза: текст, обоснование — **без проверки оснований и в первом ответе (S15a-01)** | **C** |
| 31 | `discrepancies.ts` POST /tenders/:id/source-priority | source_priority.update | тендер + `source_priority.manage` | приоритет источников | B |
| 32 | `economics.ts` POST /stages/:id/comparisons | economics.comparison.create | этап + `economics.compare` | ID, итоги | A |
| 33 | `economics.ts` POST /comparisons/:id/reason-runs | economics.reason_run.request | то же | ID, статус | A |
| 34 | `evidenceScopes.ts` POST /stages/:id/evidence-scopes | evidence.scope.create | этап + `source.write` | снимок: названия документов договора, темы писем | **C** |
| 35 | `facts.ts` POST /evidence-facts/:id/decisions | fact.decision | право чтения владельца факта + право решения | граф факта | B |
| 36 | `formDrafts.ts` POST /stages/:id/application-drafts | forms.draft.create | этап + `application.fill` | черновик приложения | B |
| 37 | `formSuggestions.ts` POST /application-drafts/:id/suggestion-runs | forms.suggestion_run.request | черновик + `application.fill` | ID, статус | A |
| 38 | `formTemplates.ts` POST /application-templates | forms.template.create | `template.manage` | шаблон: свой ввод | A |
| 39 | `formTemplates.ts` POST /application-templates/:id/revisions | forms.template_revision.create | шаблон читается + управление | ревизия шаблона | B |
| 40 | `formTemplates.ts` POST /form-samples | forms.sample.upload | управление шаблонами | свой файл | A |
| 41 | `formTemplates.ts` POST /approved-wordings | forms.wording.propose | право предложить | формулировка: свой ввод | A |
| 42 | `formTemplates.ts` POST /approved-wordings/:id/versions | forms.wording.propose | формулировка читается | формулировка | B |
| 43 | `imports.ts` POST /stages/:id/imports | source.import.accept | этап + `source.write` | ID, счётчики | A |
| 44 | `imports.ts` POST /import-items/:id/resolve | source.import_item.resolve | элемент импорта тендера + право | элемент импорта | B |
| 45 | `intake.ts` POST /tenders/:id/intake-channels | intake.channel.create | `admin.intake` | канал: свой ввод | A |
| 46 | `localRecognition.ts` POST /document-revisions/:id/local-recognitions | recognition.local.request | редакция читается + право записи | ID, статус | A |
| 47 | `mailMessages.ts` POST /mail-messages/:id/tender-links | mail.tender.link | `mail.read` + `mail.link` + `source.write` | связь без содержимого письма | B |
| 48 | `mailMessages.ts` POST /mail-messages/:id/tender-links/:tenderId/unlink | mail.tender.unlink | то же | то же | B |
| 49 | `mailboxes.ts` POST /mailboxes | mailbox.create | `admin.mailbox` | ящик: свой ввод | A |
| 50 | `mailboxes.ts` POST /mailboxes/:id/imports | mail.import | ящик + `mail.import` | импорт: свой ввод | A |
| 51 | `recognition.ts` POST /document-revisions/:id/recognition-imports | recognition.import.accept | редакция читается + право записи | прогон распознавания | B |
| 52 | `releaseCandidates.ts` POST /stages/:id/release-candidates | release.candidate.create | этап + `candidate.create` | карточка нового комплекта: названия приложений и вложений | **C** |
| 53 | `releaseCandidates.ts` POST /standard-attachments | release.attachment.create | `template.manage` | свой ввод | A |
| 54 | `releaseCandidates.ts` POST /standard-attachments/:id/revisions | release.attachment.revision.create | то же | вложение | B |
| 55 | `releaseComparisons.ts` POST /tenders/:id/release-comparisons | release.comparison.create | tender.read + `economics.compare` | сравнение; ответ строится заново | `replay` |
| 56 | `requirementCandidates.ts` POST /requirement-registries/:id/requirement-candidates | requirement.candidate.create | реестр + `requirement.create` | кандидат: текст фрагментов-оснований | **C** |
| 57 | `requirementCandidates.ts` POST /requirement-registries/:id/fact-candidates | fact.candidate.create | реестр + `fact.create` | кандидат: текст оснований | **C** |
| 58 | `requirementCandidates.ts` POST /requirement-candidates/:id/confirm | requirement.candidate.confirm | кандидат + `requirement.confirm` | кандидат: формулировка, обоснование, основания | **C** |
| 59 | `requirementCandidates.ts` POST /fact-candidates/:id/confirm | fact.candidate.confirm | кандидат + `fact.confirm` | то же | **C** |
| 60 | `requirementCandidates.ts` POST /requirement-candidates/:id/rebase | requirement.candidate.rebase | кандидат + `requirement.create` | новый кандидат | **C** |
| 61 | `requirementCandidates.ts` POST /fact-candidates/:id/rebase | fact.candidate.rebase | кандидат + `fact.create` | новый кандидат | **C** |
| 62 | `requirementItems.ts` POST /requirement-revisions/:id/coverage | requirement.coverage.record | редакция + `requirement.confirm` | карточка требования целиком | **C** |
| 63 | `requirementItems.ts` POST /requirements/:id/decisions | requirement.decision.record | требование + `requirement.decide` | карточка требования целиком | **C** |
| 64 | `requirementRegistries.ts` POST /stages/:id/requirement-registries | requirement.registry.create | этап + `requirement.manage` | реестр: свой ввод | A |
| 65 | `requirementRegistries.ts` POST /requirement-registries/:id/marks | requirement.registry.mark | реестр + `requirement.create` | ID, счётчики | A |
| 66 | `requirementRegistries.ts` POST /requirement-registries/:id/reviews | requirement.registry.review.complete | реестр + `requirement.manage` | ID, счётчики | A |
| 67 | `requirementRegistries.ts` POST /requirement-registries/:id/analysis-runs | analysis.run.request | реестр + `analysis.run` | ID, статус | A |
| 68 | `reviews.ts` POST /stages/:id/review-runs | review.run.request | этап + `review.run` | ID, статус | A |
| 69 | `reviews.ts` POST /stages/:id/findings | finding.create | этап + `finding.write` | замечание: текст оснований | **C** |
| 70 | `reviews.ts` POST /findings/:id/transitions | finding.transition | замечание + `finding.write` | замечание целиком | **C** |
| 71 | `reviews.ts` PATCH /findings/:id | finding.update | то же | замечание целиком | **C** |
| 72 | `sends.ts` POST /releases/:id/send-evidence | send.evidence.upload | видимый выпуск + `send.register` | свой файл | A |
| 73 | `sends.ts` POST /releases/:id/send-events | send.register | то же | отправка; ответ строится заново | `replay` |
| 74 | `sends.ts` POST /send-events/:id/accept-extras | send.accept_extras | видимый выпуск + `send.accept_extras` | отправка; ответ строится заново | `replay` |
| 75 | `sends.ts` POST /releases/:id/compliance-incidents | send.incident.register | видимый выпуск + `send.register` | нарушение; ответ строится заново | `replay` |
| 76 | `sourceSets.ts` POST /stages/:id/source-set-revisions | source.set.revision.create | этап + `source.write` | ID, хэш | A |
| 77 | `sourceSets.ts` POST /source-set-revisions/:id/freeze | source.set.freeze | то же | ревизия набора без названий закрытых источников | B |
| 78 | `stageRecords.ts` POST /stages/:id/assumptions | assumption.create | этап + `requirement.create` | допущение: текст оснований, код требования | **C** |
| 79 | `stageRecords.ts` POST /stages/:id/customer-questions | customer_question.create | то же | вопрос: свой ввод | A |
| 80 | `stageRecords.ts` POST /stages/:id/notes | stage_note.create | то же | заметка: свой ввод | A |
| 81 | `stages.ts` POST /tenders/:id/stages | stage.create | тендер + `stage.manage` | этап: свой ввод | A |
| 82 | `tenders.ts` POST /tenders | tender.create | `admin.tender` | тендер: свой ввод | A |
