# Этап 02 — Рабочий каркас, БД и права

Дата: 2026-09-18
Базовый коммит: `77f9004` (ветка `stage-01`, этап 01 принят по `f8a0f20`)
Проверяемый коммит: HEAD ветки `stage-02` — коммит «Этап 02: …», содержащий этот отчёт; точный SHA — в сообщении передачи
Рабочее дерево (чистое / точный список исключений): чистое; не в Git по `.gitignore` — `node_modules/`, `apps/web/dist/`, `runtime/pg` (локальный кластер)

## Результат для пользователя

Портал запускается локально и работает с настоящей PostgreSQL. Первый администратор-руководитель создаётся командой на сервере, дальше пользователей ведёт администратор в интерфейсе. Администратор создаёт тендеры и назначает руководителя и не больше двух инженеров. Участник видит только свои тендеры. Руководитель тендера создаёт этапы, любой участник правит их название и срок подачи. Одновременная правка не теряется: второй получает конфликт с текущими значениями. Руководитель видит журнал действий по тендеру, администратор — журнал входов и управления пользователями. Интерфейс русский, работает на смартфоне и десктопе, в светлой и тёмной теме, устанавливается как PWA. Данные — синтетические демо (`npm run db:seed-demo`). Экранов других модулей нет.

## Объём

Реализовано:

| Область | Файлы | Содержание |
|---|---|---|
| Миграции | `docs/migrations/0001_access_tenders_audit.sql`, `packages/db/src/migrate.ts`, `setup.ts` | `app_user`, `user_role`, `session`, `tender`, `tender_member`, `tender_stage`, `audit_event`, `idempotency_record`, `process_heartbeat`. Роли `kontur_migrator`/`kontur_app`/`kontur_backup`. Триггер `forbid_mutation` (append-only журнал, в том числе TRUNCATE). Триггер назначений: не больше двух инженеров под блокировкой тендера, роль назначения = глобальная роль. Раннер: только вперёд, SHA-256 применённых файлов, advisory-lock, отказ `test`-режима на базе без `test` |
| Доступ | `packages/core/src/capabilities.ts`, `packages/db/src/access.ts`, `tenders.ts` | `AccessContext` читается из БД на каждый запрос. Возможности `tender.read`, `stage.write`, `stage.manage`, `audit.read`, `admin.*`. Условие области тендера в каждом запросе; чужой тендер — 404 |
| Сессии | `apps/server/src/http/security.ts`, `routes/auth.ts`, `routes/loginLimiter.ts`, `packages/core/src/password.ts` | argon2id. Cookie сессии HttpOnly + SameSite=Strict (+Secure при TLS), в БД только хэши. CSRF-токен, связанный с сессией, плюс обязательный разрешённый `Origin`. Истечение по неактивности и абсолютный срок. Отзыв при выходе, отключении, сбросе и смене пароля. Ограничение перебора |
| Команды | `apps/server/src/http/command.ts`, `routes/*.ts` | Транзакция команды. `If-Match` → 428/412 с `current`. `Idempotency-Key` с сериализацией повторов. RFC 9457 с машинным `code`. Каждая команда и каждый отказ (401/403/404/409/412/422, Origin/CSRF) пишут `audit_event` |
| Эксплуатация | `routes/health.ts`, `apps/worker/src/main.ts`, `packages/config`, `scripts/*` | `/health`, `/ready`: БД, схема, запись в хранилище, heartbeat worker. Server и worker не стартуют при расхождении схемы. `config:check` показывает только «задано / не задано». Без TLS — только loopback. `db:setup`, `db:migrate`, `bootstrap`, `db:seed-demo`, `pg:*` |
| Интерфейс | `apps/web/**` | Вход, тендеры, карточка, участники, этапы, журнал, администрирование, смена пароля. Диалоги конфликта 412. Токены BRAND.md, темы без мигания (`public/theme-init.js`, CSP без inline). PWA: `registerType: 'prompt'` и баннер обновления. Иконки генерируются из SVG (`npm run icons:generate -w @kontur/web`) |
| Тесты | `tests/*.test.ts`, `tests/helpers.ts`, `vitest.config.ts`, `scripts/smoke.mjs`, `artifacts/stage-02/ui-check.mjs` | 59 интеграционных и модульных тестов: отдельная база на файл. Сквозная проверка реальных процессов. Проверка интерфейса в Edge против настоящего сервера |

Документы: `docs/runbooks/clean-start.md`, `.env.example`, `README.md`; `docs/contracts/portal-api.md` §2.1–2.2; `docs/architecture/data-model.md` §2, §4.1, §4.12; ADR-001 и ADR-006 — разделы «Реализация (этап 02)»; все ADR — статус accepted по приёмке этапа 01; `docs/decisions.md` D-006, D-007; `docs/requirements-traceability.md`.

