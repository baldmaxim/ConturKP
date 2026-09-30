// Локальное распознавание (этап 05a, D-014, D-024; миграция 0014): маршрут редакции, идентичность
// прогона, постановка командой и автоматическим проходом, предпочтительный прогон. Правила маршрута,
// идентичности и выбора держит БД (функции и охранники 0014); здесь — их использование.
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { activeRunForRevision, latestFinishedRun, lockRevisionForRecognition } from './recognition.ts';

export type LocalInputFormat = 'pdf' | 'docx' | 'xlsx' | 'csv';
export type RecognitionRoutePolicy = 'auto' | 'local' | 'rdweb';
export type RevisionRoute = RecognitionRoutePolicy | 'unsupported';

// Описание распознавателя — как его принимает БД (local_recognizer_valid): отпечаток считает она сама.
export interface ILocalRecognizerDescriptor {
  recognizerId: string;
  recognizerVersion: string;
  inputFormat: LocalInputFormat;
  processing: 'structured_parser' | 'native_text' | 'native_text+ocr';
  languages: string[];
  config: Record<string, unknown>;
}

export const LOCAL_JOB_KIND = 'recognition.local';
// Приоритет фоновой полосы (ADR-004 §7a): ниже импорта и индексации.
export const LOCAL_JOB_PRIORITY = 5;

export interface IRevisionRecognitionInfo {
  id: string;
  document_id: string;
  tender_id: string | null;
  contract_id: string | null;
  blob_sha256: string;
  input_format: LocalInputFormat | null;
  route: RevisionRoute;
  document_route: RecognitionRoutePolicy;
}

export const revisionRecognitionInfo = async (db: Queryable, revisionId: string): Promise<IRevisionRecognitionInfo | null> => {
  const r = await db.query<IRevisionRecognitionInfo>(
    `SELECT dr.id, dr.document_id, dr.tender_id, dr.contract_id, dr.blob_sha256,
            local_input_format(b.media_type) AS input_format,
            recognition_revision_route(dr.id) AS route,
            d.recognition_route AS document_route
       FROM document_revision dr
       JOIN blob b ON b.sha256 = dr.blob_sha256
       JOIN document d ON d.id = dr.document_id
      WHERE dr.id = $1`,
    [revisionId],
  );
  return r.rows[0] ?? null;
};

// Отпечаток описания — той же функцией БД, что пишет его в прогон: расхождения нет.
export const recognizerFingerprint = async (db: Queryable, d: ILocalRecognizerDescriptor): Promise<string> => {
  const r = await db.query<{ fp: string }>('SELECT local_recognizer_fingerprint($1::jsonb) AS fp', [JSON.stringify(d)]);
  return r.rows[0]!.fp;
};

export interface ILocalRunRef {
  id: string;
  status: string;
  recognizer_fingerprint: string;
}

// Прогон той же идентичности (OD-2): редакция, оригинал, распознаватель, версия, конфигурация.
export const findLocalRunByIdentity = async (db: Queryable, revisionId: string, fingerprint: string): Promise<ILocalRunRef | null> => {
  const r = await db.query<ILocalRunRef>(
    `SELECT r.id, r.status, r.recognizer_fingerprint FROM recognition_run r
       JOIN document_revision dr ON dr.id = r.document_revision_id
      WHERE r.document_revision_id = $1 AND r.engine = 'local_ocr' AND r.source_artifact_sha256 = dr.blob_sha256
        AND r.recognizer_fingerprint = $2 AND r.status NOT IN ('failed', 'cancelled')`,
    [revisionId, fingerprint],
  );
  return r.rows[0] ?? null;
};

export type EnqueueLocalOutcome =
  | { kind: 'created'; runId: string }
  | { kind: 'reused'; runId: string }
  | { kind: 'active'; runId: string }
  | { kind: 'refused'; reason: 'unsupported_format' | 'route_rdweb' | 'route_auto_requires_command' | 'not_found' };

