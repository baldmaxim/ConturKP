# Этап 06 — TenderHub: этапы и закрытые расчёты

Дата: 2026-09-28
Статус передачи: **IMPLEMENTED_AWAITING_U04 / PRE-REVIEW**. Реализация завершена и проверена на фикстурах; live-smoke не выполнялся — ключа TenderHub и разрешённого тендера нет (U-04). К приёмке (`READY_FOR_ACCEPTANCE`) этап не заявляется: без live-smoke он не может быть принят (решение владельца «GO Stage 06»).
Базовый коммит: `25a64bbeaee9ba6abd5a454cb4facf9b19247085` (ветка `stage-05`: этап 05 принят ревью 05-2 и закрыт)
Ветка: `stage-06`, создана от базового коммита.
Проверяемый коммит: HEAD ветки `stage-06` — коммит документов и артефактов, следующий за коммитом кода `d1fd0e185b04ecd1692874c330846c59d3e49bc3`; отчёт входит в HEAD, поэтому его хэш указан в сообщении передачи и в комментарии ZIP.
Рабочее дерево: чистое; не в Git по `.gitignore` — `node_modules/`, `apps/web/dist/`, `runtime/`; по `.git/info/exclude` — архивы передачи `ConturKP-stage-*.zip` и HTML-копии страниц передачи `ConturKP-*.html` в корне.
Задание: `docs/spec/prompts/stage-06.md` и решение владельца «GO Stage 06» (2026-09-28): D-016 без прямого транспорта; X-01, Q-01, Q-05, U-04 открыты; Q-03 не блокирует. Этапы 06a, 10, 13, 15 не начинались.
Среда: Ubuntu 26.04.1, Node 24.14.1; PostgreSQL 18.6 с pgvector 0.8.6 в контейнере `kontur-pg` на `127.0.0.1:55432` (как на этапе 05); Chromium headless shell (Playwright) через CDP без песочницы.

## Результат для пользователя

На странице этапа появилась вкладка «Расчёт». Администратор, назначенный на тендер, связывает этап с тендером TenderHub (uuid версии тендера). Участник нажимает «Выгрузить расчёт»: `worker` в фоне читает TenderHub по официальному API и показывает состояние выгрузки — «Выгрузка идёт», «Выгружено», «Данные менялись» (TenderHub менялся во время чтения, ложной ревизии нет) или «Выгрузка не удалась» с понятной причиной (ключ отклонён, нет доступа к тендеру, лимит запросов, сбой сети). Успешная выгрузка даёт неизменяемую ревизию расчёта с позициями ВОР и строками сметы: разделы показаны как разделы, пустые и дополнительные позиции видны, комплексный материал привязан к работе, числа — без потери точности. Ревизия помечена **предварительной (provisional)**: TenderHub не отдаёт закрытую ревизию (X-01), поэтому боевой выпуск с ней заблокирован, а итог КП портал не выводит — правило итога не задано (Q-05). Повторная выгрузка без изменений новой ревизии не создаёт; изменение в TenderHub даёт новую ревизию, прежняя остаётся как была.

## Решение владельца «GO Stage 06» — как выполнено