Не реализовано / внешние зависимости:
- Очередь заданий, источники, хранилище по SHA-256 — этап 03. Каталог хранилища на этапе 02 проверяется только на запись в `/ready`.
- События барьера актуальности (`stage_input_event`): `tender_stage.input_version` создан и не меняется до этапа 03.
- MCP-токены (`api_token`), почтовые ящики (`mailbox_access`) — этапы 07 и 16.
- Интеграции не подключались. Ключи перечислены в `config:check` только как «задано / не задано».
- Службы Windows, TLS-сертификат, целевой ПК, резервное копирование — этап 17, U-01, U-02.

## Проверка критериев

| Критерий этапа / инвариант | Реализация | Доказательство | Статус |
|---|---|---|---|
| Миграция пустой БД | раннер + `0001` | `platform.test.ts` «пустая БД мигрирует…»; `smoke.log` «db:migrate — пустая БД» и «повторный запуск без изменений» | PASS |
| Перезапуск | сессии и данные в БД; сверка схемы при старте | `platform.test.ts` «перезапуск»; `smoke.log` «перезапуск server — /ready 200», «сессия действительна» | PASS |
| Отказ неаутентифицированному | `requireAuth`, 401 + аудит | `access.test.ts` «неаутентифицированный пользователь»; `smoke.log`; `ui-check.log` «без входа открывается форма входа» | PASS |
| Инженер не получает права руководителя подменой запроса | возможности только из БД; лишние поля и заголовки игнорируются или отклоняются | `access.test.ts` «подмена роли (A25)»: поля `role`/`memberRole`/`capabilities`, заголовки `X-Role`, `X-Capabilities`; 403 и запись в журнале с требуемым правом | PASS |
| Чужой тендер недоступен | условие области в каждом запросе, 404 | `access.test.ts` «чужой тендер (A12)»: список, карточка, этапы, участники, журнал, этап по ID, изменение; ответ совпадает с несуществующим ID; `ui-check.log` «чужой тендер DEMO-002 не показан» | PASS |
| Stale edit → конфликт | `row_version`, `If-Match` | `concurrency.test.ts` «устаревшая правка»: 412 с `current`, 428 без заголовка, параллельные правки — ровно одна; `ui-check.log` «412 → диалог конфликта» | PASS |
| Аудит фиксирует автора и объект | `audit_event` в транзакции команды; отказы — отдельной записью | `concurrency.test.ts` «журнал действий»; `access.test.ts` «каждый отказ отражён…»; `auth.test.ts` CSRF/Origin | PASS |
| Защищённый bootstrap, без открытой регистрации в LAN | консольная команда; отказ при наличии администратора | `platform.test.ts` «bootstrap руководителя»; `auth.test.ts` «открытой регистрации нет»; `smoke.log` «bootstrap — повтор отклонён» (код 4) | PASS |
| Интеграционные credentials отделены от сессий | только окружение процесса, не БД и не сессии | `packages/config`; `platform.test.ts` «конфигурация»; `smoke.log` «config:check — без значений секретов», «журналы процессов без секретов» | PASS |
| health/readiness | `/health`, `/ready` | `platform.test.ts` «health / ready»: 503 без heartbeat, при недоступном хранилище и изменённой схеме | PASS |
| Проверка конфигурации без секретов | `config:check` | `platform.test.ts`; `smoke.log` | PASS |
| Isolated test DB | локальный кластер `runtime/pg`, база `kontur_kp_test_*` на файл тестов | `tests/helpers.ts`; `platform.test.ts` «база без test не мигрируется» | PASS |
| Демо-данные, инструкция чистого старта | `db:seed-demo`, `docs/runbooks/clean-start.md` | `smoke.log` «db:seed-demo», «список тендеров (демо)» | PASS |
| LAN: origin, cookie/CSRF, защищённый транспорт | `Origin` обязателен; CSRF по сессии; SameSite=Strict; без TLS — только 127.0.0.1; в production TLS обязателен; HSTS при TLS | `auth.test.ts` «CSRF и Origin», «Secure-cookie при TLS»; `platform.test.ts` «без TLS — только loopback» | PASS (локально); сертификат и имя — U-02 |
| LocalAI остаётся внутренним | портал не проксирует LocalAI; адрес и токен — только в окружении | `packages/config` (`LOCALAI_URL`, `LOCALAI_TOKEN`), маршрутов к LocalAI нет | PASS (интеграция — этап 05) |
| Без фиктивных экранов других модулей | в интерфейсе только разделы этапа 02 | `apps/web/src/pages/*` | PASS |
| I13 права на сервере, нет молчаливой перезаписи | см. выше | `access.test.ts`, `concurrency.test.ts` | PARTIAL (этап 02) |
| I14 повтор безопасен | `Idempotency-Key` | `concurrency.test.ts` «идемпотентность команд», в том числе параллельные повторы; `platform.test.ts` повтор после перезапуска | PARTIAL (команды API) |
| I17 секреты | окружение, отчёт без значений | см. выше | PARTIAL (этап 02) |
| I19 неизменяемость | две линии для `audit_event` | `concurrency.test.ts` «роль приложения не может изменить или удалить журнал» | PARTIAL (журнал) |

## Фактически выполненные проверки

