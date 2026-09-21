# Независимое ревью этапа 03 — Контур КП

Дата: 2026-09-21. Вердикт: **CHANGES_REQUIRED**.

Проверенный артефакт: `ConturKP-stage-03.zip`, SHA-256 `32c55d94573f77ed97f3331342371e64b8c557dbb354c4571348f22147cef95c` (коммит `2234d181b6d72ae2792d4119ea78b932a9804665`).
Текст передачи сохранён дословно.

---

Работаем только в Stage 03 проекта «Контур КП». Stage 04 / RDWeb НЕ начинать.

Независимое ревью Stage 03 завершено со статусом CHANGES_REQUIRED (требуются исправления).

Проверенный артефакт:
ConturKP-stage-03.zip
SHA-256:
32c55d94573f77ed97f3331342371e64b8c557dbb354c4571348f22147cef95c

Нужно исправить подтверждённые замечания R03-01 — R03-09.

Главное правило:
сначала воспроизвести каждый дефект отдельным регрессионным тестом, который падает на текущей реализации. Затем исправить первопричину и убедиться, что тест проходит. Не ослаблять архитектурные инварианты, не менять acceptance criteria (критерии приёмки) и не обходить дефект специальным условием только для теста.

R03-01 — P1 — frozen source_set_item

Файл:
docs/migrations/0002_sources_jobs_intake.sql
source_set_item_guard(), примерно строки 351–363.

Проблема:
при UPDATE проверяется статус NEW.source_set_revision_id. Поэтому строку из frozen revision (замороженной ревизии) можно перенести в draft revision (черновую ревизию), изменив уже замороженный состав.

Требуется:

* не допускать изменения состава frozen revision через reparent;
* предпочтительно сделать source_set_revision_id неизменяемым после INSERT;
* guard должен корректно учитывать OLD и NEW;
* сохранить возможность штатной работы с draft revision.

Регрессия:
от имени kontur_app создать frozen revision и draft revision; попытка UPDATE source_set_item SET source_set_revision_id=<draft> для строки frozen revision должна завершаться ошибкой БД. Состав frozen revision после ошибки неизменен.

R03-02 — P1 — import_item frozen-after неполный

Файл:
docs/migrations/0002_sources_jobs_intake.sql
import_item_guard(), примерно строки 210–237.

Проблема:
после завершения import_batch запрещено менять только часть полей. Остаются изменяемыми tender_id, observed_name, reject_detail, size_bytes, resolved_by, resolved_at, created_at и другие поля доказательства. Кроме того, их можно изменить одновременно с первым resolution.

Требуется:

* после завершения партии использовать строгий whitelist (разрешённый список) изменяемых полей;
* разрешить только однократный переход resolution из none в допустимое состояние и связанные с этим переходом поля;
* identity/evidence fields (поля идентичности и доказательства) должны быть неизменяемы;
* сохранить технические row_version/updated_at, если они действительно нужны механизму обновления;
* проверить согласованность resolved_by/resolved_at/resolution.

Регрессии:
прямые UPDATE от kontur_app каждого класса защищаемых полей после completed/completed_with_errors должны падать; штатное однократное resolve должно работать; второе resolve должно падать.

R03-03 — P1 — input_version можно изменить без stage_input_event

Файлы:
docs/migrations/0002_sources_jobs_intake.sql
docs/migrations/0001_access_tenders_audit.sql
packages/db/src/stageEvents.ts

Проблема:
tender_stage_input_version_guard проверяет только увеличение ровно на +1.
stage_input_event_seq_guard проверяет seq только при наличии события.
kontur_app имеет UPDATE на tender_stage.

Поэтому возможна транзакция:
UPDATE tender_stage
SET input_version = input_version + 1
WHERE id = ...;
COMMIT;

без stage_input_event.

Это нарушает R01-03 и архитектуру barrier freshness (барьера актуальности).

Требуется обеспечить на уровне БД:
изменение input_version и соответствующий stage_input_event существуют как одна непрерывная операция и не могут быть зафиксированы раздельно.

