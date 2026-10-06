// Кандидат выпуска (этап 12; D-032; проект §5): создание под блокировкой этапа с закреплением входов — ревизия расчёта,
// снимок области, последний завершённый прогон проверок, действующие решения этапа, выбранные «заполненные» приложения
// с точными версиями полей, ревизии их шаблонов, выбранные вложения; базы актуальности; задание сборки. Чтение кандидата
// его не пересобирает. Изменения входов после сборки — события барьера после базы; использованное поле — только
// изменения приложений этого кандидата (D-032 В-12-9). Завершение сборки — файлы, проверки, манифест одной транзакцией.
import { canonicalJson, sha256Hex, type Audience, type IManifest } from '@kontur/core';
import { draftFields, getDraft, type IDraftRow } from './forms.ts';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { lockTenderStages } from './stageEvents.ts';

export const CANDIDATE_ASSEMBLE_JOB_KIND = 'candidate.assemble';

export interface IReleaseCandidateRow {
  id: string;
  tender_id: string;
  stage_id: string;
  seq: number;
  mode: 'test' | 'production';
  status: 'assembling' | 'assembly_failed' | 'ready_for_approval' | 'superseded';
  calculation_revision_id: string;
  evidence_scope_id: string;
  calculation_baseline_version: number;
  content_baseline_version: number;
  inputs_sha256: string;
  converter_version: string | null;
  manifest_blob_sha256: string | null;
  manifest_sha256: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  finished_at: Date | null;
  superseded_by_candidate_id: string | null;
  row_version: number;
}

export interface ICandidateFileRow {
  id: string;
  candidate_id: string;
  ordinal: number;
  path: string;
  role: 'document' | 'attachment' | 'preview';
  audience: Audience;
  media_type: string;
  blob_sha256: string;
  size_bytes: number;
  source_file_id: string | null;
  template_revision_id: string | null;
  draft_id: string | null;
  attachment_revision_id: string | null;
  pages: number | null;
  fonts: string[] | null;
}

export interface ICandidateCheckRow {
  ordinal: number;
  code: string;
  outcome: 'passed' | 'failed' | 'unverified' | 'not_applicable';
  path: string | null;
  detail: string | null;
}

export interface ICandidateInputRow {
  kind: 'review_run' | 'decision' | 'application_draft' | 'field_version' | 'template_revision' | 'attachment_revision';
  ref_id: string;
  ordinal: number;
}

const CANDIDATE_SELECT = `SELECT c.*, u.display_name AS created_by_name FROM release_candidate c JOIN app_user u ON u.id = c.created_by`;

export const getCandidate = async (db: Queryable, id: string, lock = false): Promise<IReleaseCandidateRow | null> =>
  (await db.query<IReleaseCandidateRow>(`${CANDIDATE_SELECT} WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`, [id])).rows[0] ?? null;

export const listCandidates = async (db: Queryable, stageId: string): Promise<IReleaseCandidateRow[]> =>
  (await db.query<IReleaseCandidateRow>(`${CANDIDATE_SELECT} WHERE c.stage_id = $1 ORDER BY c.seq DESC`, [stageId])).rows;

export const candidateInputs = async (db: Queryable, id: string): Promise<ICandidateInputRow[]> =>
  (await db.query<ICandidateInputRow>('SELECT kind, ref_id, ordinal FROM candidate_input WHERE candidate_id = $1 ORDER BY kind, ordinal', [id])).rows;

export const candidateFiles = async (db: Queryable, id: string): Promise<ICandidateFileRow[]> =>
  (await db.query<ICandidateFileRow>('SELECT * FROM candidate_file WHERE candidate_id = $1 ORDER BY ordinal', [id])).rows.map((f) => ({ ...f, size_bytes: Number(f.size_bytes) }));

export const candidateChecks = async (db: Queryable, id: string): Promise<ICandidateCheckRow[]> =>
  (await db.query<ICandidateCheckRow>('SELECT ordinal, code, outcome, path, detail FROM candidate_check WHERE candidate_id = $1 ORDER BY ordinal', [id])).rows;

