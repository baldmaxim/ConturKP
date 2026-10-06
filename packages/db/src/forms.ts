// Приложения этапа 11 (D-031; проект docs/architecture/11-forms-design.md): шаблоны компании и заказчика с ревизиями
// схемы forms/1, библиотека утверждённых формулировок, приложения этапа, версии значений полей с происхождением и
// основаниями. Значение — неизменяемая версия; «устарело» — отметка инвалидации или заменённое основание по текущему
// состоянию (функция БД field_basis_problem). Предложение системы и модели становится значением только явным
// действием человека. Права шаблонов компании и формулировок доступа к содержимому тендеров не дают (D-031 В-11-3).
import { schemaKeys, schemaSha256, type FieldValue, type IFormSchema, type IMarkupResult } from '@kontur/core';
import type { IAccessContext } from './access.ts';
import { contentTenderIds } from './access.ts';
import type { Queryable } from './pool.ts';
import { dependenciesOf, insertDependencies } from './reviewRuns.ts';
import { emitStageEvents } from './stageEvents.ts';

// ---------------------------------------------------------------- Шаблоны

export interface ITemplateRow {
  id: string;
  owner_kind: 'company' | 'customer';
  tender_id: string | null;
  name: string;
  is_demo: boolean;
  created_by: string;
  created_at: Date;
  archived_at: Date | null;
  row_version: number;
  current_revision_id: string | null;
  current_seq: number | null;
  latest_seq: number | null;
}

const TEMPLATE_SELECT = `
  SELECT t.*,
         (SELECT r.id FROM template_revision r WHERE r.template_id = t.id AND r.status = 'approved' ORDER BY r.seq DESC LIMIT 1) AS current_revision_id,
         (SELECT r.seq FROM template_revision r WHERE r.template_id = t.id AND r.status = 'approved' ORDER BY r.seq DESC LIMIT 1) AS current_seq,
         (SELECT max(r.seq) FROM template_revision r WHERE r.template_id = t.id) AS latest_seq
    FROM application_template t`;

// Шаблоны компании видны всем с содержательной ролью; шаблоны заказчика — участникам их тендера.
export const listTemplates = async (db: Queryable, ctx: IAccessContext, tenderId: string | null = null): Promise<ITemplateRow[]> =>
  (
    await db.query<ITemplateRow>(
      `${TEMPLATE_SELECT}
        WHERE t.archived_at IS NULL AND (t.tender_id IS NULL OR t.tender_id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR t.tender_id IS NULL OR t.tender_id = $2)
        ORDER BY t.owner_kind, t.name, t.created_at`,
      [contentTenderIds(ctx), tenderId],
    )
  ).rows;

export const getTemplate = async (db: Queryable, id: string): Promise<ITemplateRow | null> =>
  (await db.query<ITemplateRow>(`${TEMPLATE_SELECT} WHERE t.id = $1`, [id])).rows[0] ?? null;

export const createTemplate = async (db: Queryable, t: { ownerKind: 'company' | 'customer'; tenderId: string | null; name: string; isDemo: boolean; userId: string }): Promise<string> =>
  (
    await db.query<{ id: string }>(
      'INSERT INTO application_template (owner_kind, tender_id, name, is_demo, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [t.ownerKind, t.tenderId, t.name, t.isDemo, t.userId],
    )
  ).rows[0]!.id;

export interface ITemplateRevisionRow {
  id: string;
  template_id: string;
  tender_id: string | null;
  seq: number;
  schema_version: string;
  field_schema: IFormSchema;
  schema_sha256: string;
  field_keys: string[];
  required_keys: string[];
  sample_blob_sha256: string | null;
  sample_name: string | null;
  // Этап 12 (D-032 В-12-3): размеченная копия образца, формат генерации, аудитория и итог проверки разметки.
  output_format: 'docx' | 'xlsx' | null;
  audience: 'customer' | 'internal';
  marked_sample_blob_sha256: string | null;
  marked_sample_name: string | null;
  markup: IMarkupResult | null;
  status: 'draft' | 'approved' | 'retired';
  basis_fragment_ids: string[];
  basis_decision_id: string | null;
  basis_note: string | null;
  created_by: string;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  retired_at: Date | null;
  row_version: number;
  template_name: string;
  owner_kind: 'company' | 'customer';
  is_demo: boolean;
}

