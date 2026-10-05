-- Живая проба семантики TenderHub (этап 10, подготовка). Таблицы заполняет artifacts/stage-10/semantics-probe.ts
-- из выгрузки адаптером этапа 06 (только GET). Арифметика — numeric. Каждая проверка возвращает
-- (check, tag, mark, detail): только вердикты, счётчики и классы величин — сумм, названий и uuid нет.
-- Метки: A — тендер № 338; B1 / B2 — две версии одного номера (B1 — более ранняя).
-- Формулы — HUBTender 0611f20: backend/internal/calc/boq_amount.go:113-148, calc/boq_item_cost.go:319-324,
-- repository/position_recompute.go:17-35,151-160, repository/position_costs.go:94-99, calc/cached_grand_total.go:1-27,
-- analytics/changeimpact/keys.go:9-50.

-- name: schema
CREATE TABLE p_tender (tag text PRIMARY KEY, grand_total numeric, usd numeric, eur numeric, cny numeric);
CREATE TABLE p_position (
  tag text, id text, pkey text, ckey text, volume numeric, manual_volume numeric, is_section boolean, is_additional boolean,
  total_material numeric, total_works numeric, material_cost_per_unit numeric, work_cost_per_unit numeric,
  total_commercial_material numeric, total_commercial_work numeric, total_commercial_material_per_unit numeric,
  total_commercial_work_per_unit numeric, base_total numeric, commercial_total numeric, material_cost_total numeric,
  work_cost_total numeric, markup_percentage numeric, items_count int, PRIMARY KEY (tag, id));
CREATE TABLE p_line (
  tag text, id text, position_id text, item_type text, material_type text, lkey text, parent_id text, quantity numeric,
  consumption numeric, conversion numeric, unit_rate numeric, currency text, delivery_type text, delivery_amount numeric,
  total_amount numeric, commercial_markup numeric, comm_mat numeric, comm_work numeric, base_quantity numeric, PRIMARY KEY (tag, id));
-- «Совпадает» с точностью до хвостов float64 источника: относительная 1e-9, абсолютная 1e-6.
CREATE FUNCTION near(a numeric, b numeric) RETURNS boolean IMMUTABLE LANGUAGE sql AS
  $$ SELECT coalesce(abs(a - b) <= greatest(abs(b) * 1e-9, 1e-6), false) $$;
CREATE FUNCTION is_mat(t text) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$ SELECT t IN ('мат', 'суб-мат', 'мат-комп.') $$;
CREATE FUNCTION is_work(t text) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$ SELECT t IN ('раб', 'суб-раб', 'раб-комп.') $$;

-- name: L1 total_amount по формуле источника
WITH x AS (
  SELECT l.*, CASE l.currency WHEN 'USD' THEN t.usd WHEN 'EUR' THEN t.eur WHEN 'CNY' THEN t.cny ELSE 1 END AS fx
  FROM p_line l JOIN p_tender t USING (tag)
), e AS (
  SELECT x.*,
    CASE
      WHEN is_work(item_type) THEN coalesce(quantity, 0) * coalesce(unit_rate, 0) * fx
      WHEN is_mat(item_type) THEN coalesce(quantity, 0)
        * CASE WHEN parent_id IS NOT NULL OR coalesce(consumption, 0) = 0 THEN 1 ELSE consumption END
        * (coalesce(unit_rate, 0) * fx
           + CASE delivery_type WHEN 'не в цене' THEN coalesce(unit_rate, 0) * fx * 0.03
                                WHEN 'суммой' THEN coalesce(delivery_amount, 0) ELSE 0 END)
    END AS expected
  FROM x
), m AS (
  SELECT tag, item_type || '/' || coalesce(currency, '—') || '/' || coalesce(delivery_type, '—') AS k, count(*) AS n
  FROM e WHERE total_amount IS NOT NULL AND NOT near(expected, total_amount) GROUP BY 1, 2
)
SELECT 'L1.total_amount' AS check, tag,
  CASE WHEN count(*) FILTER (WHERE total_amount IS NOT NULL AND NOT near(expected, total_amount)) = 0 THEN 'PASS' ELSE 'FAIL' END AS mark,
  format('по формуле сошлось %s из %s строк; без total_amount %s; валютных строк без курса %s; округлено до копеек %s, с большей точностью %s; расхождения (тип/валюта/доставка): %s',
    count(*) FILTER (WHERE near(expected, total_amount)), count(*), count(*) FILTER (WHERE total_amount IS NULL),
    count(*) FILTER (WHERE fx IS NULL),
    count(*) FILTER (WHERE total_amount = round(total_amount, 2)), count(*) FILTER (WHERE total_amount <> round(total_amount, 2)),
    coalesce((SELECT string_agg(k || ' ×' || n, ', ' ORDER BY n DESC) FROM m WHERE m.tag = e.tag), 'нет')) AS detail