| Команда / сценарий | Среда и данные | Exit/result | Артефакт |
|---|---|---|---|
| `npm run typecheck` (tsc 7.0.2 — сервер, worker, пакеты, скрипты, тесты + интерфейс) | Windows 10, Node 24.14.1 | 0 | — |
| `npx vitest run --reporter=verbose` | локальный кластер PostgreSQL 18.3 (`runtime/pg`, 127.0.0.1:55432), синтетические пользователи | 0; 5 файлов, 59 тестов | `artifacts/stage-02/vitest.log` |
| `npm run build` (Vite 8, vite-plugin-pwa) | — | 0 | `apps/web/dist` (не в Git) |
| `npm run smoke` | реальные процессы server и worker, база `kontur_kp_smoke_test`, пароль генерируется и не выводится | 0; 15 шагов PASS | `artifacts/stage-02/smoke.log` |
| `node artifacts/stage-02/ui-check.mjs` | Microsoft Edge headless, 390 и 360 px, реальные server + worker, демо-данные | 0; 12 шагов PASS | `artifacts/stage-02/ui-check.log` |
| `python artifacts/stage-01/verify_architecture.py` | документы | PASS | — |
| `python artifacts/stage-00/test_verify_discovery.py`, `python artifacts/stage-01/test_verify_architecture.py` | — | OK | — |

Отдельно интерфейс проверялся агентом разработки против mock API на ширинах 360, 390, 430, 768 и 1280 px в обеих темах. Эти скриншоты — рабочий материал, они не в Git; доказательством служит только `ui-check.log`.

## Интеграции

| Сервис | Статус | Ограничение |
|---|---|---|
| TenderHub, RDWeb, LocalAI, MailHub, переговоры, Яндекс Диск, SMB, MCP | NOT_IMPLEMENTED | не входят в этап 02; `docs/integrations/status.md` не менялся |

## Непроверенное

- Реальная установка PWA на iPhone и Android, Lighthouse Installable, Safari/iOS. Проверены только регистрация service worker на 127.0.0.1 и манифест в Edge.
- HTTPS в LAN с настоящим сертификатом: проверены только выставление Secure/HSTS и отказ конфигурации без TLS (U-02).
- Службы Windows и целевой ПК (U-01, этап 17). Проверен запуск процессами Node на машине разработки.
- Нагрузка и перебор паролей в нескольких процессах: ограничитель в памяти одного процесса server.
- Контраст цветов отдельно не пересчитывался: токены взяты из BRAND.md без изменений (BRAND §3.4).
- Шрифты Inter и JetBrains Mono не поставляются со сборкой: используется системный фолбэк, пакеты шрифтов не добавлялись.

## Решения и отклонения

- D-006: технические решения этапа. argon2 встроен в Node — это API помечен экспериментальным, формат PHC позволяет сменить реализацию. Сервер запускается из TypeScript без сборки. Администратор без назначения видит карточку и участников, но не этапы. Этапы создаёт руководитель тендера (контракт этапа 01 указывал `admin.tender`; изменено). Локальный тестовый кластер с trust только на 127.0.0.1.
- D-007: ветка `stage-02` от `stage-01`; слияние в `main` — по решению владельца.
- Добавлены `process_heartbeat` (для `/ready`) и пакет `packages/config`, которых не было в проекте этапа 01; модель и ADR-001 обновлены.
- Отклонения интерфейса от BRAND.md: шрифты — системный фолбэк; иконки Lucide перенесены SVG-разметкой (`components/Icon.tsx`) без добавления `lucide-react`; скрипт темы — файлом, не inline (из-за CSP `script-src 'self'`).
- Бизнес-требования не менялись.

## Риски и блокировки

| ID | Влияние | Ответственный | Условие снятия |
|---|---|---|---|
| U-02 | доступ из LAN только после выпуска сертификата и выбора сетевого имени | владелец | имя и способ выпуска сертификата |
| R-02-1 | `node:crypto.argon2` экспериментален в Node 24 | разработчик | при изменении API — переход на пакет `argon2` без миграции формата |
| R-02-2 | ограничитель перебора паролей хранится в памяти | разработчик | допустимо для одного процесса server (ADR-001); пересмотреть при нескольких экземплярах |

Блокировок для этапа 03 нет.

## Передача в Codex

Область ревью: diff `77f9004..stage-02`. Код — `apps/`, `packages/`, `docs/migrations/`, `scripts/`, `tests/`, `artifacts/stage-02/`; документы — перечислены в «Объёме».

Воспроизведение (Windows, Node 24, PostgreSQL ≥ 16 в PATH):

```powershell
npm ci
npm run pg:init; npm run pg:start
npm run typecheck
npm test
npm run build
npm run smoke
node artifacts/stage-02/ui-check.mjs      # нужен Microsoft Edge (EDGE_PATH)
```

Другой тестовый кластер — `KONTUR_TEST_ADMIN_URL` (суперпользователь).

Вопросы к ревью:
1. Достаточна ли граница видимости администратора (карточка и участники без содержимого) для ADR-006.
2. Приемлемо ли передача прав на создание этапов руководителю тендера вместо `admin.tender`.
3. Экспериментальный `node:crypto.argon2` против пакета `argon2`.