| Пункт решения | Реализация | Статус |
|---|---|---|
| D-016: официальный API по `X-API-Key`, один доменный адаптер с возможностью второго транспорта; прямое чтение БД сейчас не реализуется; Bearer не использовать | `packages/adapters/src/tenderhub/`: интерфейс `ITenderHubSource` с полем `transport`, реализация `TenderHubApiSource`; заголовок `Authorization` не отправляется никогда; второй транспорт не писался, D-016 не отменён | выполнено |
| X-01 открыт: `portal_capture` → `provisional`; боевой выпуск блокируется `CALCULATION_PROVISIONAL` без обходов; не имитировать `verified`, `closed_at_source`, событие закрытия | выгрузка портала даёт только `provisional`; `calculationProductionBlockers` без параметров отключения; `TenderHubRevisionReader` — интерфейс проекта со статусом `BLOCKED_EXTERNAL`; `verified` и события закрытия создаются только в контрактных тестах на фикстурах, продуктового пути нет | выполнено |
| Q-01 открыт: «закрытый расчёт» не изобретать | `provisional` + сверка согласованности; срок подачи — только сигнал выгрузки | выполнено |
| Q-05 открыт: хранить все составляющие и значения источника, итогом КП ничего не объявлять, `kp_total_rule` не заполнять, недоступность правила видна в данных, API и UI | `kp_total`/`kp_total_rule` пусты (CHECK: итог без правила непредставим), `kp_total_semantics.status = rule_not_set`; API `kpTotal`; уведомление Q-05 на вкладке | выполнено |
| Q-03 не блокирует: обе схемы «этап ↔ версия» | основная и справочные связи этапа, один тендер TenderHub может быть связан с несколькими этапами | выполнено |
| U-04: без ключа — `VERIFIED_FIXTURE`, не `VERIFIED_LIVE`; без live-smoke этап не принимается; при отсутствии U-04 — `IMPLEMENTED_AWAITING_U04` и pre-review | статус интеграции `VERIFIED_FIXTURE`, live — `NOT_RUN`; подготовлен и проверен на подделке сценарий live-smoke `npm run tenderhub:live-smoke` | выполнено; live-smoke ждёт U-04 |
| Нормативный объём: промпт этапа 06, ADR-007, ADR-005 (часть этапа 06), `contracts/adapters.md`, data-model §4.5, state-machines §6, portal-api, RT-04, A07, I01–I19; без 06a/10/13/15 | см. «Объём» и «Проверка критериев» | выполнено |

## Объём

Реализовано:

| Область | Файлы | Содержание |
|---|---|---|
| Миграция | `docs/migrations/0011_calculation.sql` | `stage_calculation_source` (один `primary` на этап, связь неизменна по этапу и внешнему id, не удаляется), `external_ref` (номер тендера TenderHub — одному тендеру портала), `calculation_capture` (frozen-after, журнал попыток только дописывается, одна активная выгрузка на пару «этап — тендер TenderHub», `complete` только со связью с последней ревизией того же содержимого), `calculation_content` (+ `calculation_position`, `calculation_line`: состав вставляется только транзакцией создания, хэш пересчитывает БД функцией `calculation_content_hash()`, итог КП без правила непредставим), `calculation_revision` (линейный `seq`, `supersedes` — последняя ревизия того же тендера, `verified` ⇔ внешняя ссылка, повтор содержимого последней `provisional` новой ревизии не создаёт), `calculation_revision_status_event` (только у `verified`, допустимые переходы), `position_lineage` (append-only, позиции своих ревизий); `integration_status` компонента `TenderHubRevisionReader` = `BLOCKED_EXTERNAL` (X-01); права ролей |
| Ядро | `packages/core/src/calculation.ts`, `capabilities.ts` | каноническая десятичная запись (= `trim_scale(numeric)::text`), текст и хэш содержимого, `KP_TOTAL_RULE_NOT_SET`, `calculationProductionBlockers`; возможность `calculation.capture` |
| Адаптер | `packages/adapters/src/tenderhub/` | `TenderHubHttpClient` (только GET, `X-API-Key`, gzip, `no-cache`, собственный лимит, 429 без Retry-After, пределы ответа и времени, редирект — ошибка, классы ошибок), разбор чисел без float (`lexeme.ts`), проверка строк по контракту с отчётом отсутствующих полей (`schema.ts`), `TenderHubApiSource` (все страницы курсора), `runPortalCapture` (сверка до/после и между маршрутами, нормализация), интерфейс проекта `ITenderHubRevisionReader` |
| Слой данных | `packages/db/src/calculationCaptures.ts`, `calculationContent.ts`, `calculationRevisions.ts`; `stageEvents.ts` | связи этапа, выгрузки и попытки, статус интеграции, выгрузка по сроку; содержимое одной командой, ревизии по правилам R01-04/R01-08, событие барьера `calculation_revision_added`, сверка агрегатов в SQL `numeric`, завершение выгрузки одной транзакцией; `recordSourceRevision`/`recordRevisionStatus` — доменные правила X-01 для контрактных тестов; чтение ревизий, позиций, строк с курсорами; lineage |
| Worker | `apps/worker/src/handlers/calculation.ts`, `handlers/index.ts`, `runtime.ts` | задание `calculation.capture` (класс `network`): чтение TenderHub вне транзакции, сырые ответы и манифест в хранилище по SHA-256, попытки в журнал, `inconsistent` → повтор, терминальный исход `inconsistent`/`failed`; планировщик выгрузки по сроку подачи |
| API | `apps/server/src/routes/calculations.ts`, `calculationMappers.ts`, `app.ts` | `GET/PUT /stages/{id}/calculation-source`, `POST/GET /stages/{id}/calculation-captures`, `GET /calculation-captures/{id}`, `GET /stages/{id}/calculation-revisions`, `GET /calculation-revisions/{id}`, `…/positions`, `…/lines`, `GET/POST …/lineage`; аудит, `Idempotency-Key`, `If-Match`, правила ошибок |
| Контракты и конфигурация | `packages/contracts/src/index.ts`, `packages/config/src/index.ts`, `.env.example` | схемы запросов и курсоров; `TENDERHUB_URL` (https или loopback), `TENDERHUB_API_KEY` (секрет), `TENDERHUB_TIMEOUT_SECONDS`, `TENDERHUB_RATE_LIMIT_PER_MINUTE`, `TENDERHUB_MAX_RESPONSE_MB`, `TENDERHUB_CAPTURE_ATTEMPTS`; в `.env.example` — только имена |
| Интерфейс | `apps/web/src/pages/calculation/`, `api/calculationEndpoints.ts`, `api/calculationTypes.ts`, `utils/calculationLabels.ts`, правки `StagePage.tsx`, `Icon.tsx` | вкладка «Расчёт»: связь этапа, выгрузки и их состояния с причинами, ревизии, блокировка X-01, недоступность Q-05, закрытие у источника «недоступно до X-01», позиции и строки с догрузкой страниц |
| Скрипты | `scripts/tenderhub-fake.ts`, `tenderhub-fake-data.ts`, `tenderhub-live-smoke.ts`, правка `smoke.mjs`, `package.json` | поддельный TenderHub по контракту (сырые лексемы, gzip, курсор, отказы, живая спецификация); сценарий live-smoke для U-04; шаги этапа 06 в smoke |
| Проверки | `tests/calculationCapture.test.ts`, `calculationFailures.test.ts`, `calculationSchema.test.ts`, `calculationCore.test.ts`, `calculationMigration.test.ts`, `tenderhubAdapter.test.ts`, `tenderhubLiveSmoke.test.ts`, `calculationFixtures.ts`; правки `tests/helpers.ts`, `tests/core.test.ts`; `artifacts/stage-06/ui-check.mjs` | 62 новых теста в 7 файлах; ui-check этапа |