FROM e GROUP BY tag ORDER BY tag;

-- name: L1b количество привязанного материала
SELECT 'L1b.bound_material_quantity' AS check, c.tag,
  CASE WHEN count(*) FILTER (WHERE NOT near(c.quantity, w.quantity
      * CASE WHEN coalesce(c.conversion, 0) = 0 THEN 1 ELSE c.conversion END
      * CASE WHEN coalesce(c.consumption, 0) = 0 THEN 1 ELSE c.consumption END)) = 0 THEN 'PASS' ELSE 'FAIL' END AS mark,
  format('материалов с родительской работой %s; quantity = qty работы × conversion × consumption: %s',
    count(*), count(*) FILTER (WHERE near(c.quantity, w.quantity
      * CASE WHEN coalesce(c.conversion, 0) = 0 THEN 1 ELSE c.conversion END
      * CASE WHEN coalesce(c.consumption, 0) = 0 THEN 1 ELSE c.consumption END))) AS detail
FROM p_line c JOIN p_line w ON w.tag = c.tag AND w.id = c.parent_id
GROUP BY c.tag ORDER BY c.tag;

-- name: L1c привязанные материалы, не совпавшие с выводом quantity
WITH x AS (
  SELECT c.tag, c.quantity, c.base_quantity, w.quantity AS wq,
    CASE WHEN coalesce(c.conversion, 0) = 0 THEN 1 ELSE c.conversion END AS conv,
    CASE WHEN coalesce(c.consumption, 0) = 0 THEN 1 ELSE c.consumption END AS cons,
    c.conversion IS NULL AS conv_null, c.consumption IS NULL AS cons_null
  FROM p_line c JOIN p_line w ON w.tag = c.tag AND w.id = c.parent_id
), m AS (SELECT * FROM x WHERE NOT near(quantity, wq * conv * cons))
SELECT 'L1c.bound_material_mismatch' AS check, tag, 'INFO' AS mark,
  format('не совпало %s: quantity = base_quantity %s; = qty работы × conversion (без consumption) %s; = qty работы × consumption %s; = qty работы %s; conversion null %s, consumption null %s; отношение quantity / вывода > 1: %s, < 1: %s',
    count(*), count(*) FILTER (WHERE near(quantity, base_quantity)), count(*) FILTER (WHERE near(quantity, wq * conv)),
    count(*) FILTER (WHERE near(quantity, wq * cons)), count(*) FILTER (WHERE near(quantity, wq)),
    count(*) FILTER (WHERE conv_null), count(*) FILTER (WHERE cons_null),
    count(*) FILTER (WHERE quantity > wq * conv * cons), count(*) FILTER (WHERE quantity < wq * conv * cons)) AS detail
FROM m GROUP BY tag ORDER BY tag;