const REVISION_SELECT = `
  SELECT r.*, t.name AS template_name, t.owner_kind, t.is_demo FROM template_revision r JOIN application_template t ON t.id = r.template_id`;

export const getTemplateRevision = async (db: Queryable, id: string, lock = false): Promise<ITemplateRevisionRow | null> =>
  (await db.query<ITemplateRevisionRow>(`${REVISION_SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0] ?? null;

export const listTemplateRevisions = async (db: Queryable, templateId: string): Promise<ITemplateRevisionRow[]> =>
  (await db.query<ITemplateRevisionRow>(`${REVISION_SELECT} WHERE r.template_id = $1 ORDER BY r.seq DESC`, [templateId])).rows;

export const createTemplateRevision = async (
  db: Queryable,
  r: {
    templateId: string;
    tenderId: string | null;
    schema: IFormSchema;
    sample: { sha256: string; name: string } | null;
    marked?: { sha256: string; name: string; format: 'docx' | 'xlsx'; markup: IMarkupResult } | null;
    audience?: 'customer' | 'internal';
    userId: string;
  },
): Promise<string> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('template_revision'), hashtext($1::text))", [r.templateId]);
  const keys = schemaKeys(r.schema);
  return (
    await db.query<{ id: string }>(
      `INSERT INTO template_revision (template_id, tender_id, seq, schema_version, field_schema, schema_sha256, field_keys, required_keys, sample_blob_sha256, sample_name,
                                      output_format, audience, marked_sample_blob_sha256, marked_sample_name, markup, created_by)
       VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM template_revision WHERE template_id = $1), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        r.templateId, r.tenderId, r.schema.schemaVersion, JSON.stringify(r.schema), schemaSha256(r.schema), keys.fieldKeys, keys.requiredKeys, r.sample?.sha256 ?? null, r.sample?.name ?? null,
        r.marked?.format ?? null, r.audience ?? 'customer', r.marked?.sha256 ?? null, r.marked?.name ?? null, r.marked ? JSON.stringify(r.marked.markup) : null, r.userId,
      ],
    )
  ).rows[0]!.id;
};

// Утверждение: новая ревизия становится действующей, прежняя утверждённая выбывает (черновики на ней остаются на ней).
export const approveTemplateRevision = async (
  db: Queryable,
  a: { revision: ITemplateRevisionRow; userId: string; basisFragmentIds: readonly string[]; basisDecisionId: string | null; basisNote: string | null },
): Promise<void> => {
  await db.query(
    `UPDATE template_revision SET status = 'retired', retired_at = now(), row_version = row_version + 1
      WHERE template_id = $1 AND status = 'approved' AND id <> $2`,
    [a.revision.template_id, a.revision.id],
  );
  await db.query(
    `UPDATE template_revision SET status = 'approved', approved_by = $2, approved_at = now(), basis_fragment_ids = $3, basis_decision_id = $4, basis_note = $5,
            row_version = row_version + 1 WHERE id = $1`,
    [a.revision.id, a.userId, [...a.basisFragmentIds], a.basisDecisionId, a.basisNote],
  );
};

