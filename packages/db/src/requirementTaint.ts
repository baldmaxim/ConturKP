// Видимость производного текста этапа 08 — R08-02 (Review 08-1), усиление Р-08-5. Формальная политика:
// производные поля объекта (формулировка, параметры, область, обоснование, значение, текст решения, допущения,
// вопроса, причина и объекты покрытия, сведения о конфликте) показываются пользователю, только если он может
// читать КАЖДЫЙ фрагмент закрытости объекта T(o):
//   T(o) = фрагменты всех оснований o в любой роли (supports, contradicts, clarifies, supersedes_context)
//          ∪ T(каждого объекта, из которого o мог унаследовать текст).
// Наследование («из чего текст мог быть получен»):
//   требование      ← все его ревизии и кандидаты, из которых они подтверждены;
//   кандидат        ← правка (derived_from), перенос (rebased_from, carried_from — требование), цель правки (target);
//   факт и кандидат факта — так же;
//   решение         ← требование-предмет и заменённое решение;
//   допущение       ← все ревизии, связанное требование, заменённое им допущение;
//   вопрос          ← каждое требование, с которым он был связан (отвязка наследование не снимает), и предложение
//                     из чата, принятием которого он создан: цитаты предложения (Review 16-1, R16-01). У вопросов,
//                     созданных до миграции 0041, прежние связи восстановлены из аудита команд; где их установить
//                     нельзя — в истории все требования этапа (миграция 0042; Review 16-2, R16-02);
//   оценка покрытия ← требование, фрагменты и решения — объекты оценки.
// Замыкание считается по графу этапа; любое закрытое основание в замыкании скрывает производные поля — роль
// основания значения не имеет. Цитата по-прежнему открывается только по правам источника (GET /evidence/{id}).
import type { IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';
import { readableFragments } from './requirementAccess.ts';

export type TaintKind = 'requirement' | 'candidate' | 'fact' | 'fact_candidate' | 'decision' | 'assumption' | 'question' | 'coverage';
export const taintKey = (kind: TaintKind, id: string): string => `${kind}:${id}`;

export interface ITaintGraph {
  links: Map<string, Set<string>>;
  edges: Map<string, Set<string>>;
}

const add = (m: Map<string, Set<string>>, key: string, value: string | null | undefined): void => {
  const set = m.get(key) ?? new Set<string>();
  if (value) set.add(value);
  m.set(key, set);
};

// Граф закрытости этапа: основания и связи наследования всех объектов этапа 08.
export const loadTaintGraph = async (db: Queryable, stageId: string): Promise<ITaintGraph> => {
  const links = new Map<string, Set<string>>();
  const edges = new Map<string, Set<string>>();
  const q = async <T>(sql: string): Promise<T[]> => (await db.query<T & object>(sql, [stageId])).rows as T[];

  for (const r of await q<{ requirement_id: string; candidate_id: string | null; fragment_id: string | null }>(
    `SELECT v.requirement_id, v.candidate_id, l.fragment_id FROM requirement_revision v
       LEFT JOIN evidence_link l ON l.requirement_revision_id = v.id WHERE v.stage_id = $1`,
  )) {
    const k = taintKey('requirement', r.requirement_id);
    add(links, k, r.fragment_id);
    if (r.candidate_id) add(edges, k, taintKey('candidate', r.candidate_id));
  }
  for (const r of await q<{ id: string; derived: string | null; rebased: string | null; target: string | null; carried: string | null; fragment_id: string | null }>(
    `SELECT c.id, c.derived_from_candidate_id AS derived, c.rebased_from_candidate_id AS rebased, c.target_requirement_id AS target,
            cr.requirement_id AS carried, l.fragment_id
       FROM requirement_candidate c
       LEFT JOIN requirement_revision cr ON cr.id = c.carried_from_revision_id
       LEFT JOIN evidence_link l ON l.requirement_candidate_id = c.id
      WHERE c.stage_id = $1`,
  )) {
    const k = taintKey('candidate', r.id);
    add(links, k, r.fragment_id);
    if (r.derived) add(edges, k, taintKey('candidate', r.derived));
    if (r.rebased) add(edges, k, taintKey('candidate', r.rebased));
    if (r.target) add(edges, k, taintKey('requirement', r.target));
    if (r.carried) add(edges, k, taintKey('requirement', r.carried));
  }
  for (const r of await q<{ fact_id: string; candidate_id: string | null; fragment_id: string | null }>(
    `SELECT v.fact_id, v.candidate_id, l.fragment_id FROM fact_revision v
       LEFT JOIN evidence_link l ON l.fact_revision_id = v.id WHERE v.stage_id = $1`,
  )) {
    const k = taintKey('fact', r.fact_id);
    add(links, k, r.fragment_id);
    if (r.candidate_id) add(edges, k, taintKey('fact_candidate', r.candidate_id));
  }
  for (const r of await q<{ id: string; derived: string | null; rebased: string | null; target: string | null; carried: string | null; fragment_id: string | null }>(
    `SELECT c.id, c.derived_from_candidate_id AS derived, c.rebased_from_candidate_id AS rebased, c.target_fact_id AS target,
            cr.fact_id AS carried, l.fragment_id
       FROM fact_candidate c
       LEFT JOIN fact_revision cr ON cr.id = c.carried_from_revision_id
       LEFT JOIN evidence_link l ON l.fact_candidate_id = c.id
      WHERE c.stage_id = $1`,
  )) {
    const k = taintKey('fact_candidate', r.id);
    add(links, k, r.fragment_id);
    if (r.derived) add(edges, k, taintKey('fact_candidate', r.derived));
    if (r.rebased) add(edges, k, taintKey('fact_candidate', r.rebased));
    if (r.target) add(edges, k, taintKey('fact', r.target));
    if (r.carried) add(edges, k, taintKey('fact', r.carried));
  }
  for (const r of await q<{ id: string; subject_id: string; supersedes: string | null; fragment_id: string | null }>(
    `SELECT d.id, d.subject_id, d.supersedes_decision_id AS supersedes, l.fragment_id FROM decision d
       LEFT JOIN evidence_link l ON l.decision_id = d.id
      WHERE d.stage_id = $1 AND d.decision_type = 'requirement_decision'`,
  )) {
    const k = taintKey('decision', r.id);
    add(links, k, r.fragment_id);
    add(edges, k, taintKey('requirement', r.subject_id));
    if (r.supersedes) add(edges, k, taintKey('decision', r.supersedes));
  }
  for (const r of await q<{ id: string; requirement_id: string | null; superseded_by: string | null; fragment_id: string | null }>(
    `SELECT a.id, a.requirement_id, v.superseded_by_assumption_id AS superseded_by, l.fragment_id
       FROM assumption a JOIN assumption_revision v ON v.assumption_id = a.id
       LEFT JOIN evidence_link l ON l.assumption_revision_id = v.id
      WHERE a.stage_id = $1`,
  )) {
    const k = taintKey('assumption', r.id);
    add(links, k, r.fragment_id);
    if (r.requirement_id) add(edges, k, taintKey('requirement', r.requirement_id));
    // Новое допущение могло повторить текст заменённого.
    if (r.superseded_by) add(edges, taintKey('assumption', r.superseded_by), k);
  }
  // Происхождение вопроса (миграция 0041): история связей с требованиями и цитаты принятого предложения из чата.
  for (const r of await q<{ id: string; requirement_id: string | null; fragment_id: string | null }>(
    `SELECT c.id, b.requirement_id, pf.fragment_id
       FROM customer_question c
       LEFT JOIN LATERAL unnest(array_append(c.basis_requirement_ids, c.requirement_id)) AS b(requirement_id) ON true
       LEFT JOIN mcp_proposal_fragment pf ON pf.proposal_id = c.source_proposal_id
      WHERE c.stage_id = $1`,
  )) {
    const k = taintKey('question', r.id);
    add(links, k, r.fragment_id);
    if (r.requirement_id) add(edges, k, taintKey('requirement', r.requirement_id));
  }
  for (const r of await q<{ id: string; requirement_id: string; fragment_id: string | null; decision_id: string | null }>(
    `SELECT c.id, v.requirement_id, o.fragment_id, o.decision_id FROM requirement_coverage c
       JOIN requirement_revision v ON v.id = c.requirement_revision_id
       LEFT JOIN requirement_coverage_object o ON o.coverage_id = c.id
      WHERE c.stage_id = $1`,
  )) {
    const k = taintKey('coverage', r.id);
    add(links, k, r.fragment_id);
    add(edges, k, taintKey('requirement', r.requirement_id));
    if (r.decision_id) add(edges, k, taintKey('decision', r.decision_id));
  }
  return { links, edges };
};

// Замыкание закрытости узла: обход графа с учётом циклов.
export const taintClosure = (g: ITaintGraph, key: string): Set<string> => {
  const out = new Set<string>();
  const seen = new Set<string>();
  const stack = [key];
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const f of g.links.get(k) ?? []) out.add(f);
    for (const n of g.edges.get(k) ?? []) stack.push(n);
  }
  return out;
};

export interface IStageVisibility {
  // Производные поля объекта видимы: все фрагменты замыкания читаются пользователем.
  visible: (kind: TaintKind, id: string) => boolean;
  // Фрагменты, которые пользователь читает сейчас (для показа текста отдельных оснований).
  readable: ReadonlySet<string>;
}

export const stageVisibility = async (db: Queryable, ctx: IAccessContext, stageId: string): Promise<IStageVisibility> => {
  const g = await loadTaintGraph(db, stageId);
  const all = new Set<string>();
  for (const set of g.links.values()) for (const f of set) all.add(f);
  const readable = await readableFragments(db, ctx, [...all]);
  const memo = new Map<string, boolean>();
  return {
    readable,
    visible: (kind, id) => {
      const key = taintKey(kind, id);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const v = [...taintClosure(g, key)].every((f) => readable.has(f));
      memo.set(key, v);
      return v;
    },
  };
};