-- name: L2 commercial_markup = (колонка материалов + колонка работ) / total_amount
WITH e AS (SELECT *, coalesce(comm_mat, 0) + coalesce(comm_work, 0) AS comm FROM p_line),
n AS (SELECT tag, item_type, count(*) AS c FROM e WHERE comm_mat IS NULL AND comm_work IS NULL GROUP BY 1, 2)
SELECT 'L2.commercial_markup' AS check, tag,
  CASE WHEN count(*) FILTER (WHERE total_amount > 0 AND commercial_markup IS NOT NULL AND NOT near(commercial_markup * total_amount, comm)) = 0
    THEN 'PASS' ELSE 'FAIL' END AS mark,
  format('сошлось %s из %s строк с total_amount > 0 и коэффициентом; при total_amount ≤ 0 коэффициент = 1: %s из %s; без коммерческой стоимости %s (по типам: %s)',
    count(*) FILTER (WHERE total_amount > 0 AND commercial_markup IS NOT NULL AND near(commercial_markup * total_amount, comm)),
    count(*) FILTER (WHERE total_amount > 0 AND commercial_markup IS NOT NULL),
    count(*) FILTER (WHERE total_amount <= 0 AND commercial_markup = 1), count(*) FILTER (WHERE total_amount <= 0),
    count(*) FILTER (WHERE comm_mat IS NULL AND comm_work IS NULL),
    coalesce((SELECT string_agg(item_type || ' ×' || c, ', ') FROM n WHERE n.tag = e.tag), 'нет')) AS detail
FROM e GROUP BY tag ORDER BY tag;

-- name: L2d различных коэффициентов по типу строки
SELECT 'L2d.markup_by_type' AS check, tag, 'INFO' AS mark,
  string_agg(format('%s: строк %s, различных коэффициентов %s', item_type, n, k), '; ' ORDER BY item_type) AS detail
FROM (SELECT tag, item_type, count(*) AS n, count(DISTINCT round(commercial_markup, 6)) AS k FROM p_line GROUP BY 1, 2) s
GROUP BY tag ORDER BY tag;

-- name: L2f раскладка по колонкам КП
SELECT 'L2f.columns_by_type' AS check, tag, 'INFO' AS mark,
  string_agg(format('%s%s: только «материалы» %s, только «работы» %s, обе %s, пусто %s', item_type,
    CASE WHEN material_type IS NULL THEN '' ELSE '/' || material_type END, om, ow, b, z), '; ' ORDER BY item_type, material_type) AS detail
FROM (
  SELECT tag, item_type, material_type,
    count(*) FILTER (WHERE coalesce(comm_mat, 0) > 0 AND coalesce(comm_work, 0) = 0) AS om,
    count(*) FILTER (WHERE coalesce(comm_mat, 0) = 0 AND coalesce(comm_work, 0) > 0) AS ow,
    count(*) FILTER (WHERE coalesce(comm_mat, 0) > 0 AND coalesce(comm_work, 0) > 0) AS b,
    count(*) FILTER (WHERE coalesce(comm_mat, 0) = 0 AND coalesce(comm_work, 0) = 0) AS z
  FROM p_line GROUP BY 1, 2, 3
) s GROUP BY tag ORDER BY tag;

-- name: L2g признак НДС в колонке «материалы» основных материалов
-- При раскладке по умолчанию (calc/pricing_distribution.go:84-101) база основного материала идёт в «материалы»,
-- НДС умножается после раскладки (calc/boq_item_cost.go:310-317): отношение колонки к total_amount = 1 + НДС.
-- Раскладка тендера по ключу не отдаётся, поэтому это наблюдение, а не вывод; выводятся только стандартные ставки.
WITH r AS (
  SELECT tag, round(comm_mat / total_amount, 6) AS k FROM p_line
  WHERE material_type = 'основн.' AND is_mat(item_type) AND total_amount > 0 AND comm_mat IS NOT NULL
)
SELECT 'L2g.vat_marker' AS check, tag, 'INFO' AS mark,
  format('строк %s; различных отношений %s; = 1 (без НДС) %s; = 1,12 %s; = 1,20 %s; = 1,22 %s; иное %s',
    count(*), count(DISTINCT k), count(*) FILTER (WHERE k = 1), count(*) FILTER (WHERE k = 1.12),
    count(*) FILTER (WHERE k = 1.2), count(*) FILTER (WHERE k = 1.22),
    count(*) FILTER (WHERE k NOT IN (1, 1.12, 1.2, 1.22))) AS detail
FROM r GROUP BY tag ORDER BY tag;

