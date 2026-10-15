# Установка и эксплуатация на Windows (release runbook)

Этап 17. Для администратора целевого ПК. Проект — `docs/architecture/17-operations-design.md`; копии и восстановление — `docs/runbooks/backup-restore.md`; разработка — `docs/runbooks/clean-start.md`.

Целевой ПК — Windows-ПК в офисе; сотрудники открывают портал по адресу `https://<IP ПК>:3200` (U-02, ответ владельца 2026-10-14). Значения секретов в этот документ, журналы и чат не пишутся.

## 0. Порядок

1. Осмотр ПК (§2) → решение по PostgreSQL, диску копий и учётным записям служб (D-040).
2. Каталоги, код, PostgreSQL, файл окружения, TLS, брандмауэр (§3–§8).
3. База, первый администратор (§9).
4. Службы (§10), проверка `/ready` и вкладки «Состояние».
5. Копии и расписание (§13), живые проверки и запись статусов (§15).

## 1. Требования

| Компонент | Требование |
|---|---|
| Windows | 10 или 11 x64; сон от сети отключён (иначе службы недоступны) |
| Node.js | 24.11 или новее, но не 25 (`package.json`, `engines`) |
| PostgreSQL | 17 или новее с расширениями `vector` ≥ 0.8 и `pg_trgm` (ADR-002) |
| LibreOffice | стабильная ветка, 64-бит; шрифты образцов — для всех пользователей (`docs/runbooks/libreoffice.md`) |
| mkcert | для сертификата на IP |
| WinSW | 2.12.0, файл `WinSW-x64.exe` со страницы выпуска на GitHub |
| Место | хранилище — с запасом; копии — на другом физическом диске или сетевом ресурсе |
| LM Studio (если модель на этом ПК) | сервер OpenAI-совместимого API на loopback |

## 2. Осмотр ПК

```powershell
cd D:\Kontur\app
npm ci
npm run ops:preflight -- --out D:\Kontur\preflight.json
```

Таблица проверок в консоли (`OK` / `WARN` / `FAIL` / `N/A`) и JSON без секретов и адресов. JSON передаётся разработчику: по нему выбираются способ размещения PostgreSQL, диск копий, учётные записи служб.

## 3. Каталоги

| Каталог | Назначение | Доступ |
|---|---|---|
| `D:\Kontur\app` | код (распакованный ZIP передачи) | администраторы — запись, службы — чтение |
| `D:\Kontur\config\kontur.env` | файл окружения, вне каталога кода | администраторы и учётные записи служб — чтение; больше никто |
| `D:\Kontur\storage` | хранилище оригиналов и выпусков (`STORAGE_ROOT`) | учётные записи служб — запись |
| `E:\KonturBackups` | копии (`BACKUP_ROOT`), другой диск или сетевой ресурс | учётная запись задачи копирования — запись |
| `D:\Kontur\app\logs` | журналы служб (ротация 10 МБ × 8) | службы — запись |

Буквы дисков — пример; выбираются по осмотру.

## 4. Код

1. Распаковать ZIP передачи в `D:\Kontur\app`. Комментарий архива — полный коммит сборки.
2. `npm ci`, затем `npm run build`.
3. В файл окружения — `KONTUR_BUILD=<полный коммит>`: на установке из ZIP каталога `.git` нет, а коммит нужен манифесту копий, вкладке «Состояние» и записи живых проверок.

## 5. PostgreSQL

Способ выбирается по осмотру (D-040).

**А. Нативная служба (предпочтительно, ADR-011).** Установщик PostgreSQL 18 для Windows (служба `postgresql-x64-18`). pgvector под Windows собирается из исходников: «x64 Native Tools Command Prompt» Visual Studio Build Tools, `set "PGROOT=C:\Program Files\PostgreSQL\18"`, `nmake /F Makefile.win`, `nmake /F Makefile.win install` (по README pgvector). `pg_trgm` входит в поставку. В файл окружения — `PG_BIN_DIR=C:\Program Files\PostgreSQL\18\bin` (для копий).

