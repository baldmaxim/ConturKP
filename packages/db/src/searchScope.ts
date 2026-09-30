// Область поиска (ADR-008 §2–6, state-machines §5.1): снимок области доказательств и развёртывание
// области прогона поиска. Клиент не передаёт ID единиц сам — их выводит сервер из этапа или снимка.
import { evidenceScopeContentHash, sourceSetContentHash, type IScopeUnit } from '@kontur/core';
import { contentTenderIds, readableContractIds, type IAccessContext } from './access.ts';
import { inTransaction, type Queryable } from './pool.ts';

export interface IScopeRevisionItem {
  document_revision_id: string;
  blob_sha256: string;
  inclusion: 'included' | 'excluded_not_applicable' | 'inherited';
  // Владелец редакции-договора (D-023); у редакции тендера — null.
  contract_id: string | null;
  // Предпочтительный прогон редакции (recognition_preferred_run, AD-05a-3): RDWeb выше локального,
  // внутри класса — глубже по истории. Для истории только из RDWeb это прежний хвост цепочки.
  run_id: string | null;
}

// Элементы ревизии набора и выбранный для каждой редакции прогон «на момент чтения»
// (state-machines §5.1): предпочтительный прогон — правило БД, не время создания (AD-05a-3).
export const setRevisionItemsWithRuns = async (db: Queryable, setRevisionId: string): Promise<IScopeRevisionItem[]> => {
  const r = await db.query<IScopeRevisionItem>(
    `SELECT i.document_revision_id, dr.blob_sha256, i.inclusion, dr.contract_id,
            recognition_preferred_run(i.document_revision_id) AS run_id
       FROM source_set_item i
       JOIN document_revision dr ON dr.id = i.document_revision_id
      WHERE i.source_set_revision_id = $1
      ORDER BY i.document_revision_id`,
    [setRevisionId],
  );
  return r.rows;
};

export interface IWorkingSetRevision {
  id: string;
  status: 'draft' | 'frozen';
  content_hash: string | null;
}

// Последняя ревизия рабочего набора этапа — черновая или замороженная (режим working).
export const latestWorkingRevision = async (db: Queryable, stageId: string): Promise<IWorkingSetRevision | null> => {
  const r = await db.query<IWorkingSetRevision>(
    `SELECT r.id, r.status, r.content_hash FROM source_set_revision r JOIN source_set s ON s.id = r.source_set_id
      WHERE s.stage_id = $1 AND s.purpose = 'working'
      ORDER BY r.seq DESC LIMIT 1`,
    [stageId],
  );
  return r.rows[0] ?? null;
};

export const latestFrozenRevision = async (db: Queryable, stageId: string): Promise<IWorkingSetRevision | null> => {
  const r = await db.query<IWorkingSetRevision>(
    `SELECT r.id, r.status, r.content_hash FROM source_set_revision r JOIN source_set s ON s.id = r.source_set_id
      WHERE s.stage_id = $1 AND s.purpose = 'working' AND r.status = 'frozen'
      ORDER BY r.seq DESC LIMIT 1`,
    [stageId],
  );
  return r.rows[0] ?? null;
};

const includedUnits = (items: IScopeRevisionItem[]): IScopeUnit[] =>
  items
    .filter((i) => i.inclusion !== 'excluded_not_applicable')
    .map((i) => ({ unitType: 'document_recognition' as const, documentRevisionId: i.document_revision_id, recognitionRunId: i.run_id }));

export interface IResolvedScope {
  // Хэш снимка: сохранённого (review) или временного (working).
  snapshotHash: string;
  // Единицы источника до фильтра прав.
  unitIds: string[];
  // Единицы договора → договор (D-022 OD-3): их пропускает только фильтр прав contract.read.
  contractOf: ReadonlyMap<string, string>;
  // Включённые редакции без прогона — входят в охват как «только оригинал».
  revisionsWithoutRun: number;
}

