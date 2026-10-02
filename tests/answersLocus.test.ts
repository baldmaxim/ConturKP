// Этап 08a: случаи Locus `deferred:08a` (манифест docs/architecture/locus-regression-manifest.md) на корпусе донора
// `tests/fixtures/locus-product-v2`. Проект Locus — тендер портала; область задаёт контекст диалога, а не текст вопроса
// (D-019). Проверяется ответное ядро, а не качество модели (Q-11): модель задаётся поддельной (эвристика или сценарий).
// Случай 6 — нет ответа: ни «честная» модель без утверждений, ни «выдумывающая» депозит не дают подтверждённого ответа.
// Случай 8 — уточняющий вопрос: «А какой гарантийный срок?» после вопроса о цене — ответ по Балчугу с «3 года».
// Случай 11 — «какой сейчас аванс» (D-018, D-028): допсоглашение № 1 к договору № 15-П по тексту перекрывает пункт 3.1;
// граф фактов области хода — 10%, основание 20% — перекрытое.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { draftJson, ScriptedChat, type AnswerView } from './answerFixtures.ts';
import { buildIndex, markdownToRun, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';

const ROOT = join(import.meta.dirname, 'fixtures', 'locus-product-v2');
interface ICase {
  id: string;
  question: string;
  history?: { question: string }[];
  expected: { status: string; sourceIds: string[]; evidence: { includes: string }[]; answer?: { mustContain?: string[]; mustNotContain?: string[] } };
}
const cases = (JSON.parse(readFileSync(join(ROOT, 'contracts-core.json'), 'utf8')) as { cases: ICase[] }).cases;
const caseOf = (id: string): ICase => cases.find((c) => c.id === id)!;

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
const chat = new ScriptedChat();
const config = testConfig();
const tenderOf = new Map<string, { tenderId: string; stageId: string }>();

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = workerWithChat(db, config, chat);
  const sources = (JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8')) as { sources: { id: string; title: string; path: string }[] }).sources;
  for (const src of sources.filter((x) => ['pv2-stromynka', 'pv2-balchug'].includes(x.id))) {
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
    for (const file of ['dogovor-15-p.md', 'ds-01-k-dogovoru-15-p.md', 'pismo-skan.md', 'dogovor-b-44.md']) {
      let md: string;
      try {
        md = readFileSync(join(ROOT, dir, file), 'utf8');
      } catch {
        continue;
      }
      const rev = await uploadDocument(db, config, s.eng1, st.body.id, file.replace(/\.md$/u, '.pdf'));
      await seedEvidenceRun(db.pool, rev, markdownToRun(md));
      revisions.push(rev);
    }
    await setWorkingSet(s.eng1, st.body.id, revisions);
  }
  await buildIndex(db, worker);
});
afterAll(async () => db.drop());

