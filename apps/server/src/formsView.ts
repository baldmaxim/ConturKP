// Представление приложения этапа 11 (D-031; проект §3, §5): поля с последней версией, происхождением, основаниями,
// «устарело» (отметка инвалидации или заменённое основание сейчас), предложения системы из фактов и модели, список
// незавершённых пунктов со сверкой полей одного смысла в одном контексте по всем приложениям этапа. Значение версии и
// её комментарий — только при чтении всех источников всех оснований, включая версии, из которых значение скопировано
// (R08-02; Review 11-1 R11-01, R11-02; fieldBasisAccess.ts). Факт, исходный документ которого заменён, не предлагается и
// не сверяется (R11-03); число факта — в единицах поля (R11-04).
import {
  allFields,
  applicability,
  checkConsistency,
  contextOf,
  draftIssues,
  formatEtag,
  type FieldValue,
  type IFieldObservation,
  type IFieldStatus,
  type IFormIssue,
  type IFormSchema,
  type IReferenceValue,
  valueFromFactText,
} from '@kontur/core';
import {
  draftFields,
  fieldVersionVisibility,
  listDrafts,
  listFieldSuggestions,
  readableFragments,
  stageFieldValues,
  tenderFactsByType,
  type IAccessContext,
  type IDraftRow,
  type IFieldVersionRow,
  type Queryable,
} from '@kontur/db';

export const BASIS_PROBLEM_TEXT: Record<string, string> = {
  document_revision_superseded: 'новая редакция документа',
  recognition_run_superseded: 'новое распознавание документа',
  mail_message_revision_superseded: 'новая редакция письма',
  transcript_revision_superseded: 'новая редакция транскрипции',
  qa_item_revision_superseded: 'новая редакция ответа заказчика',
  excluded_from_source_set: 'документ исключён из состава источников',
  decision_superseded: 'решение заменено',
  requirement_revision_superseded: 'требование изменено',
  fact_superseded: 'факт заменён',
  fact_conflict: 'факт в конфликте',
  fact_unknown: 'состояние факта неизвестно',
};

const factTypesOf = (schema: IFormSchema): string[] =>
  allFields(schema)
    .map((f) => f.meaning)
    .filter((m): m is string => !!m && m.startsWith('fact:'))
    .map((m) => m.slice(5));

const valueOfVersion = (v: IFieldVersionRow | null): FieldValue | null => (v && v.state !== 'cleared' ? v.value : null);

// Наблюдения сверки по всем действующим приложениям этапа и факты того же смысла.
const stageObservations = async (db: Queryable, stageId: string, tenderId: string): Promise<{ observations: IFieldObservation[]; references: IReferenceValue[] }> => {
  const rows = await stageFieldValues(db, stageId);
  const byDraft = new Map<string, typeof rows>();
  for (const r of rows) (byDraft.get(r.draft_id) ?? byDraft.set(r.draft_id, []).get(r.draft_id)!).push(r);
  const observations: IFieldObservation[] = [];
  const factTypes = new Set<string>();
  for (const list of byDraft.values()) {
    const schema = list[0]!.field_schema;
    const values = new Map(list.map((r) => [r.field_key, r.state === 'cleared' ? null : r.value]));
    const app = applicability(schema, values);
    for (const t of factTypesOf(schema)) factTypes.add(t);
    for (const f of allFields(schema)) {
      const row = list.find((r) => r.field_key === f.key);
      const groupKeys = [...(f.meaning ? [f.meaning] : []), ...(row?.decision_ids ?? []).map((d) => `decision:${d}`)];
      if (groupKeys.length === 0 || !app.applicable.has(f.key)) continue;
      observations.push({
        draftId: list[0]!.draft_id,
        draftTitle: list[0]!.draft_title,
        fieldKey: f.key,
        label: f.label,
        type: f.type,
        unit: f.type === 'number' ? (f.unit ?? null) : null,
        groupKeys,
        context: contextOf(f, (k) => values.get(k) ?? null),
        value: values.get(f.key) ?? null,
      });
    }
  }
  // Действующие факты; факт с заменённым исходным документом (граф ещё не перестроен) — не действующий (R11-03).
  const facts = (await tenderFactsByType(db, tenderId, [...factTypes], stageId)).filter((x) => x.status === 'conflict' || x.problem === null);
  const references: IReferenceValue[] = facts.map((x) => ({ groupKey: `fact:${x.fact_type}`, kind: 'fact', id: x.evidence_fact_id, title: x.title, text: x.raw_value, context: x.source_context, status: x.status }));
  return { observations, references };
};

