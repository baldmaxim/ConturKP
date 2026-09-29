# Контур КП — Review 06a-2

**Вердикт: PASS**

**R06a-01: CLOSED_BY_REVIEW**

**Stage 06a: ACCEPTED**

Проверен коммит:

`456b2228fd27d5df15a29ecdd65f1bd8182b7b17`

поверх:

`0778fa0`

## R06a-01

Исправление принимается.

Миграция `0013_contract_access_creator.sql` добавляет DB-инвариант:

если:

`source = 'creator'`

то обязательно:

- `contract_id IS NOT NULL`;
- `capability IN ('contract.read', 'contract.manage')`.

Существующий FK:

`(creator_contract_id, user_id) → contract(id, created_by)`

остаётся и доказывает, что creator-право относится к реальному создателю конкретного договора.

Таким образом:

- глобальная `contract.create` не может маскироваться как creator-право;
- `contract.link` не может выдаваться с `source = creator`;
- creator-право без договора невозможно;
- creator-право другого пользователя на чужой договор невозможно.

## Регрессии

Приняты все 7 тестов R06a-01:

1. создатель + `contract.read` + creator → PASS;
2. создатель + `contract.manage` + creator → PASS;
3. другой пользователь + creator → DB отказ;
4. `contract.create` + creator + `contract_id=NULL` → DB отказ;
5. `contract.link` + creator → DB отказ;
6. глобальная `contract.create` с административным происхождением → PASS;
7. создание договора через API выдаёт создателю ровно `read + manage`.

Отдельно подтверждено, что тесты 4 и 5 воспроизводят дефект на старой схеме Stage 06a до migration 0013.

## Полная регрессия

По артефактам передачи:

- vitest: 46 файлов / 461 тест — PASS;
- typecheck — PASS;
- build — PASS;
- smoke — PASS;
- схема БД — версия 13.

Интерфейс не менялся, поэтому повторный UI-check для исправления R06a-01 не требуется.

## Девять интерпретаций

Зафиксированные Review 06a-1 интерпретации записаны в D-022 и считаются частью принятого контракта Stage 06a:

1. создатель получает `contract.read` и `contract.manage`, но не `contract.link`;
2. `admin.contract` не открывает содержимое;
3. роль администратора сама по себе не даёт `contract.read`;
4. `contract.manage` без `contract.read` допускает номер/предмет и архивирование, но не содержательные поля;
5. связь с тендером дополнительно требует `source.write`;
6. архив связи не изменяет исторические snapshots (снимки);
7. barrier event (событие барьера) направляется только этапам, куда revision явно включена;
8. `document_occurrence` для договорной загрузки Stage 06a не создаётся;
9. audit log (журнал аудита) не раскрывает содержимое без `contract.read`.

## Итог

**Review 06a-2: PASS**

**Stage 06a: ACCEPTED**

**R06a-01: CLOSED_BY_REVIEW**

Теперь разрешается:

1. сохранить `docs/reviews/06a-review-2.md`;
2. перевести R06a-01 в `CLOSED_BY_REVIEW`;
3. отметить Stage 06a как `ACCEPTED`;
4. сделать отдельный документальный commit;
5. запушить ветку `stage-06a`;
6. проверить remote HEAD и чистое рабочее дерево.

Следующий этап самостоятельно не начинать.

Перед началом следующего этапа провести отдельный preflight (предварительный аудит), если это предусмотрено принятой схемой этапов.
