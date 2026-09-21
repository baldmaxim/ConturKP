# Независимое ревью этапа 03 — Контур КП, ревью 03-4

Дата: 2026-09-21. Вердикт: **CHANGES_REQUIRED**.

Проверен коммит `b06320d9b8feed90ee5effa40d5fc32ef9af1204` (исправления — `be741ffe756e612f208553153bb539ee7c504bc0`).
R03-10, R03-11, R03-12 — CLOSED_BY_REVIEW; открыт новый дефект R03-13.
Текст передачи сохранён дословно.

---

Продолжаем только Stage 03. Stage 04 / RDWeb НЕ начинать.

Review 03-4:

* R03-10 — CLOSED_BY_REVIEW.
* R03-11 — CLOSED_BY_REVIEW.
* R03-12 — CLOSED_BY_REVIEW.
* Новый дефект: R03-13 — P1.

R03-13 — stale worker может освободить GPU slot после потери job lease.

Файл:
`packages/db/src/jobs.ts`

Проблемные функции:

* `succeedJob`;
* `confirmCancel`;
* `failJob`;
* `requeueJob`;
* общий механизм `RELEASE_SLOT_CTE`.

Сейчас `resource_slot` очищается раньше подтверждения, что строка `job` всё ещё имеет:

* `status='running'`;
* тот же `lease_token`.

После `recoverExpiredJobs()` job уже queued и token очищен, но slot намеренно остаётся за старым token на время `gpu_takeover_grace`.

Старый worker может вызвать finish/fail/requeue:

* job update вернёт 0 строк;
* но slot будет очищен;
* защитный интервал GPU будет обойдён.

Требуемый инвариант:

**если job lease потерян — ни job, ни resource_slot не меняются.**

Для GPU-переходов:

1. сохранить единый lock order:
   `resource_slot -> job`;

2. сначала заблокировать и проверить slot:
   `holder_job_id + lease_token`;

3. затем заблокировать и проверить job:
   `id + lease_token + status='running'`;

4. если любая проверка не прошла:

   * вернуть false;
   * не изменять ни slot, ни job;

5. только после подтверждения владения обеими строками:

   * изменить/освободить slot;
   * изменить job;
   * commit одной транзакцией.

Не использовать data-modifying CTE (изменяющий CTE), который может изменить slot до подтверждения job ownership.

Обязательные регрессии:

1. stale `succeedJob` после `recoverExpiredJobs`:

   * возвращает false;
   * slot полностью неизменен.

2. stale `confirmCancel`:

   * false;
   * slot неизменен.

3. stale retry `failJob`:

   * `ok=false`;
   * slot неизменен.

4. stale `requeueJob`:

   * false;
   * slot неизменен.

5. После всех этих stale-вызовов новый GPU job с ненулевым `gpu_takeover_grace` не может захватить slot раньше окончания grace.

Дополнительно желательно добавить runtime-регрессию:
после recovery старый обработчик завершается обычной ошибкой/AbortError, и его `onError()` не способен освободить старый GPU slot.

После исправления:

* добавить R03-13 в `docs/defects.md`;
* обновить ADR-004;
* обновить `docs/stages/03-report.md`;
* прежние 141 тест не удалять и не ослаблять;
* новые регрессии должны увеличить число тестов;
* выполнить:
  `npm run typecheck`
  `npx vitest run --reporter=verbose`
  `npm run build`
  `npm run smoke`
  `node artifacts/stage-03/ui-check.mjs`
* сформировать новый git archive ZIP;
* передать Git commit marker и результаты проверок.

Stage 04 до PASS Review 03-5 не начинать.