export const retireTemplateRevision = async (db: Queryable, id: string): Promise<void> => {
  await db.query("UPDATE template_revision SET status = 'retired', retired_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
};

// ---------------------------------------------------------------- Формулировки

export interface IWordingRow {
  wording_id: string;
  scope_tender_id: string | null;
  title: string;
  version_id: string;
  version: number;
  text: string;
  tags: string[];
  status: 'proposed' | 'approved' | 'retired';
  proposed_by: string;
  proposed_by_name: string;
  approved_by: string | null;
  approved_at: Date | null;
  row_version: number;
  created_at: Date;
  approved_version_id: string | null;
}

const WORDING_SELECT = `
  SELECT w.id AS wording_id, w.scope_tender_id, w.title, v.id AS version_id, v.version, v.text, v.tags, v.status, v.proposed_by, u.display_name AS proposed_by_name,
         v.approved_by, v.approved_at, v.row_version, v.created_at,
         (SELECT a.id FROM wording_version a WHERE a.wording_id = w.id AND a.status = 'approved' ORDER BY a.version DESC LIMIT 1) AS approved_version_id
    FROM wording w JOIN wording_version v ON v.wording_id = w.id JOIN app_user u ON u.id = v.proposed_by`;

// Последние версии формулировок компании и тендеров пользователя; поиск по названию, тексту и тегам.
export const listWordings = async (db: Queryable, ctx: IAccessContext, q: { tenderId: string | null; query: string | null; tag: string | null; status: string | null }): Promise<IWordingRow[]> =>
  (
    await db.query<IWordingRow>(
      `${WORDING_SELECT}
        WHERE v.version = (SELECT max(x.version) FROM wording_version x WHERE x.wording_id = w.id)
          AND (w.scope_tender_id IS NULL OR w.scope_tender_id = ANY($1::uuid[]))
          AND ($2::uuid IS NULL OR w.scope_tender_id IS NULL OR w.scope_tender_id = $2)
          AND ($3::text IS NULL OR w.title ILIKE '%' || $3 || '%' OR v.text ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR $4 = ANY (v.tags))
          AND ($5::text IS NULL OR v.status = $5)
        ORDER BY w.title, w.created_at LIMIT 500`,
      [contentTenderIds(ctx), q.tenderId, q.query, q.tag, q.status],
    )
  ).rows;

export const getWordingVersion = async (db: Queryable, versionId: string, lock = false): Promise<IWordingRow | null> =>
  (await db.query<IWordingRow>(`${WORDING_SELECT} WHERE v.id = $1${lock ? ' FOR UPDATE OF v' : ''}`, [versionId])).rows[0] ?? null;

export const wordingHistory = async (db: Queryable, wordingId: string): Promise<IWordingRow[]> =>
  (await db.query<IWordingRow>(`${WORDING_SELECT} WHERE w.id = $1 ORDER BY v.version DESC`, [wordingId])).rows;

export const createWording = async (db: Queryable, w: { scopeTenderId: string | null; title: string; text: string; tags: readonly string[]; userId: string }): Promise<{ wordingId: string; versionId: string }> => {
  const wordingId = (await db.query<{ id: string }>('INSERT INTO wording (scope_tender_id, title, created_by) VALUES ($1, $2, $3) RETURNING id', [w.scopeTenderId, w.title, w.userId])).rows[0]!.id;
  const versionId = (
    await db.query<{ id: string }>("INSERT INTO wording_version (wording_id, version, text, tags, proposed_by) VALUES ($1, 1, $2, $3, $4) RETURNING id", [wordingId, w.text, [...w.tags], w.userId])
  ).rows[0]!.id;
  return { wordingId, versionId };
};

export const addWordingVersion = async (db: Queryable, w: { wordingId: string; text: string; tags: readonly string[]; userId: string }): Promise<string> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('wording_version'), hashtext($1::text))", [w.wordingId]);
  return (
    await db.query<{ id: string }>(
      'INSERT INTO wording_version (wording_id, version, text, tags, proposed_by) VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM wording_version WHERE wording_id = $1), $2, $3, $4) RETURNING id',
      [w.wordingId, w.text, [...w.tags], w.userId],
    )
  ).rows[0]!.id;
};