**Б. Контейнер Docker.** `docker run -d --name kontur-pg --restart unless-stopped -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=… -v kontur-pg-data:/var/lib/postgresql pgvector/pgvector:pg18`. Docker должен запускаться без входа пользователя; лицензия Docker Desktop для крупных компаний платная. В файл окружения — `PG_DOCKER_CONTAINER=kontur-pg`. Зависимости служб от PostgreSQL в этом случае нет (`--pg-service` не задаётся).

## 6. Файл окружения

Образец ключей прежних этапов — `.env.example`; ключи этапа 17 — в таблице ниже; назначение каждого ключа печатает `npm run config:check`. Для установки:

| Ключ | Значение |
|---|---|
| `KONTUR_ENV` | `production` |
| `DATABASE_URL`, `DATABASE_MIGRATOR_URL`, `BACKUP_DATABASE_URL` | роли `kontur_app`, `kontur_migrator`, `kontur_backup` |
| `DATABASE_ADMIN_URL`, `KONTUR_APP_DB_PASSWORD`, `KONTUR_MIGRATOR_DB_PASSWORD`, `KONTUR_BACKUP_DB_PASSWORD` | только на время `db:setup` (§9), затем удалить из файла |
| `STORAGE_ROOT`, `BACKUP_ROOT` | §3 |
| `HTTP_HOST`, `HTTP_PORT` | `0.0.0.0`, `3200` |
| `ALLOWED_ORIGINS` | `https://<IP ПК>:3200` |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | §7 |
| `MCP_ENABLED` | `true`, если нужны Codex и Cursor |
| `MODEL_*`, `EMBEDDING_*` | адрес LM Studio на loopback, имена моделей (§12) |
| `SOFFICE_PATH` | если LibreOffice не в каталоге по умолчанию |
| `TENDERHUB_URL`, `TENDERHUB_API_KEY` | ключ с минимальной областью доступа |
| `KONTUR_BUILD` | §4 |
| `PG_BIN_DIR` или `PG_DOCKER_CONTAINER` | §5 |
| `SHUTDOWN_GRACE_SECONDS` | 20 (по умолчанию) |
| `STORAGE_WARN_FREE_MB`, `STORAGE_STOP_FREE_MB` | пороги свободного места (по умолчанию 10240 и 2048) |

Проверка: `node --env-file=D:\Kontur\config\kontur.env scripts\config-check.ts` — «конфигурация корректна» и строка TLS без замечаний. Значения не печатаются.

## 7. TLS (U-02)

```powershell
mkcert -install
mkcert -cert-file D:\Kontur\config\tls\cert.pem -key-file D:\Kontur\config\tls\key.pem <IP ПК> localhost 127.0.0.1
mkcert -CAROOT
```

- `TLS_CERT_FILE` и `TLS_KEY_FILE` — эти файлы; ключ читают только администраторы и учётная запись службы server.
- Корень `rootCA.pem` из каталога `mkcert -CAROOT` ставится на устройства коллег: Windows — `certutil -addstore -f Root rootCA.pem` (от администратора); iPhone — установить профиль, затем «Настройки → Основные → Об этом устройстве → Доверие сертификатам» и включить корень; Android — «Настройки → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат ЦС».
- Закрытый ключ корня (`rootCA-key.pem`) с ПК не выносится.
- `config:check` предупреждает за 30 дней до истечения сертификата; перевыпуск — той же командой `mkcert`, затем перезапуск службы server.
- Чат-клиенты: `docs/integrations/mcp-clients.md` §1.

## 8. Брандмауэр

```powershell
New-NetFirewallRule -DisplayName "Kontur KP 3200" -Direction Inbound -Protocol TCP -LocalPort 3200 -RemoteAddress LocalSubnet -Action Allow -Profile Domain,Private
```

