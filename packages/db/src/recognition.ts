// Распознавание и доказательства (data-model §4.4, state-machines §4). Прогон — единица
// источника (ADR-008 §1): фрагменты принадлежат прогону, а не документу, поэтому новая
// версия OCR не переписывает прежние доказательства (A10).
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export type RecognitionEngine = 'rdweb_export' | 'rdweb_api' | 'text_layer' | 'local_ocr';
export type RecognitionStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
export type RecognitionPageStatus = 'recognized' | 'missing' | 'failed';
export type FragmentOrigin =
  | 'document_text'
  | 'recognized_text'
  | 'model_description'
  | 'negotiation_speech'
  | 'negotiation_hint'
  | 'email_body'
  | 'attachment_text';
export type FragmentKind =
  | 'text_block'
  | 'image_block'
  | 'stamp_block'
  | 'unknown_block'
  | 'summary'
  | 'description'
  | 'entities'
  | 'verification'
  | 'unknown_section';
export type BboxSpace = 'page_unrotated' | 'page_rotated';

export interface IRecognitionRunRow {
  id: string;
  document_revision_id: string;
  tender_id: string;
  document_id: string;
  revision_blob_sha256: string;
  engine: RecognitionEngine;
  engine_schema_version: string | null;
  source_artifact_sha256: string;
  source_artifact_name: string | null;
  status: RecognitionStatus;
  pages_total: number | null;
  pages_recognized: number;
  quality: Record<string, unknown>;
  failure_code: string | null;
  failure_detail: string | null;
  supersedes_run_id: string | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  row_version: number;
}

const SELECT_RUN = `
  SELECT r.*, dr.document_id, dr.blob_sha256 AS revision_blob_sha256
    FROM recognition_run r JOIN document_revision dr ON dr.id = r.document_revision_id`;

