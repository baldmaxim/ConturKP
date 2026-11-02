# Воспроизводимая сверка корпуса Locus и staging

Инструменты этапа 19; Node24, для extract — pg_restore18.6. Приложение/БД не запускаются. Все результаты частные, вне Git. Полный повтор делается в новых каталогах; старые результаты не перезаписываются. `--out-dir` требует существующего родителя и отсутствующего конечного каталога.

## Входы

1. Согласованный backup: `db.dump`, его `manifest.json` и каталог `files`. `extract` проверяет SHA/размер дампа до pg_restore и не передаёт ему `--dbname`.
2. Сохранённые JSON: исходный registry Locus (`files`), каталог `sources:[{sourceId,roots:[абсолютные пути]}]`, частичная опись Locus от `locus-export-registry.mjs`, физическая опись договорных редакций backup от того же экспортёра. Это входные данные, не исполняемый код.
3. Для точного повторения прежних чисел нужны именно зафиксированные SHA входов из `19-review1-reproducibility-20261030.json`. Новое чтение изменившихся оригиналов может законно дать другие числа. Частные входы не распространяются в кодовом ZIP.

## 1. Метаданные backup и план физического чтения

Пример PowerShell с условными путями; оператор выбирает существующий backup и новый рабочий каталог. Предварительно создать `$Stage19Work`, не существующие дочерние каталоги.

```powershell
$Stage19Backup = '<existing-backup>'
$Stage19Work = '<new-private-workdir>'
node scripts/ops/locus-corpus-workflow.mjs extract --dump "$Stage19Backup/db.dump" --manifest "$Stage19Backup/manifest.json" --pg-restore '<pg_restore executable>' --out-dir "$Stage19Work/extracted"
node scripts/ops/locus-corpus-workflow.mjs prepare-portal --tables "$Stage19Work/extracted/tables.private.json" --files-root "$Stage19Backup/files" --out-dir "$Stage19Work/portal-read-plan"
node scripts/ops/locus-export-registry.mjs --registry "$Stage19Work/portal-read-plan/registry.private.json" --sources "$Stage19Work/portal-read-plan/sources.private.json" --out "$Stage19Work/portal-physical.private.json" --max-bytes 50000000000 --max-ms 900000 --concurrency 3
```

`extract` передаёт pg_restore только фиксированные `--data-only --no-owner --no-privileges --file=- --table=...`; SQL идёт в память/частный файл, не исполняется. Разбираются COPY text, UTF8, `\\`, `\N`, табы/новые строки, octal/hex. Дубликаты таблиц, обрезанные блоки, неверное число колонок и недопустимый UTF8 отклоняются. Версия pg_restore может менять служебные комментарии; значимы таблицы и SHA сохранённых входов, а не случайные SQL-заголовки.

План чтения строится из contract/document/document_revision/blob. Область revision должна совпадать с document, blob storage_key обязан соответствовать SHA. Имена документов не выбирают содержимое. Физический экспорт сохраняет исходные ошибки/неизвестные SHA и даёт exit2 как частичная опись.

При повторе на прежних зафиксированных входах физические описи можно переиспользовать. Их происхождение и SHA проверяются отдельно; такой повтор не является свежим чтением рабочей установки.

## 2. Области, кандидаты и staging-plan

```powershell
node scripts/ops/locus-corpus-workflow.mjs analyze --tables "$Stage19Work/extracted/tables.private.json" --manifest "$Stage19Backup/manifest.json" --portal-physical '<frozen-portal-physical.json>' --locus '<frozen-locus-inventory.json>' --registry '<frozen-locus-registry.json>' --sources '<frozen-source-catalog.json>' --out-dir "$Stage19Work/analyzed"
```

Выходы: `portal.private.json`, `classification.private.json`, `crosswalk.private.json`, `staging-plan.private.json`, `comparison.private.json`, `summary.json`, квитанция входных/выходных/программных SHA. `analyze` даёт exit2: это кандидатная частичная сверка, всегда retirementAllowed=false.

