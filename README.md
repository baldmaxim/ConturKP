# Контур КП

Локальный портал подготовки, проверки, согласования и выпуска коммерческих предложений Генподрядчика.

Разработка идёт по этапам пакета `docs/spec/`; состояние этапов — [docs/project-state.md](docs/project-state.md). Этапы 00–16 приняты; этап 17 — эксплуатация: службы Windows, копии и восстановление, состояние установки.

## Запуск

Разработка, тесты и чистый старт — [docs/runbooks/clean-start.md](docs/runbooks/clean-start.md). Установка на целевой Windows-ПК, службы, обновление — [docs/runbooks/release.md](docs/runbooks/release.md); копии и восстановление — [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md). Кратко: `npm ci`, `npm run pg:init && npm run pg:start`, `.env` по образцу `.env.example`, `npm run db:setup && npm run db:migrate`, `npm run bootstrap -- --login … --name "…"`, `npm run build`, `npm run start:server` и `npm run start:worker`.

| Каталог | Содержимое |
|---|---|
| `apps/server`, `apps/worker`, `apps/web` | процессы server и worker, интерфейс |
| `packages/core`, `packages/db`, `packages/contracts`, `packages/config` | доменные правила, доступ к БД, схемы API, конфигурация |
| `docs/migrations` | SQL-миграции |
| `tests` | интеграционные тесты на изолированной PostgreSQL |

## Начало разработки

1. Прочитать [инструкцию к пакету](docs/spec/README.md) и [спецификацию продукта](docs/spec/01_PRODUCT_SPEC.md).
2. Передать Claude Code [начальный промпт](docs/spec/02_CLAUDE_START.md). Первый запуск выполняет только этап 00 — инвентаризацию.
3. После каждого этапа передавать отчёт и точный коммит в независимое [ревью Codex](docs/spec/04_CODEX_REVIEW.md).
4. Исправлять замечания и переходить к следующему этапу после выполнения критериев приёмки.

## Состав пакета

- [19 этапов разработки](docs/spec/03_STAGE_PROMPTS.md), от изучения интеграций до бизнес-пилота.
- [Отдельные промпты этапов](docs/spec/prompts/).
- [46 приёмочных сценариев](docs/spec/05_ACCEPTANCE_CASES.md).
- [Шаблоны отчётов и контроля готовности](docs/spec/06_TRACKER_AND_TEMPLATES.md).
- [Наблюдения по интеграциям и открытые вопросы](docs/spec/07_INTEGRATION_DISCOVERY.md).

## Интеграции

TenderHub — расчёт и коммерческая стоимость; RDWeb — основное распознавание; поиск, цитаты и локальное распознавание — внутри портала (Locus закрыт решением D-013); локальная модель — через OpenAI-совместимый сервер (LM Studio); MailHub — переписка; сервис переговоров — записи и транскрипции; Яндекс Диск и сетевой ресурс — размещение выпусков; Codex/Cursor — работа с данными через MCP.

Реальные документы, письма, базы и секреты хранятся вне Git. Проверка на фикстурах не считается подтверждением работающей интеграции.
