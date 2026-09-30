// Распознавание и доказательства (data-model §4.4, state-machines §4). Прогон — единица
// источника (ADR-008 §1): фрагменты принадлежат прогону, а не документу, поэтому новая
// версия OCR не переписывает прежние доказательства (A10).
import { contentTenderIds, readableContractIds, readableMailboxIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export type RecognitionEngine = 'rdweb_export' | 'rdweb_api' | 'text_layer' | 'local_ocr';
export type RecognitionStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
// needs_review — единица прочитана, но не прошла шлюз качества локального распознавания (OD-6, 0014).
export type RecognitionPageStatus = 'recognized' | 'missing' | 'failed' | 'needs_review';
// Единица источника (AD-05a-1): физическая страница PDF или логическая единица файла.
export type RecognitionUnitKind = 'pdf_page' | 'xlsx_sheet' | 'csv_table' | 'docx_body';
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
  // Владелец прогона равен владельцу редакции: тендер или договор (D-023).
  tender_id: string | null;
  contract_id: string | null;
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
  // Идентичность локального прогона (AD-05a-2, 0014); у прогона RDWeb — null.
  recognizer: Record<string, unknown> | null;
  recognizer_fingerprint: string | null;
  recognizer_config_hash: string | null;
  // Прогон выбирается автоподбором (recognition_preferred_run, AD-05a-3).
  preferred: boolean;
  revision_media_type: string;
}

const SELECT_RUN = `
  SELECT r.*, dr.document_id, dr.blob_sha256 AS revision_blob_sha256, b.media_type AS revision_media_type,
         (r.id = recognition_preferred_run(r.document_revision_id)) IS TRUE AS preferred
    FROM recognition_run r JOIN document_revision dr ON dr.id = r.document_revision_id JOIN blob b ON b.sha256 = dr.blob_sha256`;

