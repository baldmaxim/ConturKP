// Видимость значения поля приложения (этап 11; Review 11-1 R11-01, R11-02; ADR-006, I13, R08-02). Значение версии и
// её комментарий показываются, только если пользователь читает каждый источник каждого основания — и основания версий,
// из которых значение скопировано (обсуждение, повторное подтверждение, перенос). Источник основания:
//   фрагмент          — он сам;
//   факт графа D-018  — фрагменты, из которых он прочитан;
//   ревизия требования — замыкание закрытости требования этапа 08 (основания любой роли и унаследованный текст);
//   решение по требованию — замыкание закрытости решения (требование-предмет, заменённое решение, основания).
// Основание, источник которого не определён (решение другого вида, неизвестный узел графа), закрыто: отсутствие
// непосредственного фрагмента не означает общедоступность.
import type { IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';
import { readableFragments } from './requirementAccess.ts';
import { loadTaintGraph, taintClosure, taintKey, type ITaintGraph } from './requirementTaint.ts';

export interface IBasisRef {
  basisType: 'fragment' | 'decision' | 'requirement_revision' | 'evidence_fact';
  fragmentId: string | null;
  decisionId: string | null;
  requirementRevisionId: string | null;
  evidenceFactId: string | null;
}

export const basisRefId = (b: IBasisRef): string | null => b.fragmentId ?? b.decisionId ?? b.requirementRevisionId ?? b.evidenceFactId;

// Основания версий вместе с основаниями версий-источников скопированного значения (по всей цепочке).
export const versionBasisClosure = async (db: Queryable, versionIds: readonly string[]): Promise<Map<string, IBasisRef[]>> => {
  const ids = [...new Set(versionIds)];
  const out = new Map<string, IBasisRef[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const r = await db.query<{ root: string; basis_type: IBasisRef['basisType']; fragment_id: string | null; decision_id: string | null; requirement_revision_id: string | null; evidence_fact_id: string | null }>(
    `WITH RECURSIVE chain(root, vid) AS (
       SELECT v.id, v.id FROM draft_field_version v WHERE v.id = ANY($1::uuid[])
       UNION
       SELECT c.root, coalesce(v.value_from_version_id,
                               CASE WHEN v.state = 'carried_over' THEN v.carried_from_version_id
                                    WHEN v.state = 'needs_discussion' AND v.value IS NOT NULL THEN v.previous_version_id END)
         FROM chain c JOIN draft_field_version v ON v.id = c.vid
        WHERE coalesce(v.value_from_version_id,
                       CASE WHEN v.state = 'carried_over' THEN v.carried_from_version_id
                            WHEN v.state = 'needs_discussion' AND v.value IS NOT NULL THEN v.previous_version_id END) IS NOT NULL)
     SELECT c.root, b.basis_type, b.fragment_id, b.decision_id, b.requirement_revision_id, b.evidence_fact_id
       FROM chain c JOIN draft_field_basis b ON b.field_version_id = c.vid`,
    [ids],
  );
  for (const x of r.rows) {
    out.get(x.root)!.push({ basisType: x.basis_type, fragmentId: x.fragment_id, decisionId: x.decision_id, requirementRevisionId: x.requirement_revision_id, evidenceFactId: x.evidence_fact_id });
  }
  return out;
};

// Видимость оснований для пользователя: каждый источник читается сейчас.
export const fieldBasisVisibility = async (db: Queryable, ctx: IAccessContext, refs: readonly IBasisRef[]): Promise<(b: IBasisRef) => boolean> => {
  const ids = (t: IBasisRef['basisType']) => [...new Set(refs.filter((b) => b.basisType === t).map(basisRefId).filter((x): x is string => !!x))];
  const factFragments = new Map<string, string[]>();
  for (const x of (await db.query<{ evidence_fact_id: string; fragment_id: string }>('SELECT evidence_fact_id, fragment_id FROM evidence_fact_fragment WHERE evidence_fact_id = ANY($1::uuid[])', [ids('evidence_fact')])).rows) {
    factFragments.set(x.evidence_fact_id, [...(factFragments.get(x.evidence_fact_id) ?? []), x.fragment_id]);
  }
  const requirements = new Map(
    (await db.query<{ id: string; requirement_id: string; stage_id: string }>('SELECT id, requirement_id, stage_id FROM requirement_revision WHERE id = ANY($1::uuid[])', [ids('requirement_revision')])).rows.map((x) => [x.id, x]),
  );
  const decisions = new Map(
    (await db.query<{ id: string; decision_type: string; stage_id: string | null }>('SELECT id, decision_type, stage_id FROM decision WHERE id = ANY($1::uuid[])', [ids('decision')])).rows.map((x) => [x.id, x]),
  );
  const graphs = new Map<string, ITaintGraph>();
  for (const stageId of new Set([...[...requirements.values()].map((x) => x.stage_id), ...[...decisions.values()].filter((x) => x.decision_type === 'requirement_decision' && x.stage_id).map((x) => x.stage_id!)])) {
    graphs.set(stageId, await loadTaintGraph(db, stageId));
  }
  // Замыкание узла графа; узел, которого в графе нет, — не определён (null).
  const closureOf = (stageId: string, key: string): Set<string> | null => {
    const g = graphs.get(stageId);
    return g && g.links.has(key) ? taintClosure(g, key) : null;
  };
  const sources = new Map<string, string[] | null>();
  for (const b of refs) {
    const id = basisRefId(b);
    if (!id) continue;
    const k = `${b.basisType}:${id}`;
    if (sources.has(k)) continue;
    if (b.basisType === 'fragment') sources.set(k, [id]);
    else if (b.basisType === 'evidence_fact') sources.set(k, factFragments.get(id) ?? null);
    else if (b.basisType === 'requirement_revision') {
      const q = requirements.get(id);
      const c = q ? closureOf(q.stage_id, taintKey('requirement', q.requirement_id)) : null;
      sources.set(k, c ? [...c] : null);
    } else {
      const d = decisions.get(id);
      const c = d && d.decision_type === 'requirement_decision' && d.stage_id ? closureOf(d.stage_id, taintKey('decision', d.id)) : null;
      sources.set(k, c ? [...c] : null);
    }
  }
  const readable = await readableFragments(db, ctx, [...sources.values()].flatMap((x) => x ?? []));
  return (b) => {
    const id = basisRefId(b);
    const list = id ? sources.get(`${b.basisType}:${id}`) : null;
    return !!list && list.every((f) => readable.has(f.toLowerCase()));
  };
};

// Видимость версий поля: все основания версии и её источников значения читаются пользователем.
export const fieldVersionVisibility = async (db: Queryable, ctx: IAccessContext, versionIds: readonly string[]): Promise<(versionId: string) => boolean> => {
  const closure = await versionBasisClosure(db, versionIds);
  const visible = await fieldBasisVisibility(db, ctx, [...closure.values()].flat());
  return (versionId) => {
    const list = closure.get(versionId);
    return !!list && list.every(visible);
  };
};
