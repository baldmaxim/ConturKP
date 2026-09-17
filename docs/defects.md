# Контур КП — журнал дефектов

| ID | Этап | Приоритет | Триггер/влияние | Инвариант | Статус | Fix commit | Регрессия | Reviewer closure |
|---|---|---|---|---|---|---|---|---|
| R00-01 | 00 | P2 | `discovery.md` называл `POST /api/dify/retrieval` маршрутом без токена по одному исключению из middleware; этап 01 получил бы неверную карту авторизации LocalAI | — (точность инвентаризации) | CLOSED_BY_REVIEW | `e2c8812` | путь middleware → обработчик → `authorizeDifyAdapterRequest` сверен вручную в ревизии `c03a3c4`; существование новых ссылок проверяет `verify_discovery.py` | `docs/reviews/00-review-2.md` — CLOSED |
| R00-02 | 00 | P2 | `verify_discovery.py` давал PASS без образца RDWeb и падал с `FileNotFoundError` без архива API; пути были привязаны к машине Claude | I18 | CLOSED_BY_REVIEW | `e2c8812` | `test_verify_discovery.py`, 8 сценариев: все материалы, нет RDWeb, нет архива API, нет ревизии Git, режим `--docs-only`, изменённый архив, строка вне файла, явные пути | `docs/reviews/00-review-2.md` — CLOSED |
