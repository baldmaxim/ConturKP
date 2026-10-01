# Этап 08 — требования, покрытие и решения

Дата: 2026-10-01
Статус: **IMPLEMENTED — передан на Review 08-1**. Живой прогон модели — `NOT_RUN` (на машине разработки нет GPU, OD-08-2: к live/pilot gate); качество модели — экспериментальное на фикстурах (Q-11).
Базовый коммит: `4ad01d5` (ветка `stage-07`: этап 07 принят Review 07-2).
Ветка: `stage-08`, создана от базового коммита.
Коммиты этапа: `08c2a6f` — решения владельца по preflight (D-026), проект модели, остановка миграции на Р-08-1…Р-08-8; `249b9ab` — решения по расхождениям, окончательная матрица миграции, проверка условий остановки; `4d0a39e` — миграция 0019, слой БД, шлюз модели, задание, API, первые тесты; затем коммит интерфейса, тестов, документов и журналов (передача Review 08-1).
Рабочее дерево: чистое после передачи; не в Git по `.gitignore` — `node_modules/`, `apps/web/dist/`, `runtime/`; по `.git/info/exclude` — архивы и страницы передачи `ConturKP-*`.
Задание: `docs/spec/03_STAGE_PROMPTS.md` §08; решения владельца — D-026, тексты — `docs/reviews/08-owner-decisions.md`, `docs/reviews/08-arch-decisions-2.md`; проект модели и матрица — `docs/architecture/08-requirements-model-design.md`.
Среда: Ubuntu 26.04.1, Node 24.14.1; PostgreSQL 18.6 с pgvector 0.8.6 в контейнере `kontur-pg` на `127.0.0.1:55432`; Chromium headless без песочницы (AppArmor).

## Результат для пользователя

Инженер открывает вкладку «Требования» этапа. Руководитель создаёт реестр на зафиксированном снимке области. Модель по кнопке предлагает кандидатов — они помечены «Гипотеза модели» и ждут решения. Инженер проходит кандидатов по одному, правит предложения и предлагает свои; руководитель подтверждает или отклоняет. Подтверждённое требование получает код `R-0001` и неизменяемые ревизии; в карточке — основания с ролью, история оценок покрытия (позиции расчёта, комплексная расценка, решение, ручное подтверждение) и решения с заменой. Полнота считается по фрагментам снимка: связан с требованием, только с фактом, «не требование» или не просмотрен; завершить проход можно только без непросмотренных. Допущения ПД, вопросы заказчику и пометки этапа ведутся отдельно. Формулировка из договора или письма видна только тем, кто читает основание; остальным — оболочка без текста.

## Решения владельца — как выполнено

| Решение | Реализация |
|---|---|
| OD-08-1 источники | основания — только `evidence_fragment` снимка: документы RDWeb и 05a, договоры 06a, письма, переговоры; Q&A — новая ветка фрагментов (Р-08-1); расчёт — объект покрытия, не источник; модель читает только вход прогона — фрагменты снимка, читаемые запустившим |
| OD-08-2 модель | абстракция `IModelGatewayChat`: `OpenAiCompatibleChat` (локальный сервер, loopback/LAN) и `FakeChat`; прогон фиксирует провайдера, модель, версию, промпт, настройки, вход, версию схемы, время; результат — кандидаты |
| OD-08-3, Р-08-4 факты | `fact_kind` (справочник без CHECK), `fact_candidate`, `fact` → `fact_revision`, подтверждение `fact.confirm`; виды — только D-018 и манифест (И-08-10); `D-018 structural model implemented; closed fact taxonomy unavailable in repository` |
| OD-08-4, Р-08-5 видимость | полный текст — при праве на все основания `supports`; иначе оболочка; `clarifies` текст не скрывает; отзыв и возврат права действуют сразу; цитата — только по правам источника |
| OD-08-5, Р-08-8 права | возможности из роли участника, вторая линия — `has_stage_capability`; создатель кандидата не подтверждает; администратор без назначения — ничего |
| OD-08-6 | `assumption` → `assumption_revision`, `customer_question`, `stage_note` — отдельные типы |
| OD-08-7, Р-08-7 полнота | единица — фрагмент; пакеты по странице, редакции, письму, вопросу, транскрипции разворачиваются в ID; `total = reviewed + explicitly_not_requirement + unreviewed`; завершение — только при `unreviewed = 0` |
| AD-08-1…AD-08-3 первого текста | `requirement` → `requirement_revision`; `requirement_candidate` отдельно; `evidence_link` с ролью и ровно одним владельцем |
| Р-08-2 покрытие | `requirement_coverage` (история оценок ревизии) + `requirement_coverage_object` (`evidence_fragment`, `calculation_revision` с `explicit_line` / `complex_rate`, `decision`, `manual_confirmation`); `needs_review` — триггер новой ревизии расчёта |
| Р-08-3 решения | строка `decision` — версия, замена — `supersedes_decision_id`; вид `requirement_decision`, право `requirement.decide`, событие барьера `decision_recorded` |
| Р-08-6 реестр | `requirement_registry` на снимке, указатель `requirement_registry_active`; переход — явной командой с переносом; прежний реестр не меняется; кандидат прежнего реестра — явный перенос |
| «Model run» | `analysis_run` + `analysis_run_input`; повтор — тот же прогон, после отказа — новая попытка; хэш входа сверяет БД |
| X-01, Q-11, GPU | ревизии расчёта `provisional` остаются блокером выпуска; качество модели не заявлено; живой прогон — `NOT_RUN` |

