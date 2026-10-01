# Контур КП — Review 07-2

**Вердикт: PASS**

**Stage 07: ACCEPTED**

*Проверялась ветка `stage-07` на коммите `4037e79fa9e3216206ee78baf01a08078af39509` (журнал настоящего EML поверх документального коммита `4b0060d`; implementation HEAD Review 07-1 — `50af6b661c39043d93c50b5120d82c436349412b`). Текст ревью получен 2026-10-01 и приведён без изменений.*

Последний acceptance gate Stage 07 — ручной импорт настоящего EML — выполнен.

## Real EML

Проверка выполнена на настоящем `.eml` через штатный путь Stage 07:

`mailbox → import EML → server/worker → mail_message → mail_message_revision`

Production-код не изменялся.

Проверка выполнялась на отдельной временной PostgreSQL-базе с настоящими server и worker.

Результат:

**11/11 PASS**

## Подтверждено

1. server и worker готовы;
2. mailbox зарегистрирован, права выданы;
3. импорт завершён успешно;
4. subject/from/to/date разобраны;
5. кириллица body не повреждена;
6. message revision создана;
7. исходный EML сохранён побайтно, SHA-256 совпадает;
8. повтор идентичного EML идемпотентен;
9. письмо связано с тестовым tender;
10. письмо доступно в текущем tender context;
11. FTS search находит mail fragment;
12. citation открывается при `mail.read`;
13. после revoke `mail.read`:
   - письмо недоступно;
   - предыдущий search run недоступен;
   - citation недоступна;
   - новый search не содержит письмо;
14. audit/process logs не содержат запрещённого содержимого письма.

## MIME / encoding

Реальный пример дополнительно подтвердил работу с:

- `multipart/mixed`;
- HTML body;
- UTF-8 encoded-word headers;
- base64 body;
- DOCX attachment.

Вложение принято штатно.

Отдельный parser defect не обнаружен.

## Privacy

Сам `.eml`:

- не коммитился;
- не включался в ZIP;
- не сохранялся в артефактах Stage 07.

`real-eml-check.log` содержит только безопасные агрегированные технические сведения.

## Integration status

Разрешается перевести:

`EmlImporter: VERIFIED_FIXTURE → VERIFIED_LIVE`

Сохранить:

`MailHub: BLOCKED_EXTERNAL (X-03)`

`Negotiation service: BLOCKED_EXTERNAL (Q-06)`

Реальный EML подтверждает manual fallback, но не закрывает X-03.

## Review 07

Review 07-1 PRE-PASS остаётся в силе.

Подтверждены ранее принятые:

- mail ownership model;
- communication grouping;
- message revisions;
- attachment-backed documents;
- Stage 05a recognition;
- unified evidence/search;
- mail permissions;
- revoke without reindex;
- historical scope;
- Q&A revisions;
- negotiation evidence;
- search leakage protection;
- DB invariants;
- UI Stage 07.

## Итог

**Review 07-2: PASS**

**Stage 07: ACCEPTED**

Теперь разрешается:

1. сохранить `docs/reviews/07-review-2.md`;
2. обновить `docs/project-state.md`: Stage 07 → `ACCEPTED`;
3. обновить `docs/integrations/status.md`: `EmlImporter → VERIFIED_LIVE`;
4. обновить `docs/stages/07-report.md`;
5. сохранить безопасный `artifacts/stage-07/real-eml-check.log`;
6. сделать отдельный документальный commit;
7. push `stage-07`;
8. проверить remote HEAD = local HEAD;
9. проверить чистое рабочее дерево.

Stage 08 самостоятельно не начинать.

Перед Stage 08 провести отдельный preflight.