-- name: L3 cached_grand_total против Σ коммерческих стоимостей строк
WITH s AS (SELECT tag, sum(coalesce(comm_mat, 0) + coalesce(comm_work, 0)) AS lines_sum FROM p_line GROUP BY tag),
p AS (SELECT tag, sum(commercial_total) AS pos_sum FROM p_position GROUP BY tag),
r AS (SELECT t.tag, t.grand_total, s.lines_sum, p.pos_sum, t.grand_total - round(s.lines_sum, 2) AS res
      FROM p_tender t JOIN s USING (tag) JOIN p USING (tag))
SELECT 'L3.grand_total' AS check, tag,
  CASE WHEN abs(res) <= 0.01 THEN 'PASS' ELSE 'INFO' END AS mark,
  format('остаток cached_grand_total − round2(Σ строк): знак %s, %s; Σ commercial_total позиций = Σ строк: %s; итог округлён до копеек: %s',
    CASE WHEN res > 0 THEN '+' WHEN res < 0 THEN '−' ELSE '0' END,
    CASE WHEN abs(res) <= 0.01 THEN 'в пределах округления (≤ 0,01)'
         WHEN grand_total = 0 THEN 'итог равен 0'
         WHEN abs(res) / grand_total < 0.0001 THEN '< 0,01 % итога'
         WHEN abs(res) / grand_total < 0.01 THEN '0,01–1 % итога'
         WHEN abs(res) / grand_total < 0.05 THEN '1–5 % итога' ELSE '> 5 % итога' END,
    CASE WHEN abs(pos_sum - lines_sum) <= 0.01 THEN 'да' ELSE 'нет' END,
    CASE WHEN grand_total = round(grand_total, 2) THEN 'да' ELSE 'нет' END) AS detail
FROM r ORDER BY tag;

-- name: L4 итоги позиции против строк
WITH a AS (
  SELECT p.*,
    coalesce(sum(l.total_amount) FILTER (WHERE is_mat(l.item_type)), 0) AS mat_cost,
    coalesce(sum(l.total_amount) FILTER (WHERE is_work(l.item_type)), 0) AS work_cost,
    coalesce(sum(l.total_amount), 0) AS base,
    coalesce(sum(coalesce(l.comm_mat, 0) + coalesce(l.comm_work, 0)), 0) AS comm,
    coalesce(sum(l.comm_mat), 0) AS cm, coalesce(sum(l.comm_work), 0) AS cw
  FROM p_position p LEFT JOIN p_line l ON l.tag = p.tag AND l.position_id = p.id GROUP BY p.tag, p.id
)
SELECT 'L4.position_totals' AS check, tag,
  CASE WHEN count(*) FILTER (WHERE NOT near(total_material, mat_cost) OR NOT near(total_works, work_cost)
    OR NOT near(base_total, base) OR NOT near(commercial_total, comm) OR NOT near(material_cost_total, cm)
    OR NOT near(work_cost_total, cw)) = 0 THEN 'PASS' ELSE 'FAIL' END AS mark,
  format('позиций %s; total_material = Σ себестоимости материалов %s, total_works = Σ работ %s (≤ 0,01: %s / %s); base_total = Σ total_amount %s; commercial_total = Σ коммерческих %s; material_cost_total = Σ колонки КП «материалы» %s, work_cost_total = Σ колонки «работы» %s (для сравнения: = total_material %s, = total_works %s); markup_percentage = commercial_total / base_total %s из %s (как процент ×100: %s)',
    count(*), count(*) FILTER (WHERE near(total_material, mat_cost)), count(*) FILTER (WHERE near(total_works, work_cost)),
    count(*) FILTER (WHERE abs(total_material - mat_cost) <= 0.01), count(*) FILTER (WHERE abs(total_works - work_cost) <= 0.01),
    count(*) FILTER (WHERE near(base_total, base)), count(*) FILTER (WHERE near(commercial_total, comm)),
    count(*) FILTER (WHERE near(material_cost_total, cm)), count(*) FILTER (WHERE near(work_cost_total, cw)),
    count(*) FILTER (WHERE near(material_cost_total, total_material)), count(*) FILTER (WHERE near(work_cost_total, total_works)),
    count(*) FILTER (WHERE base_total > 0 AND near(markup_percentage, commercial_total / base_total)), count(*) FILTER (WHERE base_total > 0),
    count(*) FILTER (WHERE base_total > 0 AND near(markup_percentage, 100 * commercial_total / base_total))) AS detail
