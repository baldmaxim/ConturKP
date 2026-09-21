# Контур КП — трассировка требований

Статусы: `NOT_STARTED` — нет ни проекта, ни кода; `DESIGNED` — спроектировано на этапе 01, кода нет; далее по мере реализации — `PARTIAL` (реализована и проверена тестами часть требования, этап указан), `IMPLEMENTED`, `VERIFIED`. В колонке «Реализация» на этапе 01 указаны документы проекта; в колонке «Проверка/артефакт» — сценарии и внешние зависимости (X-, Q-, U- из `docs/architecture/unknowns.md` и `docs/discovery.md`).

## Обязательные инварианты

| ID требования | Требование | Этап | Реализация | Case IDs | Проверка/артефакт | Ревью | Статус |
|---|---|---|---|---|---|---|---|
| I01 | Закрытие расчёта, согласование, размещение и отправка — разные события; upload не является отправкой | 06, 13, 14, 15 | ADR-007; state-machines §11, §15–17; overview §4 | A08, A31, A46 | test-plan A08/A31/A46; Q-01, X-01 | — | DESIGNED |
| I02 | Согласование привязано к точным версиям и файлам; при размещении файлы не генерируются заново | 12, 13, 14 | ADR-003; state-machines §5.1, §11, §16; data-model §5 | A09, A27 | test-plan A09/A27 | — | DESIGNED |
| I03 | Изменение утверждённого состава создаёт новую ревизию; прежний выпуск сохраняется | 12, 13 | ADR-002 §3; data-model §1 | A09, A10 | test-plan A09/A10; walkthroughs §3 | — | DESIGNED |
| I04 | Новый источник после согласования переводит готовность на проверку; согласование не стирается | 03, 13 | state-machines §1.1, §13; walkthroughs §2, §7 | A07, A08 | test-plan A07/A08 | — | DESIGNED |
| I05 | Поиск ограничен тендером, правами и набором источников; нет утечки | 05, 16 | ADR-006 §6–8; `packages/db/src/tenders.ts`, `access.ts`; ADR-008; state-machines §5.1; walkthroughs §6, §11 | A11, A12, A35 | test-plan A11/A12/A35; X-04, Q-13 | — | PARTIAL (02: изоляция тендеров в API — `tests/access.test.ts`; поиск — 05, 16) |
| I06 | Текст проекта, OCR, описание модели, подсказка переговоров и решение человека — разные типы | 04, 07, 08 | data-model §4.4; ADR-009 | A03, A43 | test-plan A03/A43 | — | DESIGNED |
| I07 | «Не найдено» не равно «не предусмотрено» | 08, 09 | ADR-008 §11; portal-api §3 | A05, A16, A44 | test-plan A05/A16/A44 | — | DESIGNED |
| I08 | Устное предложение, согласие, ТЗ/договор и включение в КП — разные состояния | 07, 09 | data-model §4.7.1; walkthroughs §1 | A01, A03, A46 | test-plan A01/A03/A46 | — | DESIGNED |
| I09 | Четыре статуса независимы | 09 | data-model §4.7.1; state-machines §10 | A01, A04 | test-plan A01/A04 | — | DESIGNED |
| I10 | Деньги считаются программно в decimal; валюта, единица, НДС, дата и вид цены входят в сопоставление | 06, 10 | ADR-005 | A18, A19, A20, A21, A22 | test-plan A18–A22; Q-05 | — | DESIGNED |
| I11 | Причина изменения подтверждается человеком; необъяснённый остаток виден | 10 | data-model §4.11; state-machines §18 | A20, A23 | test-plan A20/A23 | — | DESIGNED |
| I12 | Модель не согласует, не выпускает, не отправляет и не закрывает замечания | 13, 16 | ADR-006 §3–4; ADR-010 §5 | A25, A36, A37 | test-plan A25/A36/A37 | — | DESIGNED |
| I13 | Права проверяет сервер; нет молчаливой перезаписи | 02, 13 | ADR-005 §9; ADR-006; `apps/server/src/http/command.ts`, `routes/*` | A24, A25, A35 | test-plan A24/A25/A35; walkthroughs §4 | — | PARTIAL (02: права сервера, 403/404, 412/428 — `tests/access.test.ts`, `tests/concurrency.test.ts`; согласование — 13) |
| I14 | Повтор безопасен; ошибка одного назначения не отменяет другое | 03, 14, 15 | ADR-004; ADR-005 §10–11; state-machines §2, §16; walkthroughs §10 | A15, A26, A28, A29, A30, A37 | test-plan A15/A26/A28–A30/A37; walkthroughs §5 | — | PARTIAL (02: `Idempotency-Key` команд API; 03: `dedupe_key` заданий, уникальные ключи результата, повтор импорта без дублей — `tests/queue.test.ts`, `tests/imports.test.ts`; доставки — 14, 15) |
| I15 | Оригиналы и распознавание версионируются отдельно; переиндексация не уничтожает доказательства | 03, 04, 05 | ADR-003; data-model §4.4 | A10, A13, A14, A42 | test-plan A10/A13/A14/A42 | — | PARTIAL (03: оригиналы по SHA-256 без перезаписи, удаление из папки ничего не удаляет, редакции и происхождения неизменяемы — `tests/storage.test.ts`, `tests/intake.test.ts`; распознавание — 04) |
| I16 | Команды внутри документов — недоверенные данные | 03, 08, 16 | ADR-009 §3; ADR-010 §7 | A36, A38 | test-plan A36/A38 | — | PARTIAL (03: HTML, письма и XML не исполняются — выдача скачиванием в песочнице CSP; архивы и типы проверяются — `tests/imports.test.ts` A38; модель и MCP — 08, 16) |
| I17 | Секреты не попадают в Git, логи, чат и MCP; документы защищены как их фрагменты | 02, 07, 16, 17 | ADR-006 §14; `packages/config`; ADR-003 §5 | A35, A39 | test-plan A35/A39; скан секретов в проверках этапов | — | PARTIAL (02: `config:check` без значений, секреты только в окружении, журналы процессов без секретов — `tests/platform.test.ts`, `artifacts/stage-02/smoke.log`) |
| I18 | Нельзя заявлять полную проверку при неполной обработке | 04, 09 | state-machines §8; test-plan §5 | A16, A44 | test-plan A16/A44 | — | DESIGNED |
| I19 | Неизменяемость защищает от действий приложения, но не абсолютна | 13, 17 | ADR-002 §3 | — | ревью этапов 13 и 17; отдельного сценария нет | — | PARTIAL (02: две линии для `audit_event` — права роли и триггер `forbid_mutation`, `tests/concurrency.test.ts`) |

