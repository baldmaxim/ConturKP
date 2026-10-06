// Инвалидация по событиям барьера (docs/architecture/09-review-checks-design.md §5.4, D-029). Каждое событие этапа
// обрабатывается один раз: затронутые объекты определяются точно — по зависимостям от заменённого объекта — или, когда
// область изменения не определена, консервативно — все замечания затронутых семейств, основанные на входах старше
// события. Замечание получает «устарело» с причиной; связанные решения (включая принятие риска) и события осей —
// отметку недействительности; гипотезы — «истекла». Ничего не удаляется и не переписывается: история сохраняется.
import { FINDING_KINDS, type FindingKind } from '@kontur/core';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import type { IStageEventRow } from './stageEvents.ts';

export const STAGE_INVALIDATE_JOB_KIND = 'stage.invalidate';
export const STAGE_INVALIDATE_PRIORITY = 45;

export const eventsAwaitingInvalidation = async (db: Queryable, limit = 200): Promise<{ id: string; tender_id: string }[]> =>
  (
    await db.query<{ id: string; tender_id: string }>(
      `SELECT e.id, s.tender_id FROM stage_input_event e JOIN tender_stage s ON s.id = e.stage_id
        WHERE NOT EXISTS (SELECT 1 FROM stage_input_event_processing p WHERE p.event_id = e.id)
        ORDER BY e.created_at, e.seq LIMIT $1`,
      [limit],
    )
  ).rows;

export const enqueueInvalidation = (db: Queryable, eventId: string, tenderId: string) =>
  enqueueJob(db, {
    kind: STAGE_INVALIDATE_JOB_KIND,
    dedupeKey: `invalidate:${eventId}`,
    payload: { eventId },
    resourceClass: 'default',
    priority: STAGE_INVALIDATE_PRIORITY,
    maxAttempts: 5,
    tenderId,
  });

interface ITarget {
  type: string;
  id: string;
}

export interface IEventChange {
  mode: 'exact' | 'conservative';
  reason: string;
  targets: ITarget[];
  families: FindingKind[];
}

const RULE_KINDS: FindingKind[] = FINDING_KINDS.filter((k) => k !== 'human' && k !== 'model_hypothesis');
const CALCULATION_KINDS: FindingKind[] = ['coverage_gap', 'parameter_mismatch', 'unit_mismatch', 'quantity_mismatch', 'quantity_uncertain', 'duplicate_position', 'contract_obligation'];
const COMMUNICATION_KINDS: FindingKind[] = ['source_conflict', 'customer_silence', 'pd_uncertainty'];

const one = async <T>(db: Queryable, sql: string, params: unknown[]): Promise<T | null> => ((await db.query<T & object>(sql, params)).rows[0] as T | undefined) ?? null;

