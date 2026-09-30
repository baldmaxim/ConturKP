// Случаи 10, 14, 15 манифеста Locus (`deferred:05a`, docs/architecture/locus-regression-manifest.md): смета
// Стромынки — настоящая синтетическая XLSX, распознанная локально (этап 05a); цитата указывает на лист и
// строку. Остальной корпус переносится как в этапе 05 (прогоны-фикстуры RDWeb). Утверждение — уровень
// поиска: основание-строка сметы в top-5 итога, цитата из ожидаемого документа, лист и строка якоря
// совпадают с ожиданием донора, утечки между тендерами нет. Основание договора в случае 10 — корпус
// RDWeb этапа 05 и его ранжирование r1: результат записывается, гейтом 05a не является. Показ
// конфликта — этап 08a. Отдельно: 9 случаев stage05 на том же корпусе со сметой не хуже порогов этапа 05.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { smetaStromynkaXlsx } from './localFixtures.ts';
import { buildIndex, markdownToRun, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const ROOT = join(import.meta.dirname, 'fixtures', 'locus-product-v2');

interface IEvidence {
  sourceId: string;
  file: string;
  includes: string;
  sheet?: string;
  row?: number;
}
interface ICase {
  id: string;
  question: string;
  expected: { sourceIds: string[]; evidence: IEvidence[] };
}

const CASES = ['pv2-conflict-total-cost', 'pv2-spreadsheet-monolith', 'pv2-spreadsheet-concrete-price'];
const allCases = (JSON.parse(readFileSync(join(ROOT, 'contracts-core.json'), 'utf8')) as { cases: ICase[] }).cases;
const cases = allCases.filter((c) => CASES.includes(c.id));
const MANIFEST = join(import.meta.dirname, '..', 'docs', 'architecture', 'locus-regression-manifest.md');
const stage05Ids = (): string[] =>
  readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map((line) => /^\| \d+ \| `(pv2-[a-z0-9-]+)` \|[^|]*\|[^|]*\| `stage05` \|/u.exec(line)?.[1])
    .filter((x): x is string => !!x);

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const tenderOf = new Map<string, { tenderId: string; stageId: string }>();
const fileOfRun = new Map<string, string>();

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  const worker = makeWorker(db, config);
  const sources = (JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8')) as { sources: { id: string; title: string; path: string }[] }).sources;
  for (const src of sources) {
    const t = await s.admin.post('/tenders', { code: src.id, title: src.title }, { headers: idem() });
    const m = await s.admin.put(`/tenders/${t.body.id}/members/${s.ids.eng1}`, { memberRole: 'engineer' }, { headers: { 'If-Match': t.headers.etag as string } });
    await s.admin.put(`/tenders/${t.body.id}/members/${s.ids.manager}`, { memberRole: 'manager' }, { headers: { 'If-Match': m.headers.etag as string } });
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
      fileOfRun.set(await seedEvidenceRun(db.pool, rev, markdownToRun(md)), file);
      revisions.push(rev);
    }
    if (dir === 'stromynka') {
      // Смета — не «выход конвертера», а файл XLSX, который распознаёт локальный движок этапа 05a.
      const up = await s.eng1.post(`/stages/${st.body.id}/imports?name=${encodeURIComponent('smeta-stromynka.xlsx')}`, smetaStromynkaXlsx(), {
        headers: { 'Content-Type': 'application/octet-stream', ...idem() },
      });
      expect(up.status, up.text).toBe(202);
      await drain(worker);
      const rev = (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
      await worker.scheduleLocalRecognition();
      await drain(worker);
      const run = (await s.eng1.get(`/document-revisions/${rev}/recognition-runs`)).body.items[0];
      expect(run).toMatchObject({ engine: 'local_ocr', status: 'complete' });
      fileOfRun.set(run.id as string, 'smeta-stromynka.md');
      revisions.push(rev);
    }
    await setWorkingSet(s.eng1, st.body.id, revisions);
  }
  await buildIndex(db, worker);
});
afterAll(async () => db.drop());