const contractUnits = (items: { run_id: string | null; contract_id: string | null }[]): Map<string, string> =>
  new Map(items.flatMap((i) => (i.run_id && i.contract_id ? [[i.run_id, i.contract_id] as const] : [])));

// Временный снимок режима working (ADR-008 §3): последняя ревизия рабочего набора этапа и
// предпочтительные прогоны её редакций. Хэш считается так же, как хэш сохранённого снимка, поэтому одинаковый
// состав даёт одинаковый scopeHash.
export const resolveWorkingScope = async (db: Queryable, stageId: string): Promise<IResolvedScope> => {
  const rev = await latestWorkingRevision(db, stageId);
  if (!rev) return { snapshotHash: evidenceScopeContentHash('empty', []), unitIds: [], contractOf: new Map(), revisionsWithoutRun: 0 };
  const items = await setRevisionItemsWithRuns(db, rev.id);
  const setHash =
    rev.content_hash ??
    sourceSetContentHash(items.map((i) => ({ documentRevisionId: i.document_revision_id, blobSha256: i.blob_sha256, inclusion: i.inclusion })));
  const units = includedUnits(items);
  return {
    snapshotHash: evidenceScopeContentHash(setHash, units),
    unitIds: units.filter((u) => u.recognitionRunId !== null).map((u) => u.recognitionRunId!),
    contractOf: contractUnits(items.filter((i) => i.inclusion !== 'excluded_not_applicable')),
    revisionsWithoutRun: units.filter((u) => u.recognitionRunId === null).length,
  };
};

// Область контекста contract (ADR-012 §24): текущий корпус договора — последняя редакция каждого
// документа (основной договор, допсоглашения, приложения) и её предпочтительный прогон.
// Отдельного снимка договора нет (T06A-1); хэш временного снимка считается так же, как у этапа.
export const resolveContractScope = async (db: Queryable, contractId: string): Promise<IResolvedScope> => {
  const r = await db.query<IScopeRevisionItem>(
    `SELECT lr.id AS document_revision_id, lr.blob_sha256, 'included' AS inclusion, lr.contract_id,
            recognition_preferred_run(lr.id) AS run_id
       FROM document d
       JOIN LATERAL (SELECT x.id, x.blob_sha256, x.contract_id FROM document_revision x
                      WHERE x.document_id = d.id ORDER BY x.revision_seq DESC LIMIT 1) lr ON true
      WHERE d.contract_id = $1
      ORDER BY lr.id`,
    [contractId],
  );
  const units = includedUnits(r.rows);
  const setHash = sourceSetContentHash(r.rows.map((i) => ({ documentRevisionId: i.document_revision_id, blobSha256: i.blob_sha256, inclusion: i.inclusion })));
  return {
    snapshotHash: evidenceScopeContentHash(setHash, units),
    unitIds: units.filter((u) => u.recognitionRunId !== null).map((u) => u.recognitionRunId!),
    contractOf: contractUnits(r.rows),
    revisionsWithoutRun: units.filter((u) => u.recognitionRunId === null).length,
  };
};

// ---------------------------------------------------------------- Снимок области (evidence_scope)

export interface IEvidenceScopeRow {
  id: string;
  stage_id: string;
  tender_id: string;
  source_set_revision_id: string;
  input_version: number;
  content_hash: string;
  created_by: string;
  created_at: Date;
}

export interface IEvidenceScopeItemRow {
  document_revision_id: string;
  recognition_run_id: string | null;
  inclusion_reason: string;
  contract_id: string | null;
  document_id: string;
  document_title: string;
  revision_seq: number;
  run_status: string | null;
  pages_total: number | null;
  pages_recognized: number | null;
}

