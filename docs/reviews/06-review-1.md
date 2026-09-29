# Контур КП — Review 06-1

**Вердикт: PASS**

**Stage 06: ACCEPTED**

Проверен финальный артефакт:

`fa3b3224aa6a33f62269aee26133c16218d8e66e`

Последний implementation commit:

`696e52e5a77689f14cd2cedaa35d90fb5b3df072`

После Review 06-pre-3 production-код не изменялся.

## 1. U-04 — CLOSED для Stage 06

Живой прогон TenderHub выполнен успешно.

Подтверждено:

- настоящий TenderHub доступен;
- используется `X-API-Key`;
- Bearer не используется;
- выполнялись только GET-запросы;
- API key не попал в журнал;
- сырые коммерческие данные в журнал не попали;
- UUID маскирован;
- OpenAPI развёрнутой сборки получен и проверен;
- все пять требуемых Stage 06 маршрутов присутствуют;
- живой адаптер успешно прочитал расчёт.

`TenderHubReader` разрешается перевести:

`VERIFIED_FIXTURE → VERIFIED_LIVE`.

## 2. Pagination

Рабочая выгрузка при `limit=200` уложилась в одну страницу, поэтому:

`pagination_multi_page = NOT_OBSERVED`

зафиксирован корректно.

Отдельный read-only probe с `limit=31` подтвердил реальное поведение cursor pagination:

- 4 страницы;
- cursor менялся;
- повторов cursor — 0;
- дублей — 0;
- уникальных позиций — 93 из 93.

Live pagination принимается.

## 3. with-costs / no-cache

Подтверждено на живом API:

- HTTP 200;
- запрос отправлен с `Cache-Control: no-cache`;
- ответ TenderHub содержит собственный `private, max-age=60` и ETag;
- состав position ID совпадает с paginated positions;
- общие поля совпадают.

Результат принимается.

## 4. BOQ

Живой `boq-items-full`:

- 2363 строки;
- 2363 уникальных ID;
- дублей нет;
- orphan lines — 0;
- `items_count` совпал для 93 из 93 позиций.

R06-01 на живых данных не проявился; соответствующая защита остаётся в production-коде и регрессиях.

## 5. PortalCaptureStrategy

Реальная рабочая стратегия вернула:

`consistency = consistent`.

Подтверждено:

- before/after stable;
- positions cross-check;
- BOQ count;
- duplicate check;
- updated_at check.

Это подтверждает работоспособность принятой provisional-модели на живом источнике.

Это по-прежнему не заменяет X-01 и не доказывает наличие неизменяемой source revision TenderHub.

## 6. Числовой контракт

`numeric_contract = PASS`.

На живом источнике встречены значения до:

- 17 значащих цифр;
- 18 знаков после десятичной точки.

Адаптер обработал их принятой decimal-string/numeric моделью без промежуточного бинарного float.

Регрессия с 21 значащей цифрой остаётся отдельным доказательством предельной точности.

## 7. OpenAPI и реальные ответы

Обнаружены четыре реально недокументированных поля:

### positions/with-costs

- `rich_runs`;
- `total_commercial_material_per_unit`;
- `total_commercial_work_per_unit`.

### boq-items-full

- `import_session_id`.

Это не блокирует Stage 06.

`total_commercial_material_per_unit` и `total_commercial_work_per_unit` уже поддерживаются адаптером и доменной моделью.

Дополнительные `rich_runs` и `import_session_id` не нарушают parsing и не являются обязательными данными Stage 06.

Расхождение фиксируется как факт текущего живого контракта TenderHub.

Остальные `field_undocumented` из журнала подтверждены как ложные срабатывания диагностического parser OpenAPI из-за flow-style YAML. Production TenderHub parser этим не затронут.

Отдельный R06-дефект не создаётся.

## 8. Q-05

Q-05 остаётся OPEN.

Живой источник подтвердил:

присутствуют отдельные коммерческие составляющие, но в проверенных ответах/OpenAPI отсутствуют:

- insurance;
- reduction;
- redistribution;
- VAT.

`cached_grand_total` не объявляется итогом КП.

`kp_total_rule` самостоятельно не определяется.

Это соответствует принятому решению Stage 06.

## 9. Статусы после Review 06-1

Установить:

`TenderHubReader = VERIFIED_LIVE`

Сохранить:

`TenderHubRevisionReader = BLOCKED_EXTERNAL (X-01)`

`TenderHub DB transport = NOT_IMPLEMENTED`

Открытыми остаются:

- X-01;
- Q-01;
- Q-05;
- Q-03 в ранее принятом неблокирующем режиме.

U-04 для Stage 06 считать выполненным.

Production gate:

`CALCULATION_PROVISIONAL`

остаётся обязательным до X-01 либо отдельного принятого решения владельца по Q-01.

## 10. Ключ TenderHub

Живой ключ имеет более широкую область видимости тендеров, чем минимально необходимая.

Это не блокирует приёмку Stage 06, поскольку:

- операции только read-only;
- live-smoke выполнял только GET;
- использован один разрешённый тендер;
- write-запросов не выполнялось.

Зафиксировать как эксплуатационный follow-up:

при наличии технической возможности использовать TenderHub credential (учётные данные) с минимально необходимой областью доступа.

Не считать это R06-дефектом.

## 11. Итог

**Review 06-1: PASS**

**Stage 06: ACCEPTED**

**R06-01: CLOSED_BY_REVIEW**

**U-04: выполнен для Stage 06**

Теперь разрешается:

1. сохранить `docs/reviews/06-review-1.md`;
2. обновить `docs/project-state.md`: Stage 06 → `ACCEPTED`;
3. обновить `docs/integrations/status.md`: `TenderHubReader → VERIFIED_LIVE`;
4. обновить отчёт Stage 06;
5. сделать отдельный документальный commit;
6. запушить ветку `stage-06`;
7. проверить чистоту дерева и remote HEAD.

После документального закрытия Stage 06 разрешается переходить к подготовке **Stage 06a**.

Stage 06a самостоятельно не реализовывать до отдельной команды владельца/ревьюера.