const dialogFor = async (client: TestClient, project: string): Promise<string> => {
  const { tenderId, stageId } = tenderOf.get(project)!;
  const r = await client.post('/dialogs', { context: { kind: 'tender', tenderId, mode: 'working', stageId } }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};
const askIn = async (dialogId: string, question: string): Promise<AnswerView> => {
  const q = await s.eng1.post(`/dialogs/${dialogId}/messages`, { text: question }, { headers: idem() });
  expect(q.status, q.text).toBe(201);
  await drain(worker);
  return (await s.eng1.get(`/answer-runs/${q.body.runId}`)).body as AnswerView;
};

describe('случай 6 pv2-no-answer-insurance — недостаточно оснований (Locus insufficient_evidence)', () => {
  it('модель без утверждений — неполнота, а не «подтверждено»; текста о депозите нет', async () => {
    const c = caseOf('pv2-no-answer-insurance');
    chat.scenario = (input) => (input.task === 'answer_draft' ? { ok: true, value: JSON.stringify({ claims: [], summary: '', open_questions: ['Страхового депозита в договоре нет'] }) } : null);
    const r = await askIn(await dialogFor(s.eng1, c.expected.sourceIds[0]!), c.question);
    expect(r).toMatchObject({ answerStatus: 'incomplete_processing', incompleteReason: 'insufficient_evidence' });
    for (const bad of c.expected.answer!.mustNotContain!) expect(r.answer!.text!.toLowerCase()).not.toContain(bad);
  });

  it('модель выдумывает депозит со ссылкой на настоящий пункт — гейт отклоняет, статус тот же', async () => {
    const c = caseOf('pv2-no-answer-insurance');
    chat.scenario = (input) =>
      input.task === 'answer_draft'
        ? draftJson([{ text: 'Страховой депозит составляет 5% от цены договора.', kind: 'percentage', evidence: ['E1'] }])
        : null;
    const r = await askIn(await dialogFor(s.eng1, c.expected.sourceIds[0]!), c.question);
    expect(r).toMatchObject({ answerStatus: 'incomplete_processing', incompleteReason: 'insufficient_evidence', answer: { shownClaims: 0 } });
    for (const bad of c.expected.answer!.mustNotContain!) expect(r.answer!.text!.toLowerCase()).not.toContain(bad);
  });
});

describe('случай 8 pv2-follow-up-warranty — уточняющий вопрос (Locus verified)', () => {
  it('«А какой гарантийный срок?» после вопроса о цене — подтверждено цитатами, «3 года» Балчуга, чужого проекта нет', async () => {
    const c = caseOf('pv2-follow-up-warranty');
    chat.scenario = null;
    const project = c.expected.sourceIds[0]!;
    const d = await dialogFor(s.eng1, project);
    for (const h of c.history ?? []) await askIn(d, h.question);
    const r = await askIn(d, c.question);
    expect(r.answerStatus).toBe('confirmed_by_citations');
    for (const must of c.expected.answer!.mustContain!) expect(r.answer!.text).toContain(must);
    expect(r.answer!.citations.some((cit) => c.expected.evidence.some((e) => (cit.text ?? '').includes(e.includes)))).toBe(true);
    // Утечки между тендерами нет: все цитаты — из тендера Балчуга.
    const cited = await db.pool.query<{ tender_id: string }>(
      'SELECT DISTINCT f.tender_id FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1',
      [r.id],
    );
    expect(cited.rows.map((x) => x.tender_id)).toEqual([tenderOf.get(project)!.tenderId]);
    expect((await db.pool.query('SELECT plan FROM answer_run WHERE id = $1', [r.id])).rows[0].plan).toMatchObject({ followUp: true });
  });
});

describe('случай 11 pv2-amendment-advance — перекрытый допсоглашением пункт (Locus verified, D-018)', () => {
  it('«Какой сейчас размер аванса…» — 10% из допсоглашения; пункт договора 20% — перекрытое основание, не текущее', async () => {
    const c = caseOf('pv2-amendment-advance');
    chat.scenario = null;
    const r = await askIn(await dialogFor(s.eng1, c.expected.sourceIds[0]!), c.question);
    expect(r.answerStatus).toBe('confirmed_by_citations');
    for (const must of c.expected.answer!.mustContain!) expect(r.answer!.text).toContain(must);
    for (const bad of c.expected.answer!.mustNotContain!) expect(r.answer!.text!.toLowerCase()).not.toContain(bad);
    const packet = await db.pool.query<{ version_note: string; text: string }>(
      'SELECT e.version_note, f.text FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1',
      [r.id],
    );
    const cited = r.answer!.citations.map((x) => x.text ?? '');
    expect(c.expected.evidence.every((e) => cited.some((t) => t.toLowerCase().includes(e.includes.toLowerCase())))).toBe(true);
    for (const stale of (c.expected as unknown as { staleEvidence: { includes: string }[] }).staleEvidence) {
      expect(packet.rows.find((p) => p.text.toLowerCase().includes(stale.includes.toLowerCase()))?.version_note).toBe('superseded');
    }
  });
});