FROM a GROUP BY tag ORDER BY tag;

-- name: L5 поля позиции без писателя в источнике
WITH a AS (
  SELECT p.*,
    coalesce(sum(l.comm_mat), 0) AS cm, coalesce(sum(l.comm_work), 0) AS cw,
    coalesce(sum(l.total_amount) FILTER (WHERE is_mat(l.item_type)), 0) AS mc,
    coalesce(sum(l.total_amount) FILTER (WHERE is_work(l.item_type)), 0) AS wc
  FROM p_position p LEFT JOIN p_line l ON l.tag = p.tag AND l.position_id = p.id GROUP BY p.tag, p.id
), f AS (
  SELECT tag, 'total_commercial_material' AS field, total_commercial_material AS v, cm AS agg FROM a
  UNION ALL SELECT tag, 'total_commercial_work', total_commercial_work, cw FROM a
  UNION ALL SELECT tag, 'total_commercial_material_per_unit', total_commercial_material_per_unit, cm / nullif(manual_volume, 0) FROM a
  UNION ALL SELECT tag, 'total_commercial_work_per_unit', total_commercial_work_per_unit, cw / nullif(manual_volume, 0) FROM a
  UNION ALL SELECT tag, 'material_cost_per_unit', material_cost_per_unit, mc / nullif(manual_volume, 0) FROM a
  UNION ALL SELECT tag, 'work_cost_per_unit', work_cost_per_unit, wc / nullif(manual_volume, 0) FROM a
)
SELECT 'L5.legacy_position_fields' AS check, tag, 'INFO' AS mark,
  string_agg(format('%s: null %s, 0 %s, ≠0 %s, из них = агрегату строк (≤ 0,01) %s', field, nn, z, nz, ok), '; ' ORDER BY field) AS detail
FROM (
  SELECT tag, field, count(*) FILTER (WHERE v IS NULL) AS nn, count(*) FILTER (WHERE v = 0) AS z,
    count(*) FILTER (WHERE v <> 0) AS nz, count(*) FILTER (WHERE v <> 0 AND abs(v - agg) <= 0.01) AS ok
  FROM f GROUP BY 1, 2
) s GROUP BY tag ORDER BY tag;

-- name: L6a распределения строк
SELECT 'L6a.lines' AS check, tag, 'INFO' AS mark,
  format('строк %s; типы: %s; валюты: %s; доставка у материалов: %s; material_type: %s; quantity null %s, ≤ 0 %s; отрицательные: unit_rate %s, delivery_amount %s, total_amount %s, коммерческие %s; total_amount = 0 %s',
    count(*),
    (SELECT string_agg(k || ' ×' || n, ', ' ORDER BY k) FROM (SELECT item_type AS k, count(*) AS n FROM p_line i WHERE i.tag = l.tag GROUP BY 1) s),
    (SELECT string_agg(k || ' ×' || n, ', ' ORDER BY k) FROM (SELECT coalesce(currency, 'null') AS k, count(*) AS n FROM p_line i WHERE i.tag = l.tag GROUP BY 1) s),
    (SELECT string_agg(k || ' ×' || n, ', ' ORDER BY k) FROM (SELECT coalesce(delivery_type, 'null') AS k, count(*) AS n FROM p_line i WHERE i.tag = l.tag AND is_mat(item_type) GROUP BY 1) s),
    (SELECT string_agg(k || ' ×' || n, ', ' ORDER BY k) FROM (SELECT coalesce(material_type, 'null') AS k, count(*) AS n FROM p_line i WHERE i.tag = l.tag GROUP BY 1) s),
    count(*) FILTER (WHERE quantity IS NULL), count(*) FILTER (WHERE quantity <= 0),
    count(*) FILTER (WHERE unit_rate < 0), count(*) FILTER (WHERE delivery_amount < 0), count(*) FILTER (WHERE total_amount < 0),
    count(*) FILTER (WHERE comm_mat < 0 OR comm_work < 0), count(*) FILTER (WHERE total_amount = 0)) AS detail