Порт PostgreSQL наружу не открывается. Профиль сети «Общедоступная» — правило не действует (осмотр предупреждает).

## 9. База и первый администратор

```powershell
$env = '--env-file=D:\Kontur\config\kontur.env'
node $env scripts\db-setup.ts
node $env scripts\db-migrate.ts
node $env scripts\bootstrap.ts --login <логин> --name "<имя>"
```

Затем удалить из файла окружения `DATABASE_ADMIN_URL` и `KONTUR_*_DB_PASSWORD`.

## 10. Службы

```powershell
npm run ops:service -- render --winsw C:\Downloads\WinSW-x64.exe --env-file D:\Kontur\config\kontur.env --pg-service postgresql-x64-18
npm run ops:service -- install
```

- `render` печатает SHA-256 WinSW — сверить со страницей выпуска; создаёт `services\kontur-server.exe|xml`, `services\kontur-worker.exe|xml`.
- Учётные записи — в оснастке «Службы» (`services.msc`), вкладка «Вход в систему» (решение В-17-4). Worker работает под учётной записью с доступом к папкам размещения и шрифтам (D-034); ей нужно право «Вход в качестве службы». Пароль хранит диспетчер служб, в файлах его нет. При смене пароля учётной записи — ввести новый здесь же, иначе служба не запустится.
- Права на каталоги §3 — учётным записям служб.
- Запуск: `npm run ops:service -- start`; состояние: `npm run ops:service -- status`.
- Проверка: `curl.exe https://<IP ПК>:3200/api/v1/ready` → 200 и все проверки `ok`; вход администратора → «Администрирование → Состояние».

## 11. Остановка, перезапуск, выключение, сбой

| Событие | Что происходит |
|---|---|
| `npm run ops:service -- stop` или «Остановить» в оснастке | WinSW шлёт процессу Ctrl+C (`SIGINT`): server закрывает соединения, worker прерывает текущие задания и возвращает их в очередь без потери попытки, слот GPU освобождается сразу; код выхода 0. Не уложились в `SHUTDOWN_GRACE_SECONDS` — код 4, WinSW завершает процесс по `stoptimeout` (срок + 10 с) |
| Выключение или перезагрузка ПК | Windows останавливает службы тем же путём |
| Включение ПК после перезагрузки | Службы стартуют без входа пользователя. PostgreSQL должен подняться сам: нативная служба — тип запуска «Автоматически»; контейнер — `--restart unless-stopped` и движок Docker, работающий без входа пользователя. Пока база недоступна, server и worker завершаются и перезапускаются через 60 с (в журнале `ECONNREFUSED`): после загрузки Windows так и было, пока остановленный тестовый контейнер с политикой `no` не запустили вручную (Review 17-3). Проверка: перезагрузить ПК, **не входить** в систему, через 5 минут `curl.exe https://<IP ПК>:3200/api/v1/ready` с другого компьютера — 200. LM Studio без входа пользователя не запускается: до входа смысловой поиск и ответы честно недоступны |
| Сбой процесса | WinSW перезапускает через 10, 30, 60 с; счётчик сбоев сбрасывается через час |
| Принудительное завершение (`taskkill /F`, сбой питания) | задания возвращаются в очередь после аренды (`JOB_LEASE_SECONDS`, 60 с); GPU-задания — ещё после защитного интервала (`GPU_TAKEOVER_GRACE_SECONDS`, 180 с): худший случай около 4 минут |
| Перезапуск PostgreSQL | процессы не падают; `/ready` — 503, пока база недоступна; затем работа продолжается сама |

Журналы: `logs\kontur-server.out.log`, `kontur-server.err.log`, то же для worker; ротация по 10 МБ, восемь файлов. Секретов и текстов документов в журналах нет.

## 12. Модель (LM Studio)