## Обязательные функции

| ID требования | Требование | Этап | Реализация | Case IDs | Проверка/артефакт | Ревью | Статус |
|---|---|---|---|---|---|---|---|
| F01 | Договор: обязательства и противоречия с расчётом | 08, 09 | data-model §4.7; test-plan A02 | A02 | test-plan A02 | — | DESIGNED |
| F02 | ТЗ, его редакции и согласованные замены | 08, 09 | data-model §4.3, §4.7; walkthroughs §1 | A01, A06 | test-plan A01/A06 | — | DESIGNED |
| F03 | Формы приложений компании и заказчика | 11, 12 | data-model §4.8; state-machines §11.1 (`TEMPLATE_DEMO`) | A09, A41 | test-plan A09/A41; Q-08 | — | DESIGNED |
| F04 | RDWeb — основное распознавание | 04 | contracts/adapters §3 «Реализация (этап 04)»; ADR-007 §9; миграция 0005; `packages/adapters` | A16, A17, A43 | `tests/adapters.test.ts`, `tests/recognition.test.ts`, `tests/bbox.test.ts`, `artifacts/stage-04/{vitest,ui-check}.log`; Q-02 открыт, X-05 вне объёма этапа | — | IMPLEMENTED (импорт экспорта); автоматическая постановка задач — BLOCKED_EXTERNAL |
| F05 | LocalAI — поиск по закреплённым версиям | 05 | ADR-008; contracts/adapters §4 | A10, A11, A12, A42 | test-plan A10–A12/A42; X-04, Q-13 | — | DESIGNED |
| F06 | TenderHub — закрытие расчёта и коммерческая стоимость | 06, 10 | ADR-007 §5–8; contracts/adapters §2; data-model §4.5 | A07, A18, A19, A20, A21, A22, A23 | test-plan A07/A18–A23; Q-01, Q-05, X-01, U-04 | — | DESIGNED |
| F07 | Переговоры: записи, транскрипции, подсказки | 07 | contracts/adapters §6; data-model §4.6 | A03 | test-plan A03; Q-06 | — | DESIGNED |
| F08 | MailHub: переписка, вопросы–ответы, отправленные | 07, 15 | contracts/adapters §5; ADR-006 §9–10 | A32, A33, A34, A35 | test-plan A32–A35; X-03, Q-07 | — | DESIGNED |
| F09 | Источники между этапами: поздние, унаследованные, переименованные | 03, 15 | data-model §4.3; state-machines §5, §13 | A07, A08, A11, A13, A14 | test-plan A07/A08/A11/A13/A14 | — | PARTIAL (03: переименование и повторное получение — происхождения одной редакции, новое содержимое — новая редакция, состав источников этапа — `tests/intake.test.ts`, `tests/imports.test.ts`, `tests/sourceSets.test.ts`; унаследованные источники между этапами — 15) |
| F10 | Роли: два инженера и руководитель | 02, 13 | ADR-006 | A24, A25, A45 | test-plan A24/A25/A45; Q-09 | — | PARTIAL (02: роли, назначения, не более двух инженеров, bootstrap — `tests/*.test.ts`; согласование — 13) |
| F11 | Размещение на Яндекс Диске | 14 | contracts/adapters §7; state-machines §16 | A28, A29, A30 | test-plan A28–A30; Q-10 | — | DESIGNED |
| F12 | Размещение в сетевой папке SMB | 14 | contracts/adapters §7; state-machines §16 | A28, A29, A30 | test-plan A28–A30; Q-10 | — | DESIGNED |
| F13 | Фиксация отправки с основанием | 15 | data-model §4.10; state-machines §17 | A31, A32, A46 | test-plan A31/A32/A46 | — | DESIGNED |
| F14 | Сравнение двух выпусков | 15 | data-model §4.11; state-machines §18 | A20, A22, A23 | test-plan A20/A22/A23; X-02 | — | DESIGNED |
| F15 | Чат через Codex (MCP) | 16 | ADR-010; contracts/mcp-tools | A11, A12, A36, A37 | test-plan A11/A12/A36/A37; Q-12 | — | DESIGNED |
| F16 | Чат через Cursor (MCP) | 16 | ADR-010; contracts/mcp-tools | A11, A12, A36, A37 | test-plan A11/A12/A36/A37; Q-12 | — | DESIGNED |
| F17 | Резервное копирование и восстановление | 17 | ADR-011 §7–12 | A40 | test-plan A40; U-06, U-07 | — | DESIGNED |
| F18 | Кандидат, согласование, выпуск | 12, 13 | state-machines §11–15 | A09, A25, A26, A27, A45 | test-plan A09/A25–A27/A45 | — | DESIGNED |
| F19 | Долговечная очередь, восстановление, ограничение GPU | 03, 17 | ADR-004 | A15 | test-plan A15; U-05, U-08 | — | PARTIAL (03: очередь, аренда, recovery, слот GPU, повторы — `tests/queue.test.ts`; реальная GPU-нагрузка и целевой ПК — U-05, U-08, этап 17) |
| F20 | Реестр требований, покрытие, разногласия | 08, 09 | data-model §4.7; state-machines §7–8 | A04, A05, A44 | test-plan A04/A05/A44 | — | DESIGNED |
| F21 | Экономика: виды цен, разложение, сопоставление | 10 | ADR-005; data-model §4.5, §4.11 | A18, A19, A20, A21, A22, A23 | test-plan A18–A23; Q-05, X-02 | — | DESIGNED |
| F22 | Видимое состояние интеграций и деградация | 17 | state-machines §19; data-model §4.12 | A39, A42, A43 | test-plan A39/A42/A43 | — | DESIGNED |
| F23 | Русский интерфейс, LAN/VPN, без публикации в интернете | 02, 17 | ADR-001; ADR-006 §13 | — | U-02 | — | PARTIAL (02: русский интерфейс, HTTP только loopback, для LAN обязателен TLS — `tests/platform.test.ts`; целевой ПК и сертификат — 17, U-02) |
| F24 | Даты с часовым поясом, отображение Europe/Moscow | 01, 02 | ADR-005 §8 | — | тесты форматирования этапа 02 | — | DESIGNED |
| F25 | Пилот на эталонном тендере | 18 | test-plan §6 | все A01–A46 | Q-11 | — | NOT_STARTED |

## Ограничения первой версии

| ID требования | Требование | Этап | Реализация | Case IDs | Проверка/артефакт | Ревью | Статус |
|---|---|---|---|---|---|---|---|
| C01 | Не создавать второй OCR/RAG без доказанной необходимости | 01, 04, 05 | ADR-008 §7 (обоснование), ADR-007 | A43 | ревью этапа 01 и 05 | — | DESIGNED |
| C02 | Не переписывать соседние системы; доработки — отдельными заданиями | все | ADR-007 §1–3; unknowns §3 | — | X-01…X-05 | — | DESIGNED |
| C03 | Нет встроенного чата на подписочных токенах и UI-автоматизации | 16 | ADR-009 §8; ADR-010 §5 | — | ревью этапа 16 | — | DESIGNED |
| C04 | Нет автоматической рассылки заказчику | 15 | data-model §4.10; state-machines §17 | A31 | test-plan A31 | — | DESIGNED |
| C05 | Telegram — вне первой версии | 18 (backlog) | не входит в архитектуру первой версии | — | — | — | NOT_STARTED |