## Миграция 0019 — итог

Новые таблицы (21): `requirement_registry`, `requirement_registry_active`, `analysis_run`, `analysis_run_input`, `requirement_candidate`, `requirement`, `requirement_revision`, `fact_kind`, `fact_candidate`, `fact`, `fact_revision`, `evidence_link`, `requirement_coverage`, `requirement_coverage_object`, `assumption`, `assumption_revision`, `customer_question`, `stage_note`, `registry_mark_batch`, `registry_fragment_mark`, `requirement_registry_review`.

Изменения прежних таблиц: `qa_item_revision` (`UNIQUE (id, tender_id)`, `created_xact`, триггер фрагментов), `evidence_fragment` (ветка `qa_item_revision`, происхождения `qa_question` / `qa_answer`, якорь `qa_item`), `evidence_scope_item` (единица `qa_item_revision`), `evidence_scope_composition_hash` и `evidence_scope_verify` (Q&A; хэши прежних снимков прежние), `decision` (вид `requirement_decision`, охранник по виду, `created_xact`), триггер после вставки `calculation_revision` (`needs_review`), строка `integration_status` `model/ModelGateway` — `VERIFIED_FIXTURE`. Функции: `tender_capabilities`, `has_stage_capability`, `evidence_origin_reviewable`, `evidence_origin_fact_basis`, `evidence_scope_has_fragment`, `analysis_input_hash`, `registry_fragment_states`, `registry_completeness`, хэши содержания ревизий. Удаления нет ни у одной таблицы этапа.

## Объём

| Что | Число |
|---|---|
| новые таблицы | 21 |
| маршруты API | 38 (`apps/server/src/routes/requirementRegistries.ts`, `requirementCandidates.ts`, `requirementItems.ts`, `stageRecords.ts`) |
| экраны | вкладка «Требования» (реестр, кандидаты с обходом, факты, полнота, анализ моделью, допущения и вопросы) и карточка требования |
| задания | `analysis.extract` (класс `gpu`, приоритет 20, пачка за задание) |
| интеграции | шлюз генеративной модели |
| возможности | 9: `requirement.read`, `.create`, `.confirm`, `.decide`, `.manage`, `analysis.run`, `fact.read`, `.create`, `.confirm` |
| события аудита | 21 вид команд и отказы |
| тесты этапа | 77 в 8 файлах + правка `tests/core.test.ts` |

## Обязательные инварианты БД (15) — прямой SQL