export const planEvidenceScope = async (
  db: Queryable,
  setRevision: { id: string; content_hash: string },
): Promise<{ contentHash: string; units: IScopeUnit[] }> => {
  const items = await setRevisionItemsWithRuns(db, setRevision.id);
  const units = includedUnits(items);
  return { contentHash: evidenceScopeContentHash(setRevision.content_hash, units), units };
};

// Одинаковый состав этапа — та же строка (data-model §4.3): повтор возвращает существующий снимок.
// Снимок и весь его состав пишутся в одной транзакции, единицы — одной командой (миграция 0010, R05-01):
// БД сверяет полноту и хэш после команды и при COMMIT, а после фиксации единицу в снимок не вставить.
// Параллельное создание того же состава ждёт на уникальности (stage_id, content_hash) и возвращает
// зафиксированный снимок; частично заполненный снимок другим транзакциям не виден.
export const createEvidenceScope = async (
  db: Queryable,
  s: { stageId: string; tenderId: string; sourceSetRevisionId: string; inputVersion: number; contentHash: string; createdBy: string; units: IScopeUnit[] },
): Promise<{ id: string; created: boolean }> =>
  inTransaction(db, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO evidence_scope (stage_id, tender_id, source_set_revision_id, input_version, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stage_id, content_hash) DO NOTHING RETURNING id`,
      [s.stageId, s.tenderId, s.sourceSetRevisionId, s.inputVersion, s.contentHash, s.createdBy],
    );
    const id = r.rows[0]?.id;
    if (!id) {
      const existing = await tx.query<{ id: string }>('SELECT id FROM evidence_scope WHERE stage_id = $1 AND content_hash = $2', [s.stageId, s.contentHash]);
      return { id: existing.rows[0]!.id, created: false };
    }
    if (s.units.length > 0) {
      // Владелец единицы-договора выводится из редакции, а не передаётся (AD-06a-1 §8–9); FK сверяют его.
      await tx.query(
        `INSERT INTO evidence_scope_item (scope_id, tender_id, contract_id, unit_type, document_revision_id, recognition_run_id, inclusion_reason)
         SELECT $1, $2, dr.contract_id, u.unit_type, u.document_revision_id, u.recognition_run_id, 'source_set_included'
           FROM unnest($3::text[], $4::uuid[], $5::uuid[]) AS u(unit_type, document_revision_id, recognition_run_id)
           JOIN document_revision dr ON dr.id = u.document_revision_id`,
        [id, s.tenderId, s.units.map((u) => u.unitType), s.units.map((u) => u.documentRevisionId), s.units.map((u) => u.recognitionRunId)],
      );
    }
    return { id, created: true };
  });

export const getEvidenceScope = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IEvidenceScopeRow | null> => {
  const r = await db.query<IEvidenceScopeRow>('SELECT * FROM evidence_scope WHERE id = $1 AND tender_id = ANY($2::uuid[])', [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

export const listEvidenceScopes = async (db: Queryable, stageId: string): Promise<(IEvidenceScopeRow & { units: number })[]> => {
  const r = await db.query<IEvidenceScopeRow & { units: number }>(
    `SELECT s.*, (SELECT count(*) FROM evidence_scope_item i WHERE i.scope_id = s.id) AS units
       FROM evidence_scope s WHERE s.stage_id = $1 ORDER BY s.created_at DESC, s.id`,
    [stageId],
  );
  return r.rows;
};

export const evidenceScopeItems = async (db: Queryable, scopeId: string): Promise<IEvidenceScopeItemRow[]> => {
  const r = await db.query<IEvidenceScopeItemRow>(
    `SELECT i.document_revision_id, i.recognition_run_id, i.inclusion_reason, i.contract_id, d.id AS document_id, d.title AS document_title,
            dr.revision_seq, r.status AS run_status, r.pages_total, r.pages_recognized
       FROM evidence_scope_item i
       JOIN document_revision dr ON dr.id = i.document_revision_id
       JOIN document d ON d.id = dr.document_id
       LEFT JOIN recognition_run r ON r.id = i.recognition_run_id
      WHERE i.scope_id = $1
      ORDER BY d.title, dr.revision_seq`,
    [scopeId],
  );
  return r.rows;
};

// Область режима review — единицы сохранённого снимка (ADR-008 §6): поздние прогоны не входят.
export const resolveSnapshotScope = async (db: Queryable, scope: IEvidenceScopeRow): Promise<IResolvedScope> => {
  const items = await db.query<{ recognition_run_id: string | null; contract_id: string | null }>(
    'SELECT recognition_run_id, contract_id FROM evidence_scope_item WHERE scope_id = $1',
    [scope.id],
  );
  return {
    snapshotHash: scope.content_hash,
    unitIds: items.rows.filter((i) => i.recognition_run_id !== null).map((i) => i.recognition_run_id!).sort(),
    contractOf: contractUnits(items.rows.map((i) => ({ run_id: i.recognition_run_id, contract_id: i.contract_id }))),
    revisionsWithoutRun: items.rows.filter((i) => i.recognition_run_id === null).length,
  };
};

// Права поверх закреплённой области (ADR-008 §4): снимок не даёт вечного разрешения. Возвращает
// единицы, доступ к которым у пользователя пропал. Прогон тендера — доступ к тендеру; прогон
// договора — contract.read, даже если единица закреплена в снимке тендера (D-022 OD-3); письма и
// их ящики (этап 07) добавят сюда проверку mailbox_access.
export const unitsNotPermitted = async (db: Queryable, ctx: IAccessContext, unitIds: string[]): Promise<string[]> => {
  if (unitIds.length === 0) return [];
  const r = await db.query<{ id: string }>(
    `SELECT u.id FROM unnest($1::uuid[]) AS u(id)
      WHERE NOT EXISTS (SELECT 1 FROM recognition_run r
                         WHERE r.id = u.id AND (r.tender_id = ANY($2::uuid[]) OR r.contract_id = ANY($3::uuid[])))`,
    [unitIds, contentTenderIds(ctx), readableContractIds(ctx)],
  );
  return r.rows.map((x) => x.id);
};

// ---------------------------------------------------------------- Охват

export interface IScopeCoverage {
  units: number;
  pagesRecognized: number;
  pagesTotal: number;
  unitsNotIndexed: number;
  // A43: сколько единиц области — локальное распознавание и сколько из них требуют проверки (partial).
  localUnits: number;
  localNeedsReview: number;
}

// Охват области (ADR-008 §11): сколько единиц и страниц распознано и сколько единиц ещё не
// проиндексировано активной версией. Честная неполнота вместо тихого «ничего нет» (I07, I18).
// Локальные единицы считаются отдельно: происхождение не подменяется основной обработкой (A43).
export const scopeCoverage = async (db: Queryable, versionId: string, unitIds: string[]): Promise<IScopeCoverage> => {
  const r = await db.query<{ pages_recognized: number | null; pages_total: number | null; not_indexed: number; local_units: number; local_review: number }>(
    `SELECT sum(r.pages_recognized)::int AS pages_recognized, sum(r.pages_total)::int AS pages_total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM search_index_unit u
                                                WHERE u.index_version_id = $1 AND u.source_unit_id = r.id))::int AS not_indexed,
            count(*) FILTER (WHERE r.engine = 'local_ocr')::int AS local_units,
            count(*) FILTER (WHERE r.engine = 'local_ocr' AND r.status = 'partial')::int AS local_review
       FROM recognition_run r WHERE r.id = ANY($2::uuid[])`,
    [versionId, unitIds],
  );
  const row = r.rows[0]!;
  return {
    units: unitIds.length,
    pagesRecognized: row.pages_recognized ?? 0,
    pagesTotal: row.pages_total ?? 0,
    unitsNotIndexed: row.not_indexed,
    localUnits: row.local_units,
    localNeedsReview: row.local_review,
  };
};
