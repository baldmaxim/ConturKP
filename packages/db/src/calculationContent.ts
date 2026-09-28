// Расчёт TenderHub: содержимое, ревизии, сверка агрегатов, завершение выгрузки и ревизия источника
// (этап 06; state-machines §6, R01-04, R01-08). Деньги и количества — десятичные строки: в pg уходят
// текстом, из numeric приходят строкой (ADR-005).
import type { ICalcContent, ICalcLine, ICalcPosition } from '@kontur/core';
import { CalculationDomainError, getCapture } from './calculationCaptures.ts';
import type { Queryable } from './pool.ts';
import { emitStageEvents, lockTenderStages } from './stageEvents.ts';

// ---------------------------------------------------------------- Содержимое

type Col<T> = [column: string, sqlType: string, value: (row: T) => unknown];

const POSITION_COLUMNS: Col<ICalcPosition>[] = [
  ['external_position_id', 'uuid', (p) => p.externalPositionId],
  ['position_number', 'numeric', (p) => p.positionNumber],
  ['item_no', 'text', (p) => p.itemNo],
  ['work_name', 'text', (p) => p.workName],
  ['unit_code', 'text', (p) => p.unitCode],
  ['volume', 'numeric', (p) => p.volume],
  ['manual_volume', 'numeric', (p) => p.manualVolume],
  ['manual_note', 'text', (p) => p.manualNote],
  ['client_note', 'text', (p) => p.clientNote],
  ['section_number', 'text', (p) => p.sectionNumber],
  ['position_name', 'text', (p) => p.positionName],
  ['is_section', 'boolean', (p) => p.isSection],
  ['is_additional', 'boolean', (p) => p.isAdditional],
  ['hierarchy_level', 'integer', (p) => p.hierarchyLevel],
  ['parent_external_position_id', 'uuid', (p) => p.parentExternalPositionId],
  ['cost_category_name', 'text', (p) => p.costCategoryName],
  ['total_material', 'numeric', (p) => p.totalMaterial],
  ['total_works', 'numeric', (p) => p.totalWorks],
  ['material_cost_per_unit', 'numeric', (p) => p.materialCostPerUnit],
  ['work_cost_per_unit', 'numeric', (p) => p.workCostPerUnit],
  ['total_commercial_material', 'numeric', (p) => p.totalCommercialMaterial],
  ['total_commercial_work', 'numeric', (p) => p.totalCommercialWork],
  ['total_commercial_material_per_unit', 'numeric', (p) => p.totalCommercialMaterialPerUnit],
  ['total_commercial_work_per_unit', 'numeric', (p) => p.totalCommercialWorkPerUnit],
  ['base_total', 'numeric', (p) => p.baseTotal],
  ['commercial_total', 'numeric', (p) => p.commercialTotal],
  ['material_cost_total', 'numeric', (p) => p.materialCostTotal],
  ['work_cost_total', 'numeric', (p) => p.workCostTotal],
  ['markup_percentage', 'numeric', (p) => p.markupPercentage],
  ['items_count', 'integer', (p) => p.itemsCount],
  ['raw_lexemes', 'jsonb', (p) => p.rawLexemes],
];