| № | Инвариант | Тест |
|---|---|---|
| 1 | требования без ревизии нет | `tests/requirementsSchema.test.ts` «1.» |
| 2 | кандидат не становится подтверждённым в обход перехода | «2.» — UPDATE без ревизии, инженер прямым SQL, ревизия по `proposed` |
| 3 | ревизия требования неизменяема | «3.» — роль приложения и владелец схемы |
| 4 | основание — существующий фрагмент снимка | «4.» |
| 5 | факт и требование — разные сущности | «5.» |
| 6 | ревизия решения неизменяема | «6–7.» |
| 7 | замена не удаляет прежнюю версию | «6–7.» |
| 8 | покрытие — к конкретной текущей ревизии | «8.» |
| 9 | прогон закреплён на снимке | «9.» и хэш входа — `tests/requirementsAnalysis.test.ts` |
| 10 | завершение невозможно при `unreviewed > 0` | «10.» |
| 11 | кандидат прежнего реестра — только явным переносом | «11.» |
| 12 | закрытие или архив не уничтожают происхождение | «12.» |
| 13 | отзыв права не открывается через цитату требования | `tests/requirementsSecurity.test.ts` «7.» |
| 14 | конкурентное подтверждение предсказуемо | `tests/requirements.test.ts` — ровно одно 200, второе 412 |
| 15 | A → B → A — различимые ревизии | `tests/requirements.test.ts`, `tests/requirementsSchema.test.ts` «15.» |

Дополнительно: совпадение `tender_capabilities` с кодом для 7 сочетаний ролей; пометка неизменяема; текст отправленного вопроса не меняется.

## Приёмочные тесты решения

| Тест | Где |
|---|---|
| candidate → confirm; rejected | `tests/requirements.test.ts` |
| duplicate model run; different prompt / settings → new run; different scope → new run | `tests/requirementsAnalysis.test.ts` |
| requirement A → B → A; fact A → B → A; decision superseded | `tests/requirements.test.ts` |
| partial, full coverage; complex pricing A05 | `tests/requirementsCoverage.test.ts` |
| unreviewed scope; registry completeness | `tests/requirementsCompleteness.test.ts` |
| protected contract / mail evidence; revoke source permission; admin without source read | `tests/requirementsSecurity.test.ts` |
| concurrent confirm | `tests/requirements.test.ts` |
| model failure; malformed output; provider unavailable; worker restart; retryable inference failure; deterministic failure без повтора | `tests/requirementsAnalysis.test.ts` |
| clean migration; upgrade from 07 | все тестовые базы с нуля; `tests/requirementsMigration.test.ts` |
| regression 02–07 | полный набор, `artifacts/stage-08/ui-check-stage*-regression.log` |

Видимость (7), покрытие (9), полнота (10) из решения по расхождениям — `tests/requirementsSecurity.test.ts`, `tests/requirementsCoverage.test.ts`, `tests/requirementsCompleteness.test.ts`.

## Проверки задания этапа

| Проверка | Результат |
|---|---|
| несколько работ на требование, несколько требований в позиции | покрытие — 1..N объектов на оценку; одна позиция — в оценках разных требований |
| одинаковый материал разных этажей | `object_scope` (объект, секция, этаж, помещение) у кандидата и ревизии; отдельные требования |
| неверная единица, конфликтующие требования | роль основания `contradicts`, правил нет — этап 09 (G11) |
| ложная цитата модели | отбрасывается до записи, учитывается в охвате прогона |
| повтор извлечения | тот же прогон; кандидаты в прогоне уникальны по ключу |
| ручная правка не затирается | правка — новая версия кандидата; повтор прогона кандидатов в требования не пишет |
| A05, A06, A44 | `test-plan.md` §3 |

## Пробелы G1–G13 — временная трактовка

| Пробел | Временная трактовка | Источник решения | Влияние |
|---|---|---|---|
| G1 D-018 не перенесён | структурная модель фактов, справочник видов; `fact_state` и правила — нет | OD-08-3, Р-08-4 | приёмка: случай Locus 11 не закрыт |
| G2 переговоры как источник | основание требования — речь допускается; основание факта — нет | OD-08-1, D-018 | — |
| G3 Q&A без фрагментов | ветка фрагментов `qa_item_revision`, без индекса | Р-08-1 | закрыт |
| G4 `model_suggestion.run_id` | `analysis_run`; `model_suggestion` — 09+ | «Model run» | закрыт |
| G5 имена возможностей | список решения | «Permissions» | закрыт |
| G6 охранник решения | по виду: импорт — руководитель, требование — `requirement.decide` | Р-08-3, Р-08-8 | закрыт |
| G7 область этапа | реестр на снимке, явный указатель | Р-08-6 | закрыт |
| G8 `stale` покрытия | `needs_review` триггером новой ревизии расчёта; `evidence_dependency` — 09 | Р-08-2 | приёмка 09 |
| G9 провайдер | OpenAI-совместимый локальный сервер; `fake` в разработке | OD-08-2 | production (live) |
| G10 события барьера | только `decision_recorded` решений 08 (И-08-9) | `state-machines.md` §1.1 | — |
| G11 «неверная единица», «конфликт» | роль `contradicts`; правил нет | OD-08-6 | приёмка 09 |
| G12 «обход» | полнота по фрагментам | OD-08-7, Р-08-7 | закрыт |
| G13 допущение ПД | отдельный тип `assumption` | OD-08-6 | закрыт |