// Утверждение новой версии выводит прежнюю утверждённую из библиотеки: заполненные поля сохраняют свою версию.
export const decideWordingVersion = async (db: Queryable, d: { versionId: string; wordingId: string; status: 'approved' | 'retired'; userId: string }): Promise<void> => {
  if (d.status === 'approved') {
    await db.query("UPDATE wording_version SET status = 'retired', retired_at = now(), row_version = row_version + 1 WHERE wording_id = $1 AND status = 'approved' AND id <> $2", [d.wordingId, d.versionId]);
    await db.query("UPDATE wording_version SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [d.versionId, d.userId]);
  } else {
    await db.query("UPDATE wording_version SET status = 'retired', retired_at = now(), row_version = row_version + 1 WHERE id = $1", [d.versionId]);
  }
};

// ---------------------------------------------------------------- Приложения

export interface IDraftRow {
  id: string;
  tender_id: string;
  stage_id: string;
  template_revision_id: string;
  title: string;
  status: 'in_progress' | 'complete' | 'superseded';
  migrated_from_draft_id: string | null;
  migration_report: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  completed_by: string | null;
  completed_at: Date | null;
  row_version: number;
  template_id: string;
  template_name: string;
  owner_kind: 'company' | 'customer';
  is_demo: boolean;
  revision_seq: number;
  revision_status: string;
  field_schema: IFormSchema;
  current_revision_id: string | null;
  superseded_by_draft_id: string | null;
}

const DRAFT_SELECT = `
  SELECT a.*, t.id AS template_id, t.name AS template_name, t.owner_kind, t.is_demo, r.seq AS revision_seq, r.status AS revision_status, r.field_schema,
         (SELECT x.id FROM template_revision x WHERE x.template_id = t.id AND x.status = 'approved' ORDER BY x.seq DESC LIMIT 1) AS current_revision_id,
         (SELECT n.id FROM application_draft n WHERE n.migrated_from_draft_id = a.id LIMIT 1) AS superseded_by_draft_id
    FROM application_draft a JOIN template_revision r ON r.id = a.template_revision_id JOIN application_template t ON t.id = r.template_id`;

export const getDraft = async (db: Queryable, id: string, lock = false): Promise<IDraftRow | null> =>
  (await db.query<IDraftRow>(`${DRAFT_SELECT} WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [id])).rows[0] ?? null;

export const listDrafts = async (db: Queryable, stageId: string): Promise<IDraftRow[]> =>
  (await db.query<IDraftRow>(`${DRAFT_SELECT} WHERE a.stage_id = $1 ORDER BY a.status = 'superseded', a.created_at`, [stageId])).rows;

export const createDraft = async (
  db: Queryable,
  d: { tenderId: string; stageId: string; revision: ITemplateRevisionRow; title: string; userId: string; migratedFromDraftId?: string | null; migrationReport?: Record<string, unknown> | null },
): Promise<{ draftId: string; fieldIds: Map<string, string> }> => {
  const draftId = (
    await db.query<{ id: string }>(
      `INSERT INTO application_draft (tender_id, stage_id, template_revision_id, title, created_by, migrated_from_draft_id, migration_report)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [d.tenderId, d.stageId, d.revision.id, d.title, d.userId, d.migratedFromDraftId ?? null, d.migrationReport ? JSON.stringify(d.migrationReport) : null],
    )
  ).rows[0]!.id;
  const rows = await db.query<{ id: string; field_key: string }>(
    'INSERT INTO draft_field (draft_id, tender_id, field_key) SELECT $1, $2, k FROM unnest($3::text[]) AS k RETURNING id, field_key',
    [draftId, d.tenderId, d.revision.field_keys],
  );
  return { draftId, fieldIds: new Map(rows.rows.map((r) => [r.field_key, r.id])) };
};

