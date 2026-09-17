# Контур КП — статус интеграций

Состояние на этап 00 (2026-09-17). Кода интеграций нет. Факты и ссылки — в `docs/discovery.md`.

| Система | Контракт/версия | Auth и scopes без секретов | Fixture | Live | Доработка | Владелец | Блокируемые этапы |
|---|---|---|---|---|---|---|---|
| TenderHub (чтение расчёта) | архив документации API от 2026-09-02; OpenAPI развёрнутой сборки не сверялся (R-06) | `X-API-Key`, область `tenders:read`, ограничение списком тендеров; ключ действует от имени выпустившего | NOT_IMPLEMENTED | NOT_IMPLEMENTED: ключ не выдавался (U-04) | X-01, X-02 | не назначен | 06 (production-gate), 10, 13 |
| RDWeb (импорт экспорта) | образец `schema_version` 1; подлинность не подтверждена (Q-02) | не требуется: файловый импорт | NOT_IMPLEMENTED | — | — | не назначен | 04 |
| RDWeb (API) | нет данных | нет данных | NOT_IMPLEMENTED | BLOCKED_EXTERNAL | X-05 | не назначен | автоматизация этапа 04 |
| LocalAI | репозиторий, ревизия `c03a3c4`; HTTP `/api/*`, MCP из 7 read-only инструментов | общий Bearer-токен `RAG_AUTH_TOKEN`, только loopback; ролей и тендерной изоляции нет | NOT_IMPLEMENTED | NOT_IMPLEMENTED | X-04 | не назначен | 05, 16 |
| MailHub | репозиторий, ревизия `6f21dee`; `/api/v1` | cookie-сессия человека и CSRF; машинного доступа нет | NOT_IMPLEMENTED | BLOCKED_EXTERNAL: нужен сервисный read-only доступ | X-03 | не назначен | 07, 15 |
| Сервис переговоров | не определён (Q-06) | нет данных | NOT_IMPLEMENTED | BLOCKED_EXTERNAL | определить после Q-06 | не назначен | 07 |
| Яндекс Диск | не изучался | нет данных (Q-10) | NOT_IMPLEMENTED | NOT_IMPLEMENTED | — | не назначен | 14 |
| Сетевая папка (SMB) | не изучалась | нет данных (Q-10) | NOT_IMPLEMENTED | NOT_IMPLEMENTED | — | не назначен | 14 |
| Codex (клиент MCP) | не изучался | нет данных (Q-12) | NOT_IMPLEMENTED | NOT_IMPLEMENTED | — | не назначен | 16 |
| Cursor (клиент MCP) | не изучался | нет данных (Q-12) | NOT_IMPLEMENTED | NOT_IMPLEMENTED | — | не назначен | 16 |
