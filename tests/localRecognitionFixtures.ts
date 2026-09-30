// Фикстуры локальных прогонов для тестов БД (этап 05a): редакции нужного типа файла прямо в БД и
// локальный прогон по настоящей машине состояний (queued → running → терминальный статус) — так
// охранники миграции 0014 проверяются под ролью приложения без кода портала.
import { createHash, randomBytes } from 'node:crypto';
import { finishRun, insertFragments, insertPages, type Pool, type RecognitionPageStatus, type RecognitionUnitKind } from '../packages/db/src/index.ts';

export const MEDIA = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
} as const;
export type FixtureFormat = keyof typeof MEDIA;

export const newRevision = async (
  pool: Pool,
  o: { tenderId: string; format: FixtureFormat; route?: 'auto' | 'local' | 'rdweb'; userId: string },
): Promise<{ revisionId: string; documentId: string; sha: string }> => {
  const sha = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, $2, $3)', [sha, MEDIA[o.format], `t/${sha}`]);
  const doc = await pool.query<{ id: string }>(
    "INSERT INTO document (tender_id, title, name_key, recognition_route) VALUES ($1, $2, $3, $4) RETURNING id",
    [o.tenderId, `Документ ${sha.slice(0, 6)}.${o.format}`, `doc-${sha.slice(0, 12)}`, o.route ?? 'auto'],
  );
  const rev = await pool.query<{ id: string }>(
    'INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, $3, 1, $4) RETURNING id',
    [doc.rows[0]!.id, o.tenderId, sha, o.userId],
  );
  return { revisionId: rev.rows[0]!.id, documentId: doc.rows[0]!.id, sha };
};

export const descriptorOf = (format: 'pdf' | 'docx' | 'xlsx' | 'csv', over: Record<string, unknown> = {}) => ({
  recognizerId: 'kontur.local',
  recognizerVersion: '1',
  inputFormat: format,
  processing: format === 'pdf' ? 'native_text' : 'structured_parser',
  languages: [] as string[],
  config: { parser: format },
  ...over,
});

// Локальный прогон встаёт за хвостом истории редакции (линейность 0008).
export const insertLocalRun = async (pool: Pool, revisionId: string, descriptor: object, createdBy: string | null): Promise<string> => {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, source_artifact_name,
                                  supersedes_run_id, created_by, recognizer)
     SELECT dr.id, dr.tender_id, dr.contract_id, 'local_ocr', dr.blob_sha256, NULL,
            (SELECT p.id FROM recognition_run p
              WHERE p.document_revision_id = dr.id AND p.status IN ('complete', 'partial')
                AND NOT EXISTS (SELECT 1 FROM recognition_run c WHERE c.supersedes_run_id = p.id AND c.status NOT IN ('failed', 'cancelled'))),
            $2, $3::jsonb
       FROM document_revision dr WHERE dr.id = $1 RETURNING id`,
    [revisionId, createdBy, JSON.stringify(descriptor)],
  );
  return r.rows[0]!.id;
};

export const startRunSql = async (pool: Pool, runId: string): Promise<void> => {
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [runId]);
};

export interface IUnitSpec {
  kind: RecognitionUnitKind;
  status?: RecognitionPageStatus;
  label?: string | null;
}

// Завершение локального прогона с единицами и фрагментами (по одному фрагменту на единицу, если задан текст).
export const completeLocalRun = async (
  pool: Pool,
  runId: string,
  units: IUnitSpec[],
  texts: (string | null)[] = [],
): Promise<void> => {
  await startRunSql(pool, runId);
  const ref = await pool.query<{ tender_id: string | null; contract_id: string | null; document_revision_id: string }>(
    'SELECT tender_id, contract_id, document_revision_id FROM recognition_run WHERE id = $1',
    [runId],
  );
  const run = ref.rows[0]!;
  await insertPages(
    pool,
    runId,
    units.map((u, i) => ({
      pageIndex: i,
      pageLabel: u.label ?? (u.kind === 'xlsx_sheet' ? `Лист ${i + 1}` : u.kind === 'pdf_page' ? String(i + 1) : null),
      sheetLabel: null,
      widthPx: u.kind === 'pdf_page' ? 1654 : null,
      heightPx: u.kind === 'pdf_page' ? 2339 : null,
      rotation: 0,
      status: u.status ?? 'recognized',
      unitKind: u.kind,
    })),
  );
  const locatorOf = (u: IUnitSpec, i: number): Record<string, unknown> => {
    switch (u.kind) {
      case 'pdf_page':
        return { kind: 'pdf_text', page: i + 1, method: 'native_text', block: 1 };
      case 'xlsx_sheet':
        return { kind: 'xlsx_cells', sheet: `Лист ${i + 1}`, sheetIndex: i + 1, range: 'A1:B1', rowFrom: 1, rowTo: 1, colFrom: 1, colTo: 2 };
      case 'csv_table':
        return { kind: 'csv_rows', rowFrom: 1, rowTo: 1, colFrom: 1, colTo: 2, headerRow: 1, lineFrom: 1, lineTo: 1 };
      case 'docx_body':
        return { kind: 'docx_paragraph', part: 'body', block: 1, section: 1 };
    }
  };
  await insertFragments(
    pool,
    { runId, tenderId: run.tender_id, contractId: run.contract_id, documentRevisionId: run.document_revision_id },
    units.flatMap((u, i) => {
      const text = texts[i];
      if (!text) return [];
      return [
        {
          origin: 'document_text' as const,
          fragmentKind: 'text_block' as const,
          fragmentKey: `u${i}`,
          externalBlockId: null,
          ordinal: 1,
          pageIndex: i,
          bboxNorm: null,
          bboxSpace: null,
          shapeType: null,
          polygonNorm: null,
          rotation: null,
          text,
          textSha256: createHash('sha256').update(text).digest('hex'),
          derivedModelRef: null,
          externalCropUrl: null,
          warnings: [],
          partIndex: 0,
          partTotal: 1,
          locator: locatorOf(u, i),
        },
      ];
    }),
  );
  const recognized = units.filter((u) => (u.status ?? 'recognized') === 'recognized').length;
  await finishRun(pool, runId, {
    status: recognized === units.length ? 'complete' : 'partial',
    engineSchemaVersion: 'test',
    pagesTotal: units.length,
    pagesRecognized: recognized,
    quality: { verdict: recognized === units.length ? 'complete' : 'needs_review' },
  });
};

export const sqlCode = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