export const getRun = async (db: Queryable, id: string, lock = false): Promise<IRecognitionRunRow | null> => {
  if (lock) await db.query('SELECT 1 FROM recognition_run WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<IRecognitionRunRow>(`${SELECT_RUN} WHERE r.id = $1`, [id]);
  return r.rows[0] ?? null;
};

// Прогон договора читается только с contract.read (D-022 OD-2, OD-3), прогон документа вложения — только
// с mail.read на ящик письма (D-025).
export const getScopedRun = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IRecognitionRunRow | null> => {
  const r = await db.query<IRecognitionRunRow>(
    `${SELECT_RUN}
      WHERE r.id = $1
        AND (r.tender_id = ANY($2::uuid[]) OR r.contract_id = ANY($3::uuid[])
             OR (r.tender_id IS NULL AND r.contract_id IS NULL AND EXISTS (
                   SELECT 1 FROM mail_message m WHERE m.id = document_revision_mail_message(r.document_revision_id) AND m.mailbox_id = ANY($4::uuid[]))))`,
    [id, contentTenderIds(ctx), readableContractIds(ctx), readableMailboxIds(ctx)],
  );
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

// Хвост истории распознавания редакции — предшественник нового прогона (A10). Именно хвост,
// а не просто последний завершённый: перекрывать середину цепочки нельзя, и это же условие
// проверяет охранник вставки (миграция 0008, R04-12).
export const latestFinishedRun = async (db: Queryable, revisionId: string): Promise<IRecognitionRunRow | null> => {
  const r = await db.query<IRecognitionRunRow>(
    `${SELECT_RUN} WHERE r.document_revision_id = $1 AND r.status IN ('complete', 'partial')
        AND NOT EXISTS (SELECT 1 FROM recognition_run c WHERE c.supersedes_run_id = r.id AND c.status NOT IN ('failed', 'cancelled'))
      ORDER BY r.created_at DESC LIMIT 1`,
    [revisionId],
  );
  return r.rows[0] ?? null;
};

// Потомок — только тот прогон, который действительно занял следующее место в истории.
// Отказавшая и отменённая попытка места не занимает (миграция 0008), поэтому и перекрытым
// прогон от неё не становится: иначе один сбой объявлял бы прежнюю версию устаревшей (R04-18).
// Такой потомок не более одного — это держит частичный уникальный индекс.
export const supersededBy = async (db: Queryable, runId: string): Promise<string | null> => {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM recognition_run
      WHERE supersedes_run_id = $1 AND status NOT IN ('failed', 'cancelled')
      ORDER BY created_at LIMIT 1`,
    [runId],
  );
  return r.rows[0]?.id ?? null;
};

// Владелец прогона выводится из редакции в самой вставке, а не передаётся вызывающим (AD-06a-1 §9);
// составные FK миграций 0005 и 0012 сверяют его ещё раз.
export const createRun = async (
  db: Queryable,
  run: {
    documentRevisionId: string;
    engine: RecognitionEngine;
    sourceArtifactSha256: string;
    sourceArtifactName: string | null;
    supersedesRunId: string | null;
    createdBy: string | null;
  },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, source_artifact_name, supersedes_run_id, created_by)
     SELECT dr.id, dr.tender_id, dr.contract_id, $2, $3, $4, $5, $6 FROM document_revision dr WHERE dr.id = $1
     RETURNING id`,
    [run.documentRevisionId, run.engine, run.sourceArtifactSha256, run.sourceArtifactName, run.supersedesRunId, run.createdBy],
  );
  if (!r.rows[0]) throw new Error('редакция документа не найдена');
  return r.rows[0].id;
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
  unit_kind: RecognitionUnitKind;
}

export interface INewPage {
  pageIndex: number;
  pageLabel: string | null;
  sheetLabel: string | null;
  widthPx: number | null;
  heightPx: number | null;
  rotation: number;
  status: RecognitionPageStatus;
  // По умолчанию — страница PDF (прогоны RDWeb).
  unitKind?: RecognitionUnitKind;
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
        params.push(p.pageIndex, p.pageLabel, p.sheetLabel, p.widthPx, p.heightPx, p.rotation, p.status, p.unitKind ?? 'pdf_page');
        return `($1, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8})`;
      })
      .join(', ');
    await db.query(
      `INSERT INTO recognition_page (run_id, page_index, page_label, sheet_label, width_px, height_px, rotation, status, unit_kind)
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
  tender_id: string | null;
  contract_id: string | null;
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
  // Структурный якорь локального фрагмента (AD-05a-1); у фрагмента RDWeb — null.
  locator: Record<string, unknown> | null;
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
  locator?: Record<string, unknown> | null;
}

// Владелец фрагментов — владелец прогона (ref берётся из строки прогона, не из запроса клиента).
export const insertFragments = async (
  db: Queryable,
  ref: { runId: string; tenderId: string | null; contractId: string | null; documentRevisionId: string },
  fragments: INewFragment[],
): Promise<void> => {
  for (const part of chunked(fragments)) {
    const params: unknown[] = [ref.tenderId, ref.runId, ref.documentRevisionId, ref.contractId];
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
          f.locator ? JSON.stringify(f.locator) : null,
        );
        return (
          `($1, $4, 'recognition_run', $2, $2, $3, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, ` +
          `$${i + 7}::numeric[], $${i + 8}, $${i + 9}, $${i + 10}::numeric[], $${i + 11}, $${i + 12}, $${i + 13}, $${i + 14}, $${i + 15}, $${i + 16}::jsonb, $${i + 17}, $${i + 18}, $${i + 19}::jsonb)`
        );
      })
      .join(', ');
    await db.query(
      `INSERT INTO evidence_fragment (tender_id, contract_id, source_unit_type, source_unit_id, run_id, document_revision_id,
         origin, fragment_kind, fragment_key, external_block_id, ordinal, page_index, bbox_norm, bbox_space,
         shape_type, polygon_norm, rotation, text, text_sha256, derived_model_ref, external_crop_url, warnings,
         part_index, part_total, locator)
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
  unit_kind: RecognitionUnitKind | null;
  run_engine: RecognitionEngine | null;
  revision_media_type: string | null;
  // Почтовая ветка и транскрипция (D-025): письмо (у вложения — письмо вложения), ящик, шапка ревизии;
  // сессия и сегмент транскрипции.
  source_unit_type: 'recognition_run' | 'mail_message_revision' | 'transcript_revision';
  mail_message_revision_id: string | null;
  transcript_revision_id: string | null;
  transcript_segment_id: string | null;
  mail_message_id: string | null;
  mailbox_id: string | null;
  mail_subject: string | null;
  mail_from: string | null;
  mail_sent_at: Date | null;
  attachment_filename: string | null;
  session_id: string | null;
  session_title: string | null;
  transcript_tender_id: string | null;
  speaker_label: string | null;
  segment_kind: 'speech' | 'hint' | null;
  t_start_ms: number | null;
  t_end_ms: number | null;
}

