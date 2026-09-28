# Происхождение фикстуры

Регрессионный контракт донора (D-013, `docs/architecture/locus-regression-manifest.md`), скопирован без изменений.

- Репозиторий: `Odintsov/Locus/LocalAI` (заморожен решением D-013).
- Коммит последнего изменения случаев и корпуса: `95614a876558b53b13b1a00c8fbe31d2ec1c292e` (2026-09-16); HEAD донора на момент копирования — `33c6bcf4becafae968b1c388ffda1ba307282dfd`.
- Данные синтетические: организации, суммы и даты вымышлены (так помечены сами документы).

| Файл | Источник в Locus | SHA-256 |
|---|---|---|
| `contracts-core.json` | `evals/product-v2/contracts-core.json` | `2ba22e2c5077f01659674f3cc0e92802de26fd3d4a401eec4cfd320c1c35d16f` |
| `sources.json` | `fixtures/product-v2/sources.json` | `d5cc210ce53000c3d24912ec93ce82b7529cb32103de39df9fc948ea680b4b76` |
| `balchug/dogovor-b-44.md` | `fixtures/product-v2/balchug/dogovor-b-44.md` | `8db234eaf0ff2c9c4621f260bbb54cc3111e682f263c65e4de7249ebebc3f7bb` |
| `rusakovskaya/dogovor-7-rs.md` | `fixtures/product-v2/rusakovskaya/dogovor-7-rs.md` | `e31e99f6602a2fbb4c457359d47c9a91df24c9a6a36f2c9c7ccb496cc7a2fa72` |
| `stromynka/dogovor-15-p.md` | `fixtures/product-v2/stromynka/dogovor-15-p.md` | `82e5f7855ca6903d0f81e6dcfb5b807db66aed62d5d047c94e416a6e49adc86c` |
| `stromynka/ds-01-k-dogovoru-15-p.md` | `fixtures/product-v2/stromynka/ds-01-k-dogovoru-15-p.md` | `a97c2c14c07763efe788db58373f18bb2edd9c94c011b0aa894d6f0a4cc166a1` |
| `stromynka/pismo-skan.md` | `fixtures/product-v2/stromynka/pismo-skan.md` | `5a71ec967d10010da01b56b744d145c6964125d9402b515e3c7bfe0a742c5d2a` |
| `stromynka/smeta-stromynka.md` | `fixtures/product-v2/stromynka/smeta-stromynka.md` | `13a32000185f4bcd32ab754164a28c72a23f040965f9f05b3f27d1d2f604c679` |

Перенос в портал (`tests/searchLocus.test.ts`): проект → тендер; файл → редакция документа тендера с прогоном-фикстурой RDWeb; раздел `##` (или `## OCR page N`) → страница; заголовок `#` → шапка листа; абзац → фрагмент `recognized_text`. Смета (`.xlsx` у донора) в этапе 05 не используется: её случаи отложены на 05a.