Допустимые архитектурные варианты:

* deferred constraint trigger (отложенный ограничивающий триггер), проверяющий пару к моменту COMMIT;
  или
* запрет прямого UPDATE input_version для прикладной роли + узкая DB-функция, атомарно выполняющая изменение версии и вставку события.

Не вводить SECURITY DEFINER без минимальных прав и явного search_path.

Регрессии:

* прямой +1 без события обязан завершиться ошибкой на COMMIT;
* событие без корректной версии запрещено;
* штатный emitStageEvents работает;
* несколько последовательных событий не дают пропусков seq.

R03-04 — P1 — GPU lease/slot fencing

Файлы:
packages/db/src/jobs.ts
apps/worker/src/runtime.ts

Проблема:
heartbeatJob отдельно обновляет job.locked_until и отдельно resource_slot.locked_until.
Если обновление job прошло, а слот уже потерян или второе обновление не выполнилось, heartbeat может считать аренду действующей.
lockOwnedJob также проверяет только job/token/status, не владение GPU-slot.

Требуется:

* для GPU-задания heartbeat атомарно проверяет и продлевает и job lease (аренду задания), и resource_slot;
* если slot уже не принадлежит этому job+lease_token, результат heartbeat — lost lease (аренда потеряна);
* доменная запись старого GPU-handler (обработчика GPU) после передачи slot другому владельцу невозможна;
* takeover (перехват) GPU-slot не должен оставлять старого владельца способным завершить или записать результат;
* сохранить grace period (защитный интервал) из ADR-004;
* обычные default/network jobs не усложнять без необходимости.

Регрессии:

* два GPU jobs;
* владелец A получает первый;
* смоделировать истечение/рассинхронизацию slot;
* B получает slot;
* heartbeat A возвращает false/lost;
* writeMarker/complete/succeed A не проходят;
* B остаётся единственным владельцем;
* отдельный тест: job token верен, slot token уже чужой — GPU heartbeat обязан вернуть lost.

R03-05 — P1 — терминальная ошибка import job не переводит batch в failed

Файлы:
packages/db/src/sources.ts
apps/worker/src/runtime.ts
apps/worker/src/handlers/imports.ts

Проблема:
failBatch() существует, но нигде не вызывается.
После исчерпания max_attempts для import.expand/import.register job становится failed, а import_batch может остаться running, item — pending.

Требуется:

* терминальная ошибка import.expand/import.register должна под ещё действующим lease token (токеном аренды) фиксировать доменный failed;
* import_batch → failed;
* failure_code заполнен безопасным кодом;
* незавершённые элементы могут остаться pending для истории согласно существующему комментарию;
* import_accepted barrier event (событие барьера) остаётся uncovered (непокрытым);
* нельзя сначала потерять lease_token, а затем отдельным запросом менять batch.

Нужно спроектировать атомарную terminal-failure boundary (границу терминальной ошибки), а не добавлять случайный вызов failBatch после failJob.

Регрессии:
постоянная ошибка expand/register до max_attempts → job=failed, batch=failed, failure_code есть, нет ложного completed/completed_with_errors.

R03-06 — P1 — physical storage root / junction alias

Файлы:
apps/worker/src/handlers/intake.ts
packages/storage/src/index.ts

Проблема:
intake root сравнивается через realpath, storageRoot — через resolve.
Junction/symlink alias storageRoot может физически указывать на каталог внутри intake root, но overlap-проверка этого не увидит.

Требуется:

* после создания/инициализации BlobStore получить canonical real storage root (канонический физический корень);
* overlap и contains/skip выполнять в одном каноническом пространстве физических путей;
* не разрешать сканирование sha256/, tmp/, derived/ через альтернативный путь/alias.

Регрессия:
physical-store находится внутри intake root, STORAGE_ROOT настроен на junction alias снаружи → канал должен получить overlaps_storage либо физический store должен гарантированно исключаться из обхода.