// Что изменило событие: заменённые объекты (точно) или семейства проверок (консервативно) — с причиной для человека.
export const analyzeEvent = async (db: Queryable, e: IStageEventRow): Promise<IEventChange> => {
  const exact = (reason: string, targets: ITarget[] = []): IEventChange => ({ mode: 'exact', reason, targets, families: [] });
  const conservative = (reason: string, families: FindingKind[], targets: ITarget[] = []): IEventChange => ({ mode: 'conservative', reason, targets, families });
  switch (e.event_type) {
    case 'document_revision_registered': {
      const r = await one<{ prev: string | null; title: string; seq: number }>(
        db,
        'SELECT dr.supersedes_revision_id AS prev, d.title, dr.revision_seq AS seq FROM document_revision dr JOIN document d ON d.id = dr.document_id WHERE dr.id = $1',
        [e.ref_id],
      );
      if (r?.prev) return exact(`новая редакция ${r.seq} документа «${r.title}»: прежняя редакция заменена`, [{ type: 'document_revision', id: r.prev }]);
      return conservative(`новый документ «${r?.title ?? '—'}»: область влияния не определена — полная повторная проверка`, RULE_KINDS);
    }
    case 'recognition_run_completed': {
      const r = await one<{ prev_run: string | null; prev_revision: string | null; title: string }>(
        db,
        `SELECT rr.supersedes_run_id AS prev_run, dr.supersedes_revision_id AS prev_revision, d.title
           FROM recognition_run rr JOIN document_revision dr ON dr.id = rr.document_revision_id JOIN document d ON d.id = dr.document_id WHERE rr.id = $1`,
        [e.ref_id],
      );
      if (r?.prev_run) return exact(`новое распознавание документа «${r.title}»: прежний прогон заменён`, [{ type: 'recognition_run', id: r.prev_run }]);
      if (r?.prev_revision) return exact(`распознана новая редакция документа «${r.title}»`, [{ type: 'document_revision', id: r.prev_revision }]);
      return conservative(`распознан новый документ «${r?.title ?? '—'}»: область влияния не определена — полная повторная проверка`, RULE_KINDS);
    }
    case 'calculation_revision_added': {
      const r = await one<{ prev: string | null; seq: number }>(db, 'SELECT supersedes_revision_id AS prev, seq FROM calculation_revision WHERE id = $1', [e.ref_id]);
      if (r?.prev) return exact(`новая ревизия расчёта № ${r.seq}: прежняя ревизия заменена`, [{ type: 'calculation_revision', id: r.prev }]);
      return conservative('первая ревизия расчёта этапа: область влияния не определена', CALCULATION_KINDS);
    }
    case 'decision_recorded': {
      const r = await one<{ prev: string | null; decision_type: string }>(db, 'SELECT supersedes_decision_id AS prev, decision_type FROM decision WHERE id = $1', [e.ref_id]);
      if (r?.prev && r.decision_type === 'requirement_decision') return exact('решение по требованию заменено новым', [{ type: 'decision', id: r.prev }]);
      return exact('записано решение: прежние основания не меняются');
    }
    case 'communication_linked':
      return conservative('связано письмо: область влияния не определена — повторная проверка конфликтов, молчания и неопределённости', COMMUNICATION_KINDS);
    case 'qa_form_added': {
      const revs = (
        await db.query<{ prev: string | null }>('SELECT supersedes_revision_id AS prev FROM qa_item_revision WHERE import_id = $1', [e.ref_id])
      ).rows;
      const targets = revs.filter((r) => r.prev).map((r) => ({ type: 'qa_item_revision', id: r.prev! }));
      if (revs.some((r) => !r.prev)) {
        return conservative('добавлены новые вопросы–ответы: область влияния не определена — повторная проверка конфликтов, молчания и неопределённости', COMMUNICATION_KINDS, targets);
      }
      return exact('обновлены ответы в вопросах–ответах: прежние редакции заменены', targets);
    }
    case 'transcript_revision_added': {
      const r = await one<{ prev: string | null }>(db, 'SELECT supersedes_revision_id AS prev FROM transcript_revision WHERE id = $1', [e.ref_id]);
      if (r?.prev) return exact('новая редакция транскрипции: прежняя заменена', [{ type: 'transcript_revision', id: r.prev }]);
      return exact('новая сессия переговоров: речь не входит в программные проверки, основания осей проверяются точно');
    }
    case 'source_set_changed': {
      const cur = await one<{ source_set_id: string; seq: number }>(db, 'SELECT source_set_id, seq FROM source_set_revision WHERE id = $1', [e.ref_id]);
      const prev = cur
        ? await one<{ id: string }>(db, 'SELECT id FROM source_set_revision WHERE source_set_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 1', [cur.source_set_id, cur.seq])
        : null;
      if (!prev) return conservative('первый состав источников этапа: область влияния не определена — полная повторная проверка', RULE_KINDS);
      const diff = (
        await db.query<{ revision: string; was: boolean; now: boolean }>(
          `SELECT coalesce(a.document_revision_id, b.document_revision_id) AS revision,
                  coalesce(a.inclusion <> 'excluded_not_applicable', false) AS was, coalesce(b.inclusion <> 'excluded_not_applicable', false) AS now
             FROM (SELECT * FROM source_set_item WHERE source_set_revision_id = $1) a
             FULL JOIN (SELECT * FROM source_set_item WHERE source_set_revision_id = $2) b ON b.document_revision_id = a.document_revision_id`,
          [prev.id, e.ref_id],
        )
      ).rows;
      const removed = diff.filter((d) => d.was && !d.now).map((d) => ({ type: 'document_revision', id: d.revision }));
      if (diff.some((d) => d.now && !d.was)) return conservative('в состав источников добавлены документы: область влияния не определена — полная повторная проверка', RULE_KINDS, removed);
      return exact('из состава источников исключены документы', removed);
    }
    case 'import_accepted':
      return exact('импорт принят: входы этапа меняются событиями регистрации редакций и состава источников');
    // Этап 11: новая версия значения поля приложения — вход барьера выпуска (класс content), не основание проверок,
    // причин и других полей: точная обработка без целей.
    case 'draft_field_changed':
      return exact('изменено поле приложения: проверки, причины и другие поля не затронуты');
    default:
      return conservative(`событие «${e.event_type}»: область влияния не определена`, RULE_KINDS);
  }
};

