# Независимое ревью этапа 03 — Контур КП, ревью 03-3

Дата: 2026-09-21. Вердикт: **CHANGES_REQUIRED**.

Проверен коммит `052b50a9409797b5462fad98696ef5c7485429fc` (исправления — `7156f8571f5ac98f4a6ae54dc16bef6e79ad7abb`).
R03-03 и R03-05 закрыты; исходные симптомы R03-04 закрыты; открыты новые R03-10, R03-11 и замечание R03-12.
Текст передачи сохранён дословно.

---

Продолжаем только Stage 03. Stage 04 / RDWeb НЕ начинать.

Независимое ревью 03-3 завершено со статусом CHANGES_REQUIRED.

По предыдущему ревью:

* R03-03 — CLOSED_BY_REVIEW;
* R03-04 — прежние два обхода закрыты;
* R03-05 — CLOSED_BY_REVIEW.

Обнаружены два новых блокирующих дефекта GPU lease protocol и одно замечание документации.

R03-10 — P1 — единый порядок блокировок GPU

Сейчас heartbeatJob работает в направлении resource_slot → job, а lockOwnedJob и ряд завершений — job → resource_slot.

Это создаёт deadlock:

T1:

1. lockOwnedJob блокирует job;
2. пытается заблокировать resource_slot.

Параллельно heartbeat:

1. блокирует resource_slot;
2. пытается изменить job.

Получается цикл ожидания.

Нужно не добавлять retry deadlock как обход, а исправить первопричину.

Ввести ОДИН порядок блокировок для всех GPU-переходов. Рекомендуемый порядок:

resource_slot → job.

Проверить и привести к нему:

* claimJob;
* heartbeatJob;
* lockOwnedJob / withLease;
* complete / succeedJob;
* confirmCancel;
* failJob retry/terminal;
* requeueJob;
* recovery/takeover в местах, где одновременно затрагиваются обе сущности.

Логически единый переход job + slot должен быть одной короткой транзакцией либо единым DB-примитивом с настоящей атомарностью.

Обязательная регрессия:
heartbeat одного GPU-job параллельно с ctx.withLease/ctx.complete не приводит к PostgreSQL 40P01, не переводит корректное задание в retry/failed и не теряет доменный результат.

Тест должен быть детерминированным, а не зависеть от случайного тайминга.

R03-11 — P1 — heartbeat после потери job lease не должен менять slot

Сейчас после:

1. GPU-job захвачен A;
2. lease истёк;
3. recoverExpiredJobs переводит job в queued и очищает job lease_token;
4. resource_slot по дизайну остаётся со старым token до окончания grace;

старый вызов heartbeatJob(A, oldToken) возвращает ok=false, но перед этим всё равно продлевает resource_slot.locked_until.

Причина: data-modifying CTE для slot выполняет UPDATE независимо от того, обновил ли второй CTE строку job.

Инвариант должен быть:

heartbeat = обе аренды продлены вместе ИЛИ не изменено ничего.

Если job уже не running с тем же token:

* resource_slot не меняется.

Если slot уже не принадлежит тому же job/token:

* job не меняется.

Рекомендуемая модель:
короткая транзакция с единым порядком slot → job:

1. заблокировать/проверить slot;
2. заблокировать/проверить job;
3. только после успешной проверки обеих строк установить одинаковый новый locked_until;
4. commit;
5. при любой невалидности — rollback/no-op и ok=false.

Дополнительно runtime после первого подтверждённого hb.ok=false не должен продолжать запускать новые heartbeat этого job, даже если handler ещё некоторое время не завершился после AbortSignal.

Обязательные регрессии:

A. heartbeat после recovery:

* захватить GPU job;
* сделать job и slot просроченными;
* вызвать recoverExpiredJobs;
* сохранить старое resource_slot.locked_until;
* вызвать heartbeat старым token;
* ожидать ok=false;
* resource_slot.locked_until не изменился.

B. после lost heartbeat:

* handler намеренно не завершается сразу после AbortSignal;
* новых успешных/изменяющих slot heartbeat после подтверждённого lost нет.

R03-12 — P2 — исправить 03-report.md

Сейчас строка отчёта утверждает, что HEAD отличается только отчётом от:

67415952...

Это старая база предыдущего цикла.

Текущая передача говорит:
commit исправлений = 7156f8571f5ac98f4a6ae54dc16bef6e79ad7abb;
HEAD = 052b50a9409797b5462fad98696ef5c7485429fc;
между ними только docs/stages/03-report.md.

Привести отчёт к этой фактической цепочке.

После исправлений:

1. Добавить R03-10 и R03-11 в docs/defects.md.
2. R03-03 и R03-05 отметить CLOSED_BY_REVIEW.
3. R03-04 можно отметить CLOSED_BY_REVIEW по исходным симптомам, а новые проблемы вести отдельными R03-10/R03-11.
4. Обновить ADR-004 единым формальным lock order для GPU.
5. Обновить docs/stages/03-report.md.
6. Не удалять и не ослаблять текущие 136 тестов.
7. Новые тесты должны увеличить их число.
8. Запустить:
   npm run typecheck
   npx vitest run --reporter=verbose
   npm run build
   npm run smoke
   node artifacts/stage-03/ui-check.mjs
9. Передать новый git archive Stage 03.

Для следующего ревью основной идентификатор артефакта — Git commit marker в ZIP. SHA-256 ZIP также указать, но расхождение после передачи через чат само по себе не считать ошибкой проекта.

Stage 04 до отдельного PASS Review 03-4 не начинать.