// «Устарело»: отметка инвалидации версии (у копии без подтверждения — и её источников) или проблема основания сейчас —
// собственного или версий-источников скопированного значения (R11-05).
const versionStale = (v: IFieldVersionRow): boolean => v.invalidations.length > 0 || v.chain_invalidated || v.bases.some((b) => b.problem !== null) || v.inherited_problem !== null;

// Комментарий обсуждения — текст о значении: показывается только тому, кто видит версию (R11-02).
const statusOf = (v: IFieldVersionRow | null, visible: (versionId: string) => boolean): IFieldStatus => ({
  value: valueOfVersion(v),
  state: v?.state ?? null,
  stale: v ? versionStale(v) : false,
  comment: v && visible(v.id) ? v.comment : null,
  responsibleName: v?.responsible_name ?? null,
});

export interface IDraftIssuesResult {
  issues: IFormIssue[];
  blocking: number;
}

// Список незавершённых пунктов приложения: правила схемы, состояния полей и сверка по этапу.
export const issuesForDraft = async (db: Queryable, ctx: IAccessContext, draft: IDraftRow, fields?: Awaited<ReturnType<typeof draftFields>>): Promise<IDraftIssuesResult> => {
  const list = fields ?? (await draftFields(db, draft));
  const visible = await fieldVersionVisibility(db, ctx, list.flatMap((f) => (f.latest ? [f.latest.id] : [])));
  const statuses = new Map(list.map((f) => [f.field_key, statusOf(f.latest, visible)]));
  const { observations, references } = await stageObservations(db, draft.stage_id, draft.tender_id);
  const findings = checkConsistency(observations, references);
  const issues = draftIssues(draft.field_schema, statuses, findings, draft.id);
  return { issues, blocking: issues.filter((i) => i.blocking).length };
};

export const stageIssues = async (db: Queryable, ctx: IAccessContext, stageId: string) => {
  const drafts = (await listDrafts(db, stageId)).filter((d) => d.status !== 'superseded');
  const out = [];
  for (const d of drafts) {
    const r = await issuesForDraft(db, ctx, d);
    out.push({ draftId: d.id, title: d.title, status: d.status, isDemo: d.is_demo, blocking: r.blocking, issues: r.issues });
  }
  return out;
};

const versionView = (v: IFieldVersionRow, visible: boolean) => ({
  id: v.id,
  version: v.version,
  value: visible ? v.value : null,
  state: v.state,
  origin: v.origin,
  restricted: !visible,
  wording: v.wording_version_id ? { versionId: v.wording_version_id, version: v.wording_version, title: v.wording_title, newerApproved: v.wording_newer_approved } : null,
  suggestionId: v.suggestion_id,
  previousVersionId: v.previous_version_id,
  carriedFromVersionId: v.carried_from_version_id,
  valueFromVersionId: v.value_from_version_id,
  comment: visible ? v.comment : null,
  responsible: v.responsible_user_id ? { id: v.responsible_user_id, name: v.responsible_name } : null,
  customerQuestionId: v.customer_question_id,
  actor: { id: v.actor_user_id, name: v.actor_name },
  createdAt: v.created_at.toISOString(),
  bases: v.bases.map((b) => ({ ...b, text: visible ? b.text : null, quote: visible ? b.quote : null, problemText: b.problem ? (BASIS_PROBLEM_TEXT[b.problem] ?? b.problem) : null })),
  invalidations: v.invalidations,
  inheritedProblem: v.inherited_problem ? { cause: v.inherited_problem, text: BASIS_PROBLEM_TEXT[v.inherited_problem] ?? v.inherited_problem } : null,
  stale: versionStale(v),
});

export const visibilityFor = async (db: Queryable, ctx: IAccessContext, fragmentIds: readonly string[]) => {
  const readable = await readableFragments(db, ctx, fragmentIds);
  return (ids: readonly (string | null | undefined)[]) => ids.every((id) => !id || readable.has(id.toLowerCase()));
};

export const historyView = async (db: Queryable, ctx: IAccessContext, rows: readonly IFieldVersionRow[]) => {
  const visible = await fieldVersionVisibility(db, ctx, rows.map((v) => v.id));
  return rows.map((v) => versionView(v, visible(v.id)));
};

