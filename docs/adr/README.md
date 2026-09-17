# Архитектурные решения (ADR)

Статус `proposed` — решение предложено на этапе 01 и принимается вместе с этапом после независимого ревью. Технический выбор в рамках требований делает разработчик; изменение бизнес-требований ADR не оформляется (см. `docs/decisions.md`).

| ADR | Решение | Статус |
|---|---|---|
| [ADR-001](ADR-001-stack-and-processes.md) | Node.js 24 LTS и TypeScript, React + Vite, два процесса приложения | proposed |
| [ADR-002](ADR-002-postgresql-and-migrations.md) | PostgreSQL, классы изменяемости, миграции SQL | proposed |
| [ADR-003](ADR-003-file-storage.md) | Хранилище файлов по SHA-256, только запись без перезаписи | proposed |
| [ADR-004](ADR-004-durable-job-queue.md) | Долговечная очередь заданий в PostgreSQL | proposed |
| [ADR-005](ADR-005-money-time-concurrency-idempotency.md) | Деньги, время, оптимистичная конкуренция, идемпотентность | proposed |
| [ADR-006](ADR-006-access-roles-isolation.md) | Пользователи, роли, изоляция тендеров и почтовых ящиков | proposed |
| [ADR-007](ADR-007-sources-of-truth-and-adapters.md) | Источники истины и адаптеры интеграций | proposed |
| [ADR-008](ADR-008-search-scope.md) | Область поиска — явные ID разрешённых редакций | proposed |
| [ADR-009](ADR-009-model-and-rules.md) | Место модели и программных правил | proposed |
| [ADR-010](ADR-010-portal-mcp.md) | MCP-сервер портала для Codex и Cursor | proposed |
| [ADR-011](ADR-011-deployment-backup-restore.md) | Запуск на Windows, миграции, резервное копирование и восстановление | proposed |
