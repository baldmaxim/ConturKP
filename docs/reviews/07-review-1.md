# Контур КП — Review 07-1

**Вердикт: PRE-PASS**

**Stage 07: IMPLEMENTED_AWAITING_REAL_EML**

*Проверялась передача `50af6b661c39043d93c50b5120d82c436349412b` (ZIP `ConturKP-stage-07-50af6b6.zip`). Текст ревью получен 2026-10-01 и приведён без изменений.*

Блокирующих дефектов реализации Stage 07 не обнаружено.

## Принято

Принимаются:

- migrations 0017/0018;
- mail ownership/access model;
- `mailbox → mail_message → mail_message_revision`;
- `mail_communication`;
- many-to-many message ↔ tender;
- attachment-backed document subtype;
- Stage 05a recognition для вложений;
- mail evidence branch в общем search;
- exact / FTS / vector ACL filtering;
- повторная проверка прав при чтении search run/citation;
- revoke `mail.read` без переиндексации;
- historical evidence после снятия текущей tender link;
- Q&A revisions и A→B→A;
- negotiation speech/hint separation;
- DB invariants;
- search leakage regressions;
- upgrade 0016 → 0018;
- UI Stage 07;
- X-03 и Q-06 как `BLOCKED_EXTERNAL`.

## Интерпретации

И-07-2 — CONFIRMED.  
И-07-3 — CONFIRMED.  
И-07-4 — CONFIRMED.  
И-07-5 — CONFIRMED.  
И-07-7 — CONFIRMED.

И-07-1 и И-07-6 ранее подтверждены D-025.

Все интерпретации можно перевести из `PENDING_REVIEW_TEXT` в `CONFIRMED`.

## Реальный EML

Остаётся единственный обязательный acceptance gate:

**ручной импорт настоящего EML владельцем.**

Синтетические fixtures (фикстуры) и smoke не заменяют этот шаг, поскольку OD-07-4 специально потребовал реальный пример.

### Что нужно сделать

Владелец экспортирует одно обычное письмо из реальной почтовой системы в `.eml`.

Предпочтительно выбрать безопасное тестовое письмо без чувствительных данных.

Минимально желательно, чтобы EML содержал:

- тему;
- отправителя;
- получателя;
- дату;
- простой текст или HTML;
- русские символы.

Вложение желательно, но не обязательно для закрытия Stage 07, поскольку attachment path уже покрыт тестами.

### Проверка

Импортировать этот файл штатным Stage 07 manual EML path:

`mailbox → import EML → worker → mail message/revision`

Проверить:

1. импорт завершён успешно;
2. subject/from/to/date разобраны корректно;
3. body отображается без повреждения кириллицы;
4. revision создана;
5. raw EML blob сохранён;
6. повтор того же EML идемпотентен;
7. письмо можно связать с тестовым tender;
8. оно появляется в текущем tender context после связи;
9. поиск находит фрагмент письма;
10. после отзыва `mail.read` письмо/search/citation перестают быть доступны;
11. журнал не содержит лишних секретов/данных сверх штатного аудита.

Если реальный EML содержит quoted-printable, encoded-word или multipart HTML — дополнительно зафиксировать, что они разобраны корректно.

### Что передать ревьюеру

Не нужно присылать само письмо, если оно содержит реальные данные.

Достаточно безопасного журнала:

- размер файла;
- MIME structure summary;
- parser result PASS/FAIL;
- наличие subject/from/to/date/body;
- charset/transfer encoding;
- число вложений;
- повторный импорт = reused/idempotent;
- search result = PASS;
- revoke permission = PASS.

Без:

- полного body;
- адресов;
- темы;
- вложений;
- коммерческих данных.

Если manual-smoke PASS и production-код менять не пришлось:

- новый implementation commit не нужен;
- достаточно документального commit с результатом;
- передать на **Review 07-2**.

Review 07-2 будет коротким: только реальный EML и итоговый integration status.

Если реальный EML выявит parser defect:

- не маскировать;
- остановиться;
- зафиксировать фактическое расхождение;
- передать ревьюеру до изменения кода.

## Статусы до Review 07-2

`EmlImporter = VERIFIED_FIXTURE`

`MailHub = BLOCKED_EXTERNAL (X-03)`

`Negotiation service = BLOCKED_EXTERNAL (Q-06)`

Stage 08 не начинать.