export const setDraftStatus = async (db: Queryable, d: { draftId: string; status: 'in_progress' | 'complete' | 'superseded'; userId: string }): Promise<void> => {
  await db.query(
    `UPDATE application_draft SET status = $2, completed_by = CASE WHEN $2 = 'complete' THEN $3::uuid END, completed_at = CASE WHEN $2 = 'complete' THEN now() END,
            updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [d.draftId, d.status, d.userId],
  );
};

// ---------------------------------------------------------------- Поля и версии

export interface IFieldBasisRow {
  basisType: 'fragment' | 'decision' | 'requirement_revision' | 'evidence_fact';
  fragmentId: string | null;
  decisionId: string | null;
  requirementRevisionId: string | null;
  evidenceFactId: string | null;
  quote: string | null;
  text: string | null;
  origin: string | null;
  problem: string | null;
}

export interface IFieldVersionRow {
  id: string;
  field_id: string;
  version: number;
  value: FieldValue | null;
  state: 'accepted' | 'edited' | 'needs_discussion' | 'cleared' | 'carried_over';
  origin: 'manual' | 'approved_wording' | 'model_suggestion' | 'system_suggestion' | 'carried_over';
  wording_version_id: string | null;
  wording_version: number | null;
  wording_title: string | null;
  wording_newer_approved: boolean;
  suggestion_id: string | null;
  previous_version_id: string | null;
  carried_from_version_id: string | null;
  value_from_version_id: string | null;
  comment: string | null;
  responsible_user_id: string | null;
  responsible_name: string | null;
  customer_question_id: string | null;
  actor_user_id: string;
  actor_name: string;
  created_at: Date;
  bases: IFieldBasisRow[];
  invalidations: { reason: string; at: string }[];
  // Проблема основания версий-источников скопированного значения сейчас (R11-05); null — действуют.
  inherited_problem: string | null;
  // Отметка «основание изменилось» у версии или у источников копии без подтверждения (R11-05).
  chain_invalidated: boolean;
}

const VERSION_SELECT = (stageExpr: string) => `
  SELECT v.id, v.field_id, v.version, v.value, v.state, v.origin, v.wording_version_id, wv.version AS wording_version, w.title AS wording_title,
         coalesce(EXISTS (SELECT 1 FROM wording_version n WHERE n.wording_id = wv.wording_id AND n.status = 'approved' AND n.version > wv.version), false) AS wording_newer_approved,
         v.suggestion_id, v.previous_version_id, v.carried_from_version_id, v.value_from_version_id, v.comment, v.responsible_user_id, ru.display_name AS responsible_name,
         v.customer_question_id, v.actor_user_id, u.display_name AS actor_name, v.created_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object('basisType', b.basis_type, 'fragmentId', b.fragment_id, 'decisionId', b.decision_id,
                                                       'requirementRevisionId', b.requirement_revision_id, 'evidenceFactId', b.evidence_fact_id, 'quote', b.quote,
                                                       'text', left(f.text, 600), 'origin', f.origin,
                                                       'problem', field_basis_problem(${stageExpr}, b.fragment_id, b.decision_id, b.requirement_revision_id, b.evidence_fact_id))
                                    ORDER BY b.id)
                     FROM draft_field_basis b LEFT JOIN evidence_fragment f ON f.id = b.fragment_id WHERE b.field_version_id = v.id), '[]'::jsonb) AS bases,
         coalesce((SELECT jsonb_agg(jsonb_build_object('reason', i.reason, 'at', i.created_at) ORDER BY i.created_at)
                     FROM evidence_invalidation i WHERE i.dependent_type = 'draft_field_version' AND i.dependent_id = v.id), '[]'::jsonb) AS invalidations,
         field_version_basis_problem(${stageExpr}, draft_field_value_source(v.id)) AS inherited_problem,
         field_version_invalidated(v.id) AS chain_invalidated
    FROM draft_field_version v
    JOIN app_user u ON u.id = v.actor_user_id
    LEFT JOIN app_user ru ON ru.id = v.responsible_user_id
    LEFT JOIN wording_version wv ON wv.id = v.wording_version_id
    LEFT JOIN wording w ON w.id = wv.wording_id`;

export interface IDraftFieldRow {
  field_id: string;
  field_key: string;
  latest: IFieldVersionRow | null;
}

// Поля приложения с последней версией, основаниями (и их проблемами сейчас) и отметками инвалидации.
export const draftFields = async (db: Queryable, draft: IDraftRow): Promise<IDraftFieldRow[]> => {
  const fields = (await db.query<{ id: string; field_key: string }>('SELECT id, field_key FROM draft_field WHERE draft_id = $1', [draft.id])).rows;
  const latest = (
    await db.query<IFieldVersionRow>(
      `${VERSION_SELECT('$2::uuid')}
        WHERE v.draft_id = $1 AND v.version = (SELECT max(x.version) FROM draft_field_version x WHERE x.field_id = v.field_id)`,
      [draft.id, draft.stage_id],
    )
  ).rows;
  const byField = new Map(latest.map((v) => [v.field_id, v]));
  return fields.map((f) => ({ field_id: f.id, field_key: f.field_key, latest: byField.get(f.id) ?? null }));
};

export const fieldHistory = async (db: Queryable, fieldId: string, stageId: string): Promise<IFieldVersionRow[]> =>
  (await db.query<IFieldVersionRow>(`${VERSION_SELECT('$2::uuid')} WHERE v.field_id = $1 ORDER BY v.version DESC`, [fieldId, stageId])).rows;

export const getDraftField = async (db: Queryable, fieldId: string): Promise<{ id: string; draft_id: string; tender_id: string; field_key: string } | null> =>
  (await db.query<{ id: string; draft_id: string; tender_id: string; field_key: string }>('SELECT id, draft_id, tender_id, field_key FROM draft_field WHERE id = $1', [fieldId])).rows[0] ?? null;

export const fieldVersionNumber = async (db: Queryable, fieldId: string): Promise<{ version: number; id: string | null }> => {
  const r = (await db.query<{ version: number; id: string }>('SELECT version, id FROM draft_field_version WHERE field_id = $1 ORDER BY version DESC LIMIT 1', [fieldId])).rows[0];
  return { version: r?.version ?? 0, id: r?.id ?? null };
};

export interface IBasisInput {
  basisType: 'fragment' | 'decision' | 'requirement_revision' | 'evidence_fact';
  id: string;
  quote?: string | null;
}

export interface IFieldVersionInput {
  tenderId: string;
  stageId: string;
  draftId: string;
  fieldId: string;
  value: FieldValue | null;
  state: IFieldVersionRow['state'];
  origin: IFieldVersionRow['origin'];
  wordingVersionId?: string | null;
  suggestionId?: string | null;
  carriedFromVersionId?: string | null;
  // Версия, значение которой повторяет новая (обсуждение, подтверждение, перенос): права и происхождение — по ней (R11-02).
  valueFromVersionId?: string | null;
  comment?: string | null;
  responsibleUserId?: string | null;
  customerQuestionId?: string | null;
  userId: string;
  bases: readonly IBasisInput[];
}

// Заменённые и конфликтующие основания новой версии (D-031 В-11-5, В-11-6) — по текущему состоянию.
export const fieldBasisProblems = async (db: Queryable, stageId: string, bases: readonly IBasisInput[]): Promise<{ basisType: string; id: string; cause: string }[]> => {
  if (bases.length === 0) return [];
  const r = await db.query<{ t: string; id: string; cause: string | null }>(
    `SELECT x.t, x.id, field_basis_problem($1, CASE WHEN x.t = 'fragment' THEN x.id END, CASE WHEN x.t = 'decision' THEN x.id END,
                                           CASE WHEN x.t = 'requirement_revision' THEN x.id END, CASE WHEN x.t = 'evidence_fact' THEN x.id END) AS cause
       FROM unnest($2::text[], $3::uuid[]) AS x(t, id)`,
    [stageId, bases.map((b) => b.basisType), bases.map((b) => b.id)],
  );
  return r.rows.filter((x) => x.cause !== null).map((x) => ({ basisType: x.t, id: x.id, cause: x.cause! }));
};

// Новая версия значения с основаниями и зависимостями; событие барьера `draft_field_changed` (класс content).
export const appendFieldVersion = async (db: Queryable, i: IFieldVersionInput): Promise<string> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('draft_field_version'), hashtext($1::text))", [i.fieldId]);
  const prev = await fieldVersionNumber(db, i.fieldId);
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, wording_version_id, suggestion_id, previous_version_id,
                                        carried_from_version_id, value_from_version_id, comment, responsible_user_id, customer_question_id, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [
        i.fieldId, i.draftId, i.tenderId, prev.version + 1, i.value === null ? null : JSON.stringify(i.value), i.state, i.origin, i.wordingVersionId ?? null,
        i.suggestionId ?? null, prev.id, i.carriedFromVersionId ?? null, i.valueFromVersionId ?? null, i.comment ?? null, i.responsibleUserId ?? null,
        i.customerQuestionId ?? null, i.userId,
      ],
    )
  ).rows[0]!.id;
  for (const b of i.bases) {
    await db.query(
      `INSERT INTO draft_field_basis (field_version_id, tender_id, basis_type, fragment_id, decision_id, requirement_revision_id, evidence_fact_id, quote)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, i.tenderId, b.basisType, b.basisType === 'fragment' ? b.id : null, b.basisType === 'decision' ? b.id : null,
        b.basisType === 'requirement_revision' ? b.id : null, b.basisType === 'evidence_fact' ? b.id : null, b.quote ?? null,
      ],
    );
  }
  // Зависимости — от исходных фрагментов каждого основания (требование, решение, факт — до фрагментов, R11-03) и
  // от оснований версий-источников скопированного значения (R11-05); решение — и от закреплённой им ревизии требования.
  const inherited = i.valueFromVersionId
    ? (
        await db.query<{ t: IBasisInput['basisType']; id: string }>(
          `WITH RECURSIVE chain(vid) AS (
             SELECT $1::uuid
             UNION
             SELECT draft_field_value_source(c.vid) FROM chain c WHERE draft_field_value_source(c.vid) IS NOT NULL)
           SELECT b.basis_type AS t, coalesce(b.fragment_id, b.decision_id, b.requirement_revision_id, b.evidence_fact_id) AS id
             FROM chain c JOIN draft_field_basis b ON b.field_version_id = c.vid`,
          [i.valueFromVersionId],
        )
      ).rows
    : [];
  const all = [...i.bases.map((b) => ({ t: b.basisType, id: b.id })), ...inherited];
  const sources = all.length
    ? (
        await db.query<{ fragment_id: string | null; requirement_revision_id: string | null }>(
          `SELECT DISTINCT f.id AS fragment_id, NULL::uuid AS requirement_revision_id
             FROM unnest($1::text[], $2::uuid[]) AS x(t, id),
                  LATERAL field_basis_source_fragments(CASE WHEN x.t = 'fragment' THEN x.id END, CASE WHEN x.t = 'decision' THEN x.id END,
                                                       CASE WHEN x.t = 'requirement_revision' THEN x.id END, CASE WHEN x.t = 'evidence_fact' THEN x.id END) AS f(id)
           UNION
           SELECT NULL, decision_requirement_revision_of(x.id) FROM unnest($1::text[], $2::uuid[]) AS x(t, id) WHERE x.t = 'decision'`,
          [all.map((b) => b.t), all.map((b) => b.id)],
        )
      ).rows
    : [];
  const refs = [
    ...(await dependenciesOf(db, sources.flatMap((r) => (r.fragment_id ? [{ side: 'context' as const, objectType: 'fragment' as const, fragmentId: r.fragment_id }] : [])))),
    ...[...new Set(all.filter((b) => b.t === 'decision').map((b) => b.id))].map((id) => ({ type: 'decision', id })),
    ...[...new Set([...all.filter((b) => b.t === 'requirement_revision').map((b) => b.id), ...sources.flatMap((r) => (r.requirement_revision_id ? [r.requirement_revision_id] : []))])].map((id) => ({
      type: 'requirement_revision',
      id,
    })),
  ];
  await insertDependencies(db, { tenderId: i.tenderId, stageId: i.stageId, dependentType: 'draft_field_version', dependentId: id, refs });
  await emitStageEvents(db, { tenderId: i.tenderId, stageIds: [i.stageId], eventType: 'draft_field_changed', refType: 'draft_field_version', refId: id, actorUserId: i.userId });
  return id;
};