FROM p_line l GROUP BY tag ORDER BY tag;

-- name: L6b распределения позиций
WITH c AS (SELECT p.tag, p.id, count(l.id) AS n FROM p_position p LEFT JOIN p_line l ON l.tag = p.tag AND l.position_id = p.id GROUP BY 1, 2)
SELECT 'L6b.positions' AS check, p.tag, 'INFO' AS mark,
  format('позиций %s; разделов %s, из них со строками %s; ДОП %s; volume null %s, = 0 %s; manual_volume null %s, = 0 %s; manual_volume ≠ volume %s; без строк %s; commercial_total > 0 при пустом или нулевом manual_volume %s',
    count(*), count(*) FILTER (WHERE is_section), count(*) FILTER (WHERE is_section AND c.n > 0), count(*) FILTER (WHERE is_additional),
    count(*) FILTER (WHERE volume IS NULL), count(*) FILTER (WHERE volume = 0),
    count(*) FILTER (WHERE manual_volume IS NULL), count(*) FILTER (WHERE manual_volume = 0),
    count(*) FILTER (WHERE manual_volume IS NOT NULL AND volume IS NOT NULL AND manual_volume <> volume),
    count(*) FILTER (WHERE c.n = 0), count(*) FILTER (WHERE commercial_total > 0 AND coalesce(manual_volume, 0) = 0)) AS detail
FROM p_position p JOIN c USING (tag, id) GROUP BY p.tag ORDER BY p.tag;

-- name: L7a ключ позиции между версиями (item_no | work_name | unit_code)
WITH g AS (SELECT tag, pkey, count(*) AS n FROM p_position WHERE tag IN ('B1', 'B2') GROUP BY 1, 2),
j AS (
  SELECT coalesce(a.pkey, b.pkey) AS pkey, a.n AS na, b.n AS nb
  FROM (SELECT * FROM g WHERE tag = 'B1') a FULL JOIN (SELECT * FROM g WHERE tag = 'B2') b ON a.pkey = b.pkey
)
SELECT 'L7a.position_key' AS check, 'B1→B2' AS tag, 'INFO' AS mark,
  format('позиций B1 %s, B2 %s; общих uuid %s; повторов ключа внутри версии: B1 групп %s (позиций %s), B2 групп %s (позиций %s); уникальных пар %s; неоднозначных ключей %s; только в B1 %s, только в B2 %s; ключ clone (position_number | is_additional | work_name) — уникальных пар %s',
    (SELECT count(*) FROM p_position WHERE tag = 'B1'), (SELECT count(*) FROM p_position WHERE tag = 'B2'),
    (SELECT count(*) FROM p_position a JOIN p_position b ON a.id = b.id AND a.tag = 'B1' AND b.tag = 'B2'),
    (SELECT count(*) FROM g WHERE tag = 'B1' AND n > 1), (SELECT coalesce(sum(n), 0) FROM g WHERE tag = 'B1' AND n > 1),
    (SELECT count(*) FROM g WHERE tag = 'B2' AND n > 1), (SELECT coalesce(sum(n), 0) FROM g WHERE tag = 'B2' AND n > 1),
    (SELECT count(*) FROM j WHERE na = 1 AND nb = 1),
    (SELECT count(*) FROM j WHERE na IS NOT NULL AND nb IS NOT NULL AND (na > 1 OR nb > 1)),
    (SELECT count(*) FROM j WHERE nb IS NULL), (SELECT count(*) FROM j WHERE na IS NULL),
    (SELECT count(*) FROM (SELECT ckey FROM p_position WHERE tag = 'B1' GROUP BY ckey HAVING count(*) = 1) a
       JOIN (SELECT ckey FROM p_position WHERE tag = 'B2' GROUP BY ckey HAVING count(*) = 1) b USING (ckey))) AS detail;

