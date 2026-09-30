// Этап 07: обязательные тесты утечки через поиск (D-025, AD-07-1a). Поиск один: exact, FTS и vector
// работают с ревизией письма и документом вложения. Результат письма допустим только при одновременно:
// единица в области, mail.read на ящик, связь с тендером контекста, доступ к тендеру. Проверка — до
// ранжирования (единица не попадает в область прогона) и повторно при чтении прогона и цитаты.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEmbeddings } from '../packages/adapters/src/index.ts';
import { getActiveVersion } from '../packages/db/src/index.ts';
import { INTERACTIVE_KINDS, type WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { auditRows, buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { buildMailScope, MARK, setMailAccess, type IMailScope } from './mailFixtures.ts';
import { buildIndex, fixScope, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let m: IMailScope;
const fake = new FakeEmbeddings({ dim: 16, batchSize: 8 });
const config = testConfig({
  embedding: { provider: 'fake', baseUrl: null, model: null, revision: fake.revision, apiKey: null, dim: 16, template: 'plain', timeoutMs: 5000, batchSize: 8 },
});

interface IRunView {
  searchRunId: string;
  status: string;
  scope: { units: number; excludedByAcl: number; mailUnits: number };
  fused: { items: { fragmentId: string; text: string; sourceKind: string | null; mail: { messageId: string } | null }[] } | null;
  lexical: { items: { text: string }[] } | null;
}

// Поиск до итога: смысловая ветка выполняется заданием, затем прогон читается заново.
const searchAll = async (client: TestClient, body: object): Promise<IRunView> => {
  const r = await client.post('/search', body, { headers: idem() });
  expect(r.status, r.text).toBe(200);
  const pendingTexts = (r.body.lexical?.items ?? []).map((i: { text: string }) => i.text);
  expect(leaks(pendingTexts, client === s.eng1 || client === s.manager ? [] : ALL)).toEqual([]);
  if (r.body.status !== 'pending') return r.body;
  while (await worker.runOnce([...INTERACTIVE_KINDS])) {
    // смысловая ветка
  }
  const done = await client.get(`/search-runs/${r.body.searchRunId}`);
  expect(done.status, done.text).toBe(200);
  return done.body;
};

const ALL = [MARK.m1, MARK.att, MARK.m2, MARK.m3, MARK.sib];
const leaks = (texts: string[], markers: string[]): string[] => texts.filter((t) => markers.some((mk) => t.includes(mk.slice(0, 18))));
const texts = (b: IRunView): string[] => (b.fused?.items ?? []).map((i) => i.text);

// Фрагменты всех веток прогона (exact, fts, vector, fused) — прямо из БД, мимо проекции.
const branchFragments = async (runId: string): Promise<string[]> =>
  (
    await db.pool.query<{ text: string }>(
      'SELECT f.text FROM search_run_result r JOIN evidence_fragment f ON f.id = r.fragment_id WHERE r.run_id = $1',
      [runId],
    )
  ).rows.map((x) => x.text);

const mailFragmentId = async (text: string): Promise<string> =>
  (await db.pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE mail_message_revision_id IS NOT NULL AND text LIKE $1', [`%${text.slice(0, 18)}%`])).rows[0]!.id;
const attachmentFragmentId = async (): Promise<string> =>
  (await db.pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE run_id = $1 AND text LIKE $2', [m.attRun, `%${MARK.att}%`])).rows[0]!.id;

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config, 'mail-search-worker', fake);
  m = await buildMailScope(
    s,
    worker,
    () => uploadDocument(db, config, s.eng1, s.stageA, 'тз-А.pdf'),
    (rev, text) => seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] }),
  );
  await setWorkingSet(s.eng1, s.stageA, [m.tenderDoc, m.attRevision]);
  await buildIndex(db, worker);
});
afterAll(async () => {
  await db.drop();
});

