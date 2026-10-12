// Сравнение двух выпусков (проект §4, §5.1): запись сравнения этапа 15 — по закреплённым записям выпусков, а не по
// текущему состоянию. Готовое сравнение пары берётся повторно; иначе создаётся тем же расчётом, что в портале.
// Выводы показываются по текущим правам читателя; закрытый вывод — без названий и значений.
import { RELEASE_COMPARE_METHOD, type IReleaseManifest } from '@kontur/core';
import { createReleaseComparison, getRelease, listReleaseComparisons, releaseComparisonItems, releaseReasonCounts, withTransaction, type IReleaseComparisonRow, type IReleaseRow } from '@kontur/db';
import { z } from 'zod';
import { HttpError } from '../../http/errors.ts';
import { itemViews } from '../../releaseComparisonViews.ts';
import { readStoredBlob } from '../../releaseMarkup.ts';
import { loadVisibleRelease } from '../../releaseViews.ts';
import { hasTenderCap } from '../../routes/scope.ts';
import { needsSelection } from '../scope.ts';
import { McpToolError, outOfScope, type IMcpSession } from '../session.ts';
import { DATA_NOTICE, defineTool } from '../tools.ts';

const uuid = z.string().uuid();
const SECTIONS = ['sources', 'requirements', 'questions', 'terms', 'decisions', 'applications', 'received'] as const;

const visibleRelease = async (s: IMcpSession, tenderId: string, id: string): Promise<IReleaseRow> => {
  try {
    const { release } = await loadVisibleRelease(s.pool, s.ctx, await getRelease(s.pool, id), id);
    if (release.tender_id !== tenderId) throw outOfScope();
    return release;
  } catch (err) {
    if (err instanceof HttpError) throw outOfScope();
    throw err;
  }
};

const manifestOf = async (s: IMcpSession, r: IReleaseRow): Promise<IReleaseManifest> => JSON.parse((await readStoredBlob(s.store, r.release_manifest_blob_sha256)).toString('utf8')) as IReleaseManifest;

export const compareReleasesTool = defineTool({
  name: 'compare_releases',
  title: 'Сравнение выпусков',
  description: `Сравнивает два выпуска одного тендера по закреплённым записям каждого: источники, требования, вопросы, условия, решения, приложения и файлы, отдельно — полученное между выпусками; расчёт — ссылкой на сравнение ревизий. У каждого вывода — доказательства (ID записей) и статус причины; причину записывает человек. section — один раздел; без него — сводка и первые выводы. ${DATA_NOTICE}`,
  scope: 'read',
  input: z
    .object({ tenderId: uuid.optional(), leftReleaseId: uuid.optional(), rightReleaseId: uuid.optional(), section: z.enum(SECTIONS).optional(), cursor: z.string().regex(/^\d{1,9}$/).optional(), limit: z.number().int().min(1).max(50).optional() })
    .strict(),
  run: async (s, a) => {
    if (!a.tenderId || !a.leftReleaseId || !a.rightReleaseId) throw await needsSelection(s.pool, s, 'для сравнения укажите тендер и оба выпуска (их ID — в get_case_overview)');
    const tenderId = a.tenderId.toLowerCase();
    if (a.leftReleaseId.toLowerCase() === a.rightReleaseId.toLowerCase()) throw new McpToolError('invalid_request', 'сравниваются два разных выпуска');
    if (!hasTenderCap(s.ctx, tenderId, 'economics.compare')) throw outOfScope();
    const [one, two] = [await visibleRelease(s, tenderId, a.leftReleaseId.toLowerCase()), await visibleRelease(s, tenderId, a.rightReleaseId.toLowerCase())];
    // Левая сторона — выпущенная раньше: порядок определяет БД, как в портале.
    const first = (await s.pool.query<{ id: string }>('SELECT id FROM release WHERE id = ANY($1::uuid[]) ORDER BY released_at, id LIMIT 1', [[one.id, two.id]])).rows[0]!.id;
    const [left, right] = first === one.id ? [one, two] : [two, one];
    const existing = (await listReleaseComparisons(s.pool, tenderId, 200)).find((c) => c.status === 'ready' && c.method_version === RELEASE_COMPARE_METHOD && c.left_release_id === left.id && c.right_release_id === right.id);
    const comparison: IReleaseComparisonRow =
      existing ??
      (await withTransaction(s.pool, async (client) =>
        createReleaseComparison(client, { tenderId, left, right, leftManifest: await manifestOf(s, left), rightManifest: await manifestOf(s, right), userId: s.ctx.principal.userId }),
      ));
    const base = { tenderId, entityType: 'release_comparison', entityId: comparison.id, details: { reused: !!existing, status: comparison.status, resultSha256: comparison.result_sha256 } };
    const head = {
      comparisonId: comparison.id,
      status: comparison.status,
      methodVersion: comparison.method_version,
      resultSha256: comparison.result_sha256,
      left: { releaseId: left.id, stageId: left.stage_id, mode: left.mode, releasedAt: left.released_at.toISOString() },
      right: { releaseId: right.id, stageId: right.stage_id, mode: right.mode, releasedAt: right.released_at.toISOString() },
    };
    if (comparison.status !== 'ready' || !comparison.summary) return { result: { ...head, failureReason: comparison.failure_reason, noData: { reason: 'comparison_failed', message: 'сравнение не построено' } }, ...base };
    const limit = a.limit ?? 20;
    const after = a.cursor ? Number(a.cursor) : 0;
    const rows = await releaseComparisonItems(s.pool, comparison.id, { section: a.section ?? null, after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const items = await itemViews(s.pool, s.ctx, { tenderId, leftStageId: left.stage_id, rightStageId: right.stage_id }, page);
    return {
      result: {
        ...head,
        sections: comparison.summary.sections,
        calculation: comparison.summary.calculation,
        reasons: await releaseReasonCounts(s.pool, comparison.id),
        section: a.section ?? null,
        items,
        nextCursor: rows.length > limit && page.length > 0 ? String(page.at(-1)!.ordinal) : null,
      },
      ...base,
    };
  },
});