// Постановка локального прогона: сначала блокировка редакции (та же advisory, что у приёма RDWeb),
// затем формат и маршрут, повтор той же идентичности, незавершённый прогон. Прогон встаёт за хвостом истории.
export const enqueueLocalRecognition = async (
  db: Queryable,
  o: { revisionId: string; descriptor: ILocalRecognizerDescriptor; createdBy: string | null },
): Promise<EnqueueLocalOutcome> => {
  await lockRevisionForRecognition(db, o.revisionId);
  const info = await revisionRecognitionInfo(db, o.revisionId);
  if (!info) return { kind: 'refused', reason: 'not_found' };
  if (info.input_format === null || info.route === 'unsupported') return { kind: 'refused', reason: 'unsupported_format' };
  // Маршрут RDWeb закрывает локальный путь раньше повтора: прежний локальный прогон такой редакции
  // не выдаётся за ответ на новую команду (OD-1, D-014).
  if (info.route === 'rdweb') return { kind: 'refused', reason: 'route_rdweb' };
  if (info.input_format === 'pdf' && info.route === 'auto' && o.createdBy === null) return { kind: 'refused', reason: 'route_auto_requires_command' };
  const fingerprint = await recognizerFingerprint(db, o.descriptor);
  const existing = await findLocalRunByIdentity(db, o.revisionId, fingerprint);
  if (existing) return { kind: 'reused', runId: existing.id };
  const active = await activeRunForRevision(db, o.revisionId);
  if (active) return { kind: 'active', runId: active.id };
  const previous = await latestFinishedRun(db, o.revisionId);
  const r = await db.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, source_artifact_name,
                                  supersedes_run_id, created_by, recognizer)
     SELECT dr.id, dr.tender_id, dr.contract_id, 'local_ocr', dr.blob_sha256, NULL, $2, $3, $4::jsonb
       FROM document_revision dr WHERE dr.id = $1
     RETURNING id`,
    [o.revisionId, previous?.id ?? null, o.createdBy, JSON.stringify(o.descriptor)],
  );
  const runId = r.rows[0]!.id;
  await enqueueJob(db, {
    kind: LOCAL_JOB_KIND,
    dedupeKey: `recognition:${o.revisionId}:${info.blob_sha256}:${fingerprint}`,
    payload: { runId },
    tenderId: info.tender_id,
    resourceClass: 'default',
    priority: LOCAL_JOB_PRIORITY,
  });
  return { kind: 'created', runId };
};

// Отпечатки текущего распознавателя по форматам — вход автоматического прохода.
export type FingerprintByFormat = Record<LocalInputFormat, string>;

// Кандидаты автоматического прохода (OD-2): DOCX, XLSX, CSV и PDF с политикой local, у которых нет
// успешного локального прогона, нет незавершённого прогона и нет прогона текущей идентичности в любом
// статусе — отказ того же распознавателя повторно не ставится сам, только явной командой.
export const autoRecognitionCandidates = async (
  db: Queryable,
  fps: FingerprintByFormat,
  limit: number,
): Promise<{ revision_id: string; input_format: LocalInputFormat }[]> => {
  const r = await db.query<{ revision_id: string; input_format: LocalInputFormat }>(
    `SELECT c.id AS revision_id, c.input_format
       FROM (SELECT dr.id, dr.received_at, local_input_format(b.media_type) AS input_format
               FROM document_revision dr JOIN blob b ON b.sha256 = dr.blob_sha256) c
      WHERE c.input_format IS NOT NULL
        AND (c.input_format <> 'pdf' OR recognition_revision_route(c.id) = 'local')
        AND NOT EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = c.id AND r.status IN ('queued', 'running'))
        AND NOT EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = c.id AND r.engine = 'local_ocr'
                          AND r.status IN ('complete', 'partial'))
        AND NOT EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = c.id AND r.engine = 'local_ocr'
                          AND r.recognizer_fingerprint = CASE c.input_format WHEN 'pdf' THEN $1 WHEN 'docx' THEN $2
                                                                            WHEN 'xlsx' THEN $3 ELSE $4 END)
      ORDER BY c.received_at, c.id
      LIMIT $5`,
    [fps.pdf, fps.docx, fps.xlsx, fps.csv, limit],
  );
  return r.rows;
};

export const preferredRunId = async (db: Queryable, revisionId: string): Promise<string | null> => {
  const r = await db.query<{ id: string | null }>('SELECT recognition_preferred_run($1) AS id', [revisionId]);
  return r.rows[0]?.id ?? null;
};

// Отказ локального прогона с диагностикой качества (без текста документа).
export const failLocalRun = async (db: Queryable, id: string, code: string, detail: string, quality: Record<string, unknown>): Promise<boolean> => {
  const r = await db.query(
    `UPDATE recognition_run
        SET status = 'failed', failure_code = $2, failure_detail = $3, quality = $4::jsonb, finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [id, code.slice(0, 60), detail.slice(0, 2000), JSON.stringify(quality)],
  );
  return (r.rowCount ?? 0) > 0;
};

export const setDocumentRecognitionRoute = async (db: Queryable, documentId: string, route: RecognitionRoutePolicy): Promise<void> => {
  await db.query('UPDATE document SET recognition_route = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [documentId, route]);
};
