# Контур КП — Review 05a-3

**Вердикт: PASS**

**R05a-01: CLOSED_BY_REVIEW**

**Stage 05a: ACCEPTED**

Проверен коммит:

`33cb0098e18269d8d55c21e61f879f4da2175256`

поверх:

`e92486e`

## R05a-01

Исправление принимается.

Финальный инвариант:

физическая `pdf_page` обязана иметь `width_px` и `height_px`.

Единственное допустимое исключение:

`recognition_run.engine = 'rdweb_export'`
+
`recognition_page.status = 'missing'`.

Это исключение сохраняет поведение принятого Stage 04 для страницы, отсутствующей в `_blocks.json`.

На:

- `rdweb_api`;
- `text_layer`;
- `local_ocr`;

страница PDF без размеров запрещена при `missing`.

Для `recognized` и `failed` отсутствие размеров дополнительно отклоняется общим DB CHECK.

## Migration 0016

`0016_recognition_page_rdweb_missing_only.sql` принимается.

Перед применением миграция проверяет уже существующие данные.

Upgrade разрешён только если все существующие PDF-страницы без размеров соответствуют:

`rdweb_export + missing`.

Если существует иная строка без размеров, миграция завершается `23514`, версия схемы не повышается.

Исторический `rdweb_export missing` сохраняется.

## Регрессии

Набор `regressions-r05a.test.ts` принимает требуемую матрицу:

- `rdweb_export missing` без размеров → PASS;
- `rdweb_export recognized/failed` → отказ;
- `rdweb_api missing` → отказ;
- `text_layer missing` → отказ;
- `local_ocr missing` → отказ;
- те же движки с корректными размерами → PASS;
- logical units (логические единицы) сохраняют правило отсутствия пиксельной геометрии;
- upgrade 0015 → 0016 проверен;
- отрицательные upgrade-сценарии проверены.

Дополнительно подтверждено, что без migration 0016 новые тесты воспроизводят дефект Stage 05a-2.

## Остальной Stage 05a

Предыдущий Review 05a-1 остаётся в силе.

Приняты:

- RDWeb/local routing;
- deterministic preferred run (детерминированный выбор предпочтительного прогона);
- DOCX/XLSX/CSV structural parsing;
- PDF native text → OCR fallback;
- quality gate;
- recognition fingerprint/idempotency;
- договорные permissions;
- search/evidence isolation;
- structural anchors;
- реальный XLSX fixture;
- все 15 интерпретаций D-024.

## Проверки

По артефактам передачи:

- vitest: **545/545 PASS**;
- typecheck — PASS;
- build — PASS;
- smoke — **42 PASS**;
- схема БД — 16 migrations.

UI не менялся после ранее принятого UI-check, поэтому повтор не требуется.

## Windows

Позиция предыдущих review сохраняется:

целевой Windows-ПК — `NOT_RUN`.

Это **не блокирует Stage 05a**.

U-08 остаётся обязательной эксплуатационной проверкой Stage 17.

## Итог

**Review 05a-3: PASS**

**Stage 05a: ACCEPTED**

**R05a-01: CLOSED_BY_REVIEW**

Теперь разрешается:

1. сохранить `docs/reviews/05a-review-3.md`;
2. перевести R05a-01 в `CLOSED_BY_REVIEW`;
3. отметить Stage 05a как `ACCEPTED`;
4. обновить traceability/project-state;
5. сделать отдельный документальный commit;
6. запушить ветку `stage-05a`;
7. проверить remote HEAD и чистое рабочее дерево.

Stage 07 самостоятельно не начинать.

Перед Stage 07 провести отдельный preflight, поскольку ранее для него уже были известны X-03, Q-06 и Q-07.