Документы: ADR-004 (строка приоритета), ADR-005, ADR-006, ADR-007 — разделы «Реализация (этап 06)»; `data-model.md` §4.2, §4.5, §5; `state-machines.md` §6, §11.1; `contracts/adapters.md` §2, §9; `contracts/portal-api.md` §2.2, §2.5; `integrations/status.md`; `architecture/unknowns.md` §5; `requirements-traceability.md` (I01, I10, I13, I14, I17, I18, I19, F06); `runbooks/clean-start.md`.

Не реализовано (по плану и решению владельца, не отложено молча):

- **Прямое чтение БД TenderHub** — второй транспорт D-016; доступ не подтверждён. Отсутствие дефектом не является.
- **`TenderHubRevisionReader`** — у TenderHub нет маршрутов неизменяемой ревизии, статуса закрытия и ленты изменений (X-01): `BLOCKED_EXTERNAL`.
- **Итог КП и его правило** — Q-05; составляющие страхования, снижения и перераспределения API по ключу не отдаёт.
- **Автоматическое сопоставление позиций** между ревизиями — этап 10; на этапе 06 — хранение и решения человека.
- **Команды кандидата, согласования и выпуска** — этапы 12–13: блокер `CALCULATION_PROVISIONAL` реализован функцией ядра и полем API, проверять его будут эти команды.
- **MCP-инструмент `capture_calculation`** — этап 16.
- **Live-smoke** — U-04.

## Проверка критериев

