# Архитектурные решения (ADR)

ADR предложены на этапе 01 и приняты вместе с этапом (ревью 01-4, коммит `f8a0f20`). Уточнения при реализации дописываются в ADR разделом «Реализация» с номером этапа. Технический выбор в рамках требований делает разработчик; изменение бизнес-требований ADR не оформляется (см. `docs/decisions.md`).

| ADR | Решение | Статус |
|---|---|---|
| [ADR-001](ADR-001-stack-and-processes.md) | Node.js 24 LTS и TypeScript, React + Vite, два процесса приложения | accepted |
| [ADR-002](ADR-002-postgresql-and-migrations.md) | PostgreSQL, классы изменяемости, миграции SQL | accepted |
| [ADR-003](ADR-003-file-storage.md) | Хранилище файлов по SHA-256, только запись без перезаписи | accepted |
| [ADR-004](ADR-004-durable-job-queue.md) | Долговечная очередь заданий в PostgreSQL | accepted |
| [ADR-005](ADR-005-money-time-concurrency-idempotency.md) | Деньги, время, оптимистичная конкуренция, идемпотентность | accepted |
| [ADR-006](ADR-006-access-roles-isolation.md) | Пользователи, роли, изоляция тендеров и почтовых ящиков | accepted |
| [ADR-007](ADR-007-sources-of-truth-and-adapters.md) | Источники истины и адаптеры интеграций | accepted |
| [ADR-008](ADR-008-search-scope.md) | Область поиска — явные ID разрешённых редакций | accepted |
| [ADR-009](ADR-009-model-and-rules.md) | Место модели и программных правил | accepted |
| [ADR-010](ADR-010-portal-mcp.md) | MCP-сервер портала для Codex и Cursor | accepted |
| [ADR-011](ADR-011-deployment-backup-restore.md) | Запуск на Windows, миграции, резервное копирование и восстановление | accepted |
