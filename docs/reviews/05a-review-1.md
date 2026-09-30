# Контур КП — Review 05a-1

**Вердикт: CHANGES REQUIRED**

Основная реализация Stage 05a принимается предварительно.

Найден один блокирующий дефект DB-инварианта.

## R05a-01 — размеры физической PDF-страницы обязательны не для всех статусов

**Severity: MEDIUM**  
**Status: OPEN**

AD-05a-1 и интерпретация №13 определяют:

> `pdf_page` является физической страницей и всегда имеет `width_px` и `height_px`.

Штатный локальный PDF pipeline это выполняет: размер вычисляется до проверки текстового слоя/OCR и сохраняется независимо от итогового статуса страницы.

Но constraint миграции `0014_local_recognition.sql` сейчас допускает NULL-размеры для PDF-страниц со статусами:

- `needs_review`;
- `missing`;
- `failed`.

Текущий CHECK фактически требует размеры только при:

`status = 'recognized'`.

Это позволяет создать через прямой SQL состояние, невозможное по AD-05a-1 и заявленной модели source unit.

### Требуемое исправление

Для:

`unit_kind = 'pdf_page'`

БД должна всегда требовать:

- `width_px IS NOT NULL`;
- `height_px IS NOT NULL`.

Независимо от:

- `recognized`;
- `needs_review`;
- `missing`;
- `failed`.

Для логических единиц:

- `xlsx_sheet`;
- `csv_table`;
- `docx_body`;

сохраняется обратное правило:

- `width_px IS NULL`;
- `height_px IS NULL`;
- отсутствие фиктивной геометрии.

Исправить отдельной узкой миграцией поверх `0014`.

Не переписывать миграцию `0014`, уже являющуюся частью проверяемого состояния.

## Регрессии

Добавить DB-тесты минимум:

1. `pdf_page + recognized + NULL dimensions` → отказ;
2. `pdf_page + needs_review + NULL dimensions` → отказ;
3. `pdf_page + missing + NULL dimensions` → отказ;
4. `pdf_page + failed + NULL dimensions` → отказ;
5. все четыре статуса с нормальными размерами → допустимы там, где сам статус разрешён моделью;
6. `xlsx_sheet/csv_table/docx_body` с размерами → отказ;
7. логическая единица без размеров → PASS.

Желательно отдельным тестом подтвердить, что production PDF pipeline по-прежнему действительно записывает размеры для:

- слабого текстового слоя;
- `ocr_unreadable`;
- `ocr_unavailable`.

## Что не менять

Не переделывать:

- `recognition_preferred_run`;
- PDF route policy;
- RDWeb/local priority;
- recognizer fingerprint;
- quality thresholds;
- DOCX/XLSX/CSV parsers;
- OCR adapter;
- contract permissions;
- search/evidence;
- UI;
- Stage 04–06a.

Исправление должно быть только DB constraint + регрессии + документация дефекта.

# Интерпретации

Подтверждены:

1. `needs_review` наружу = существующий `recognition_run.status = partial` + `outcome=needs_review` — **CONFIRMED**.
2. `engine=local_ocr` для всех локальных форматов; способ обработки — в recognizer — **CONFIRMED**.
3. recognition route хранится на document и действует на его revisions — **CONFIRMED**.
4. queued/running/complete/partial RDWeb закрывает local; failed/cancelled — нет — **CONFIRMED**.
5. отсутствие `created_by` отличает автоматическую постановку; PDF auto таким путём запрещён — **CONFIRMED**.
6. договор: требуется `contract.read` для видимости и `contract.manage` для команды — **CONFIRMED**.
7. OCR confidence `<40` → failed, `40–80` → needs_review — **CONFIRMED как текущий fixture-derived threshold**.
8. слабый native-text без OCR → needs_review; скан без OCR → missing; без пригодного текста run failed — **CONFIRMED**.
9. mismatch recognizer fingerprint → `recognizer_changed`, старой конфигурацией run не выполняется — **CONFIRMED**.
10. XLSX empty/hidden/formula/formatting policy — **CONFIRMED**.
11. XLSX row anchors и CSV row anchors — **CONFIRMED**.
12. DOCX headers/comments/revisions/altChunk/external link policy — **CONFIRMED**.
13. физическая PDF page всегда имеет размеры — **CONFIRMED AS REQUIREMENT; R05a-01 закрывает неполную DB-защиту**.
14. Locus case 10: гейт 05a — строки сметы и anchors, не ranking основания договора — **CONFIRMED**.
15. автоматическая постановка через maintenance pass worker — **CONFIRMED**.

# Windows

Целевой Windows-ПК:

`NOT_RUN`

не блокирует Review 05a.

U-08 остаётся эксплуатационной проверкой Stage 17.

При Stage 17 обязательно проверить на целевой машине минимум:

- запуск `tesseract.js`;
- загрузку `rus/eng` моделей без сети;
- `@napi-rs/canvas`;
- текстовый PDF;
- сканированный PDF;
- память;
- время OCR;
- длинный многостраничный документ;
- worker restart.

Это не требуется для закрытия R05a-01.

## После исправления

Прогнать:

- новые R05a-01 tests;
- `localRecognitionSchema.test.ts`;
- `localPdf.test.ts`;
- все Stage 05a tests;
- полный vitest;
- typecheck;
- smoke.

UI-check повторять не требуется, если UI не меняется.

Сделать отдельный небольшой commit поверх `86c0e15`.

Передать ZIP на **Review 05a-2**.

Review 05a-2 будет узким: R05a-01, связанные тесты и подтверждение, что остальная реализация не менялась.

Stage 07 не начинать.