| Критерий / инвариант | Реализация | Доказательство | Статус |
|---|---|---|---|
| Официальный API read-only по `X-API-Key`, не Bearer | `TenderHubHttpClient`: только GET, заголовок `X-API-Key`, `Authorization` не отправляется | `tenderhubAdapter.test.ts` (заголовки); `calculationCapture.test.ts` (все запросы выгрузки); smoke: «только GET с X-API-Key, без Authorization» | PASS (fixture) |
| Тендеры, этапы/версии, ВОР, строки, примечания, иерархия, коммерческие значения, внешние ID | `brief` (номер, версия, срок), `overview`, `positions` (раздел, категория), `with-costs` (суммы), `boq-items-full` (строки, справочники, родительская работа); внешние ID позиций и строк, `external_ref` | `calculationCapture.test.ts`: `sourceObserved`, позиции и строки через API | PASS (fixture) |
| Пагинация, лимиты, gzip, кэш with-costs | курсор до конца, повтор курсора — отказ; собственный лимит; 429 → ожидание окна; `Accept-Encoding: gzip`; `Cache-Control: no-cache` | `calculationCapture.test.ts` (4 позиции при странице 2 — две страницы), `tenderhubAdapter.test.ts` (лимит, 429, gzip, зацикленный курсор) | PASS (fixture) |
| Закрытие TenderHub — единственный источник события закрытия; второго механизма нет | событие закрытия — только `calculation_revision_status_event` у `verified`; срок подачи — сигнал выгрузки (`trigger = deadline`), ревизия остаётся `provisional` | `calculationSchema.test.ts` (события только у `verified`), `calculationFailures.test.ts` (выгрузка по сроку) | PASS |
| Собственная выгрузка не выдаётся за атомарный снимок; `provisional` не проходит production gate | `portal_capture` → только `provisional`; `CALCULATION_PROVISIONAL` без отключения | `calculationCore.test.ts`, `calculationCapture.test.ts` (`productionGate`), smoke, ui-check | PASS |
| Сырой ответ и нормализованные данные с версиями контракта | тела ответов после gzip и манифест выгрузки в `blob` по SHA-256; `contract_version`, `normalization_version`; исходные лексемы в `raw_lexemes` | `calculationCapture.test.ts`: манифест, тело с лексемой цены, ключа нет | PASS |
| Раздел — не работа; категория позиции — не категория строки; `manual_volume` без семантики | `is_section`; `cost_category_name` позиции хранится отдельно, строка — своя категория; `manualVolume.semantics = unconfirmed` | `calculationCapture.test.ts` («позиции: раздел — не работа…»), ui-check | PASS |
| Lineage позиций между этапами хранится | `position_lineage` + API решений человека | `calculationSchema.test.ts` (If-Match, append-only, позиции своих ревизий, чужой тендер — нет) | PASS (хранение; сопоставление — 10) |
| Пустая / дополнительная позиция | сохраняются, видны с отметками | `calculationCapture.test.ts`, ui-check | PASS |
| Комплексная строка | `parent_work_external_item_id` материала к работе | `calculationCapture.test.ts`, ui-check | PASS |
| Много страниц | все страницы курсора; одна страница — не расчёт | `calculationCapture.test.ts`; `calculationFailures.test.ts` (обрыв на второй странице) | PASS |
| 401 / 403 / 429 | классы ошибок, 401 и 403 — без повторов, 429 — ожидание окна, затем повтор задания | `calculationFailures.test.ts` (401 обоих видов, 403 область и тендер, 404, 429 кратковременный и затяжной, 503 `ENDPOINT_DISABLED`, прочие 5xx, не JSON) | PASS (fixture) |
| Сбой сети после частичной загрузки | попытка `failed`, ревизии нет, повтор задания | `calculationFailures.test.ts` («обрыв на второй странице позиций») | PASS |
| Изменение во время выгрузки | признаки до/после, согласованность маршрутов, строки новее начала выгрузки → `inconsistent`, повтор; ложной ревизии нет | `calculationFailures.test.ts` (4 сценария), ui-check | PASS |
| Повторная выгрузка | идемпотентна относительно последней ревизии, события барьера нет | `calculationCapture.test.ts` | PASS |
| Расхождение агрегатов | сверка в SQL с допуском 0.01, показывается и не подгоняется | `calculationFailures.test.ts`, `calculationCapture.test.ts` | PASS |
| Повторное событие закрытия; новая ревизия после открытия | на фикстуре контракта X-01: повтор статуса не пишется, переоткрытие, новая ревизия не меняет прежнюю | `calculationSchema.test.ts` («закрытие — событие…») | PASS (fixture до X-01) |
| RT-04: одинаковые строки с разными курсами; одинаковые строки с разным итогом; одинаковый итог с разными строками; повтор; `verified` с содержимым `provisional`; A → B → A → повтор | правила R01-04/R01-08 в коде и в триггерах БД | `calculationCapture.test.ts` (блок «идентичность ревизии», 6 тестов), `calculationSchema.test.ts` (2 теста), `calculationCore.test.ts` (хэш) | PASS |
| A07: изменение после выгрузки — новая ревизия, прежняя не меняется, влияние показано | новая `calculation_revision` + событие `calculation_revision_added` | `calculationCapture.test.ts` («A07 / RT-04…») | PASS |
| `provisional` не становится `verified` | запись ревизии неизменна; `verified` без внешней ревизии непредставима (CHECK) | `calculationCapture.test.ts`, `calculationSchema.test.ts` | PASS |
| Точность 15+ значащих цифр: ответ → разбор → домен → БД → API | лексема через `JSON.parse` с исходным текстом, `numeric`, `::text` | `calculationCapture.test.ts` (21 цифра), `calculationCore.test.ts` (сверка с PostgreSQL), `calculationSchema.test.ts` (хэш БД = хэш приложения), smoke, ui-check | PASS |
| Инварианты в БД | триггеры и CHECK по образцу R05-01 | `calculationSchema.test.ts` (11 тестов, в т. ч. `kontur_app` и владелец таблиц) | PASS |
| Миграции с чистой БД и обновление со схемы этапа 05 | 0011 применяется к пустой базе и к базе этапа 05 с данными | smoke (`db:migrate` — 11 миграций), `calculationMigration.test.ts` (0010 → 0011 с данными этапов 02–05) | PASS |
| Секреты (I17) | ключ только в окружении и заголовке | `calculationFailures.test.ts`, `tenderhubLiveSmoke.test.ts`, smoke («журналы процессов без секретов»), ui-check | PASS |
| Права и конкуренция (I13, I14) | `calculation.capture`, `admin.tender`; `If-Match`, `Idempotency-Key`, одна активная выгрузка | `calculationCapture.test.ts` (403/404/428/412/409) | PASS |
| Интерфейс: состояния, X-01, Q-05, смартфоны, темы | вкладка «Расчёт» | ui-check: 26 шагов, 390 и 360 px, подписи кнопок не обрезаны, тёмная тема 1280 px, консоль и CSP без ошибок | PASS |
| Live-smoke на разрешённом тендере | сценарий `scripts/tenderhub-live-smoke.ts` | проверен только на подделке (`tenderhubLiveSmoke.test.ts`) | NOT_RUN (U-04) |

