# Контур КП — состояние

Текущий этап: 04 RDWeb — READY_FOR_REVIEW после исправлений по ревью 04-1 (объём сужен владельцем до импорта результатов распознавания, D-010)
HEAD / рабочее дерево: ветка `stage-04` от принятого коммита этапа 03 `301e7f2`; после коммита отчёта дерево чистое
Последнее принятое ревью: `docs/reviews/03-review-5.md` — PASS, этап 03 принят по коммиту `6f685424102d06021e766c5edebdc4cbd849d942`
Последнее ревью этапа 04: `docs/reviews/04-review-1.md` — CHANGES_REQUIRED; R04-01…R04-06 исправлены, ожидают повторного ревью
Ближайшее действие: повторное независимое ревью этапа 04 (`docs/stages/04-report.md`); этап 05 не начинать до его результата; слияние `stage-00`…`stage-04` в `main` — по решению владельца

| Этап | Статус | Коммит | Отчёт | Ревью | Открытые блокировки |
|---|---|---|---|---|---|
| 00 Инвентаризация | ACCEPTED | `e2c8812ab3d15cc618fd35cb36475fe622807a38` (база `db2c1d7`) | `docs/stages/00-report.md` | `docs/reviews/00-review-1.md` — CHANGES_REQUIRED; `docs/reviews/00-review-2.md` — PASS | нет |
| 01 Архитектура | ACCEPTED | `f8a0f200b75d619f81d70bdd12d9aca0c2a997b6` (база `cbe5bf5`) | `docs/stages/01-report.md` | 01-review-1…01-review-3 — CHANGES_REQUIRED; `docs/reviews/01-review-4.md` — PASS | нет; Q-01, Q-03, Q-05, Q-13 открыты, этап 02 не блокируют |
| 02 Каркас и права | ACCEPTED | `a32556d6c27f4c170571e04735725b34d045df79` (база `77f9004`) | `docs/stages/02-report.md` | `docs/reviews/02-review-1.md` — CHANGES_REQUIRED; `docs/reviews/02-review-2.md` — PASS | нет; U-02, PWA на телефонах, службы Windows — эксплуатационные проверки этапа 17 |
| 03 Источники и очередь | ACCEPTED | `6f685424102d06021e766c5edebdc4cbd849d942` (база `7457833`) | `docs/stages/03-report.md` | ревью 03-1…03-4 — CHANGES_REQUIRED (R03-01…R03-13 закрыты); `docs/reviews/03-review-5.md` — PASS | нет; U-05, U-08 и диагностика фоновых процессов PostgreSQL — этап 17 |
| 04 RDWeb | READY_FOR_REVIEW | передача 1: `89024f8` → … → `de90029`; исправления ревью 04-1: `ec6d86d` → `47676b8` → `925f045` → `ebcdb6d` (база `301e7f2`) | `docs/stages/04-report.md` | `docs/reviews/04-review-1.md` — CHANGES_REQUIRED (R04-01…R04-06 исправлены) | Q-02 (другие варианты схемы экспорта); X-05 — только автоматическая постановка задач, вне объёма этапа (D-010) |
| 05 LocalAI и поиск | NOT_STARTED | | | | X-04, Q-13 |
| 06 TenderHub | NOT_STARTED | | | | X-01 (production-gate), Q-01, Q-05, U-04 |
| 07 MailHub и переговоры | NOT_STARTED | | | | X-03, Q-06, Q-07 |
| 08 Требования | NOT_STARTED | | | | |
| 09 Проверки и разногласия | NOT_STARTED | | | | |
| 10 Экономика | NOT_STARTED | | | | Q-05, X-02 |
| 11 Формы | NOT_STARTED | | | | Q-08 |
| 12 Файлы кандидата | NOT_STARTED | | | | Q-08 |
| 13 Согласование и выпуск | NOT_STARTED | | | | Q-09 |
| 14 Размещение | NOT_STARTED | | | | Q-10 |
| 15 Отправки и сравнение | NOT_STARTED | | | | X-03 |
| 16 MCP/чат | NOT_STARTED | | | | Q-12 |
| 17 Эксплуатация | NOT_STARTED | | | | U-01, U-05, U-06, U-07 |
| 18 Пилот | NOT_STARTED | | | | Q-11 |