const mark = async (db: Queryable, e: IStageEventRow, tenderId: string, type: string, id: string, mode: string, reason: string): Promise<boolean> =>
  ((
    await db.query(
      `INSERT INTO evidence_invalidation (tender_id, stage_id, dependent_type, dependent_id, stage_input_event_id, mode, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dependent_type, dependent_id, stage_input_event_id) DO NOTHING`,
      [tenderId, e.stage_id, type, id, e.id, mode, reason.slice(0, 1000)],
    )
  ).rowCount ?? 0) === 1;

export interface IInvalidationOutcome {
  mode: 'exact' | 'conservative';
  reason: string;
  findings: number;
  decisions: number;
  axisEvents: number;
  suggestions: number;
  // Этап 10: подтверждённые причины изменений с изменившимся основанием и погашенные гипотезы причин.
  explanations: number;
  reasonSuggestions: number;
  // Этап 11: версии значений полей с изменившимся основанием и погашенные предложения модели.
  fieldVersions: number;
  fieldSuggestions: number;
}

// Объекты, к которым применяется изменение события: все (обработка события) или только записанные прогоном после
// обработки события (сверка поздних результатов, R09-01).
export interface IApplyScope {
  findingIds: ReadonlySet<string>;
  suggestionIds: ReadonlySet<string>;
  reasonSuggestionIds?: ReadonlySet<string>;
  fieldSuggestionIds?: ReadonlySet<string>;
}