export const getRun = async (db: Queryable, id: string, lock = false): Promise<IRecognitionRunRow | null> => {
  if (lock) await db.query('SELECT 1 FROM recognition_run WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<IRecognitionRunRow>(`${SELECT_RUN} WHERE r.id = $1`, [id]);
  return r.rows[0] ?? null;
};

export const getScopedRun = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IRecognitionRunRow | null> => {
  const r = await db.query<IRecognitionRunRow>(`${SELECT_RUN} WHERE r.id = $1 AND r.tender_id = ANY($2::uuid[])`, [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

export const listRunsForRevision = async (db: Queryable, revisionId: string): Promise<IRecognitionRunRow[]> => {
  const r = await db.query<IRecognitionRunRow>(`${SELECT_RUN} WHERE r.document_revision_id = $1 ORDER BY r.created_at DESC, r.id`, [revisionId]);
  return r.rows;
};

// Прогон, который уже держит эту пару «редакция + архив» (частичный уникальный индекс).
export const findRunByArtifact = async (db: Queryable, revisionId: string, sha256: string): Promise<IRecognitionRunRow | null> => {
  const r = await db.query<IRecognitionRunRow>(
    `${SELECT_RUN} WHERE r.document_revision_id = $1 AND r.source_artifact_sha256 = $2 AND r.status NOT IN ('failed', 'cancelled')`,
    [revisionId, sha256],
  );
  return r.rows[0] ?? null;
};

// Незавершённый прогон редакции. История прогонов обязана быть цепочкой, поэтому второй
// архив, принятый до обработки первого, получает отказ, а не общего предшественника (R04-12).
export const activeRunForRevision = async (db: Queryable, revisionId: string): Promise<IRecognitionRunRow | null> => {
  const r = await db.query<IRecognitionRunRow>(
    `${SELECT_RUN} WHERE r.document_revision_id = $1 AND r.status IN ('queued', 'running') LIMIT 1`,
    [revisionId],
  );
  return r.rows[0] ?? null;
};

// Блокировка приёма архивов по одной редакции: два запроса выполняются строго по очереди,
// поэтому проверка «активный прогон уже есть» не разъезжается со вставкой нового прогона.
// Блокировка именно advisory: строку document_revision заблокировать нельзя — таблица
// неизменяема, и права UPDATE у роли приложения нет (0002). Снимается концом транзакции.
export const lockRevisionForRecognition = async (db: Queryable, revisionId: string): Promise<void> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('recognition_import'), hashtext($1))", [revisionId]);
};

// Последний завершённый прогон редакции — предшественник нового (A10).
export const latestFinishedRun = async (db: Queryable, revisionId: string): Promise<IRecognitionRunRow | null> => {
  const r = await db.query<IRecognitionRunRow>(
    `${SELECT_RUN} WHERE r.document_revision_id = $1 AND r.status IN ('complete', 'partial') ORDER BY r.created_at DESC LIMIT 1`,
    [revisionId],
  );
  return r.rows[0] ?? null;
};

export const supersededBy = async (db: Queryable, runId: string): Promise<string | null> => {
  const r = await db.query<{ id: string }>('SELECT id FROM recognition_run WHERE supersedes_run_id = $1 ORDER BY created_at LIMIT 1', [runId]);
  return r.rows[0]?.id ?? null;
};

export const createRun = async (
  db: Queryable,
  run: {
    documentRevisionId: string;
    tenderId: string;
    engine: RecognitionEngine;
    sourceArtifactSha256: string;
    sourceArtifactName: string | null;
    supersedesRunId: string | null;
    createdBy: string | null;
  },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, source_artifact_name, supersedes_run_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [run.documentRevisionId, run.tenderId, run.engine, run.sourceArtifactSha256, run.sourceArtifactName, run.supersedesRunId, run.createdBy],
  );
  return r.rows[0]!.id;
};

// queued → running. 0 строк означает, что прогон уже не в queued (повторный захват задания).
export const startRun = async (db: Queryable, id: string): Promise<boolean> => {
  const r = await db.query(
    `UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'queued'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
};

export const finishRun = async (
  db: Queryable,
  id: string,
  f: {
    status: 'complete' | 'partial';
    engineSchemaVersion: string | null;
    pagesTotal: number;
    pagesRecognized: number;
    quality: Record<string, unknown>;
  },
): Promise<boolean> => {
  const r = await db.query(
    `UPDATE recognition_run
        SET status = $2, engine_schema_version = $3, pages_total = $4, pages_recognized = $5, quality = $6::jsonb,
            finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'running'`,
    [id, f.status, f.engineSchemaVersion, f.pagesTotal, f.pagesRecognized, JSON.stringify(f.quality)],
  );
  return (r.rowCount ?? 0) > 0;
};

// Отмена задания обязана терминализовать прогон: иначе он навсегда остаётся queued/running,
// блокирует заморозку состава как recognition_in_progress и держит пару «редакция + архив»
// (R04-02). Отмена — не ошибка, поэтому failure_code пуст.
export const cancelRun = async (db: Queryable, id: string): Promise<boolean> => {
  const r = await db.query(
    `UPDATE recognition_run SET status = 'cancelled', finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
};

// Отказ допустим из queued и из running: прогон, не дошедший до разбора, тоже обязан
// получить видимый терминальный статус, а не остаться висеть.
export const failRun = async (db: Queryable, id: string, code: string, detail: string): Promise<boolean> => {
  const r = await db.query(
    `UPDATE recognition_run
        SET status = 'failed', failure_code = $2, failure_detail = $3, finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [id, code.slice(0, 60), detail.slice(0, 2000)],
  );
  return (r.rowCount ?? 0) > 0;
};

export interface IRecognitionPageRow {
  id: string;
  run_id: string;
  page_index: number;
  page_label: string | null;
  sheet_label: string | null;
  width_px: number | null;
  height_px: number | null;
  rotation: number;
  status: RecognitionPageStatus;
}

export interface INewPage {
  pageIndex: number;
  pageLabel: string | null;
  sheetLabel: string | null;
  widthPx: number | null;
  heightPx: number | null;
  rotation: number;
  status: RecognitionPageStatus;
}

const CHUNK = 100;

const chunked = <T>(rows: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
};

export const insertPages = async (db: Queryable, runId: string, pages: INewPage[]): Promise<void> => {
  for (const part of chunked(pages)) {
    const params: unknown[] = [runId];
    const values = part
      .map((p) => {
        const i = params.length;
        params.push(p.pageIndex, p.pageLabel, p.sheetLabel, p.widthPx, p.heightPx, p.rotation, p.status);
        return `($1, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7})`;
      })
      .join(', ');
    await db.query(
      `INSERT INTO recognition_page (run_id, page_index, page_label, sheet_label, width_px, height_px, rotation, status)
       VALUES ${values} ON CONFLICT (run_id, page_index) DO NOTHING`,
      params,
    );
  }
};

export const listPages = async (db: Queryable, runId: string): Promise<IRecognitionPageRow[]> => {
  const r = await db.query<IRecognitionPageRow>('SELECT * FROM recognition_page WHERE run_id = $1 ORDER BY page_index', [runId]);
  return r.rows;
};

export interface IEvidenceFragmentRow {
  id: string;
  tender_id: string;
  source_unit_type: string;
  source_unit_id: string;
  run_id: string | null;
  document_revision_id: string | null;
  origin: FragmentOrigin;
  fragment_kind: FragmentKind;
  fragment_key: string;
  external_block_id: string | null;
  ordinal: number | null;
  page_index: number | null;
  // numeric[] приходит из pg строками: точность координат не теряется на разборе.
  bbox_norm: string[] | null;
  bbox_space: BboxSpace | null;
  shape_type: 'rectangle' | 'polygon' | null;
  polygon_norm: string[] | null;
  rotation: number | null;
  text: string;
  text_sha256: string;
  derived_model_ref: string | null;
  external_crop_url: string | null;
  warnings: string[];
  // Часть длинного текста блока: доказательство не усекается, а разбивается (R04-06).
  part_index: number;
  part_total: number;
  created_at: Date;
}

export interface INewFragment {
  origin: FragmentOrigin;
  fragmentKind: FragmentKind;
  fragmentKey: string;
  externalBlockId: string | null;
  ordinal: number | null;
  pageIndex: number | null;
  bboxNorm: number[] | null;
  bboxSpace: BboxSpace | null;
  shapeType: 'rectangle' | 'polygon' | null;
  polygonNorm: number[] | null;
  rotation: number | null;
  text: string;
  textSha256: string;
  derivedModelRef: string | null;
  externalCropUrl: string | null;
  warnings: string[];
  partIndex: number;
  partTotal: number;
}

export const insertFragments = async (
  db: Queryable,
  ref: { runId: string; tenderId: string; documentRevisionId: string },
  fragments: INewFragment[],
): Promise<void> => {
  for (const part of chunked(fragments)) {
    const params: unknown[] = [ref.tenderId, ref.runId, ref.documentRevisionId];
    const values = part
      .map((f) => {
        const i = params.length;
        params.push(
          f.origin,
          f.fragmentKind,
          f.fragmentKey,
          f.externalBlockId,
          f.ordinal,
          f.pageIndex,
          f.bboxNorm,
          f.bboxSpace,
          f.shapeType,
          f.polygonNorm,
          f.rotation,
          f.text,
          f.textSha256,
          f.derivedModelRef,
          f.externalCropUrl,
          JSON.stringify(f.warnings),
          f.partIndex,
          f.partTotal,
        );
        return (
          `($1, 'recognition_run', $2, $2, $3, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, ` +
          `$${i + 7}::numeric[], $${i + 8}, $${i + 9}, $${i + 10}::numeric[], $${i + 11}, $${i + 12}, $${i + 13}, $${i + 14}, $${i + 15}, $${i + 16}::jsonb, $${i + 17}, $${i + 18})`
        );
      })
      .join(', ');
    await db.query(
      `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id,
         origin, fragment_kind, fragment_key, external_block_id, ordinal, page_index, bbox_norm, bbox_space,
         shape_type, polygon_norm, rotation, text, text_sha256, derived_model_ref, external_crop_url, warnings,
         part_index, part_total)
       VALUES ${values} ON CONFLICT (run_id, fragment_key) DO NOTHING`,
      params,
    );
  }
};

export interface IFragmentPage {
  items: IEvidenceFragmentRow[];
  nextCursor: string | null;
}

// Курсор по (page_index, ordinal, part_index, id): порядок совпадает с индексом
// evidence_fragment_page_idx. part_index в ключе обязателен — иначе части одного длинного
// блока упорядочивались бы случайным uuid (R04-06).
export const listFragments = async (
  db: Queryable,
  runId: string,
  q: { pageIndex?: number | null; cursor?: string | null; limit: number },
): Promise<IFragmentPage> => {
  const after = q.cursor ? q.cursor.split(':') : null;
  const r = await db.query<IEvidenceFragmentRow>(
    `SELECT * FROM evidence_fragment
      WHERE run_id = $1
        AND ($2::int IS NULL OR page_index = $2::int)
        AND ($6::uuid IS NULL OR (coalesce(page_index, -1), coalesce(ordinal, -1), part_index, id) > ($3::int, $4::int, $5::int, $6::uuid))
      ORDER BY coalesce(page_index, -1), coalesce(ordinal, -1), part_index, id
      LIMIT $7`,
    [
      runId,
      q.pageIndex ?? null,
      after ? Number(after[0]) : null,
      after ? Number(after[1]) : null,
      after ? Number(after[2]) : null,
      after?.[3] ?? null,
      q.limit + 1,
    ],
  );
  const items = r.rows.slice(0, q.limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: r.rows.length > q.limit && last ? `${last.page_index ?? -1}:${last.ordinal ?? -1}:${last.part_index}:${last.id}` : null,
  };
};

export const countFragmentsByKind = async (db: Queryable, runId: string): Promise<Record<string, number>> => {
  const r = await db.query<{ fragment_kind: string; n: number }>(
    'SELECT fragment_kind, count(*)::int AS n FROM evidence_fragment WHERE run_id = $1 GROUP BY fragment_kind',
    [runId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.fragment_kind, x.n]));
};

export interface IScopedFragmentRow extends IEvidenceFragmentRow {
  document_id: string | null;
  run_status: RecognitionStatus | null;
  page_label: string | null;
  sheet_label: string | null;
  page_width_px: number | null;
  page_height_px: number | null;
  page_status: RecognitionPageStatus | null;
}

export const getScopedFragment = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IScopedFragmentRow | null> => {
  const r = await db.query<IScopedFragmentRow>(
    `SELECT f.*, dr.document_id, r.status AS run_status,
            p.page_label, p.sheet_label, p.width_px AS page_width_px, p.height_px AS page_height_px, p.status AS page_status
       FROM evidence_fragment f
       LEFT JOIN document_revision dr ON dr.id = f.document_revision_id
       LEFT JOIN recognition_run r ON r.id = f.run_id
       LEFT JOIN recognition_page p ON p.run_id = f.run_id AND p.page_index = f.page_index
      WHERE f.id = $1 AND f.tender_id = ANY($2::uuid[])`,
    [id, contentTenderIds(ctx)],
  );
  return r.rows[0] ?? null;
};

// Затронутые этапы события recognition_run_completed (state-machines §1.1): активные этапы
// тендера, где редакция входит в набор источников или ещё не отнесена. Явно исключённая
// из последней ревизии набора редакция этап не затрагивает.
export const stagesAffectedByRevision = async (db: Queryable, tenderId: string, revisionId: string): Promise<string[]> => {
  const r = await db.query<{ id: string }>(
    `SELECT s.id
       FROM tender_stage s
      WHERE s.tender_id = $1 AND s.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM source_set ss
            JOIN LATERAL (
              SELECT rr.id FROM source_set_revision rr WHERE rr.source_set_id = ss.id ORDER BY rr.seq DESC LIMIT 1
            ) last ON true
            JOIN source_set_item i ON i.source_set_revision_id = last.id
           WHERE ss.stage_id = s.id AND i.document_revision_id = $2 AND i.inclusion = 'excluded_not_applicable')
      ORDER BY s.id`,
    [tenderId, revisionId],
  );
  return r.rows.map((x) => x.id);
};

// Включённые редакции ревизии набора без пригодного распознавания (охранное условие заморозки).
export interface IBlockingItemRow {
  document_revision_id: string;
  document_id: string;
  document_title: string;
  revision_seq: number;
  reason: 'no_recognition' | 'recognition_in_progress' | 'recognition_failed' | 'recognition_cancelled';
}

export const blockingFreezeItems = async (db: Queryable, revisionId: string): Promise<IBlockingItemRow[]> => {
  const r = await db.query<IBlockingItemRow>(
    `SELECT i.document_revision_id, d.id AS document_id, d.title AS document_title, dr.revision_seq,
            CASE
              WHEN EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = i.document_revision_id
                            AND r.status IN ('queued', 'running')) THEN 'recognition_in_progress'
              WHEN EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = i.document_revision_id
                            AND r.status = 'failed') THEN 'recognition_failed'
              WHEN EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = i.document_revision_id
                            AND r.status = 'cancelled') THEN 'recognition_cancelled'
              ELSE 'no_recognition'
            END AS reason
       FROM source_set_item i
       JOIN document_revision dr ON dr.id = i.document_revision_id
       JOIN document d ON d.id = dr.document_id
      WHERE i.source_set_revision_id = $1
        AND i.inclusion <> 'excluded_not_applicable'
        AND NOT EXISTS (SELECT 1 FROM recognition_run r
                         WHERE r.document_revision_id = i.document_revision_id AND r.status IN ('complete', 'partial'))
      ORDER BY d.title, dr.revision_seq`,
    [revisionId],
  );
  return r.rows;
};