// ---------------------------------------------------------------- Сверка этапа и факты

export interface IStageFieldValueRow {
  draft_id: string;
  draft_title: string;
  field_schema: IFormSchema;
  field_key: string;
  value: FieldValue | null;
  state: string;
  decision_ids: string[];
}

// Последние значения полей всех действующих приложений этапа (для сверки полей одного смысла и решения).
export const stageFieldValues = async (db: Queryable, stageId: string): Promise<IStageFieldValueRow[]> =>
  (
    await db.query<IStageFieldValueRow>(
      `SELECT a.id AS draft_id, a.title AS draft_title, r.field_schema, f.field_key, v.value, v.state,
              coalesce((SELECT array_agg(b.decision_id) FROM draft_field_basis b WHERE b.field_version_id = v.id AND b.decision_id IS NOT NULL), '{}') AS decision_ids
         FROM application_draft a
         JOIN template_revision r ON r.id = a.template_revision_id
         JOIN draft_field f ON f.draft_id = a.id
         JOIN LATERAL (SELECT x.* FROM draft_field_version x WHERE x.field_id = f.id ORDER BY x.version DESC LIMIT 1) v ON true
        WHERE a.stage_id = $1 AND a.status <> 'superseded'`,
      [stageId],
    )
  ).rows;

export interface IActiveFactRow {
  evidence_fact_id: string;
  fact_type: string;
  title: string;
  raw_value: string;
  // Фраза факта с продолжением во фрагменте источника (валюта и масштаб после числа, R11-04); null — не найдена.
  source_context: string | null;
  status: 'active' | 'conflict';
  // Проблема основания сейчас (R11-03): исходный документ заменён, хотя граф ещё не перестроен; null — действует.
  problem: string | null;
  fragment_ids: string[];
}

