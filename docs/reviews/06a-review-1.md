# Контур КП — Review 06a-1

**Вердикт: CHANGES REQUIRED**

Основная архитектура Stage 06a принимается.

Найден один блокирующий дефект второй линии БД.

## R06a-01 — неполный инвариант creator-выдачи contract_access

**Severity: MEDIUM**  
**Статус: OPEN**

### Проблема

`contract_access` использует `source = 'creator'` для прав, автоматически выданных создателю конкретного договора.

Сейчас БД проверяет:

- `granted_by = user_id`;
- generated `creator_contract_id`;
- FK `(creator_contract_id, user_id) → contract(id, created_by)`.

Однако для глобальной capability:

`contract.create`

`contract_id = NULL`.

При `source = 'creator'` generated `creator_contract_id` также становится NULL, а обычный PostgreSQL FK с NULL не проверяет наличие родительской строки.

Поэтому прямой INSERT под ролью приложения может создать логически невозможную запись:

`source = creator`  
`capability = contract.create`  
`contract_id = NULL`

без какого-либо созданного этим пользователем договора.

Кроме того, схема сама не запрещает creator-выдачу:

`contract.link`

хотя принятая интерпретация Stage 06a — создатель автоматически получает только:

- `contract.read`;
- `contract.manage`.

`contract.link` выдаётся отдельно.

### Требуемый инвариант

На уровне БД обеспечить:

если:

`source = 'creator'`

то обязательно:

- `contract_id IS NOT NULL`;
- пользователь действительно является `created_by` этого договора;
- capability входит только в разрешённый creator-набор:
  - `contract.read`;
  - `contract.manage`.

`contract.create` не может иметь `source = creator`.

`contract.link` не может иметь `source = creator`.

Глобальный `contract.create` должен иметь административное/явное происхождение согласно существующей модели выдачи, но не маскироваться как право создателя договора.

### Реализация

Предпочтительно закрыть это декларативным CHECK рядом с существующими constraints.

Например, семантически:

`source <> 'creator' OR (contract_id IS NOT NULL AND capability IN ('contract.read','contract.manage'))`

при сохранении существующего creator FK.

Конкретное имя constraint выбери по стилю схемы.

Не переносить эту проверку только в TypeScript.

## Обязательные регрессии

Добавить прямые DB-тесты под ролью приложения:

1. настоящий создатель + `contract.read` + `source=creator` → PASS;
2. настоящий создатель + `contract.manage` + `source=creator` → PASS;
3. другой пользователь + `contract.read` + `source=creator` → DB отказ;
4. `contract.create` + `source=creator` + `contract_id=NULL` → DB отказ;
5. `contract.link` + `source=creator` → DB отказ;
6. `contract.create` с нормативным административным происхождением → PASS;
7. существующее создание договора через API по-прежнему выдаёт создателю ровно `read + manage`.

## Что НЕ менять

Не переделывать:

- ownership chain (цепочку владения);
- migration matrix;
- десять ownership-таблиц;
- `evidence_scope`;
- search architecture;
- many-to-many договор ↔ тендер;
- `contract.read/link/manage/create`;
- исторические снимки;
- UI;
- Stage 05a;
- Stage 06.

Исправление должно быть узким.

# Интерпретации Stage 06a

Все девять интерпретаций из `06a-report.md` подтверждаются ревьюером:

1. создатель получает `contract.read` и `contract.manage`, но не `contract.link` — **CONFIRMED**;
2. `admin.contract` только ведёт строки доступа и не открывает содержимое — **CONFIRMED**;
3. выдача содержательных прав действует для инженерной/руководящей роли, системный администратор сам по себе не получает чтение — **CONFIRMED**;
4. `contract.manage` без `contract.read` может менять номер/предмет и архивировать; контрагент и дата требуют `contract.read` — **CONFIRMED**;
5. связь с тендером требует также `source.write` по этому тендеру — **CONFIRMED**;
6. архивирование связи исключает договор из рабочего состава, но не разрушает исторические снимки — **CONFIRMED**;
7. barrier event (событие барьера) после распознавания договора отправляется только затронутым этапам, куда редакция была явно включена — **CONFIRMED**;
8. `document_occurrence` для договорной загрузки на Stage 06a не добавляется — **CONFIRMED**;
9. audit log (журнал аудита) не раскрывает содержательные поля пользователям без `contract.read` — **CONFIRMED**.

Эти интерпретации после закрытия R06a-01 можно считать частью принятого контракта Stage 06a и зафиксировать в документации.

## Остальная часть Review 06a-1

Предварительно принимаются:

- AD-06a-1 / вариант B;
- migration matrix;
- 15 DB-инвариантов ownership;
- many-to-many contract ↔ tender;
- contract/addendum/appendix;
- immutable document revision;
- отсутствие физического удаления;
- fail-closed search;
- повторная проверка `contract.read` при чтении результатов;
- отзыв права после индексирования;
- историческая воспроизводимость scope;
- отсутствие автоматического расширения области поиска через contract-tender link;
- отсутствие реализации Stage 05a;
- отсутствие изменений Stage 06.

## После исправления

Прогнать:

- новые тесты R06a-01;
- `contractsSchema.test.ts`;
- `contracts.test.ts`;
- полный vitest;
- typecheck;
- smoke.

UI-check повторять не требуется, если интерфейс не меняется.

Сделать отдельный маленький commit поверх `0778fa0`.

Передать на **Review 06a-2**.

Review 06a-2 будет узким — только R06a-01, регрессии и фиксация девяти подтверждённых интерпретаций.

Следующий этап не начинать.