Сначала по конфигурационным корням/предкам вычисляется source_key существующего history-binding. Относительный folder_path привязывает **путь оригинала** к договору. Выбирается наиболее конкретная папка, противоречивые равные папки остаются SCOPE_AMBIGUOUS. Только затем ищется равный SHA/размер в выбранной области портала. Совпадение только в чужой области — BLOB_ONLY_IN_OTHER_SCOPE, без crosswalk-ссылки и без автоматического staging. Это отдельно проверено синтетическим end-to-end CLI-сценарием.

crosswalk2 требует пустого массива scopes; область обязательна на каждой ссылке. Сам аудитор не удостоверяет истинность binding или ACL: он проверяет объявленные описи. Истинность происхождения и допуск пользователя остаются отдельной человеческой/живой проверкой. humanReviewed=false не снимается генератором.

План берёт только NO_EQUAL_BLOB_IN_BACKUP_CONTRACTS, группирует байты по SHA, сохраняет каждую логическую исходную идентичность и candidateScopeId. Один источник может охватывать несколько договоров. Неизвестные SHA и чужие области не теряются из classification, но не копируются автоматически.

## 3. Копирование и независимое перечитывание

```powershell
node scripts/ops/locus-stage.mjs --plan "$Stage19Work/analyzed/staging-plan.private.json" --sources '<source-catalog.json>' --store '<new-isolated-blobstore>' --portal-root '<portal-data-root>' --portal-root '<portal-storage-root>' --portal-root '<portal-config-root>' --out "$Stage19Work/copy.private.json"
node scripts/ops/locus-stage.mjs --verify-only --plan "$Stage19Work/analyzed/staging-plan.private.json" --store '<existing-isolated-blobstore>' --out "$Stage19Work/readback.private.json"
```

Копировщик проверяет структуру плана, уникальность SHA/исходных идентичностей, разрешённые корни и физические алиасы. Для копирования обязательны явные `--portal-root`: data/storage/config портала (либо их общий корень установки). Проверяются физические пути, в том числе junction; совпадение/вложенность назначения в любой из этих корней отклоняется до создания каталога. Эти проверенные границы попадают в квитанцию. Проверка существующего staging через `--verify-only` не требует новых portal-root, поскольку не пишет в store. Хранилище должно быть новым, вне корней оригиналов; существующее не очищается/не переиспользуется. Используется штатный BlobStore с проверкой SHA/размера. При изменении оригинала результат не объявляется успешным. Нет регистрации document_revision, OCR, миграций или изменения рабочей установки.

`--verify-only` не читает исходные сетевые файлы и не пишет в store. Он заново читает запланированные SHA-объекты, проверяет размер, SHA, границы пути и стабильность файла. Не доверяет старой copy-квитанции. Новая квитанция создаётся wx вне store. Exit0 — операция выполнена без ошибок, exit2 — ошибки копирования/чтения, exit1 — вход/IO; ни один код не разрешает отключение Locus.

## Проверки

`npm run test:node`, `npm run typecheck`. Синтетические тесты содержат чужой договор с тем же SHA, выбор правильной области независимо от порядка target-строк, неоднозначную папку, traversal, дубликаты и отсутствие хэшей; копирование реальных временных байтов, изменение источника, порчу staging, алиасы и отказ от перезаписи. Оригиналы пользователя в тестах не используются.

23 913 873 379 байт исходного экспорта — **сумма по успешно прочитанным записям реестра**, не уникальным файлам и не объём сетевого IO. Если две записи ссылаются на один файл, его размер входит дважды. Аналогично сумма backup-описи относится к редакциям. В staging 9 546 189 056 байт — сумма уникальных SHA из плана. Экспортёр теперь возвращает statistics.byteAccounting=SUM_PER_REGISTRY_ENTRY_NOT_UNIQUE_FILES.