// Действующие и конфликтующие факты графа D-018 тендера по типам (смысл `fact:<тип>`); проблема — относительно этапа.
export const tenderFactsByType = async (db: Queryable, tenderId: string, types: readonly string[], stageId: string | null = null): Promise<IActiveFactRow[]> => {
  if (types.length === 0) return [];
  return (
    await db.query<IActiveFactRow>(
      `SELECT e.id AS evidence_fact_id, e.fact_type, t.title, e.raw_value, s.status,
              (SELECT substr(fr.text, strpos(fr.text, e.raw_value), length(e.raw_value) + 160)
                 FROM evidence_fact_fragment ff JOIN evidence_fragment fr ON fr.id = ff.fragment_id
                WHERE ff.evidence_fact_id = e.id AND strpos(fr.text, e.raw_value) > 0 ORDER BY ff.ordinal LIMIT 1) AS source_context,
              field_basis_problem($3::uuid, NULL, NULL, NULL, e.id) AS problem,
              coalesce((SELECT array_agg(ff.fragment_id ORDER BY ff.ordinal) FROM evidence_fact_fragment ff WHERE ff.evidence_fact_id = e.id), '{}') AS fragment_ids
         FROM fact_state s JOIN evidence_fact e ON e.id = s.evidence_fact_id JOIN evidence_fact_type t ON t.code = e.fact_type
        WHERE s.tender_id = $1 AND s.status IN ('active', 'conflict') AND e.fact_type = ANY($2::text[])
        ORDER BY e.fact_type, e.created_at`,
      [tenderId, [...types], stageId],
    )
  ).rows;
};

export const userNames = async (db: Queryable, ids: readonly string[]): Promise<Map<string, string>> => {
  if (ids.length === 0) return new Map();
  const r = await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM app_user WHERE id = ANY($1::uuid[])', [[...new Set(ids)]]);
  return new Map(r.rows.map((x) => [x.id, x.display_name]));
};