export const getCandidateFile = async (db: Queryable, id: string): Promise<ICandidateFileRow | null> => {
  const r = (await db.query<ICandidateFileRow>('SELECT * FROM candidate_file WHERE id = $1', [id])).rows[0];
  return r ? { ...r, size_bytes: Number(r.size_bytes) } : null;
};

// Закреплённые версии полей кандидата (права на содержимое считаются по ним, а не по текущим — D-032 В-12-7).
export const candidateFieldVersionIds = async (db: Queryable, id: string): Promise<string[]> =>
  (await db.query<{ ref_id: string }>("SELECT ref_id FROM candidate_input WHERE candidate_id = $1 AND kind = 'field_version' ORDER BY ordinal", [id])).rows.map((r) => r.ref_id);

// ---------------------------------------------------------------- Создание

export type CreateCandidateResult =
  | { ok: true; candidateId: string }
  | { ok: false; reason: 'candidate_assembling' | 'no_calculation_revision' | 'no_scope' | 'drafts_not_complete' | 'markup_missing' | 'attachment_not_approved' | 'nothing_selected'; detail?: Record<string, unknown> };

export interface ICreateCandidateInput {
  tenderId: string;
  stageId: string;
  mode: 'test' | 'production';
  draftIds: readonly string[];
  attachmentRevisionIds: readonly string[];
  userId: string;
}

// Входы, которые будут закреплены (для проверки видимости до записи): версии полей выбранных приложений.
export const plannedFieldVersionIds = async (db: Queryable, drafts: readonly IDraftRow[]): Promise<string[]> => {
  const out: string[] = [];
  for (const d of drafts) for (const f of await draftFields(db, d)) if (f.latest) out.push(f.latest.id);
  return out;
};