// Применение изменения события: «устарело» с причиной, отметки решений и событий осей, «истекла» у гипотез. Идемпотентно.
const applyEventChange = async (db: Queryable, e: IStageEventRow, tenderId: string, change: IEventChange, scope: IApplyScope | null): Promise<IInvalidationOutcome> => {
  const reason = `${change.reason} (событие № ${e.seq})`;
  const types = change.targets.map((t) => t.type);
  const ids = change.targets.map((t) => t.id);
  const dependents = async (type: string): Promise<string[]> =>
    change.targets.length === 0
      ? []
      : (
          await db.query<{ id: string }>(
            `SELECT DISTINCT d.dependent_id AS id FROM evidence_dependency d JOIN unnest($3::text[], $4::uuid[]) AS t(type, id) ON t.type = d.depends_on_type AND t.id = d.depends_on_id
              WHERE d.stage_id = $1 AND d.dependent_type = $2`,
            [e.stage_id, type, types, ids],
          )
        ).rows.map((r) => r.id);
  const inScope = (set: ReadonlySet<string> | undefined) => (id: string) => !scope || (set?.has(id) ?? false);
  const findingIds = new Set((await dependents('finding')).filter(inScope(scope?.findingIds)));
  // Основа прогона для класса события: источники — версия снимка области; расчёт — версия при запуске (ревизия
  // расчёта закреплена тогда).
  const basis = e.event_class === 'calculation' ? 'stage_input_version' : 'scope_input_version';
  if (change.families.length > 0) {
    // Консервативно: замечания затронутых семейств, основанные на входах старше события (прогон по старому снимку).
    const r = await db.query<{ id: string }>(
      `SELECT f.id FROM finding f
        WHERE f.stage_id = $1 AND f.kind = ANY($2::text[]) AND f.status <> 'stale'
          AND greatest(f.created_input_version, coalesce((SELECT max(r.${basis}) FROM finding_occurrence o JOIN review_run r ON r.id = o.run_id WHERE o.finding_id = f.id), 0)) < $3`,
      [e.stage_id, change.families, e.seq],
    );
    for (const x of r.rows) if (inScope(scope?.findingIds)(x.id)) findingIds.add(x.id);
  }
  const out: IInvalidationOutcome = { mode: change.mode, reason, findings: 0, decisions: 0, axisEvents: 0, suggestions: 0, explanations: 0, reasonSuggestions: 0, fieldVersions: 0, fieldSuggestions: 0 };
  for (const id of [...findingIds].sort()) {
    const f = (await db.query<{ status: string }>('SELECT status FROM finding WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!f) continue;
    await mark(db, e, tenderId, 'finding', id, change.mode, reason);
    if (f.status !== 'stale') {
      await db.query(
        `INSERT INTO finding_event (finding_id, tender_id, seq, event_kind, from_value, to_value, reason, actor_kind, stage_input_event_id)
         VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM finding_event WHERE finding_id = $1), 'status', $3, 'stale', $4, 'system', $5)`,
        [id, tenderId, f.status, reason.slice(0, 2000), e.id],
      );
      await db.query("UPDATE finding SET status = 'stale', updated_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
      out.findings += 1;
    }
    // Связанные решения — по замечанию и по его разногласию — действующие версии получают отметку (D-029).
    const decisions = await db.query<{ id: string }>(
      `SELECT d.id FROM decision d
        WHERE (d.subject_id = $1 OR d.subject_id IN (SELECT x.id FROM discrepancy x WHERE x.finding_id = $1))
          AND d.decision_type IN ('finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision')
          AND NOT EXISTS (SELECT 1 FROM decision n WHERE n.supersedes_decision_id = d.id)`,
      [id],
    );
    for (const d of decisions.rows) if (await mark(db, e, tenderId, 'decision', d.id, change.mode, reason)) out.decisions += 1;
  }
  if (!scope) {
    for (const id of await dependents('discrepancy_status_event')) if (await mark(db, e, tenderId, 'discrepancy_status_event', id, change.mode, reason)) out.axisEvents += 1;
  }
  const suggestionIds = new Set((await dependents('model_suggestion')).filter(inScope(scope?.suggestionIds)));
  if (change.families.length > 0) {
    const r = await db.query<{ id: string }>(
      `SELECT m.id FROM model_suggestion m JOIN review_run r ON r.id = m.run_id WHERE m.stage_id = $1 AND m.status = 'open' AND r.${basis} < $2`,
      [e.stage_id, e.seq],
    );
    for (const x of r.rows) if (inScope(scope?.suggestionIds)(x.id)) suggestionIds.add(x.id);
  }
  for (const id of [...suggestionIds].sort()) {
    const upd = await db.query("UPDATE model_suggestion SET status = 'expired', updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'open'", [id]);
    if ((upd.rowCount ?? 0) > 0) {
      await mark(db, e, tenderId, 'model_suggestion', id, change.mode, reason);
      out.suggestions += 1;
    }
  }
  // Этап 10 (D-029, D-030): версия причины с заменённым основанием получает отметку «основание изменилось» (сама не
  // меняется); открытые гипотезы причин гаснут — по зависимостям, а при неопределённой области (новые документы и
  // переписка) — все гипотезы прогонов на снимке старше события. Ревизии расчёта сравнения неизменны: событие расчёта
  // их не гасит.
  if (!scope) {
    for (const id of await dependents('change_explanation')) if (await mark(db, e, tenderId, 'change_explanation', id, change.mode, reason)) out.explanations += 1;
  }
  const reasonIds = new Set((await dependents('change_reason_suggestion')).filter(inScope(scope?.reasonSuggestionIds)));
  if (change.families.length > 0 && e.event_class !== 'calculation') {
    const r = await db.query<{ id: string }>(
      `SELECT s.id FROM change_reason_suggestion s JOIN reason_run r ON r.id = s.run_id JOIN evidence_scope sc ON sc.id = r.evidence_scope_id
        WHERE s.stage_id = $1 AND s.status = 'open' AND sc.input_version < $2`,
      [e.stage_id, e.seq],
    );
    for (const x of r.rows) if (inScope(scope?.reasonSuggestionIds)(x.id)) reasonIds.add(x.id);
  }
  for (const id of [...reasonIds].sort()) {
    const upd = await db.query("UPDATE change_reason_suggestion SET status = 'expired', updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'open'", [id]);
    if ((upd.rowCount ?? 0) > 0) {
      await mark(db, e, tenderId, 'change_reason_suggestion', id, change.mode, reason);
      out.reasonSuggestions += 1;
    }
  }
  // Этап 11 (D-031 В-11-5, В-11-6): версия значения поля с заменённым основанием получает отметку «устарело» (сама не
  // меняется, текст не перезаписывается); открытые предложения модели гаснут — по зависимостям, а при неопределённой
  // области (новые документы и переписка) — все предложения прогонов на снимке старше события.
  if (!scope) {
    for (const id of await dependents('draft_field_version')) if (await mark(db, e, tenderId, 'draft_field_version', id, change.mode, reason)) out.fieldVersions += 1;
  }
  const fieldSuggestionIds = new Set((await dependents('field_suggestion')).filter(inScope(scope?.fieldSuggestionIds)));
  if (change.families.length > 0 && e.event_class !== 'calculation') {
    const r = await db.query<{ id: string }>(
      `SELECT s.id FROM field_suggestion s JOIN field_suggestion_run r ON r.id = s.run_id JOIN evidence_scope sc ON sc.id = r.evidence_scope_id
        WHERE s.stage_id = $1 AND s.status = 'open' AND sc.input_version < $2`,
      [e.stage_id, e.seq],
    );
    for (const x of r.rows) if (inScope(scope?.fieldSuggestionIds)(x.id)) fieldSuggestionIds.add(x.id);
  }
  for (const id of [...fieldSuggestionIds].sort()) {
    const upd = await db.query("UPDATE field_suggestion SET status = 'expired', updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'open'", [id]);
    if ((upd.rowCount ?? 0) > 0) {
      await mark(db, e, tenderId, 'field_suggestion', id, change.mode, reason);
      out.fieldSuggestions += 1;
    }
  }
  return out;
};

// Доменная блокировка этапа: обработка событий, запись результатов прогона и команды решений сериализуются строкой
// этапа (тот же порядок, что у барьера §1.1: сначала этап).
export const lockStageForReview = async (db: Queryable, stageId: string): Promise<string | null> =>
  (await db.query<{ tender_id: string }>('SELECT tender_id FROM tender_stage WHERE id = $1 FOR UPDATE', [stageId])).rows[0]?.tender_id ?? null;

// Обработка одного события барьера: один раз (строка обработки — ключ события), под блокировкой этапа.
export const processStageEvent = async (db: Queryable, eventId: string): Promise<IInvalidationOutcome | null> => {
  const head = (await db.query<{ stage_id: string }>('SELECT stage_id FROM stage_input_event WHERE id = $1', [eventId])).rows[0];
  if (!head) return null;
  const tenderId = await lockStageForReview(db, head.stage_id);
  if (!tenderId) return null;
  if ((await db.query('SELECT 1 FROM stage_input_event_processing WHERE event_id = $1', [eventId])).rowCount) return null;
  const e = (await db.query<IStageEventRow>('SELECT * FROM stage_input_event WHERE id = $1', [eventId])).rows[0]!;
  const change = await analyzeEvent(db, e);
  const out = await applyEventChange(db, e, tenderId, change, null);
  await db.query('INSERT INTO stage_input_event_processing (event_id, stage_id, mode, reason, affected) VALUES ($1, $2, $3, $4, $5)', [
    e.id,
    e.stage_id,
    change.mode,
    out.reason.slice(0, 1000),
    JSON.stringify({
      targets: change.targets.length,
      families: change.families,
      findings: out.findings,
      decisions: out.decisions,
      axisEvents: out.axisEvents,
      suggestions: out.suggestions,
      explanations: out.explanations,
      reasonSuggestions: out.reasonSuggestions,
      fieldVersions: out.fieldVersions,
      fieldSuggestions: out.fieldSuggestions,
    }),
  ]);
  return out;
};

// Все необработанные события этапа — в транзакции вызывающего под блокировкой этапа (команда решения не ждёт worker,
// R09-01): после вызова статусы замечаний отражают все поступившие изменения.
export const processPendingStageEvents = async (db: Queryable, stageId: string): Promise<number> => {
  await lockStageForReview(db, stageId);
  const pending = await db.query<{ id: string }>(
    `SELECT e.id FROM stage_input_event e WHERE e.stage_id = $1 AND NOT EXISTS (SELECT 1 FROM stage_input_event_processing p WHERE p.event_id = e.id)
      ORDER BY e.seq`,
    [stageId],
  );
  for (const p of pending.rows) await processStageEvent(db, p.id);
  return pending.rowCount ?? 0;
};

// Сверка поздних результатов прогона (R09-01): события после закреплённого снимка, уже обработанные до записи
// результатов, применяются к замечаниям и гипотезам, которые записал этот прогон. Вызывается под блокировкой этапа.
export const reconcileRunWithProcessedEvents = async (db: Queryable, run: { stage_id: string; tender_id: string; scope_input_version: number }, scope: IApplyScope): Promise<number> => {
  if (scope.findingIds.size === 0 && scope.suggestionIds.size === 0) return 0;
  const events = (
    await db.query<IStageEventRow>(
      `SELECT e.* FROM stage_input_event e JOIN stage_input_event_processing p ON p.event_id = e.id
        WHERE e.stage_id = $1 AND e.seq > $2 ORDER BY e.seq`,
      [run.stage_id, run.scope_input_version],
    )
  ).rows;
  let affected = 0;
  for (const e of events) {
    const out = await applyEventChange(db, e, run.tender_id, await analyzeEvent(db, e), scope);
    affected += out.findings + out.suggestions;
  }
  return affected;
};

// События после версии прогона (для пометки «устарел») с обработкой, если она уже есть.
export const eventsAfter = async (
  db: Queryable,
  stageId: string,
  version: number,
): Promise<{ seq: number; event_type: string; created_at: Date; mode: string | null; reason: string | null }[]> =>
  (
    await db.query<{ seq: number; event_type: string; created_at: Date; mode: string | null; reason: string | null }>(
      `SELECT e.seq, e.event_type, e.created_at, p.mode, p.reason FROM stage_input_event e LEFT JOIN stage_input_event_processing p ON p.event_id = e.id
        WHERE e.stage_id = $1 AND e.seq > $2 ORDER BY e.seq LIMIT 50`,
      [stageId, version],
    )
  ).rows;

// Сверка поздних гипотез причин (R09-01): события после снимка прогона, обработанные до записи гипотез, гасят записанные
// сейчас гипотезы так же, как если бы они существовали при обработке. Вызывается под блокировкой этапа.
export const reconcileReasonRunWithProcessedEvents = async (db: Queryable, run: { stage_id: string; tender_id: string; evidence_scope_id: string }, suggestionIds: ReadonlySet<string>): Promise<number> => {
  if (suggestionIds.size === 0) return 0;
  const version = Number((await db.query<{ v: string }>('SELECT input_version::text AS v FROM evidence_scope WHERE id = $1', [run.evidence_scope_id])).rows[0]?.v ?? 0);
  const events = (
    await db.query<IStageEventRow>(
      `SELECT e.* FROM stage_input_event e JOIN stage_input_event_processing p ON p.event_id = e.id
        WHERE e.stage_id = $1 AND e.seq > $2 ORDER BY e.seq`,
      [run.stage_id, version],
    )
  ).rows;
  let affected = 0;
  for (const e of events) {
    const out = await applyEventChange(db, e, run.tender_id, await analyzeEvent(db, e), { findingIds: new Set(), suggestionIds: new Set(), reasonSuggestionIds: suggestionIds });
    affected += out.reasonSuggestions;
  }
  return affected;
};

// Сверка поздних предложений полей (R09-01): события после снимка прогона, обработанные до записи предложений, гасят
// записанные сейчас предложения так же, как если бы они существовали при обработке. Вызывается под блокировкой этапа.
export const reconcileFieldSuggestionRunWithProcessedEvents = async (
  db: Queryable,
  run: { stage_id: string; tender_id: string; evidence_scope_id: string },
  suggestionIds: ReadonlySet<string>,
): Promise<number> => {
  if (suggestionIds.size === 0) return 0;
  const version = Number((await db.query<{ v: string }>('SELECT input_version::text AS v FROM evidence_scope WHERE id = $1', [run.evidence_scope_id])).rows[0]?.v ?? 0);
  const events = (
    await db.query<IStageEventRow>(
      `SELECT e.* FROM stage_input_event e JOIN stage_input_event_processing p ON p.event_id = e.id
        WHERE e.stage_id = $1 AND e.seq > $2 ORDER BY e.seq`,
      [run.stage_id, version],
    )
  ).rows;
  let affected = 0;
  for (const e of events) {
    const out = await applyEventChange(db, e, run.tender_id, await analyzeEvent(db, e), { findingIds: new Set(), suggestionIds: new Set(), fieldSuggestionIds: suggestionIds });
    affected += out.fieldSuggestions;
  }
  return affected;
};