- Портал обращается к модели только запросами `POST /chat/completions` и `POST /embeddings` на адрес из `MODEL_BASE_URL` и `EMBEDDING_BASE_URL` (loopback). Загрузкой и выгрузкой моделей портал не управляет и `ttl` не передаёт.
- Одновременно портал держит у модели не больше одного своего запроса (слот GPU). Агент MailHub на той же видеокарте порталом не управляется: их взаимное влияние измеряется живьём (`docs/architecture/17-operations-design.md` §13).
- LM Studio при включённой автозагрузке (JIT) загружает модель по первому запросу и держит её 60 минут после последнего. Модели портала рекомендуется загрузить в LM Studio вручную: ручная загрузка не вытесняется автовыгрузкой JIT. Выбор — за администратором LM Studio.
- Проба модели эмбеддингов портала — раз в час (`EMBEDDING_PROBE_INTERVAL_SECONDS`), пока модель отвечает.
- LM Studio работает в сеансе пользователя: без входа модель недоступна, портал честно показывает деградацию смыслового поиска и неполноту проверок.

## 13. Копии

`docs/runbooks/backup-restore.md`. Кратко: `npm run ops:backup` вручную и перед каждым обновлением; ежедневно — задачей планировщика:

```powershell
npm run ops:service -- backup-task --env-file D:\Kontur\config\kontur.env --account "<DOMAIN\учётная запись>" --at 02:00
```

Команда печатается (пароль задачи спрашивается скрыто при её выполнении). Последняя копия видна на вкладке «Состояние».

## 14. Обновление

1. `npm run ops:service -- stop`.
2. Копия: `npm run ops:backup`. **Первое обновление установки этапов 14–16 на этап 17** — `npm run ops:backup -- --pre-update` (у `kontur_backup` прав ещё нет, их выдаёт миграция 0043; копию снимает владелец схемы).
3. Распаковать новую сборку в `D:\Kontur\app` поверх кода (каталоги `services`, `logs` сохраняются), `npm ci`, `npm run build`, новый `KONTUR_BUILD`.
4. `node --env-file=… scripts\db-migrate.ts`.
5. `npm run ops:service -- render …` (если менялись параметры служб), `npm run ops:service -- start`.
6. `/ready` — 200; вход, тендеры, вкладка «Состояние»: схема новой версии.

Отката схемы нет. При неудаче — восстановление из копии шага 2 (`docs/runbooks/backup-restore.md` §4).

## 15. Живые проверки и статусы в базе установки

Обязательный набор — D-040: TenderHub, импорт EML, Яндекс Диск и SMB, OCR, LibreOffice, LM Studio с эмбеддингами, Codex и Cursor по HTTPS, iPhone и Android. Каждая проверка пишет журнал с отметкой «Режим: LIVE», коммитом сборки и «Итог: PASS». Статус в базе установки записывает администратор:

```powershell
npm run ops:integration-verify -- --system tenderhub --component TenderHubReader --journal artifacts\stage-17\target\tenderhub-live.log --admin <логин>
```

Строки: `tenderhub/TenderHubReader`, `yandex_disk/FsDeliveryTarget`, `smb/FsDeliveryTarget`, `model/ModelGateway`, `embedding_model/ModelGatewayEmbeddings`, `mcp/PortalMcpServer`, `codex/McpClient`, `cursor/McpClient`; новая строка — с `--create`. Фикстурный журнал и журнал другой сборки не принимаются.

## 15а. Замер профиля нагрузки (D-040)

Замер идёт на отдельной базе `kontur_kp_measure_test` кластера `KONTUR_TEST_ADMIN_URL` с собственными процессами; рабочая установка и её база не используются. Нужен свободный диск: на 1 ГБ Markdown база занимает несколько гигабайт, корпус на время замера — около 1 ГБ во временном каталоге.