R03-07 — P1 — TOCTOU при чтении watched folder

Файл:
apps/worker/src/handlers/intake.ts

Проблема:
walk выполняет lstat обычного файла, но createReadStream позже повторно открывает путь.
Между проверкой и использованием файл можно заменить symlink/reparse point (символической ссылкой/точкой повторного разбора) на объект вне разрешённого root.

Требуется:

* не полагаться на старый lstat;
* непосредственно перед чтением снова подтвердить физический target и принадлежность canonical intake root;
* исключить symlink/reparse;
* по возможности открыть file handle (файловый дескриптор) и читать именно его, проверив identity/stat до и после чтения;
* учитывать Windows/SMB;
* изменение/подмена во время чтения должно приводить к unstable/reject/retry, но не к импорту внешнего файла.

Регрессия:
детерминированно заменить найденный файл ссылкой между scan и read → содержимое объекта за пределами INTAKE_ROOTS не должно попасть в BlobStore.

R03-08 — P2 — EEXIST проверяет только размер

Файл:
packages/storage/src/index.ts
BlobStore.putStream()

ADR-003 требует при существующем content-addressed object (объекте, адресуемом содержимым) проверить размер и hash (хэш).

Сейчас проверяется только size.

Требуется:
при EEXIST:

* проверить размер;
* пересчитать SHA-256 существующего target;
* подтвердить равенство ожидаемому sha256;
* при несовпадении вернуть явную storage corruption error (ошибку повреждения хранилища);
* не регистрировать повреждённый объект как успешный duplicate (дубликат).

Регрессия:
создать корректный blob A; заменить target другими байтами B той же длины; повторно положить A → операция обязана обнаружить повреждение.

R03-09 — P2 — DB insert watched-folder blob вне lease

Файл:
apps/worker/src/handlers/intake.ts

Проблема:
insertBlob(ctx.pool, ...) выполняется вне ctx.withLease.
Архивный импорт аналогичную запись уже делает внутри ctx.withLease.

Требуется:

* DB metadata write (запись метаданных БД) для blob выполнять только под действующим lease fencing (ограждением аренды);
* не держать длинную DB transaction (транзакцию БД) во время копирования файла;
* content-addressed filesystem write (запись файла по хэшу) может быть выполнена до короткой fenced-транзакции;
* после потери lease старый handler не пишет blob/domain metadata.

Регрессия:
потерять lease между putStream и DB insert → старый обработчик не создаёт blob row и не меняет доменное состояние.

После исправлений обязательно:

1. Обновить docs/defects.md:
   R03-01…R03-09 с описанием исправления и ссылкой на регрессионный тест.

2. Обновить docs/stages/03-report.md:

   * перечислить найденные независимым ревью дефекты;
   * описать исправления;
   * указать фактические новые результаты тестов;
   * исправить расхождение «16 UI шагов» с фактическим логом либо объяснить метод подсчёта;
   * записать ТОЧНЫЙ полный SHA проверяемого commit (коммита), а не HEAD/«будет в сообщении».

3. Запустить на штатной среде Node.js 24 + PostgreSQL >=16:
   npm run typecheck
   npx vitest run --reporter=verbose
   npm run build
   npm run smoke
   node artifacts/stage-03/ui-check.mjs

4. Не удалять и не ослаблять существующие 117 тестов. Новые регрессии должны увеличить количество тестов.

5. Проверить весь diff исправлений на новые обходы DB guards, lease fencing, path containment и frozen-after.

6. Сформировать новый ZIP всего проекта Stage 03 без node_modules, runtime БД, секретов и реальных документов.

В результате передать:

* точный commit SHA;
* новый SHA-256 ZIP, если рассчитывается локально;
* итог новых тестов;
* таблицу R03-01…R03-09 → что изменено → какой тест;
* обновлённый docs/stages/03-report.md;
* обновлённый docs/defects.md;
* новый ZIP для повторного независимого ревью.

До отдельного вердикта PASS независимого повторного ревью Stage 04 не начинать.
