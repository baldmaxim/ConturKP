// Регрессионный контракт Locus (docs/architecture/locus-regression-manifest.md, AR05-05): 9 случаев
// со статусом stage05 — гейты этапа, 8 отложены с этапом и причиной. Корпус донора переносится как
// документы тендеров с прогонами-фикстурами RDWeb; утверждение — уровень поиска, не ответа.
// Пороги на итоге по ветвям {exact, fts}: утечка 0, Recall@5 ≥ 0,85, MRR ≥ 0,70, точность цитаты 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildIndex, markdownToRun, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const ROOT = join(import.meta.dirname, 'fixtures', 'locus-product-v2');
const MANIFEST = join(import.meta.dirname, '..', 'docs', 'architecture', 'locus-regression-manifest.md');

interface ICase {
  id: string;
  class: string;
  question: string;
  expected: { status: string; sourceIds?: string[]; evidence?: { sourceId: string; file: string; includes: string }[] };
}

const cases = (JSON.parse(readFileSync(join(ROOT, 'contracts-core.json'), 'utf8')) as { cases: ICase[] }).cases;

// Статусы случаев из таблицы манифеста: `ID` → stage05 | deferred:<этап>.
const manifestStatuses = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    const m = /^\| \d+ \| `(pv2-[a-z0-9-]+)` \|[^|]*\|[^|]*\| `(stage05a?|deferred:[0-9a-z]+)` \|/u.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
};

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const tenderOf = new Map<string, { tenderId: string; stageId: string }>();
const fileOfRun = new Map<string, string>();

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  const sources = (JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8')) as { sources: { id: string; title: string; path: string }[] }).sources;
  for (const src of sources) {
    const t = await s.admin.post('/tenders', { code: src.id, title: src.title }, { headers: idem() });
    expect(t.status, t.text).toBe(201);
    const m = await s.admin.put(`/tenders/${t.body.id}/members/${s.ids.eng1}`, { memberRole: 'engineer' }, { headers: { 'If-Match': t.headers.etag as string } });
    expect(m.status, m.text).toBe(200);
    const mm = await s.admin.put(`/tenders/${t.body.id}/members/${s.ids.manager}`, { memberRole: 'manager' }, { headers: { 'If-Match': m.headers.etag as string } });
    expect(mm.status, mm.text).toBe(200);
    const st = await s.manager.post(`/tenders/${t.body.id}/stages`, { title: 'Договор' }, { headers: idem() });
    tenderOf.set(src.id, { tenderId: t.body.id, stageId: st.body.id });
    const dir = src.path.split('/').pop()!;
    const revisions: string[] = [];
    for (const file of ['dogovor-15-p.md', 'ds-01-k-dogovoru-15-p.md', 'pismo-skan.md', 'dogovor-7-rs.md', 'dogovor-b-44.md']) {
      let md: string;
      try {
        md = readFileSync(join(ROOT, dir, file), 'utf8');
      } catch {
        continue;
      }
      const rev = await uploadDocument(db, config, s.eng1, st.body.id, file.replace(/\.md$/u, '.pdf'));
      const runId = await seedEvidenceRun(db.pool, rev, markdownToRun(md));
      fileOfRun.set(runId, file);
      revisions.push(rev);
    }
    await setWorkingSet(s.eng1, st.body.id, revisions);
  }
  await buildIndex(db, makeWorker(db, config));
});
afterAll(async () => db.drop());

describe('манифест переноса (AR05-05)', () => {
  it('17 случаев донора: 9 stage05, 3 stage05a и 5 отложенных — каждый ID из корпуса есть в манифесте', () => {
    const statuses = manifestStatuses();
    expect([...statuses.keys()].sort()).toEqual(cases.map((c) => c.id).sort());
    const stage05 = [...statuses.values()].filter((v) => v === 'stage05');
    expect(stage05).toHaveLength(9);
    // Случаи deferred:05a закрыты этапом 05a (stage05a, tests/searchLocus05a.test.ts); остальные отложены.
    expect([...statuses.values()].filter((v) => v === 'stage05a')).toHaveLength(3);
    const deferred = [...statuses.values()].filter((v) => v.startsWith('deferred:'));
    expect(deferred.sort()).toEqual(['deferred:08', 'deferred:08a', 'deferred:08a', 'deferred:16', 'deferred:16']);
  });
});

describe('регрессионный контракт Locus: случаи stage05', () => {
  it('утечка ноль, Recall@5 ≥ 0,85, MRR ≥ 0,70, точность цитаты 1', async () => {
    const statuses = manifestStatuses();
    const gated = cases.filter((c) => statuses.get(c.id) === 'stage05');
    let evidenceTotal = 0;
    let evidenceFound = 0;
    let reciprocal = 0;
    let leaks = 0;
    let citationChecked = 0;
    let citationExact = 0;
    const rows: string[] = [];
    for (const c of gated) {
      const project = c.expected.sourceIds![0]!;
      const { tenderId, stageId } = tenderOf.get(project)!;
      const r = await s.eng1.post('/search', searchBody(tenderId, stageId, c.question, 10));
      expect(r.status, r.text).toBe(200);
      const items = (r.body.fused?.items ?? []) as { text: string; recognitionRunId: string; rank: number }[];
      // Утечка: любой фрагмент чужого тендера в выдаче.
      const own = await db.pool.query<{ id: string }>('SELECT id FROM recognition_run WHERE tender_id = $1', [tenderId]);
      const ownRuns = new Set(own.rows.map((x) => x.id));
      leaks += items.filter((i) => !ownRuns.has(i.recognitionRunId)).length;
      const top5 = items.slice(0, 5);
      const evidence = c.expected.evidence ?? [];
      let firstRelevant = 0;
      const found: string[] = [];
      for (const e of evidence) {
        evidenceTotal += 1;
        const hit = top5.find((i) => i.text.includes(e.includes));
        if (hit) {
          evidenceFound += 1;
          found.push(e.includes.slice(0, 24));
          // Точность цитаты: основание процитировано из того документа, который ожидает донор.
          citationChecked += 1;
          if (fileOfRun.get(hit.recognitionRunId) === e.file) citationExact += 1;
        }
      }
      items.forEach((i, idx) => {
        if (firstRelevant === 0 && evidence.some((e) => i.text.includes(e.includes))) firstRelevant = idx + 1;
      });
      reciprocal += firstRelevant > 0 ? 1 / firstRelevant : 0;
      rows.push(`${c.id}: найдено ${found.length}/${evidence.length}, первый релевантный — ${firstRelevant || 'нет'}`);
    }
    const recall = evidenceFound / evidenceTotal;
    const mrr = reciprocal / gated.length;
    const exactness = citationChecked === 0 ? 0 : citationExact / citationChecked;
    const report = [
      `регрессия Locus (stage05, ранжирование r1, итог по {exact, fts}): случаев ${gated.length}, оснований ${evidenceTotal}`,
      ...rows,
      `Recall@5 = ${recall.toFixed(3)} (${evidenceFound}/${evidenceTotal}); MRR = ${mrr.toFixed(3)}; утечка = ${leaks}; точность цитаты = ${exactness.toFixed(3)}`,
    ].join('\n');
    console.log(report);
    // Артефакт этапа: путь задаёт прогон проверки (artifacts/stage-05/).
    if (process.env.KONTUR_LOCUS_REPORT) writeFileSync(process.env.KONTUR_LOCUS_REPORT, `${report}\n`);
    expect(leaks).toBe(0);
    expect(exactness).toBe(1);
    expect(recall).toBeGreaterThanOrEqual(0.85);
    expect(mrr).toBeGreaterThanOrEqual(0.7);
  });
});
