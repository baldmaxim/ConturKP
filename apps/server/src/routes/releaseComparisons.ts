// Сравнение двух выпусков (этап 15; portal-api §2.10; проект docs/architecture/15-send-comparison-design.md §8–§13).
// Стороны — любые два выпуска одного тендера; левая — выпущенная раньше. Сравнение строит система по закреплённым
// записям выпусков (правило, а не пользователь: вход полный), показ ограничен правами читателя (releaseComparisonViews).
// Причину вывода ставит человек с change_reason.confirm; основания причины он должен читать сам (I11, как на этапе 10).
import { CreateReleaseComparisonRequest, ReleaseComparisonItemsQuery, ReleaseReasonRequest } from '@kontur/contracts';
import { formatEtag, parseIfMatch, type IReleaseManifest } from '@kontur/core';
import {
  appendReleaseReason,
  CHANGE_NOTE_REASONS_SQL,
  createReleaseComparison,
  getCandidate,
  getComparison,
  getRelease,
  getReleaseComparison,
  getReleaseComparisonItem,
  lineageSeq,
  listReleaseComparisons,
  readableFragments,
  releaseComparisonItems,
  releaseReasonCounts,
  releaseReasonHistory,
  releaseReasonVersion,
  type IAccessContext,
  type IReleaseComparisonRow,
  type IReleaseRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router, type Request } from 'express';