const LINE_COLUMNS: Col<ICalcLine>[] = [
  ['external_item_id', 'uuid', (l) => l.externalItemId],
  ['external_position_id', 'uuid', (l) => l.externalPositionId],
  ['sort_number', 'integer', (l) => l.sortNumber],
  ['item_type', 'text', (l) => l.itemType],
  ['material_type', 'text', (l) => l.materialType],
  ['description', 'text', (l) => l.description],
  ['work_name', 'text', (l) => l.workName],
  ['material_name', 'text', (l) => l.materialName],
  ['unit_code', 'text', (l) => l.unitCode],
  ['quantity', 'numeric', (l) => l.quantity],
  ['base_quantity', 'numeric', (l) => l.baseQuantity],
  ['consumption_coefficient', 'numeric', (l) => l.consumptionCoefficient],
  ['conversion_coefficient', 'numeric', (l) => l.conversionCoefficient],
  ['unit_rate', 'numeric', (l) => l.unitRate],
  ['currency', 'text', (l) => l.currency],
  ['delivery_price_type', 'text', (l) => l.deliveryPriceType],
  ['delivery_amount', 'numeric', (l) => l.deliveryAmount],
  ['total_amount', 'numeric', (l) => l.totalAmount],
  ['commercial_markup', 'numeric', (l) => l.commercialMarkup],
  ['total_commercial_material', 'numeric', (l) => l.totalCommercialMaterial],
  ['total_commercial_work', 'numeric', (l) => l.totalCommercialWork],
  ['quote_link', 'text', (l) => l.quoteLink],
  ['cost_category', 'text', (l) => l.costCategory],
  ['detail_cost_category', 'text', (l) => l.detailCostCategory],
  ['detail_cost_location', 'text', (l) => l.detailCostLocation],
  ['work_name_id', 'text', (l) => l.workNameId],
  ['material_name_id', 'text', (l) => l.materialNameId],
  ['detail_cost_category_id', 'text', (l) => l.detailCostCategoryId],
  ['parent_work_external_item_id', 'uuid', (l) => l.parentWorkExternalItemId],
  ['raw_lexemes', 'jsonb', (l) => l.rawLexemes],
];

const rowsOf = <T>(cols: Col<T>[], items: T[]): Record<string, unknown>[] =>
  items.map((it) => Object.fromEntries(cols.map(([c, , v]) => [c, v(it)])));

const bulkInsert = <T>(table: string, cols: Col<T>[], param: string): string =>
  `INSERT INTO ${table} (content_id, ${cols.map(([c]) => c).join(', ')})
   SELECT $1, ${cols.map(([c]) => `x.${c}`).join(', ')}
     FROM jsonb_to_recordset(${param}::jsonb) AS x(${cols.map(([c, t]) => `${c} ${t}`).join(', ')})`;