-- name: L7b ключ строки внутри однозначно сопоставленных позиций
WITH pk AS (
  SELECT pkey FROM p_position WHERE tag IN ('B1', 'B2') GROUP BY pkey
  HAVING count(*) FILTER (WHERE tag = 'B1') = 1 AND count(*) FILTER (WHERE tag = 'B2') = 1
), l AS (
  SELECT l.tag, p.pkey, l.lkey FROM p_line l JOIN p_position p ON p.tag = l.tag AND p.id = l.position_id
  WHERE l.tag IN ('B1', 'B2') AND p.pkey IN (SELECT pkey FROM pk)
), g AS (SELECT tag, pkey, lkey, count(*) AS n FROM l GROUP BY 1, 2, 3),
j AS (
  SELECT a.n AS na, b.n AS nb FROM (SELECT * FROM g WHERE tag = 'B1') a
  FULL JOIN (SELECT * FROM g WHERE tag = 'B2') b ON a.pkey = b.pkey AND a.lkey = b.lkey
)
SELECT 'L7b.line_key' AS check, 'B1→B2' AS tag, 'INFO' AS mark,
  format('пар позиций %s; строк в них B1 %s, B2 %s; уникальных пар строк %s; неоднозначных ключей %s; только в B1 %s, только в B2 %s',
    (SELECT count(*) FROM pk), (SELECT count(*) FROM l WHERE tag = 'B1'), (SELECT count(*) FROM l WHERE tag = 'B2'),
    (SELECT count(*) FROM j WHERE na = 1 AND nb = 1),
    (SELECT count(*) FROM j WHERE na IS NOT NULL AND nb IS NOT NULL AND (na > 1 OR nb > 1)),
    (SELECT count(*) FROM j WHERE nb IS NULL), (SELECT count(*) FROM j WHERE na IS NULL)) AS detail;

-- name: L7c ключи позиции со строками: change-impact против clone
WITH p AS (
  SELECT p.tag, p.id, p.pkey, p.ckey FROM p_position p
  WHERE p.tag IN ('B1', 'B2') AND EXISTS (SELECT 1 FROM p_line l WHERE l.tag = p.tag AND l.position_id = p.id)
), u AS (
  SELECT tag, pkey, ckey, id,
    count(*) OVER (PARTITION BY tag, pkey) AS np, count(*) OVER (PARTITION BY tag, ckey) AS nc FROM p
), ep AS (
  SELECT a.id AS l, b.id AS r FROM u a JOIN u b ON a.pkey = b.pkey AND a.tag = 'B1' AND b.tag = 'B2' AND a.np = 1 AND b.np = 1
), cp AS (
  SELECT a.id AS l, b.id AS r FROM u a JOIN u b ON a.ckey = b.ckey AND a.tag = 'B1' AND b.tag = 'B2' AND a.nc = 1 AND b.nc = 1
)
SELECT 'L7c.key_agreement' AS check, 'B1→B2' AS tag, 'INFO' AS mark,
  format('позиций со строками B1 %s, B2 %s; в неоднозначных группах ключа change-impact B1 %s, B2 %s; уникальных пар: change-impact %s, clone %s; пар обоих ключей совпадает %s, противоречит %s; неоднозначные по change-impact, однозначные по clone %s',
    (SELECT count(*) FROM u WHERE tag = 'B1'), (SELECT count(*) FROM u WHERE tag = 'B2'),
    (SELECT count(*) FROM u WHERE tag = 'B1' AND np > 1), (SELECT count(*) FROM u WHERE tag = 'B2' AND np > 1),
    (SELECT count(*) FROM ep), (SELECT count(*) FROM cp),
    (SELECT count(*) FROM ep JOIN cp USING (l, r)),
    (SELECT count(*) FROM ep JOIN cp ON ep.l = cp.l AND ep.r <> cp.r),
    (SELECT count(*) FROM cp JOIN u ON u.id = cp.l AND u.tag = 'B1' WHERE u.np > 1)) AS detail;