## Фактически выполненные проверки

Все журналы в `artifacts/stage-06/` получены на коде коммита `d1fd0e1` (после него менялись только документы и журналы).

| Команда / сценарий | Среда и данные | Exit/result | Артефакт |
|---|---|---|---|
| `npx vitest run --reporter=verbose --maxWorkers=1 --fileParallelism=false` | Linux, PostgreSQL 18.6 + pgvector 0.8.6, отдельная БД на файл тестов, синтетические данные и поддельный TenderHub | 0 — 39 файлов, 388 тестов (326 прежних + 62 новых) | `artifacts/stage-06/vitest.log` |
| `npm run typecheck` | корень и `apps/web` | 0 | `artifacts/stage-06/typecheck.log` |
| `npm run build` | Vite 8, PWA | 0 | `artifacts/stage-06/build.log` |
| `SMOKE_STAGE=stage-06 npm run smoke` | настоящие `server` + `worker`, отдельная БД, поддельный TenderHub с ключом-маркером | 0 — 32 шага PASS (6 новых: связь этапа, выгрузка worker'ом → `provisional`, X-01, Q-05, 21 знак через API, только GET с `X-API-Key`); схема версии 11 | `artifacts/stage-06/smoke.log` |
| `CHROME_NO_SANDBOX=1 node artifacts/stage-06/ui-check.mjs` | Chromium headless, настоящие процессы, поддельный TenderHub; 390, 360, 1280 px | 0 — 26 шагов PASS | `artifacts/stage-06/ui-check.log` |
| `node artifacts/stage-05/ui-check.mjs` (регрессия) | то же, `CHROME_NO_SANDBOX=1` | 0 — 19 шагов PASS; принятый журнал этапа 05 не перезаписан | `artifacts/stage-06/ui-check-stage05-regression.log` |
| `node artifacts/stage-04/ui-check.mjs` (регрессия) | `EDGE_PATH` — обёртка Chromium с `--no-sandbox`; заголовок журнала — фиксированный текст скрипта этапа 04 | 0 — 29 шагов PASS; журнал этапа 04 не перезаписан | `artifacts/stage-06/ui-check-stage04-regression.log` |
| `node artifacts/stage-03/ui-check.mjs` (регрессия) | то же | 0 — 15 шагов PASS | `artifacts/stage-06/ui-check-stage03-regression.log` |
| `node artifacts/stage-02/ui-check.mjs` (регрессия) | то же | 0 — 12 шагов PASS | `artifacts/stage-06/ui-check-stage02-regression.log` |
| `npm run tenderhub:live-smoke -- --tender <uuid>` | настоящий TenderHub | NOT_RUN: ключа и разрешённого тендера нет (U-04) | — |

## Интеграции

| Сервис | Статус | Ограничение |
|---|---|---|
| TenderHub — чтение расчёта (`TenderHubReader`: `TenderHubApiSource` + `PortalCaptureStrategy`) | `VERIFIED_FIXTURE` | проверен против поддельного HTTP-сервера по контракту архива API от 2026-09-02; live-smoke — `NOT_RUN` до U-04; `VERIFIED_LIVE` не заявляется |
| TenderHub — ревизия, закрытие, лента изменений (`TenderHubRevisionReader`) | `BLOCKED_EXTERNAL` | X-01: у TenderHub нет таких маршрутов; только интерфейс проекта и контрактные тесты доменной модели |
| TenderHub — прямое чтение БД (второй транспорт D-016) | `NOT_IMPLEMENTED` | доступ не подтверждён; по решению владельца сейчас не реализуется |

## Непроверенное

- **Живой TenderHub.** Ни один запрос к настоящему TenderHub не выполнялся. Поведение развёрнутой сборки (состав полей, формат `submission_deadline`, `updated_at` шапки, лимиты, коды ошибок, gzip) известно только по документации архива API (R-06). После U-04: `npm run tenderhub:live-smoke -- --tender <uuid>`; журнал покажет расхождения спецификации и ответов.
- **Эвристика `updated_at` шапки.** По исходникам TenderHub (discovery §4.2) шапка может отдавать `COALESCE(updated_at, NOW())`; признак исключается из сравнения, только если оба чтения совпали с заголовком `Date` своего ответа в пределах 2 с. На живой сборке не проверено; при ложных `inconsistent` это первое место для сверки.
- **Часы источника.** Проверка «строка изменена после начала выгрузки» опирается на заголовок `Date` TenderHub (секундная точность) и `updated_at` строк; при расхождении часов сервера приложения и БД TenderHub возможны ложные `inconsistent` (не ложные ревизии).
- **Объём данных.** Проверено на синтетических тендерах до десятков позиций. Маршруты `with-costs` и `boq-items-full` отдают весь тендер без страниц: память worker и предел ответа (512 МБ по умолчанию) на тендере из десятков тысяч строк не мерялись.
- **Вид цены, НДС и валюта сумм** — Q-05: суммы отдаются с `currency: UNKNOWN` и `vat: unknown`, валюта подтверждена только у цены единицы строки.
- **Смартфоны** — headless Chromium на 390 и 360 px; реальные iOS Safari и Android Chrome — этап 17.

Нельзя делать выводы: что адаптер работает с продуктивной сборкой TenderHub; что ревизия расчёта «закрыта» или «согласована»; что какой-либо показатель является итогом КП.

## Решения и отклонения

Решений владельца этап не изобретал; технический выбор — в пределах ADR и решения «GO Stage 06».

- **Отличия от проекта этапа 01** (записаны в `data-model.md` §4.5): `component_totals` отдельной колонкой не заведён — составляющие хранятся на уровне позиций и строк, недоступные перечислены в `kp_total_semantics`; курсы — без даты (TenderHub её не отдаёт, дата не выдумывается); колонка `idempotency_key` у выгрузки не нужна (повтор гасят `idempotency_record` команды и `dedupe_key` задания).
- **Идентичность тендера во внешней системе** — номер `tender_number` (общий для версий), а не uuid версии: версия тендера в TenderHub — отдельная строка (discovery §4.2).
- **Выгрузка по сроку подачи** (state-machines §6, ADR-007 §7) — один раз после наблюдённого `submission_deadline`, если TenderHub настроен; закрытием не является.
- **Параметры по умолчанию:** собственный лимит 100 запросов в минуту (у ключа — 120), 3 попытки выгрузки, таймаут 300 с, предел ответа 512 МБ, допуск сверки агрегатов 0.01 (записывается в результат, ADR-005 §7).
- **Хэш содержимого** — построчный канонический текст `kontur.calculation_content.v1`; БД пересчитывает его сама и не фиксирует содержимое при расхождении (по образцу R05-01).
- **Сериализация по строке этапа** (`lockTenderStages`) вместо `SELECT … FOR UPDATE` на неизменяемых таблицах: роль приложения не имеет на них `UPDATE`.
- **Разбор чисел** — `JSON.parse` с исходным текстом числа (ADR-005 §2, «Реализация (этап 06)»).
- **Сценарий live-smoke подготовлен заранее** и проверен на подделке, чтобы после U-04 запускался проверенный код, а не написанный в спешке.

## Риски и блокировки

| ID | Влияние | Ответственный | Условие снятия |
|---|---|---|---|
| U-04 | этап 06 не может быть принят без live-smoke | владелец процесса | выданы ключ `tenders:read` и разрешённый тендер; выполнен `npm run tenderhub:live-smoke` с журналом без секретов; ревью журнала |
| X-01 | боевой выпуск с расчётом невозможен (`CALCULATION_PROVISIONAL`) | владелец TenderHub | TenderHub отдаёт неизменяемую ревизию, статус закрытия и ленту изменений; реализуется `TenderHubRevisionReader` |
| Q-01 | нет определения «закрытого расчёта» | владелец процесса + владелец TenderHub | ответ владельца; до него — `provisional` |
| Q-05 | итог КП не выводится; экономика этапа 10 | владелец процесса + владелец TenderHub | правило итога; заполняется `kp_total_rule` |
| R-06 | контракт адаптера может расходиться с развёрнутой сборкой | разработчик | live-smoke сверяет OpenAPI сборки и поля ответов |
| Эвристика `updated_at` и часы источника | ложные `inconsistent` (ложных ревизий нет) | разработчик | наблюдение на live-smoke; при необходимости — уточнение признаков сверки |

Блокировок для pre-review нет. Для приёмки — U-04.

## Передача независимому ревьюеру

Проверяемый коммит — HEAD ветки `stage-06`; хэш указан в сообщении передачи и в комментарии ZIP. Ветка от `25a64bb`.

| Коммит | Содержание |
|---|---|
| `d1fd0e185b04ecd1692874c330846c59d3e49bc3` | код этапа: миграция 0011, адаптер TenderHub, слой данных, задание worker, API, вкладка «Расчёт», тесты, поддельный TenderHub, сценарий live-smoke |
| HEAD передачи | документы (отчёт, ADR, модель данных, машины состояний, контракты, статус интеграций, трассировка, состояние проекта) и журналы проверок `artifacts/stage-06/` |

Что просмотреть в первую очередь:

1. `docs/migrations/0011_calculation.sql` — вторая линия: печать содержимого и пересчёт хэша в БД, линейность ревизий, `complete` только со связью с последней ревизией, события статуса только у `verified`, lineage.
2. `packages/adapters/src/tenderhub/capture.ts` и `http.ts` — признаки согласованности, классы ошибок, повторы только там, где разрешено.
3. `packages/db/src/calculationContent.ts` (`completePortalCapture`, `findOrCreateContent`, `reconcileAggregates`) и `apps/worker/src/handlers/calculation.ts` — транзакционные границы, попытки, терминальные исходы.
4. `tests/calculationCapture.test.ts`, `calculationFailures.test.ts`, `calculationSchema.test.ts` — RT-04, A07, отказы, изменения во время выгрузки, инварианты БД.

Команды воспроизведения:

```bash
npx vitest run --maxWorkers=1 --fileParallelism=false
npm run typecheck && npm run build
SMOKE_STAGE=stage-06 npm run smoke
CHROME_NO_SANDBOX=1 node artifacts/stage-06/ui-check.mjs
# после U-04, только с разрешённым тендером:
npm run tenderhub:live-smoke -- --tender <uuid>
```

Остаточные вопросы ревьюеру: достаточно ли набора признаков согласованности до X-01 (шапка до/после, маршруты между собой, `items_count`, `updated_at` строк относительно начала выгрузки); приемлемо ли исключение `updated_at` шапки по совпадению с `Date`.
