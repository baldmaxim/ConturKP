# Контур КП — Review 05a-2

**Вердикт: CHANGES REQUIRED**

Исправление R05a-01 принимается по существу, включая исключение для исторической страницы RDWeb, отсутствующей в экспортном `_blocks.json`.

Однако DB-инвариант пока шире необходимого.

## R05a-01 — остаётся OPEN

### Что уже исправлено правильно

Подтверждено:

- локальный `pdf_page` без размеров запрещён при `recognized`;
- запрещён при `needs_review`;
- запрещён при `missing`;
- запрещён при `failed`;
- штатный local pipeline записывает размеры при всех этих исходах;
- логические DOCX/XLSX/CSV units не получают фиктивные размеры;
- upgrade 0014 → 0015 сохраняет исторический `rdweb_export missing` без размеров;
- Stage 04 не изменён.

Это принимается.

## Оставшаяся проблема

`recognition_page_unit_shape` разрешает:

`unit_kind = pdf_page`
`status = missing`
`width_px = NULL`
`height_px = NULL`

для любого engine.

`recognition_page_unit_guard()` затем закрывает такой случай только для:

`engine = local_ocr`.

Но в схеме остаются и другие допустимые engines:

- `rdweb_export`;
- `rdweb_api`;
- `text_layer`;
- `local_ocr`.

Следовательно `text_layer` или `rdweb_api` могут через прямой INSERT создать `missing pdf_page` без размеров.

Это противоречит заявленному узкому исключению:

> без размеров допускается только исторический случай страницы RDWeb-export, которой нет в `_blocks.json`.

### Требуемое правило

NULL-размеры у физической `pdf_page` допустимы **только** при одновременном выполнении:

- `engine = 'rdweb_export'`;
- `status = 'missing'`.

Во всех остальных случаях физическая PDF page обязана иметь размеры.

То есть:

- `local_ocr missing` без размеров → отказ;
- `text_layer missing` без размеров → отказ;
- `rdweb_api missing` без размеров → отказ;
- `rdweb_export recognized/failed` без размеров → отказ;
- `rdweb_export missing` без размеров → PASS.

Не расширять исключение на будущий `rdweb_api`, пока для него нет принятого контракта, доказывающего необходимость такого поведения.

## Как исправить

CHECK может остаться общим, поскольку он не видит engine родительского run.

Узкое правило удобно закрыть в `recognition_page_unit_guard()`:

если:

`unit_kind = 'pdf_page'`
и один из размеров NULL,

то разрешить это только при:

`v_engine = 'rdweb_export'`
и
`NEW.status = 'missing'`.

В остальных случаях — `23514`.

Кроме того, migration precheck должен отвергать уже существующую строку без размеров, если это не:

`rdweb_export + missing`.

Сейчас precheck проверяет только `local_ocr`, поэтому его также нужно сузить по смыслу исключения.

## Регрессии

К уже существующим тестам добавить минимум:

1. `rdweb_export + missing + NULL dimensions` → PASS;
2. `rdweb_export + recognized + NULL dimensions` → отказ;
3. `rdweb_export + failed + NULL dimensions` → отказ;
4. `local_ocr + missing + NULL dimensions` → отказ;
5. `text_layer + missing + NULL dimensions` → отказ;
6. `rdweb_api + missing + NULL dimensions` → отказ;
7. upgrade допускает исторический `rdweb_export missing`;
8. upgrade отклоняет существующий `text_layer missing` без размеров;
9. upgrade отклоняет существующий `rdweb_api missing` без размеров.

Если создание `rdweb_api` сейчас невозможно через нормативный API, тест всё равно должен проверять DB-инвариант прямой записью под ролью приложения.

## Что не менять

Не менять:

- Stage 04 importer;
- local PDF pipeline;
- AD-05a-1;
- RDWeb/local selection;
- parsers;
- OCR;
- UI;
- 15 подтверждённых интерпретаций;
- Windows/U-08.

Исправление должно остаться узким: guard + migration precheck + регрессии.

## Windows

Позиция Review 05a-1 сохраняется:

Windows `NOT_RUN` не блокирует Stage 05a.

U-08 остаётся обязательной эксплуатационной проверкой Stage 17.

## Следующее действие

Сделать отдельный маленький commit поверх `e92486e`.

После исправления передать на **Review 05a-3**.

Review 05a-3 будет проверять только:

- точность исключения `rdweb_export + missing`;
- новые негативные DB-тесты;
- upgrade;
- отсутствие изменений остального Stage 05a.

Stage 07 не начинать.
