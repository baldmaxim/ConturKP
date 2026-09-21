Контур КП — независимое повторное ревью Stage 03 / Review 03-2

Дата ревью: 2026-09-21

Проверенный артефакт

Загруженный файл: ConturKP-stage-03 (1).zip

SHA-256 загруженного файла в среде ревью: d831f0320dd6ae827fdfcc634c9fcad159105aaa2ade9f9d68ec21b16e6c4034

ZIP comment / Git commit marker: 97342f3b0038bcb3558e3395a21294903724c4e5

ZIP: 363 entries, ~0.72 MiB

Заявленный пользователем SHA-256 ZIP: 3c7e73d7fefdef2b5e9a3737647f12d82cf1d4b225987166c2ce40d2719f61b4

Контрольная сумма переданного через чат бинарного ZIP не совпадает с заявленной локальной контрольной суммой. При этом внутренний comment ZIP совпадает с заявленным HEAD 97342f3b..., а состав и объём архива соответствуют передаче. Для этого ревью источником истины является фактически загруженный ZIP с SHA-256 d831f....

Итог

CHANGES_REQUIRED / требуются исправления. Stage 03 пока не принят. Stage 04 / RDWeb не начинать.

Из R03-01…R03-09:

PASS: R03-01, R03-02, R03-06, R03-07, R03-08, R03-09.

NOT CLOSED: R03-03, R03-04, R03-05.

Сохранённые доказательства тестов согласованы с отчётом:

Vitest: 12 файлов, 130/130 PASS;

smoke: 19/19 PASS;

UI-check: 15/15 PASS.

Независимо перезапустить PostgreSQL-тесты в среде ревью нельзя: доступен Node.js 22.16.0, а проект требует Node.js >=24.11 <25; psql отсутствует. Поэтому результаты выше подтверждены по сохранённым логам, а выводы по дефектам — статическим анализом фактического SQL/TypeScript.

Закрытые замечания

R03-01 — PASS

source_set_item_guard() теперь запрещает изменение source_set_revision_id и проверяет состояние OLD/NEW revision. Перенос строки из frozen revision в draft более невозможен.

R03-02 — PASS

import_item_guard() получил явную защиту идентичности и полей доказательства, однократный resolution и проверки принадлежности decision/reimported item. Регрессии покрывают основные обходы.

R03-06 — PASS

BlobStore сохраняет canonical physical root; intake сравнивает watched root и storage в одном физическом пространстве. Junction-alias сценарий покрыт регрессией.

R03-07 — PASS

Добавлен openVerifiedFile: повторная проверка непосредственно перед чтением, чтение открытого file handle, проверка физического пути и состояния после чтения. Исходный TOCTOU обход закрыт в заявленной модели угроз.

R03-08 — PASS

При EEXIST проверяются размер и фактический SHA-256 существующего объекта; повреждение того же размера даёт StorageCorruptionError.

R03-09 — PASS

Файл может физически попасть в content-addressed store до проверки аренды, но metadata blob, batch и items фиксируются только внутри ctx.complete() под действующим lease. При потере аренды остаётся максимум безопасный orphan blob-файл без доменной регистрации.

Оставшиеся дефекты

R03-03 — P1 — барьер актуальности всё ещё допускает пропуск seq

Файл: docs/migrations/0003_guards_frozen_and_input_version.sql, функция stage_version_event_pair_check().

Текущая deferred check на COMMIT проверяет только:

у текущей финальной input_version есть событие с тем же seq;

нет событий с seq > input_version.

Она не проверяет, что каждый промежуточный +1 получил своё событие.

Обход:

BEGIN;
UPDATE tender_stage SET input_version = input_version + 1 WHERE id = :stage; -- N+1
UPDATE tender_stage SET input_version = input_version + 1 WHERE id = :stage; -- N+2
INSERT INTO stage_input_event (..., stage_id, seq, ...)
VALUES (..., :stage, N+2, ...);
COMMIT;

Оба BEFORE-trigger update проходят, INSERT проходит (seq = current input_version). На COMMIT обе deferred проверки tender_stage повторно читают уже финальное input_version = N+2 и обе видят событие N+2. События N+1 нет, но COMMIT разрешается.

Это прямо нарушает R01-03: история барьера должна быть непрерывной и каждое увеличение версии должно иметь собственное неизменяемое событие.

Дополнительно tender_stage можно INSERT-нуть с ненулевым input_version, потому что pair trigger работает только на UPDATE. Это менее вероятный путь, но та же DB-инварианта должна фиксировать стартовую версию 0.

Исправление: deferred check должна связывать конкретный NEW.input_version каждой UPDATE-строки с событием этого seq, а не только перечитывать финальную версию; либо на COMMIT проверять полную непрерывность (count(events) = input_version, при seq > 0 и unique), плюс запрет ненулевого input_version на INSERT.

Новые регрессии:

два UPDATE +1 в одной транзакции + только одно событие финального seq → COMMIT обязан упасть;