import { command, parseBody, query, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { decisionsVisibility, itemViews, reasonView, reasonVisibility } from '../releaseComparisonViews.ts';
import { readStoredBlob } from '../releaseMarkup.ts';
import { candidateVisible, iso } from '../releaseViews.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

const requireDerivedIfMatch = (req: Request, id: string): number => {
  const parsed = parseIfMatch(req.header('if-match'));
  if (parsed.kind === 'missing') throw new HttpError(428, 'PRECONDITION_REQUIRED', 'изменение требует заголовка If-Match');
  if (parsed.kind === 'invalid' || parsed.id !== id) throw new HttpError(412, 'VERSION_CONFLICT', 'If-Match не относится к этому объекту');
  return parsed.rowVersion;
};

const target = (c: { id: string; tender_id: string }) => ({ tenderId: c.tender_id, entityType: 'release_comparison', entityId: c.id });

const loadComparison = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IReleaseComparisonRow> => {
  const c = await getReleaseComparison(db, id);
  if (!c || !hasTenderCap(ctx, c.tender_id, 'tender.read')) throw notFound({ entityType: 'release_comparison', entityId: id });
  return c;
};

interface ISideRow {
  id: string;
  candidate_id: string;
  candidate_seq: number;
  stage_id: string;
  stage_seq: number;
  stage_title: string;
  mode: string;
  released_at: Date;
  release_manifest_sha256: string;
}

const sidesOf = async (db: Queryable, c: IReleaseComparisonRow): Promise<{ left: ISideRow; right: ISideRow }> => {
  const r = await db.query<ISideRow>(
    `SELECT r.id, r.candidate_id, k.seq AS candidate_seq, r.stage_id, s.seq AS stage_seq, s.title AS stage_title, r.mode, r.released_at, r.release_manifest_sha256
       FROM release r JOIN release_candidate k ON k.id = r.candidate_id JOIN tender_stage s ON s.id = r.stage_id WHERE r.id = ANY($1::uuid[])`,
    [[c.left_release_id, c.right_release_id]],
  );
  return { left: r.rows.find((x) => x.id === c.left_release_id)!, right: r.rows.find((x) => x.id === c.right_release_id)! };
};

// Сторона сравнения; хэш манифеста выпуска — только тому, кто видит комплект (как в списке выпусков этапа).
const sideView = (s: ISideRow, visible: boolean) => ({
  releaseId: s.id,
  candidateSeq: Number(s.candidate_seq),
  stage: { id: s.stage_id, seq: Number(s.stage_seq), title: s.stage_title },
  mode: s.mode,
  releasedAt: iso(s.released_at),
  restricted: !visible,
  manifestSha256: visible ? s.release_manifest_sha256 : null,
});

const brief = async (db: Queryable, ctx: IAccessContext, c: IReleaseComparisonRow) => {
  const { left, right } = await sidesOf(db, c);
  const seen = async (s: ISideRow): Promise<boolean> => candidateVisible(db, ctx, (await getCandidate(db, s.candidate_id))!);
  return {
    id: c.id,
    status: c.status,
    failureReason: c.failure_reason,
    methodVersion: c.method_version,
    resultSha256: c.result_sha256,
    left: sideView(left, await seen(left)),
    right: sideView(right, await seen(right)),
    requestedBy: { id: c.requested_by, name: c.requested_by_name },
    createdAt: iso(c.created_at),
    changes: c.summary ? Object.fromEntries(Object.entries(c.summary.sections).map(([k, v]) => [k, Object.values(v.changes).reduce((a, b) => a + b, 0)])) : null,
  };
};

// Раздел расчёта: итоги сравнения ревизий этапа 10, статусы причин его единиц, необъяснённый остаток и признак
// «устарело» (после сравнения появились новые решения по парам позиций).
const calculationView = async (db: Queryable, ctx: IAccessContext, c: IReleaseComparisonRow) => {
  const calc = c.summary!.calculation;
  if (calc.state === 'same_revision' || !calc.comparisonId) return { ...calc, totals: null, reasons: null, remainder: null, outdated: false };
  const cc = await getComparison(db, ctx, calc.comparisonId);
  if (!cc || cc.status !== 'ready') return { ...calc, totals: null, reasons: null, remainder: null, outdated: false };
  const reasons = (
    await db.query<{ status: string; n: number }>(
      `SELECT coalesce(e.reason_status, 'unknown') AS status, count(*)::int AS n FROM comparison_unit u
         LEFT JOIN change_explanation e ON e.unit_id = u.id AND e.version = (SELECT max(x.version) FROM change_explanation x WHERE x.unit_id = u.id)
        WHERE u.comparison_id = $1
          AND (u.kind <> 'matched' OR NOT u.cost_comparable OR NOT u.commercial_comparable
               OR u.cost_left <> u.cost_right OR u.commercial_left <> u.commercial_right OR ${CHANGE_NOTE_REASONS_SQL('u')})
        GROUP BY 1`,
      [cc.id],
    )
  ).rows;
  const remainder = (
    await db.query<{ measure: string; amount: string }>("SELECT measure, amount::text AS amount FROM comparison_effect WHERE comparison_id = $1 AND unit_id IS NULL AND component = 'unexplained_remainder' ORDER BY measure", [cc.id])
  ).rows;
  return {
    ...calc,
    totals: cc.totals,
    reasons: { unknown: 0, hypothesis: 0, confirmed: 0, ...Object.fromEntries(reasons.map((r) => [r.status, r.n])) },
    remainder,
    outdated: (await lineageSeq(db, cc.left_revision_id, cc.right_revision_id)) !== cc.lineage_seq,
  };
};

export const releaseComparisonsRouter = (pool: Pool, store: BlobStore): Router => {
  const router = Router();

  const manifestOf = async (r: IReleaseRow): Promise<IReleaseManifest> => JSON.parse((await readStoredBlob(store, r.release_manifest_blob_sha256)).toString('utf8')) as IReleaseManifest;

  const authorizeCompare = (ctx: IAccessContext, tenderId: string): void => {
    if (!hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
    if (!hasTenderCap(ctx, tenderId, 'economics.compare')) throw forbidden('economics.compare', { tenderId, entityType: 'tender', entityId: tenderId });
  };

  router.post(
    '/tenders/:id/release-comparisons',
    command(pool, {
      action: 'release.comparison.create',
      entityType: 'tender',
      idempotent: true,
      authorize: async (_client, ctx, req) => authorizeCompare(ctx, uuidParam(req, 'id', 'tender')),
      run: async (client, ctx, req) => {
        const tenderId = uuidParam(req, 'id', 'tender');
        authorizeCompare(ctx, tenderId);
        const t = { tenderId, entityType: 'tender', entityId: tenderId };
        const body = parseBody(CreateReleaseComparisonRequest, req.body);
        const [a, b] = [await getRelease(client, body.leftReleaseId.toLowerCase()), await getRelease(client, body.rightReleaseId.toLowerCase())];
        if (!a || !b || a.tender_id !== tenderId || b.tender_id !== tenderId) throw new HttpError(400, 'VALIDATION_FAILED', 'сравниваются два выпуска этого тендера', {}, t);
        for (const r of [a, b]) {
          if (!(await candidateVisible(client, ctx, (await getCandidate(client, r.candidate_id))!))) {
            throw conflict('среди входов комплекта одной из сторон есть то, что вы не можете читать', 'restricted_inputs', t);
          }
        }
        // Левая сторона — выпущенная раньше (при равном времени — по ID): порядок определяет БД с её точностью времени —
        // тот же, что проверяет охранник; от порядка в запросе он не зависит.
        const first = (await client.query<{ id: string }>('SELECT id FROM release WHERE id = ANY($1::uuid[]) ORDER BY released_at, id LIMIT 1', [[a.id, b.id]])).rows[0]!.id;
        const [left, right] = first === a.id ? [a, b] : [b, a];
        const c = await createReleaseComparison(client, { tenderId, left, right, leftManifest: await manifestOf(left), rightManifest: await manifestOf(right), userId: ctx.principal.userId });
        return {
          status: 201,
          body: await brief(client, ctx, c),
          audit: [
            {
              action: 'release.comparison.create',
              entityType: 'release_comparison',
              entityId: c.id,
              tenderId,
              details: { leftReleaseId: left.id, rightReleaseId: right.id, status: c.status, resultSha256: c.result_sha256, calculation: c.summary?.calculation.state ?? null },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/tenders/:id/release-comparisons',
    query(pool, 'release.comparison.list', 'tender', async (ctx, req, res) => {
      const tenderId = uuidParam(req, 'id', 'tender');
      if (!hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
      const items = [];
      for (const c of await listReleaseComparisons(pool, tenderId)) items.push(await brief(pool, ctx, c));
      res.json({ items });
    }),
  );

  router.get(
    '/release-comparisons/:id',
    query(pool, 'release.comparison.read', 'release_comparison', async (ctx, req, res) => {
      const c = await loadComparison(pool, ctx, uuidParam(req, 'id', 'release_comparison'));
      res.json({
        ...(await brief(pool, ctx, c)),
        sections: c.summary?.sections ?? null,
        interval: c.summary?.interval ?? null,
        unrecognizedRight: c.summary?.unrecognizedRight ?? 0,
        calculation: c.status === 'ready' ? await calculationView(pool, ctx, c) : null,
        reasons: c.status === 'ready' ? await releaseReasonCounts(pool, c.id) : null,
        can: { setReason: hasTenderCap(ctx, c.tender_id, 'change_reason.confirm') },
      });
    }),
  );

  router.get(
    '/release-comparisons/:id/items',
    query(pool, 'release.comparison.items', 'release_comparison', async (ctx, req, res) => {
      const c = await loadComparison(pool, ctx, uuidParam(req, 'id', 'release_comparison'));
      const q = parseBody(ReleaseComparisonItemsQuery, req.query);
      const rows = await releaseComparisonItems(pool, c.id, { section: q.section ?? null, after: q.after, limit: q.limit + 1 });
      const page = rows.slice(0, q.limit);
      const { left, right } = await sidesOf(pool, c);
      res.json({
        items: await itemViews(pool, ctx, { tenderId: c.tender_id, leftStageId: left.stage_id, rightStageId: right.stage_id }, page),
        hasMore: rows.length > q.limit,
        nextAfter: rows.length > q.limit ? Number(page[page.length - 1]!.ordinal) : null,
      });
    }),
  );

  const loadItem = async (db: Queryable, ctx: IAccessContext, id: string) => {
    const item = await getReleaseComparisonItem(db, id);
    if (!item) throw notFound({ entityType: 'release_comparison_item', entityId: id });
    const c = await loadComparison(db, ctx, item.comparison_id).catch((err: unknown) => {
      if (err instanceof HttpError && err.status === 404) throw notFound({ entityType: 'release_comparison_item', entityId: id });
      throw err;
    });
    return { item, comparison: c };
  };

  router.get(
    '/release-comparison-items/:id/reasons',
    query(pool, 'release.comparison.reasons', 'release_comparison_item', async (ctx, req, res) => {
      const { item, comparison } = await loadItem(pool, ctx, uuidParam(req, 'id', 'release_comparison_item'));
      const { left, right } = await sidesOf(pool, comparison);
      // История причин закрытого вывода — без текста: вывод сначала проверяется по правам читателя.
      const [view] = await itemViews(pool, ctx, { tenderId: comparison.tender_id, leftStageId: left.stage_id, rightStageId: right.stage_id }, [item]);
      const history = await releaseReasonHistory(pool, item.id);
      const visible = await reasonVisibility(pool, ctx, comparison.tender_id, history);
      res.setHeader('ETag', formatEtag(item.id, history[0]?.version ?? 0));
      res.json({ version: history[0]?.version ?? 0, items: history.map((r) => reasonView(r, !view!.closed && visible(r))) });
    }),
  );

  // Новая версия причины вывода (I11): If-Match — текущая версия; вывод и основания должен читать сам автор.
  router.put(
    '/release-comparison-items/:id/reason',
    command(pool, {
      action: 'release.comparison.reason.set',
      entityType: 'release_comparison_item',
      authorize: async (client, ctx, req) => {
        const { comparison } = await loadItem(client, ctx, uuidParam(req, 'id', 'release_comparison_item'));
        if (!hasTenderCap(ctx, comparison.tender_id, 'change_reason.confirm')) throw forbidden('change_reason.confirm', target(comparison));
      },
      run: async (client, ctx, req) => {
        const { item, comparison } = await loadItem(client, ctx, uuidParam(req, 'id', 'release_comparison_item'));
        const t = { tenderId: comparison.tender_id, entityType: 'release_comparison_item', entityId: item.id };
        if (comparison.status !== 'ready') throw conflict('причина ставится по готовому сравнению', 'comparison_not_ready', t);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['release_comparison_reason', item.id]);
        const version = await releaseReasonVersion(client, item.id);
        if (requireDerivedIfMatch(req, item.id) !== version) throw versionConflict({ version });
        const body = parseBody(ReleaseReasonRequest, req.body);
        const { left, right } = await sidesOf(client, comparison);
        const scope = { tenderId: comparison.tender_id, leftStageId: left.stage_id, rightStageId: right.stage_id };
        // Нельзя объяснять то, чего не можешь прочитать (как R08-02): закрытый вывод причину не принимает.
        const [view] = await itemViews(client, ctx, scope, [item]);
        if (view!.closed) throw conflict('вывод закрыт для вас: среди его оснований есть то, что вы не можете читать', 'restricted_item', t);
        const fragmentIds = body.fragmentIds.map((f) => f.toLowerCase());
        const decisionIds = body.decisionIds.map((d) => d.toLowerCase());
        const readable = await readableFragments(client, ctx, fragmentIds);
        if (fragmentIds.some((f) => !readable.has(f))) throw conflict('среди оснований есть фрагменты, которые вы не можете читать', 'restricted_fragments', t);
        const inScope = fragmentIds.length
          ? (await client.query<{ id: string }>('SELECT u.id FROM unnest($1::uuid[]) AS u(id) WHERE fragment_in_stage(u.id, $2) OR fragment_in_stage(u.id, $3)', [fragmentIds, left.stage_id, right.stage_id])).rows.map((x) => x.id)
          : [];
        if (inScope.length !== new Set(fragmentIds).size) throw conflict('основание — фрагмент из снимков этапов сравниваемых выпусков', 'basis_out_of_scope', t);
        const own = decisionIds.length ? (await client.query<{ id: string }>('SELECT id FROM decision WHERE id = ANY($1::uuid[]) AND tender_id = $2', [decisionIds, comparison.tender_id])).rows : [];
        if (own.length !== new Set(decisionIds).size) throw conflict('основание — решение этого тендера', 'basis_out_of_scope', t);
        const decisionVisible = await decisionsVisibility(client, ctx, comparison.tender_id, decisionIds);
        if (!decisionIds.every(decisionVisible)) throw conflict('среди оснований есть решения, предмет которых закрыт для вас', 'restricted_decisions', t);
        const id = await appendReleaseReason(client, {
          tenderId: comparison.tender_id,
          comparisonId: comparison.id,
          itemId: item.id,
          version: version + 1,
          reasonKind: body.reasonKind,
          reasonStatus: body.reasonStatus,
          rationale: body.rationale ?? null,
          fragmentIds,
          decisionIds,
          userId: ctx.principal.userId,
        });
        const history = await releaseReasonHistory(client, item.id);
        return {
          status: 200,
          body: { version: version + 1, reason: reasonView(history[0]!, true) },
          etag: formatEtag(item.id, version + 1),
          // Пояснение причины в журнал не пишется: производный текст, закрытый вместе с основаниями (R13-02).
          audit: [
            {
              action: 'release.comparison.reason.set',
              entityType: 'release_comparison_item',
              entityId: item.id,
              tenderId: comparison.tender_id,
              details: { comparisonId: comparison.id, reasonId: id, version: version + 1, section: item.section, reasonKind: body.reasonKind, reasonStatus: body.reasonStatus, bases: fragmentIds.length + decisionIds.length },
            },
          ],
        };
      },
    }),
  );

  return router;
};