// Содержимое по хэшу: одинаковое хранится один раз (R01-04). Новое содержимое пишется целиком в этой
// транзакции, позиции и строки — одной командой (миграция 0011 сверяет полноту и хэш в БД).
export const findOrCreateContent = async (
  db: Queryable,
  c: { content: ICalcContent; hash: string; headerLexemes: Record<string, string>; kpTotalSemantics: Record<string, unknown> },
): Promise<{ id: string; created: boolean }> => {
  const existing = await db.query<{ id: string }>('SELECT id FROM calculation_content WHERE content_hash = $1', [c.hash]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  const h = c.content.header;
  const ins = await db.query<{ id: string }>(
    `INSERT INTO calculation_content (content_hash, normalization_version, source_grand_total, usd_rate, eur_rate, cny_rate,
                                      kp_total, kp_total_currency, kp_total_rule, kp_total_semantics, raw_lexemes, positions_count, lines_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (content_hash) DO NOTHING RETURNING id`,
    [
      c.hash,
      h.normalizationVersion,
      h.sourceGrandTotal,
      h.usdRate,
      h.eurRate,
      h.cnyRate,
      h.kpTotal,
      h.kpTotalCurrency,
      h.kpTotalRule,
      JSON.stringify(c.kpTotalSemantics),
      JSON.stringify(c.headerLexemes),
      c.content.positions.length,
      c.content.lines.length,
    ],
  );
  if (!ins.rows[0]) {
    // То же содержимое записала параллельная выгрузка и зафиксировала: берём его.
    const again = await db.query<{ id: string }>('SELECT id FROM calculation_content WHERE content_hash = $1', [c.hash]);
    return { id: again.rows[0]!.id, created: false };
  }
  const id = ins.rows[0].id;
  if (c.content.positions.length > 0 || c.content.lines.length > 0) {
    await db.query(
      `WITH positions AS (${bulkInsert('calculation_position', POSITION_COLUMNS, '$2')} RETURNING 1)
       ${bulkInsert('calculation_line', LINE_COLUMNS, '$3')}`,
      [id, JSON.stringify(rowsOf(POSITION_COLUMNS, c.content.positions)), JSON.stringify(rowsOf(LINE_COLUMNS, c.content.lines))],
    );
  }
  return { id, created: true };
};

// ---------------------------------------------------------------- Ревизия

export interface ICalcRevisionRow {
  id: string;
  stage_id: string;
  tender_id: string;
  content_id: string;
  capture_id: string;
  seq: number;
  kind: 'provisional' | 'verified';
  system: 'tenderhub';
  external_tender_id: string;
  external_revision_ref: string | null;
  supersedes_revision_id: string | null;
  created_at: Date;
}

export const latestRevisionFor = async (db: Queryable, stageId: string, externalTenderId: string): Promise<ICalcRevisionRow | null> => {
  const r = await db.query<ICalcRevisionRow>(
    `SELECT * FROM calculation_revision WHERE stage_id = $1 AND system = 'tenderhub' AND external_tender_id = $2 ORDER BY seq DESC LIMIT 1`,
    [stageId, externalTenderId],
  );
  return r.rows[0] ?? null;
};

const insertRevision = async (
  db: Queryable,
  r: { stageId: string; tenderId: string; contentId: string; captureId: string; kind: 'provisional' | 'verified'; externalTenderId: string; externalRevisionRef: string | null; supersedes: string | null },
): Promise<ICalcRevisionRow> => {
  const ins = await db.query<ICalcRevisionRow>(
    `INSERT INTO calculation_revision (stage_id, tender_id, content_id, capture_id, seq, kind, system, external_tender_id, external_revision_ref, supersedes_revision_id)
     VALUES ($1, $2, $3, $4, (SELECT coalesce(max(seq), 0) + 1 FROM calculation_revision WHERE stage_id = $1), $5, 'tenderhub', $6, $7, $8)
     RETURNING *`,
    [r.stageId, r.tenderId, r.contentId, r.captureId, r.kind, r.externalTenderId, r.externalRevisionRef, r.supersedes],
  );
  return ins.rows[0]!;
};

// ---------------------------------------------------------------- Сверка агрегатов

// Суммы считает PostgreSQL в numeric — точно, без float (ADR-005). Допуск записывается в результат
// (ADR-005 §7); расхождение показывается, а не подгоняется, и ревизию не блокирует: это свойство
// данных источника, а не изменение во время чтения.
export const AGGREGATE_TOLERANCE = '0.01';

interface IAggregateCheck {
  check: string;
  positions: number;
  ok: number;
  rounding: number;
  mismatch: number;
  examples: { positionId: string; source: string | null; computed: string; diff: string }[];
}

export interface IAggregateReport {
  tolerance: string;
  checks: IAggregateCheck[];
  grandTotal: { source: string | null; positionsCommercialSum: string; diff: string | null; status: 'ok' | 'rounding' | 'mismatch' | 'unavailable'; note: string };
}

export const reconcileAggregates = async (db: Queryable, contentId: string): Promise<IAggregateReport> => {
  const per = await db.query<{ check_name: string; positions: number; ok: number; rounding: number; mismatch: number; examples: IAggregateCheck['examples'] | null }>(
    `WITH p AS (
       SELECT p.external_position_id, p.base_total, p.commercial_total,
              coalesce(sum(l.total_amount), 0) AS lines_base,
              coalesce(sum(coalesce(l.total_commercial_material, 0) + coalesce(l.total_commercial_work, 0)), 0) AS lines_commercial
         FROM calculation_position p
         LEFT JOIN calculation_line l ON l.content_id = p.content_id AND l.external_position_id = p.external_position_id
        WHERE p.content_id = $1
        GROUP BY p.id),
     c AS (
       SELECT 'position.base_total = Σ line.total_amount' AS check_name, external_position_id, base_total AS source, lines_base AS computed FROM p
       UNION ALL
       SELECT 'position.commercial_total = Σ line.total_commercial_material_cost + total_commercial_work_cost', external_position_id, commercial_total, lines_commercial FROM p),
     d AS (SELECT *, abs(coalesce(source, 0) - computed) AS diff FROM c)
     SELECT check_name, count(*)::int AS positions,
            count(*) FILTER (WHERE diff = 0)::int AS ok,
            count(*) FILTER (WHERE diff > 0 AND diff <= $2::numeric)::int AS rounding,
            count(*) FILTER (WHERE diff > $2::numeric)::int AS mismatch,
            (SELECT jsonb_agg(jsonb_build_object('positionId', e.external_position_id, 'source', trim_scale(e.source)::text,
                                                 'computed', trim_scale(e.computed)::text, 'diff', trim_scale(coalesce(e.source, 0) - e.computed)::text)
                              ORDER BY e.diff DESC, e.external_position_id)
               FROM (SELECT * FROM d d2 WHERE d2.check_name = d.check_name AND d2.diff > $2::numeric ORDER BY d2.diff DESC, d2.external_position_id LIMIT 10) e) AS examples
       FROM d GROUP BY check_name ORDER BY check_name`,
    [contentId, AGGREGATE_TOLERANCE],
  );
  const total = await db.query<{ source: string | null; sum: string; diff: string | null; status: IAggregateReport['grandTotal']['status'] }>(
    `SELECT trim_scale(t.source)::text AS source, trim_scale(t.sum)::text AS sum, trim_scale(t.source - t.sum)::text AS diff,
            CASE WHEN t.source IS NULL THEN 'unavailable' WHEN t.source = t.sum THEN 'ok'
                 WHEN abs(t.source - t.sum) <= $2::numeric THEN 'rounding' ELSE 'mismatch' END AS status
       FROM (SELECT c.source_grand_total AS source,
                    coalesce((SELECT sum(commercial_total) FROM calculation_position WHERE content_id = c.id), 0) AS sum
               FROM calculation_content c WHERE c.id = $1) t`,
    [contentId, AGGREGATE_TOLERANCE],
  );
  const t = total.rows[0]!;
  return {
    tolerance: AGGREGATE_TOLERANCE,
    checks: per.rows.map((r) => ({ check: r.check_name, positions: r.positions, ok: r.ok, rounding: r.rounding, mismatch: r.mismatch, examples: r.examples ?? [] })),
    grandTotal: {
      source: t.source,
      positionsCommercialSum: t.sum,
      diff: t.diff,
      status: t.status,
      note: 'cached_grand_total TenderHub включает страхование, которого API по ключу не отдаёт (docs/discovery.md §4.2); итог КП портала не выводится (Q-05)',
    },
  };
};

// ---------------------------------------------------------------- Завершение выгрузки

export interface ICompletePortalCapture {
  captureId: string;
  content: ICalcContent;
  contentHash: string;
  headerLexemes: Record<string, string>;
  kpTotalSemantics: Record<string, unknown>;
  rawBundleSha256: string;
  consistency: Record<string, unknown>;
  sourceObserved: Record<string, unknown> & { tenderNumber: string };
  contractVersion: string;
  attempt: Record<string, unknown>;
}

export interface ICompleteResult {
  revisionId: string;
  revisionCreated: boolean;
  contentId: string;
  contentCreated: boolean;
  aggregates: IAggregateReport;
}

// Одна транзакция (state-machines §6): блокировка этапа → выгрузки; идентичность тендера во внешней
// системе; содержимое по хэшу; ревизия по правилам идентичности R01-04/R01-08; событие барьера для
// новой ревизии; сверка агрегатов; выгрузка — complete.
export const completePortalCapture = async (db: Queryable, i: ICompletePortalCapture): Promise<ICompleteResult> => {
  const probe = await getCapture(db, i.captureId);
  if (!probe) throw new CalculationDomainError('capture_not_found', 'выгрузка не найдена');
  await lockTenderStages(db, probe.tender_id, [probe.stage_id]);
  const cap = (await getCapture(db, i.captureId, true))!;
  if (cap.status !== 'capturing') throw new CalculationDomainError('capture_not_active', 'выгрузка уже завершена');

  // Номер тендера TenderHub принадлежит ровно одному тендеру портала (I05).
  // Отдельными командами: при параллельной записи того же номера SELECT видит зафиксированную строку.
  await db.query(
    `INSERT INTO external_ref (entity_type, entity_id, tender_id, system, external_id)
     VALUES ('tender', $1, $1, 'tenderhub', $2) ON CONFLICT DO NOTHING`,
    [cap.tender_id, i.sourceObserved.tenderNumber],
  );
  const ref = await db.query<{ tender_id: string }>(
    "SELECT tender_id FROM external_ref WHERE system = 'tenderhub' AND entity_type = 'tender' AND external_id = $1 AND external_version IS NULL",
    [i.sourceObserved.tenderNumber],
  );
  if (ref.rows.some((r) => r.tender_id !== cap.tender_id)) {
    throw new CalculationDomainError('external_identity_conflict', 'тендер TenderHub уже связан с другим тендером портала');
  }

  const content = await findOrCreateContent(db, { content: i.content, hash: i.contentHash, headerLexemes: i.headerLexemes, kpTotalSemantics: i.kpTotalSemantics });
  const last = await latestRevisionFor(db, cap.stage_id, cap.external_tender_id);
  let revisionId: string;
  let revisionCreated = false;
  if (last && last.content_id === content.id) {
    // Повтор той же выгрузки относительно последней ревизии — идемпотентен: новой ревизии и события нет.
    revisionId = last.id;
  } else {
    const rev = await insertRevision(db, {
      stageId: cap.stage_id,
      tenderId: cap.tender_id,
      contentId: content.id,
      captureId: cap.id,
      kind: 'provisional',
      externalTenderId: cap.external_tender_id,
      externalRevisionRef: null,
      supersedes: last?.id ?? null,
    });
    revisionId = rev.id;
    revisionCreated = true;
    await emitStageEvents(db, {
      tenderId: cap.tender_id,
      stageIds: [cap.stage_id],
      eventType: 'calculation_revision_added',
      refType: 'calculation_revision',
      refId: rev.id,
      actorUserId: cap.requested_by,
    });
  }
  const aggregates = await reconcileAggregates(db, content.id);
  await db.query(
    `UPDATE calculation_capture
        SET status = 'complete', content_id = $2, revision_id = $3, raw_bundle_sha256 = $4, consistency = $5::jsonb,
            source_observed = $6::jsonb, contract_version = $7, attempts = attempts || jsonb_build_array($8::jsonb),
            finished_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [
      cap.id,
      content.id,
      revisionId,
      i.rawBundleSha256,
      JSON.stringify({ ...i.consistency, aggregates }),
      JSON.stringify(i.sourceObserved),
      i.contractVersion,
      JSON.stringify(i.attempt),
    ],
  );
  return { revisionId, revisionCreated, contentId: content.id, contentCreated: content.created, aggregates };
};

// ---------------------------------------------------------------- Ревизия источника (после X-01)

// Ревизия TenderHub по её ID (verified). В продукте её создать нечем: адаптера ревизий нет, статус
// компонента BLOCKED_EXTERNAL (X-01). Функция — доменное правило для контрактных тестов на фикстурах:
// verified — новая запись со ссылкой на внешнюю ревизию; повтор той же ревизии идемпотентен.
export const recordSourceRevision = async (
  db: Queryable,
  i: {
    captureId: string;
    externalRevisionRef: string;
    content: ICalcContent;
    contentHash: string;
    headerLexemes: Record<string, string>;
    kpTotalSemantics: Record<string, unknown>;
    rawBundleSha256: string;
    contractVersion: string;
  },
): Promise<{ revisionId: string; created: boolean }> => {
  const probe = await getCapture(db, i.captureId);
  if (!probe) throw new CalculationDomainError('capture_not_found', 'выгрузка не найдена');
  await lockTenderStages(db, probe.tender_id, [probe.stage_id]);
  const cap = (await getCapture(db, i.captureId, true))!;
  if (cap.status !== 'capturing' || cap.capture_kind !== 'tenderhub_revision') {
    throw new CalculationDomainError('capture_not_active', 'ревизию источника принимает только незавершённая выгрузка вида tenderhub_revision');
  }
  const content = await findOrCreateContent(db, { content: i.content, hash: i.contentHash, headerLexemes: i.headerLexemes, kpTotalSemantics: i.kpTotalSemantics });
  const existing = await db.query<ICalcRevisionRow>(
    "SELECT * FROM calculation_revision WHERE stage_id = $1 AND kind = 'verified' AND external_revision_ref = $2",
    [cap.stage_id, i.externalRevisionRef],
  );
  let revisionId: string;
  let created = false;
  if (existing.rows[0]) {
    revisionId = existing.rows[0].id;
  } else {
    const last = await latestRevisionFor(db, cap.stage_id, cap.external_tender_id);
    const rev = await insertRevision(db, {
      stageId: cap.stage_id,
      tenderId: cap.tender_id,
      contentId: content.id,
      captureId: cap.id,
      kind: 'verified',
      externalTenderId: cap.external_tender_id,
      externalRevisionRef: i.externalRevisionRef,
      supersedes: last?.id ?? null,
    });
    revisionId = rev.id;
    created = true;
    await emitStageEvents(db, {
      tenderId: cap.tender_id,
      stageIds: [cap.stage_id],
      eventType: 'calculation_revision_added',
      refType: 'calculation_revision',
      refId: rev.id,
      actorUserId: cap.requested_by,
    });
  }
  await db.query(
    `UPDATE calculation_capture SET status = 'complete', content_id = $2, revision_id = $3, raw_bundle_sha256 = $4,
            consistency = '{}'::jsonb, contract_version = $5, finished_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [cap.id, content.id, revisionId, i.rawBundleSha256, i.contractVersion],
  );
  return { revisionId, created };
};

export type SourceStatus = 'closed_at_source' | 'reopened_at_source' | 'superseded_at_source';

// Статус ревизии у источника — событие; повтор того же статуса подряд идемпотентен (события нет).
export const recordRevisionStatus = async (
  db: Queryable,
  e: { revisionId: string; status: SourceStatus; observedAt: Date; sourceRawSha256: string },
): Promise<{ recorded: boolean }> => {
  // Ревизия неизменна, блокировка строки ревизии роли приложения недоступна: сериализация — строкой этапа.
  const rev = await db.query<{ stage_id: string; tender_id: string }>('SELECT stage_id, tender_id FROM calculation_revision WHERE id = $1', [e.revisionId]);
  if (rev.rows[0]) await lockTenderStages(db, rev.rows[0].tender_id, [rev.rows[0].stage_id]);
  const last = await db.query<{ status: SourceStatus; seq: number }>(
    'SELECT status, seq FROM calculation_revision_status_event WHERE revision_id = $1 ORDER BY seq DESC LIMIT 1',
    [e.revisionId],
  );
  if (last.rows[0]?.status === e.status) return { recorded: false };
  await db.query(
    `INSERT INTO calculation_revision_status_event (revision_id, seq, status, observed_at, source_raw_sha256)
     VALUES ($1, $2, $3, $4, $5)`,
    [e.revisionId, (last.rows[0]?.seq ?? 0) + 1, e.status, e.observedAt, e.sourceRawSha256],
  );
  return { recorded: true };
};