INSERT нового tender_stage с input_version = 1 и без события → должен быть запрещён;

штатные два последовательных emitStageEvents в одной транзакции/разных транзакциях → PASS без пропусков.

R03-04 — P1 — GPU fencing всё ещё имеет race window

Файл: packages/db/src/jobs.ts.

Исправление закрывает простой сценарий «slot уже чужой до heartbeat/lock». Но два SQL-контура всё ещё не атомарны относительно конкурентного takeover.

1. Heartbeat

heartbeatJob() выполняет data-modifying CTE:

updated обновляет job.locked_until, если snapshot видит slot владельцем A;

затем slot пытается обновить resource_slot;

финальный SELECT возвращает строку из updated, не проверяя, что slot реально обновил 1 строку.

Гонка:

heartbeat A начал statement и snapshot ещё видит slot=A;

worker B захватывает/перехватывает resource_slot и фиксирует slot=B;

A уже продлил job.locked_until, но UPDATE resource_slot после ожидания получает 0 rows;

финальный SELECT cancel_requested FROM updated всё равно возвращает строку;

A получает {ok:true} и продолжает GPU-работу одновременно с B до следующей проверки.

Это нарушает ADR-004 «не более одного GPU-задания одновременно».

2. lockOwnedJob()

SELECT ... FOR UPDATE OF j блокирует только row job, но не row resource_slot. EXISTS по слоту — лишь snapshot check.

После успешного lockOwnedJob() конкурентный worker может перехватить slot до завершения ctx.withLease(...). Для ctx.complete() последующий succeedJob() вызовет rollback, но обычный ctx.withLease() может зафиксировать доменную запись уже после фактической потери GPU slot.

Исправление:

heartbeat для GPU должен возвращать ok=true только если продлены и job, и slot;

transaction fence для GPU должен блокировать/проверять resource_slot в той же транзакции, а не только читать его через EXISTS;

takeover должен сериализоваться с GPU domain write boundary.

Новые регрессии:

конкурентный takeover между updated job и UPDATE resource_slot: старый heartbeat обязан вернуть lost;

transaction A успешно начинает GPU withLease, transaction B пытается takeover; B обязан ждать до COMMIT/ROLLBACK A, либо A должна потерять fence до доменной записи — не допускается коммит доменного результата при уже переданном slot.

R03-05 — P1 — при ошибке фиксации terminal domain failure старый разрыв возвращается

Файл: apps/worker/src/runtime.ts, onError().

Положительный сценарий исправлен: onTerminalFailure() + failJob() выполняются в одной транзакции.

Но если эта транзакция падает по причине, отличной от LeaseLostError, код делает:

catch (terminalErr) {
  ... log ...
}
const r = await failJob(this.o.pool, job, token, ...);

То есть после rollback доменного отказа runtime снова отдельно может сделать job.status = failed.

Для import это возвращает исходный класс дефекта: job может стать failed, а import_batch остаться running.

Причина падения terminal transaction может быть реальной: временная DB-ошибка, constraint failure, ошибка самого onTerminalFailure, неожиданное состояние доменной строки и т.п. В таком случае атомарность должна сохраняться и при отказе самого механизма фиксации.

Исправление: если handler имеет onTerminalFailure, то после неуспешной terminal transaction нельзя делать standalone failJob. Должно выполняться правило «обе записи или ни одной». Возможная политика — оставить job под текущей арендой до recovery либо безопасно вернуть его в retry state отдельной согласованной операцией, но не фиксировать failed без доменного failed.

Новая регрессия: handler run() даёт terminal error, onTerminalFailure() намеренно бросает исключение; после execute не должно существовать состояния job=failed при отсутствии доменного terminal marker. Затем recovery/retry должен оставаться возможным.

Замечание по артефакту

Заявленный локальный SHA-256 ZIP (3c7e...) не совпал с SHA-256 фактически загруженного ZIP (d831...). Это не признано дефектом кода Stage 03, потому что:

ZIP корректен;

количество entries совпадает (363);

размер соответствует передаче;

ZIP comment равен заявленному HEAD 97342f3b...;

содержимое содержит все заявленные исправления и доказательства.

В следующей передаче желательно после финального создания ZIP считать SHA-256 именно с того файла, который затем загружается, и не пересобирать его после расчёта.

Решение gate

Stage 03: CHANGES_REQUIRED.

До закрытия R03-03, R03-04, R03-05 переход к Stage 04 / RDWeb запрещён.

После исправления нужны:

новые regression tests для трёх сценариев выше;

обновление docs/defects.md — оставить R03-03/R03-04/R03-05 как FIX_PROPOSED до повторного PASS;

обновление docs/stages/03-report.md;

полный прогон Node 24 + PostgreSQL: typecheck, Vitest, build, smoke, UI-check;

новый ZIP всего дерева Stage 03 и точный SHA-256 фактически переданного файла.