describe('случаи Locus deferred:05a — лист и строка сметы', () => {
  it('основания в top-5, цитата из ожидаемого документа, якорь листа и строки — как у донора, утечки нет', async () => {
    expect(cases.map((c) => c.id).sort()).toEqual([...CASES].sort());
    const rows: string[] = [];
    let total = 0;
    let found = 0;
    let exact = 0;
    let anchored = 0;
    let sheetTotal = 0;
    let sheetFound = 0;
    let leaks = 0;
    let reciprocal = 0;
    for (const c of cases) {
      const { tenderId, stageId } = tenderOf.get(c.expected.sourceIds[0]!)!;
      const r = await s.eng1.post('/search', searchBody(tenderId, stageId, c.question, 10), { headers: idem() });
      expect(r.status, r.text).toBe(200);
      const items = (r.body.fused?.items ?? []) as { text: string; recognitionRunId: string; engine: string; locator: { sheet?: string; rowFrom?: number } | null }[];
      const own = new Set((await db.pool.query<{ id: string }>('SELECT id FROM recognition_run WHERE tender_id = $1', [tenderId])).rows.map((x) => x.id));
      leaks += items.filter((i) => !own.has(i.recognitionRunId)).length;
      const top5 = items.slice(0, 5);
      const got: string[] = [];
      for (const e of c.expected.evidence) {
        total += 1;
        if (e.sheet !== undefined) sheetTotal += 1;
        const hit = top5.find((i) => i.text.includes(e.includes));
        if (!hit) {
          got.push(`нет в top-5: ${e.includes} (${e.file})`);
          continue;
        }
        found += 1;
        if (e.sheet !== undefined) sheetFound += 1;
        if (fileOfRun.get(hit.recognitionRunId) === e.file) exact += 1;
        if (e.sheet !== undefined) {
          // Якорь локального фрагмента: тот же лист и та же строка, что в ожидании донора.
          if (hit.engine === 'local_ocr' && hit.locator?.sheet === e.sheet && hit.locator.rowFrom === e.row) anchored += 1;
        } else {
          anchored += 1;
        }
        got.push(`${e.includes}${e.sheet ? ` [${e.sheet}, строка ${e.row}]` : ''}`);
      }
      const first = items.findIndex((i) => c.expected.evidence.some((e) => i.text.includes(e.includes))) + 1;
      reciprocal += first > 0 ? 1 / first : 0;
      rows.push(`${c.id}: ${got.join('; ')}; первый релевантный — ${first || 'нет'}`);
    }
    const report = [
      `регрессия Locus (deferred:05a, ранжирование r1, итог по {exact, fts}): случаев ${cases.length}, оснований ${total}`,
      ...rows,
      `Recall@5 = ${(found / total).toFixed(3)} (${found}/${total}); MRR = ${(reciprocal / cases.length).toFixed(3)}; утечка = ${leaks}; ` +
        `точность цитаты = ${(exact / Math.max(1, found)).toFixed(3)}; строки сметы в top-5 = ${sheetFound}/${sheetTotal}; якорь листа и строки = ${anchored}/${found}`,
    ].join('\n');
    console.log(report);
    if (process.env.KONTUR_LOCUS05A_REPORT) writeFileSync(process.env.KONTUR_LOCUS05A_REPORT, `${report}\n`);
    // Гейт 05a: каждое основание-строка сметы найдено с верным листом и строкой; утечки нет;
    // найденное процитировано из ожидаемого документа.
    expect(leaks).toBe(0);
    expect(sheetFound).toBe(sheetTotal);
    expect(exact).toBe(found);
    expect(anchored).toBe(found);
  });

  it('9 случаев stage05 на корпусе со сметой XLSX — не хуже порогов этапа 05', async () => {
    const gated = allCases.filter((c) => stage05Ids().includes(c.id));
    expect(gated).toHaveLength(9);
    let total = 0;
    let found = 0;
    let reciprocal = 0;
    let leaks = 0;
    for (const c of gated) {
      const { tenderId, stageId } = tenderOf.get(c.expected.sourceIds[0]!)!;
      const r = await s.eng1.post('/search', searchBody(tenderId, stageId, c.question, 10), { headers: idem() });
      const items = (r.body.fused?.items ?? []) as { text: string; recognitionRunId: string }[];
      const own = new Set((await db.pool.query<{ id: string }>('SELECT id FROM recognition_run WHERE tender_id = $1', [tenderId])).rows.map((x) => x.id));
      leaks += items.filter((i) => !own.has(i.recognitionRunId)).length;
      for (const e of c.expected.evidence) {
        total += 1;
        if (items.slice(0, 5).some((i) => i.text.includes(e.includes))) found += 1;
      }
      const first = items.findIndex((i) => c.expected.evidence.some((e) => i.text.includes(e.includes))) + 1;
      reciprocal += first > 0 ? 1 / first : 0;
    }
    const report = `stage05 на корпусе со сметой XLSX: Recall@5 = ${(found / total).toFixed(3)} (${found}/${total}); MRR = ${(reciprocal / gated.length).toFixed(3)}; утечка = ${leaks}`;
    console.log(report);
    if (process.env.KONTUR_LOCUS05A_REPORT) writeFileSync(process.env.KONTUR_LOCUS05A_REPORT, `${report}\n`, { flag: 'a' });
    expect(leaks).toBe(0);
    expect(found / total).toBeGreaterThanOrEqual(0.85);
    expect(reciprocal / gated.length).toBeGreaterThanOrEqual(0.7);
  });
});