describe('позитивная база: оба права — письмо и вложение находятся', () => {
  it('mail.read + доступ к тендеру + связь: exact, FTS и вектор находят письмо и вложение; итог помечен источником', async () => {
    const b = await searchAll(s.eng1, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741 гидроизоляция'));
    expect(b.status).toBe('complete');
    expect(b.scope.mailUnits).toBe(2);
    const hit = b.fused!.items.find((i) => i.text.includes('ЖЕЛЕЗОБЕТОН-7741'));
    expect(hit).toMatchObject({ sourceKind: 'mail_message_revision', mail: { messageId: m.m1 } });
    const att = await searchAll(s.eng1, searchBody(s.tenderA, s.stageA, MARK.att));
    expect(texts(att).some((t) => t.includes(MARK.att))).toBe(true);
    const branches = await db.pool.query<{ branch: string }>(
      'SELECT DISTINCT r.branch FROM search_run_result r JOIN evidence_fragment f ON f.id = r.fragment_id WHERE r.run_id = $1 AND f.mail_message_revision_id IS NOT NULL',
      [b.searchRunId],
    );
    expect(branches.rows.map((x) => x.branch).sort()).toEqual(expect.arrayContaining(['exact', 'fts', 'fused', 'vector']));
  });
});

describe('обязательные тесты утечки поиска (AD-07-1a)', () => {
  it('1–4. без mail.read: нет exact, FTS, вектора и сниппета — единица исключена до ранжирования, видна только числом', async () => {
    for (const query of ['ЖЕЛЕЗОБЕТОН-7741', 'гидроизоляция фундаментной плиты согласована', 'согласование гидроизоляции фундамента заказчиком']) {
      const b = await searchAll(s.eng2, searchBody(s.tenderA, s.stageA, query));
      expect(leaks(texts(b), ALL)).toEqual([]);
      expect(leaks(await branchFragments(b.searchRunId), ALL)).toEqual([]);
      // Исключены ревизии писем M1 и M2 и прогон вложения M1.
      expect(b.scope.excludedByAcl).toBe(3);
      expect(b.scope.mailUnits).toBe(0);
    }
    const run = await db.pool.query<{ allowed: string[] }>('SELECT allowed_source_unit_ids AS allowed FROM search_run WHERE requested_by = $1', [s.ids.eng2]);
    for (const r of run.rows) expect(r.allowed).not.toContain(m.m1Revision);
  });

  it('5. нет цитаты: фрагмент письма и вложения без mail.read — 404', async () => {
    expect((await s.eng2.get(`/evidence/${await mailFragmentId(MARK.m1)}`)).status).toBe(404);
    expect((await s.eng2.get(`/evidence/${await attachmentFragmentId()}`)).status).toBe(404);
    const ok = await s.eng1.get(`/evidence/${await mailFragmentId(MARK.m1)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ sourceKind: 'mail_message_revision', mail: { messageId: m.m1 } });
  });

  it('6. нет результата вложения: ни поиском, ни через документ, прогон или байты', async () => {
    const b = await searchAll(s.eng2, searchBody(s.tenderA, s.stageA, MARK.att));
    expect(leaks(texts(b), [MARK.att])).toEqual([]);
    expect(leaks(await branchFragments(b.searchRunId), [MARK.att])).toEqual([]);
    expect((await s.eng2.get(`/document-revisions/${m.attRevision}/content`)).status).toBe(404);
    expect((await s.eng2.get(`/document-revisions/${m.attRevision}/recognition-runs`)).status).toBe(404);
    expect((await s.eng2.get(`/recognition-runs/${m.attRun}`)).status).toBe(404);
    const attId = (await s.eng1.get(`/mail-messages/${m.m1}`)).body.current.attachments[0].id;
    expect((await s.eng2.get(`/mail-attachments/${attId}/content`)).status).toBe(404);
    // Состав этапа показывает элемент вложения без mail.read только как факт.
    const items = (await s.eng2.get(`/stages/${s.stageA}/source-sets`)).body.items[0].latestItems;
    expect(items.find((i: { documentRevisionId: string }) => i.documentRevisionId === m.attRevision)).toMatchObject({ restricted: true, documentTitle: null });
  });

  it('7. отзыв mail.read после индексации закрывает результат без переиндексации', async () => {
    const version = (await getActiveVersion(db.pool))!.id;
    const before = await searchAll(s.manager, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'));
    expect(texts(before).some((t) => t.includes('ЖЕЛЕЗОБЕТОН-7741'))).toBe(true);
    const fragment = await mailFragmentId(MARK.m1);
    expect((await s.manager.get(`/evidence/${fragment}`)).status).toBe(200);
    await setMailAccess(s.admin, m.boxA, s.ids.manager, ['mail.link']);
    try {
      const reread = await s.manager.get(`/search-runs/${before.searchRunId}`);
      expect(reread.status).toBe(409);
      expect(reread.body.current).toMatchObject({ reason: 'scope_changed' });
      expect(reread.text).not.toContain('ЖЕЛЕЗОБЕТОН');
      const after = await searchAll(s.manager, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'));
      expect(leaks(texts(after), ALL)).toEqual([]);
      expect((await s.manager.get(`/evidence/${fragment}`)).status).toBe(404);
      expect((await s.manager.get(`/mail-messages/${m.m1}`)).status).toBe(404);
      expect((await getActiveVersion(db.pool))!.id).toBe(version);
    } finally {
      await setMailAccess(s.admin, m.boxA, s.ids.manager, ['mail.read', 'mail.link']);
    }
  });

  it('8. тендер A не видит письмо, связанное только с B, — даже при mail.read на его ящик', async () => {
    await setMailAccess(s.admin, m.boxB, s.ids.manager, ['mail.read']);
    try {
      const inA = await searchAll(s.manager, searchBody(s.tenderA, s.stageA, 'ПЕСКОБЕТОН-6620 стяжка'));
      expect(leaks(texts(inA), [MARK.m3])).toEqual([]);
      expect(leaks(await branchFragments(inA.searchRunId), [MARK.m3])).toEqual([]);
      const inB = await searchAll(s.manager, searchBody(s.tenderB, s.stageB, 'ПЕСКОБЕТОН-6620 стяжка'));
      expect(texts(inB).some((t) => t.includes('ПЕСКОБЕТОН-6620'))).toBe(true);
      expect((await s.manager.get(`/tenders/${s.tenderA}/mail-messages`)).body.items.map((x: { id: string }) => x.id)).not.toContain(m.m3);
    } finally {
      await setMailAccess(s.admin, m.boxB, s.ids.manager, []);
    }
  });

  it('9. письмо, связанное с A и B, видно в каждом контексте только при правах и без дублей', async () => {
    const eng1A = await searchAll(s.eng1, searchBody(s.tenderA, s.stageA, 'КЛИНКЕР-3390 облицовка'));
    expect(texts(eng1A).filter((t) => t.includes('КЛИНКЕР-3390'))).toHaveLength(1);
    const eng3B = await searchAll(s.eng3, searchBody(s.tenderB, s.stageB, 'КЛИНКЕР-3390 облицовка'));
    expect(leaks(texts(eng3B), [MARK.m2])).toEqual([]);
    expect(eng3B.scope.excludedByAcl).toBeGreaterThan(0);
    const mgrA = await searchAll(s.manager, searchBody(s.tenderA, s.stageA, 'КЛИНКЕР-3390 облицовка'));
    const mgrB = await searchAll(s.manager, searchBody(s.tenderB, s.stageB, 'КЛИНКЕР-3390 облицовка'));
    expect(texts(mgrA).filter((t) => t.includes('КЛИНКЕР-3390'))).toHaveLength(1);
    expect(texts(mgrB).filter((t) => t.includes('КЛИНКЕР-3390'))).toHaveLength(1);
    const copies = await db.pool.query('SELECT count(*)::int AS n FROM mail_message_revision r JOIN mail_message x ON x.id = r.message_id WHERE x.id = $1', [m.m2]);
    expect(copies.rows[0].n).toBe(1);
  });

  it('10. администратор без mail.read не видит тему, тело и сниппеты', async () => {
    expect((await s.admin.get(`/mail-messages/${m.m1}`)).status).toBe(404);
    expect((await s.admin.get(`/mailboxes/${m.boxA}/messages`)).status).toBe(403);
    expect((await s.admin.get(`/evidence/${await mailFragmentId(MARK.m1)}`)).status).toBe(404);
    const boxes = await s.admin.get('/mailboxes');
    expect(boxes.status).toBe(200);
    expect(boxes.text).not.toContain('Гидроизоляция');
    expect((await s.admin.post('/search', searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'), { headers: idem() })).status).toBe(404);
  });

  it('11. группировка коммуникации не открывает копию в чужом ящике', async () => {
    const a = await s.eng1.get(`/mail-messages/${m.sibA}`);
    expect(a.body.siblings).toEqual([]);
    expect(a.body.communicationId).toBe((await s.eng3.get(`/mail-messages/${m.sibB}`)).body.communicationId);
    expect((await s.eng1.get(`/mail-messages/${m.sibB}`)).status).toBe(404);
    // Копия B связана с тендером B; у eng1 нет ни тендера B, ни ящика B — поиск в тендере A её не находит.
    const b = await searchAll(s.eng1, searchBody(s.tenderA, s.stageA, 'СИБЛИНГ-4410 копия'));
    expect(leaks(texts(b), [MARK.sib])).toEqual([]);
    await setMailAccess(s.admin, m.boxB, s.ids.manager, ['mail.read']);
    try {
      const both = await s.manager.get(`/mail-messages/${m.sibA}`);
      expect(both.body.siblings.map((x: { messageId: string }) => x.messageId)).toEqual([m.sibB]);
    } finally {
      await setMailAccess(s.admin, m.boxB, s.ids.manager, []);
    }
  });
});

describe('снимок и снятие связи (тест 10 D-025)', () => {
  it('снятие связи: историческое доказательство в снимке остаётся и ищется, текущий контекст его скрывает', async () => {
    await setWorkingSet(s.eng1, s.stageA, [m.tenderDoc, m.attRevision], true);
    const scope = await fixScope(s.eng1, s.stageA);
    const detail = await s.eng1.get(`/evidence-scopes/${scope}`);
    expect(detail.body.items.map((i: { unitType: string }) => i.unitType).sort()).toEqual(['document_recognition', 'document_recognition', 'mail_message', 'mail_message']);
    // Участник без mail.read видит единицы письма в снимке только как факт.
    const hidden = await s.eng2.get(`/evidence-scopes/${scope}`);
    expect(hidden.text).not.toContain('Гидроизоляция');
    expect(hidden.body.items.filter((i: { restricted: boolean }) => i.restricted)).toHaveLength(3);
    const review = { context: { kind: 'tender', tenderId: s.tenderA, mode: 'review', evidenceScopeId: scope }, query: 'КЛИНКЕР-3390', limit: 10 };
    const r1 = await searchAll(s.eng1, review);
    expect(texts(r1).some((t) => t.includes('КЛИНКЕР-3390'))).toBe(true);
    const off = await s.eng1.post(`/mail-messages/${m.m2}/tender-links/${s.tenderA}/unlink`, {}, { headers: idem() });
    expect(off.status).toBe(200);
    const r2 = await searchAll(s.eng1, review);
    expect(texts(r2).some((t) => t.includes('КЛИНКЕР-3390'))).toBe(true);
    expect((await s.eng1.get(`/search-runs/${r1.searchRunId}`)).status).toBe(200);
    const working = await searchAll(s.eng1, searchBody(s.tenderA, s.stageA, 'КЛИНКЕР-3390'));
    expect(leaks(texts(working), [MARK.m2])).toEqual([]);
    expect((await s.eng1.get(`/tenders/${s.tenderA}/mail-messages`)).body.items.map((x: { id: string }) => x.id)).not.toContain(m.m2);
  });

  it('журнал поиска не содержит текста писем и сниппетов', async () => {
    const rows = await auditRows(db.pool, "action IN ('search.run', 'search.run.read', 'evidence.read', 'mail.message.read')");
    expect(rows.length).toBeGreaterThan(0);
    const all = JSON.stringify(rows);
    for (const mk of ALL) expect(all).not.toContain(mk.slice(0, 18));
  });
});