## Интерпретации — PENDING_REVIEW

`docs/architecture/08-requirements-model-design.md` §16, И-08-1…И-08-15: устранённые решением расхождения с нормативом; вход прогона по правам запустившего; повтор после отказа; приоритет задания 20; правка — новая версия кандидата; модель предлагает только кандидатов требований и фактов; провайдер `rules` зарезервирован; завершение прохода — при доступе ко всем фрагментам; `decision_recorded` — только решения 08; виды фактов; факт из ответа Q&A; отклонённый кандидат засчитывается в просмотр; оценка покрытия — `requirement.confirm`; правила переноса реестра; единица без фрагментов в счётчики не входит. Если какая-то меняет владение, кратность, ревизии, источник истины, права или машину состояний — остановка до исправления этой части.

## Фактически выполненные проверки

| Проверка | Итог | Журнал |
|---|---|---|
| полный набор тестов однопоточно | 713 / 713 PASS, 68 файлов | `artifacts/stage-08/tests.log` |
| typecheck (корень и web) | PASS | `artifacts/stage-08/typecheck.log` |
| сборка web | PASS | `artifacts/stage-08/build.log` |
| smoke на настоящих server + worker (`MODEL_PROVIDER=fake`) | PASS | `artifacts/stage-08/smoke.log` |
| интерфейс этапа 08: 390 / 360 px, тёмная тема 1280 px, консоль и CSP | PASS | `artifacts/stage-08/ui-check.log` |
| интерфейс этапов 02–07 | PASS | `artifacts/stage-08/ui-check-stage*-regression.log` |

## Изменения существующего кода и тестов

- `packages/core/src/capabilities.ts`, `tests/core.test.ts` — 9 возможностей этапа 08 в таблице ролей; тест точного списка обновлён.
- `packages/core/src/search.ts`, `packages/db/src/searchScope.ts` — единица снимка Q&A (6-й слот хэша); в поиск не передаётся.
- `packages/db/src/recognition.ts`, `apps/server/src/recognitionMappers.ts`, `searchMappers.ts` — цитата и состав снимка с Q&A.
- `packages/db/src/stageEvents.ts` — тип `decision_recorded` (класс `content`).
- `apps/server/src/http/errors.ts` — `40001` охранников этапа 08 → `409`.
- `apps/worker/src/runtime.ts` — генеративная модель в контексте задания; `packages/config` — ключи `MODEL_*`.
- `scripts/smoke.mjs` — шаги этапа 08 (`scripts/smoke-08.mjs`), `MODEL_PROVIDER=fake`.

## Непроверенное и ограничения

- Живая модель не запускалась (U-01, U-05, U-08); качество извлечения не измерялось (Q-11).
- `fact_state`, граф редакций договора и правила-извлекатели D-018 — нет (Р-08-4): случай Locus 11 `pv2-amendment-advance` остаётся отложенным.
- Предложения моделью связей, покрытия и формулировок решений не реализованы (И-08-6).
- Покрытие ссылается на ревизии `provisional`: `CALCULATION_PROVISIONAL` не снимается (X-01).

## Риски

- Модель в цикле: ложные цитаты и инструкции в документах отсекаются до записи, но качество предложений на живой модели не проверено.
- Производный текст закрытых источников: видимость вычисляется при каждом чтении; новые проекции должны использовать `visibilityOf`.

## Передача независимому ревьюеру

ZIP `ConturKP-stage-08-<коммит>.zip` из `git archive` коммита передачи; SHA-256, число записей и полный коммит — в странице передачи и комментарии архива.