```powershell
$env:TEMP = "$env:LOCALAPPDATA\Temp\kontur-measure"; $env:TMP = $env:TEMP
# Модель — те же значения, что в файле окружения служб (LM Studio). Ключи — только если сервер модели их требует.
$env:MODEL_PROVIDER = "openai_compatible"; $env:MODEL_BASE_URL = "http://127.0.0.1:1234/v1"; $env:MODEL_NAME = "<модель>"
$env:EMBEDDING_PROVIDER = "openai_compatible"; $env:EMBEDDING_BASE_URL = "http://127.0.0.1:1234/v1"; $env:EMBEDDING_MODEL = "<модель эмбеддингов>"; $env:EMBEDDING_DIM = "<размерность>"
npm run ops:measure -- --profile target-d040 --positions 10000 --lines 3 --docs 20 --scans 3 --md-mb 1024 --real-model
```

- `--md-mb` — объём распознанного текста. Документы с экспортом RDWeb: настоящий PDF и `_results.md`, по 5 МБ на документ (`--md-doc-mb`) и 3 КБ на страницу (`--md-page-kb`). Корпус синтетический, данных заказчика нет.
- `--real-model` — живой замер: генеративная модель и эмбеддинги берутся из окружения той же проверкой конфигурации, что у служб. Оба провайдера обязаны быть `openai_compatible`. При `fake`, `none` или неверной настройке замер не выполняется: строки «НЕ ВЫПОЛНЕНО», «Итог: NOT_RUN», код 3. Без флага модель поддельная, журнал подписан «синтетический замер» и для SLO не годится.
- Сверить строки журнала с LM Studio: «Модель: живая: …» (имена, ревизии, размерность, сервер) и «модель эмбеддингов активной версии «…», размерность …». Шаг индекса ждёт версию именно этой модели. Генеративную модель замер отдельно не проверяет — её живая проверка `npm run model:live-smoke` (§15). Журнал замера не содержит отметки «Режим: LIVE» и основанием `ops:integration-verify` не служит.
- Поиск: p50 и p95 — только по полным запросам: итог `complete`, смысловая ветка `complete`, время всех трёх веток. Неполные запросы (истёкшее ожидание, деградация, отказ смысловой ветки) — отдельной строкой с причинами и своим временем, шаг поиска — FAIL, код 1. Частая причина — модель выгружена или не отвечает: проверить LM Studio и повторить замер.
- Коды выхода: 0 — все шаги выполнены; 1 — какой-то шаг не выполнен или замер прерван; 3 — замер не выполнялся: живой замер невозможен при этой настройке или база замера уже существует.
- База замера — только своя: замер создаёт её сам, помечает и удаляет после итога, отказа шага или Ctrl+C; удаляет и свои временные каталоги. Существующую базу с именем `--db` (по умолчанию `kontur_kp_measure_test`) он не трогает и не выполняется. Осталась после принудительного завершения — удалить вручную в тестовом кластере: `DROP DATABASE kontur_kp_measure_test WITH (FORCE)`. Рабочую базу установки в `--db` не указывать.
- Журнал — `artifacts\stage-17\measure-target-d040.log`: время каждого шага, модель, размер индекса, p50 и p95 полных запросов поиска, неполные запросы, объём базы и файлов.
- Предложение SLO составляется по этому журналу (только «Итог: PASS» живого замера); утверждает владелец (В-17-5).

## 16. Неисправности

| Признак | Где смотреть | Действие |
|---|---|---|
| `/ready` 503, `schema` | «Состояние» → Установка | `db:migrate` новой сборкой |
| `/ready` 503, `worker` | журнал worker | службу worker запустить; зависший цикл — перезапуск службы |
| `/ready` 503, `queue` | «Состояние» → Очередь | задание с давно истёкшей арендой: перезапустить worker |
| `/ready` 503, `storage`: «запись остановлена» | «Состояние» → Хранилище | освободить место; задания продолжатся сами (код `storage_full`) |
| Загрузка — «Нет места в хранилище» (507) | то же | то же |
| Интеграция — «Последняя ошибка» | «Состояние» → Интеграции | причина в коде: `AUTH_FAILED` — ключ, `UNAVAILABLE` — сеть или DNS (текст причины — в журнале worker) |