// Полное представление приложения для мастера.
export const draftView = async (db: Queryable, ctx: IAccessContext, draft: IDraftRow) => {
  const fields = await draftFields(db, draft);
  const suggestions = await listFieldSuggestions(db, draft.id);
  const facts = await tenderFactsByType(db, draft.tender_id, factTypesOf(draft.field_schema), draft.stage_id);
  const fragmentIds = [...suggestions.flatMap((s) => s.evidence.map((e) => e.fragmentId)), ...facts.flatMap((x) => x.fragment_ids)];
  const visible = await visibilityFor(db, ctx, fragmentIds);
  const versionVisible = await fieldVersionVisibility(db, ctx, fields.flatMap((f) => (f.latest ? [f.latest.id] : [])));
  const values = new Map(fields.map((f) => [f.field_key, valueOfVersion(f.latest)]));
  const app = applicability(draft.field_schema, values);
  const issues = await issuesForDraft(db, ctx, draft, fields);
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const sections = draft.field_schema.sections.map((s) => ({
    key: s.key,
    title: s.title,
    help: s.help ?? null,
    fields: s.fields.map((def) => {
      const f = byKey.get(def.key)!;
      const latest = f.latest;
      const meaningType = def.meaning?.startsWith('fact:') && !def.context?.subject && !def.context?.period ? def.meaning.slice(5) : null;
      // Предложение — из действующего факта с действующим исходным документом; число — в единицах поля, иначе нет.
      const proposals = meaningType
        ? facts
            .filter((x) => x.fact_type === meaningType && x.status === 'active' && x.problem === null)
            .map((x) => ({
              evidenceFactId: x.evidence_fact_id,
              title: x.title,
              text: visible(x.fragment_ids) ? x.raw_value : null,
              value: visible(x.fragment_ids) ? valueFromFactText(def, x.raw_value, x.source_context) : null,
              restricted: !visible(x.fragment_ids),
            }))
            .filter((p) => p.restricted || p.value !== null)
        : [];
      return {
        fieldId: f.field_id,
        key: def.key,
        definition: def,
        applicable: app.applicable.has(def.key),
        required: app.required.has(def.key),
        version: latest?.version ?? 0,
        etag: formatEtag(f.field_id, latest?.version ?? 0),
        latest: latest ? versionView(latest, versionVisible(latest.id)) : null,
        systemProposals: proposals,
        conflictingFacts: meaningType ? facts.filter((x) => x.fact_type === meaningType && x.status === 'conflict').map((x) => ({ evidenceFactId: x.evidence_fact_id, title: x.title })) : [],
        suggestions: suggestions
          .filter((x) => x.field_id === f.field_id)
          .map((x) => {
            const vis = visible(x.evidence.map((e) => e.fragmentId));
            return {
              id: x.id,
              status: x.status,
              value: vis ? x.value : null,
              rationale: vis ? x.rationale : null,
              restricted: !vis,
              etag: formatEtag(x.id, x.row_version),
              evidence: x.evidence.map((e) => ({ fragmentId: e.fragmentId, origin: e.origin, quote: vis ? e.quote : null, text: vis ? e.text : null })),
            };
          }),
      };
    }),
  }));
  return {
    id: draft.id,
    title: draft.title,
    status: draft.status,
    rowVersion: draft.row_version,
    etag: formatEtag(draft.id, draft.row_version),
    tenderId: draft.tender_id,
    stageId: draft.stage_id,
    template: {
      id: draft.template_id,
      name: draft.template_name,
      ownerKind: draft.owner_kind,
      isDemo: draft.is_demo,
      revisionId: draft.template_revision_id,
      revisionSeq: draft.revision_seq,
      revisionStatus: draft.revision_status,
      currentRevisionId: draft.current_revision_id,
      newerRevisionAvailable: draft.current_revision_id !== null && draft.current_revision_id !== draft.template_revision_id,
    },
    schemaTitle: draft.field_schema.title,
    constraints: draft.field_schema.constraints ?? [],
    migratedFromDraftId: draft.migrated_from_draft_id,
    migrationReport: draft.migration_report,
    supersededByDraftId: draft.superseded_by_draft_id,
    completedAt: draft.completed_at?.toISOString() ?? null,
    sections,
    issues: issues.issues,
    blocking: issues.blocking,
  };
};