// Цитата: фрагмент тендера — доступ к тендеру; договора — contract.read; письма и документа вложения —
// mail.read на ящик письма (связь с тендером и снимок права не дают, D-025); транскрипции — доступ к
// тендеру сессии. Чужой фрагмент не отличается от несуществующего.
export const getScopedFragment = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IScopedFragmentRow | null> => {
  const r = await db.query<IScopedFragmentRow>(
    `SELECT f.*, dr.document_id, r.status AS run_status, r.engine AS run_engine, b.media_type AS revision_media_type,
            p.page_label, p.sheet_label, p.width_px AS page_width_px, p.height_px AS page_height_px, p.status AS page_status, p.unit_kind,
            coalesce(mr.message_id, amr.message_id) AS mail_message_id, coalesce(m.mailbox_id, am.mailbox_id) AS mailbox_id,
            coalesce(mr.subject, amr.subject) AS mail_subject, coalesce(mr.from_address, amr.from_address) AS mail_from,
            coalesce(mr.sent_at, amr.sent_at) AS mail_sent_at, a.filename AS attachment_filename,
            ns.id AS session_id, ns.title AS session_title, tr.tender_id AS transcript_tender_id,
            ts.speaker_label, ts.segment_kind, ts.t_start_ms, ts.t_end_ms
       FROM evidence_fragment f
       LEFT JOIN document_revision dr ON dr.id = f.document_revision_id
       LEFT JOIN document d ON d.id = dr.document_id
       LEFT JOIN blob b ON b.sha256 = dr.blob_sha256
       LEFT JOIN recognition_run r ON r.id = f.run_id
       LEFT JOIN recognition_page p ON p.run_id = f.run_id AND p.page_index = f.page_index
       LEFT JOIN mail_message_revision mr ON mr.id = f.mail_message_revision_id
       LEFT JOIN mail_message m ON m.id = mr.message_id
       LEFT JOIN mail_attachment a ON a.id = d.mail_attachment_id
       LEFT JOIN mail_message_revision amr ON amr.id = a.revision_id
       LEFT JOIN mail_message am ON am.id = amr.message_id
       LEFT JOIN transcript_revision tr ON tr.id = f.transcript_revision_id
       LEFT JOIN negotiation_session ns ON ns.id = tr.session_id
       LEFT JOIN transcript_segment ts ON ts.id = f.transcript_segment_id
      WHERE f.id = $1
        AND (f.tender_id = ANY($2::uuid[]) OR f.contract_id = ANY($3::uuid[])
             OR coalesce(m.mailbox_id, am.mailbox_id) = ANY($4::uuid[])
             OR tr.tender_id = ANY($2::uuid[]))`,
    [id, contentTenderIds(ctx), readableContractIds(ctx), readableMailboxIds(ctx)],
  );
  return r.rows[0] ?? null;
};