export const createCandidate = async (db: Queryable, i: ICreateCandidateInput): Promise<CreateCandidateResult> => {
  await lockTenderStages(db, i.tenderId, [i.stageId]);
  if (i.draftIds.length === 0 && i.attachmentRevisionIds.length === 0) return { ok: false, reason: 'nothing_selected' };
  if ((await db.query("SELECT 1 FROM release_candidate WHERE stage_id = $1 AND status = 'assembling'", [i.stageId])).rowCount) return { ok: false, reason: 'candidate_assembling' };
  const stage = (await db.query<{ input_version: number }>('SELECT input_version FROM tender_stage WHERE id = $1', [i.stageId])).rows[0]!;
  const calc = (await db.query<{ id: string }>('SELECT id FROM calculation_revision WHERE stage_id = $1 ORDER BY seq DESC LIMIT 1', [i.stageId])).rows[0];
  if (!calc) return { ok: false, reason: 'no_calculation_revision' };
  // Снимок — тот же, что берут проверки этапа: активного реестра, иначе последний (REVIEW_SCOPE_MISMATCH, этап 13).
  const registry = (await db.query<{ evidence_scope_id: string }>('SELECT g.evidence_scope_id FROM requirement_registry_active a JOIN requirement_registry g ON g.id = a.registry_id WHERE a.stage_id = $1', [i.stageId])).rows[0];
  const scope = (
    await db.query<{ id: string }>(
      registry ? 'SELECT id FROM evidence_scope WHERE id = $1' : 'SELECT id FROM evidence_scope WHERE stage_id = $1 ORDER BY created_at DESC, id LIMIT 1',
      [registry ? registry.evidence_scope_id : i.stageId],
    )
  ).rows[0];
  if (!scope) return { ok: false, reason: 'no_scope' };

  const drafts: IDraftRow[] = [];
  for (const id of [...new Set(i.draftIds)]) {
    const d = await getDraft(db, id, true);
    if (!d || d.stage_id !== i.stageId || d.status !== 'complete') return { ok: false, reason: 'drafts_not_complete', detail: { draftId: id, status: d?.status ?? null } };
    drafts.push(d);
  }
  const revisions = (
    await db.query<{ id: string; ok: boolean | null }>('SELECT id, (markup ->> \'ok\')::boolean AS ok FROM template_revision WHERE id = ANY($1::uuid[])', [drafts.map((d) => d.template_revision_id)])
  ).rows;
  const missing = drafts.filter((d) => !revisions.find((r) => r.id === d.template_revision_id)?.ok);
  if (missing.length > 0) return { ok: false, reason: 'markup_missing', detail: { draftIds: missing.map((d) => d.id) } };
  const attachments = (
    await db.query<{ id: string }>(
      `SELECT r.id FROM standard_attachment_revision r JOIN standard_attachment a ON a.id = r.attachment_id
        WHERE r.id = ANY($1::uuid[]) AND r.status = 'approved' AND (a.scope_tender_id IS NULL OR a.scope_tender_id = $2)`,
      [[...new Set(i.attachmentRevisionIds)], i.tenderId],
    )
  ).rows.map((r) => r.id);
  if (attachments.length !== new Set(i.attachmentRevisionIds).size) return { ok: false, reason: 'attachment_not_approved' };

  const run = (
    await db.query<{ id: string }>(
      "SELECT id FROM review_run WHERE stage_id = $1 AND status IN ('completed', 'completed_with_gaps') ORDER BY created_at DESC, id LIMIT 1",
      [i.stageId],
    )
  ).rows[0];
  const decisions = (
    await db.query<{ id: string }>('SELECT d.id FROM decision d WHERE d.stage_id = $1 AND NOT EXISTS (SELECT 1 FROM decision n WHERE n.supersedes_decision_id = d.id) ORDER BY d.created_at, d.id', [i.stageId])
  ).rows.map((r) => r.id);
  const fieldVersions = await plannedFieldVersionIds(db, drafts);
  const inputs: { kind: ICandidateInputRow['kind']; ids: string[] }[] = [
    { kind: 'review_run', ids: run ? [run.id] : [] },
    { kind: 'decision', ids: decisions },
    { kind: 'application_draft', ids: drafts.map((d) => d.id) },
    { kind: 'template_revision', ids: [...new Set(drafts.map((d) => d.template_revision_id))] },
    { kind: 'field_version', ids: fieldVersions },
    { kind: 'attachment_revision', ids: attachments },
  ];
  // Хэш закреплённых входов: ID по видам, ревизия расчёта, снимок, базы (повтор при тех же входах — тот же хэш).
  const hash = sha256Hex(
    `kontur.candidate_inputs.v1\n${canonicalJson({ calculationRevisionId: calc.id, evidenceScopeId: scope.id, baseline: Number(stage.input_version), inputs: inputs.map((g) => ({ kind: g.kind, ids: g.ids })) })}`,
  );
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO release_candidate (tender_id, stage_id, seq, mode, calculation_revision_id, evidence_scope_id, calculation_baseline_version, content_baseline_version,
                                      inputs_sha256, created_by)
       VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM release_candidate WHERE stage_id = $2), $3, $4, $5, $6, $6, $7, $8) RETURNING id`,
      [i.tenderId, i.stageId, i.mode, calc.id, scope.id, stage.input_version, hash, i.userId],
    )
  ).rows[0]!.id;
  for (const g of inputs) {
    for (const [ordinal, ref] of g.ids.entries()) {
      await db.query('INSERT INTO candidate_input (candidate_id, kind, ref_id, ordinal) VALUES ($1, $2, $3, $4)', [id, g.kind, ref, ordinal]);
    }
  }
  await enqueueJob(db, { kind: CANDIDATE_ASSEMBLE_JOB_KIND, dedupeKey: `assemble:${id}`, payload: { candidateId: id }, maxAttempts: 3, tenderId: i.tenderId });
  return { ok: true, candidateId: id };
};

// ---------------------------------------------------------------- Актуальность (D-032 В-12-9)

export interface ICandidateEvent {
  seq: number;
  type: string;
  createdAt: Date;
  // Событие касается кандидата: расчёт, источники, решения — всегда (I04); правка поля — только приложений кандидата.
  affects: boolean;
}

export const candidateEventsAfter = async (db: Queryable, c: IReleaseCandidateRow): Promise<ICandidateEvent[]> => {
  const rows = (
    await db.query<{ seq: number; event_type: string; created_at: Date; ref_id: string; draft_id: string | null }>(
      `SELECT e.seq, e.event_type, e.created_at, e.ref_id,
              CASE WHEN e.event_type = 'draft_field_changed' THEN (SELECT v.draft_id FROM draft_field_version v WHERE v.id = e.ref_id) END AS draft_id
         FROM stage_input_event e WHERE e.stage_id = $1 AND e.seq > $2 ORDER BY e.seq LIMIT 200`,
      [c.stage_id, Math.min(c.calculation_baseline_version, c.content_baseline_version)],
    )
  ).rows;
  const drafts = new Set((await db.query<{ ref_id: string }>("SELECT ref_id FROM candidate_input WHERE candidate_id = $1 AND kind = 'application_draft'", [c.id])).rows.map((r) => r.ref_id));
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: r.event_type,
    createdAt: r.created_at,
    affects: r.event_type === 'draft_field_changed' ? r.draft_id !== null && drafts.has(r.draft_id) : true,
  }));
};

// ---------------------------------------------------------------- Завершение сборки

export interface IFinishFile {
  ordinal: number;
  path: string;
  role: ICandidateFileRow['role'];
  audience: Audience;
  mediaType: string;
  sha256: string;
  size: number;
  sourceOrdinal: number | null;
  templateRevisionId: string | null;
  draftId: string | null;
  attachmentRevisionId: string | null;
  pages: number | null;
  fonts: string[] | null;
}

export interface IFinishCandidate {
  candidateId: string;
  converterVersion: string | null;
  files: readonly IFinishFile[];
  checks: readonly { code: string; outcome: ICandidateCheckRow['outcome']; path?: string | null; detail?: string | null }[];
  manifest: { blobSha256: string; sha256: string; body: IManifest } | null;
  failure: { code: string; detail: string } | null;
}

export const finishCandidate = async (db: Queryable, f: IFinishCandidate): Promise<'ready_for_approval' | 'assembly_failed' | 'skipped'> => {
  const c = await getCandidate(db, f.candidateId, true);
  if (!c || c.status !== 'assembling') return 'skipped';
  const fileIds = new Map<number, string>();
  if (!f.failure) {
    for (const x of [...f.files].sort((a, b) => a.ordinal - b.ordinal)) {
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO candidate_file (candidate_id, ordinal, path, role, audience, media_type, blob_sha256, size_bytes, source_file_id, template_revision_id, draft_id,
                                       attachment_revision_id, pages, fonts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [
            c.id, x.ordinal, x.path, x.role, x.audience, x.mediaType, x.sha256, x.size, x.sourceOrdinal === null ? null : fileIds.get(x.sourceOrdinal)!, x.templateRevisionId,
            x.draftId, x.attachmentRevisionId, x.pages, x.fonts,
          ],
        )
      ).rows[0]!.id;
      fileIds.set(x.ordinal, id);
    }
  }
  for (const [n, k] of f.checks.entries()) {
    await db.query('INSERT INTO candidate_check (candidate_id, ordinal, code, outcome, path, detail) VALUES ($1, $2, $3, $4, $5, $6)', [
      c.id, n + 1, k.code, k.outcome, k.path?.slice(0, 200) ?? null, k.detail?.slice(0, 4000) ?? null,
    ]);
  }
  if (f.failure || !f.manifest) {
    const failure = f.failure ?? { code: 'manifest_missing', detail: 'манифест не построен' };
    await db.query(
      `UPDATE release_candidate SET status = 'assembly_failed', failure_code = $2, failure_detail = $3, converter_version = $4, finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
      [c.id, failure.code, failure.detail.slice(0, 4000), f.converterVersion],
    );
    return 'assembly_failed';
  }
  await db.query(
    `UPDATE release_candidate SET status = 'ready_for_approval', manifest_blob_sha256 = $2, manifest_sha256 = $3, converter_version = $4, finished_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [c.id, f.manifest.blobSha256, f.manifest.sha256, f.converterVersion],
  );
  // Прежний готовый кандидат этапа заменяется новым готовым (I03: прежний не меняется по содержимому).
  await db.query(
    `UPDATE release_candidate SET status = 'superseded', superseded_by_candidate_id = $2, row_version = row_version + 1
      WHERE stage_id = $1 AND status = 'ready_for_approval' AND id <> $2 AND seq < $3`,
    [c.stage_id, c.id, c.seq],
  );
  return 'ready_for_approval';
};
