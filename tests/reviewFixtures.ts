// Фикстуры этапа 09: тендер A, этап A — ТЗ, документ договора, письмо заказчика о замене светильника, вопросы–ответы
// (два противоречащих ответа и вопрос без ответа), расчёт поддельного TenderHub (VERIFIED_FIXTURE) со строкой «светильник
// №2», кладкой и дублем позиции. Снимок, реестр, требования и покрытие — через API, как это делает пользователь.
// Тексты синтетические; модель — поддельная (механизм, не качество, D-029 В-09-5).
import { expect } from 'vitest';
import { FakeChat, type FakeChatScript } from '../packages/adapters/src/index.ts';
import type { IAppConfig } from '../packages/config/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { fakeItem, fakePosition, fakeTender, type IFakeTender } from '../scripts/tenderhub-fake-data.ts';
import { adminMember, captureNow, linkSource, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, drain, idem, makeApp, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, postManifest, qaManifest, setMailAccess } from './mailFixtures.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

export const RT = {
  tender: '7d1f0c8e-9999-4a6b-9c1d-000000000009',
  s1: '7d1f0c8e-9999-4a6b-9c1d-0000000000a0',
  lamp: '7d1f0c8e-9999-4a6b-9c1d-0000000000a1',
  masonry: '7d1f0c8e-9999-4a6b-9c1d-0000000000a2',
  masonryDup: '7d1f0c8e-9999-4a6b-9c1d-0000000000a3',
  facade: '7d1f0c8e-9999-4a6b-9c1d-0000000000a4',
  lampLine: '7d1f0c8e-9999-4a6b-9c1d-0000000000b1',
  masonryLine: '7d1f0c8e-9999-4a6b-9c1d-0000000000b2',
  facadeLine: '7d1f0c8e-9999-4a6b-9c1d-0000000000b4',
};

export const reviewTender = (): IFakeTender => {
  const p = (id: string, row: Parameters<typeof fakePosition>[2]) => fakePosition(RT.tender, id, row);
  const i = (pos: string, id: string, row: Parameters<typeof fakeItem>[3]) => fakeItem(RT.tender, pos, id, row);
  return fakeTender({
    id: RT.tender,
    tender_number: 'TH-2026-009',
    title: 'Корпус 9 — проверка',
    positions: [
      p(RT.s1, { position_number: n('1'), work_name: 'Раздел 1', is_section: true, unit_code: null, volume: null }),
      p(RT.lamp, { position_number: n('1.1'), work_name: 'Светильники коридоров', unit_code: 'шт', volume: n('10'), section_number: '1', commercial_total: n('500'), items_count: n('1') }),
      p(RT.masonry, { position_number: n('1.2'), work_name: 'Кладка стен', unit_code: 'м3', volume: n('50'), section_number: '2', commercial_total: n('900'), items_count: n('1') }),
      p(RT.masonryDup, { position_number: n('1.3'), work_name: 'Кладка стен', unit_code: 'м3', volume: n('5'), section_number: '2', commercial_total: n('90') }),
      p(RT.facade, { position_number: n('1.4'), work_name: 'Облицовка фасада', unit_code: 'м2', volume: n('100'), section_number: '3', commercial_total: n('700'), items_count: n('1') }),
    ],
    items: [
      i(RT.lamp, RT.lampLine, { boq_item_type: 'мат', description: 'Светильник светодиодный №2', unit_code: 'шт', quantity: n('10') }),
      i(RT.masonry, RT.masonryLine, { boq_item_type: 'раб', description: 'Кладка из керамического кирпича', unit_code: 'м3', quantity: n('50') }),
      i(RT.facade, RT.facadeLine, { boq_item_type: 'раб', description: 'Облицовка фасада клинкерным кирпичом', unit_code: 'м2', quantity: n('100') }),
    ],
  });
};

export const TXT = {
  lamp: 'Светильники в коридорах — светодиодные, тип №1.',
  masonry: 'Объём кладки стен — 55 м3.',
  pd: 'Марка бетона фундамента уточняется в РД.',
  facade: 'Облицовка фасада — клинкерный кирпич, 100 м2.',
  power: 'Временное электроснабжение площадки обеспечивает Генподрядчик.',
  letter: 'Согласовываем замену светильника тип №1 на светильник тип №2.',
  grey: 'Фасад выполняется в сером цвете.',
  white: 'Фасад выполняется в белом цвете.',
};

// Поддельная модель с той же идентичностью, что закрепляет сервер по testConfig (fake / fake-chat / test).
export const fakeModel = (script: FakeChatScript | null = null): FakeChat => new FakeChat({ model: 'fake-chat', revision: 'test', script });

export interface IStage09 {
  db: ITestDb;
  config: IAppConfig;
  s: IScenario;
  hub: IFakeTenderHub;
  worker: WorkerRuntime;
  boss: TestClient;
  tzRev: string;
  tzRun: string;
  contractRev: string;
  scopeId: string;
  registryId: string;
  calcRevisionId: string;
  frag: Record<'lamp' | 'masonry' | 'pd' | 'facade' | 'power' | 'letter' | 'grey' | 'white' | 'open', string>;
  mailRevisionId: string;
  qaOpenRevision: string;
  extra: { revisionId: string; runId: string }[];
}

const setDocType = async (st: { db: ITestDb; s: IScenario }, revisionId: string, docType: string): Promise<void> => {
  const documentId = (await st.db.pool.query<{ document_id: string }>('SELECT document_id FROM document_revision WHERE id = $1', [revisionId])).rows[0]!.document_id;
  const cur = await st.s.eng1.get(`/documents/${documentId}`);
  expect(cur.status, cur.text).toBe(200);
  const r = await st.s.eng1.patch(`/documents/${documentId}`, { docType }, { headers: { 'If-Match': cur.headers.etag as string } });
  expect(r.status, r.text).toBe(200);
};

export const buildStage09 = async (
  db: ITestDb,
  base: IAppConfig,
  o: { chat?: FakeChat | null; missingPage?: boolean; extraDocs?: { name: string; blocks: string[] }[] } = {},
): Promise<IStage09> => {
  const hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(RT.tender, reviewTender());
  const config = tenderHubConfig(base, hub);
  const app = makeApp(db, undefined, config);
  const s = await buildScenario(db, app);
  const worker = workerWithChat(db, config, o.chat === undefined ? fakeModel() : o.chat, 'test-worker-09');
  // Документы: ТЗ и договор (вид «договор» — источник договорных обязательств, A02).
  const tzRev = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ.pdf');
  const pages = [{ blocks: [TXT.lamp, TXT.masonry, TXT.pd, TXT.facade] }];
  const tzRun = await seedEvidenceRun(db.pool, tzRev, o.missingPage ? { pages, missingPages: 1 } : { pages });
  await setDocType({ db, s }, tzRev, 'tz');
  const contractRev = await uploadDocument(db, config, s.eng1, s.stageA, 'Проект договора.pdf');
  const contractRun = await seedEvidenceRun(db.pool, contractRev, { pages: [{ blocks: [TXT.power] }] });
  await setDocType({ db, s }, contractRev, 'contract');
  // Письмо заказчика о замене светильника (A01) — связано с этапом до фиксации снимка.
  const box = await createMailbox(s.admin, 'review@contractor.example.test', 'Ящик проверки');
  for (const id of [s.ids.eng1!, s.ids.manager!]) await setMailAccess(s.admin, box, id, ['mail.read', 'mail.import', 'mail.link']);
  const letter = await importEml(s.eng1, worker, box, eml({ messageId: 'lamp-09@example.test', subject: 'Замена светильника', text: TXT.letter }));
  await linkMail(s.eng1, letter.messageId!, s.tenderA, s.stageA);
  // Вопросы–ответы: два противоречащих ответа о цвете фасада (A04) и вопрос без ответа (молчание).
  const qa = await postManifest(
    s.eng1,
    s.tenderA,
    'qa',
    qaManifest([
      { no: '1', question: 'Какой цвет фасада?', answer: TXT.grey },
      { no: '2', question: 'Подтвердите цвет фасада.', answer: TXT.white },
      { no: '3', question: 'Каков срок поставки светильников?' },
    ]),
    { stageId: s.stageA },
  );
  expect(qa.status, qa.text).toBe(201);
  // Дополнительные документы тендера (например, договор и допсоглашение для конфликта фактов D-018).
  const extra: { revisionId: string; runId: string }[] = [];
  for (const d of o.extraDocs ?? []) {
    const revisionId = await uploadDocument(db, config, s.eng1, s.stageA, d.name);
    extra.push({ revisionId, runId: await seedEvidenceRun(db.pool, revisionId, { pages: [{ blocks: d.blocks }] }) });
  }
  await setWorkingSet(s.manager, s.stageA, [tzRev, contractRev, ...extra.map((x) => x.revisionId)], true);
  const scopeId = await fixScope(s.manager, s.stageA);
  const reg = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Реестр этапа 09' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  // Расчёт: администратор-руководитель связывает этап с поддельным TenderHub, инженер выгружает.
  const boss = await adminMember(db, s, app, s.tenderA);
  await linkSource(boss, s.stageA, RT.tender);
  const cap = await captureNow(db, worker, s.eng1, s.stageA);
  expect(cap.status).toBe('complete');
  // Факты D-018 по документам снимка (иначе конфликты фактов не проверены — I18).
  await worker.scheduleFactExtraction();
  await drain(worker);
  const one = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const mailRevisionId = letter.revisionId!;
  return {
    db,
    config,
    s,
    hub,
    worker,
    boss,
    tzRev,
    tzRun,
    contractRev,
    scopeId,
    registryId: reg.body.id as string,
    calcRevisionId: cap.revisionId as string,
    frag: {
      lamp: await fragmentIdOf(db.pool, tzRun, TXT.lamp),
      masonry: await fragmentIdOf(db.pool, tzRun, TXT.masonry),
      pd: await fragmentIdOf(db.pool, tzRun, TXT.pd),
      facade: await fragmentIdOf(db.pool, tzRun, TXT.facade),
      power: await fragmentIdOf(db.pool, contractRun, TXT.power),
      letter: await one("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [mailRevisionId]),
      grey: await one("SELECT id FROM evidence_fragment WHERE origin = 'qa_answer' AND text = $1", [TXT.grey]),
      white: await one("SELECT id FROM evidence_fragment WHERE origin = 'qa_answer' AND text = $1", [TXT.white]),
      open: await one("SELECT f.id FROM evidence_fragment f WHERE f.origin = 'qa_question' AND f.text = 'Каков срок поставки светильников?'", []),
    },
    mailRevisionId,
    extra,
    qaOpenRevision: await one("SELECT r.id FROM qa_item_revision r WHERE r.question = 'Каков срок поставки светильников?'", []),
  };
};

export const etagOf = async (client: TestClient, path: string): Promise<string> => {
  const r = await client.get(path);
  expect(r.status, r.text).toBe(200);
  return r.headers.etag as string;
};

// Требование: предложение инженера, подтверждение руководителем (при конфликте параметров — с пояснением, R08-01).
export const requirement = async (
  st: IStage09,
  statement: string,
  parameters: { name: string; value: string; unit?: string | null }[],
  fragmentIds: string[],
  conflictNote?: string,
): Promise<{ requirementId: string; revisionId: string; code: string }> => {
  const c = await st.s.eng1.post(
    `/requirement-registries/${st.registryId}/requirement-candidates`,
    { statement, parameters: parameters.map((p) => ({ unit: null, ...p })), evidence: fragmentIds.map((fragmentId) => ({ fragmentId, role: 'supports' })) },
    { headers: idem() },
  );
  expect(c.status, c.text).toBe(201);
  const r = await st.s.manager.post(`/requirement-candidates/${c.body.id}/confirm`, conflictNote ? { conflictNote } : {}, {
    headers: { 'If-Match': await etagOf(st.s.manager, `/requirement-candidates/${c.body.id}`), ...idem() },
  });
  expect(r.status, r.text).toBe(200);
  const code = (await st.db.pool.query<{ code: string }>('SELECT code FROM requirement WHERE id = $1', [r.body.requirementId])).rows[0]!.code;
  return { requirementId: r.body.requirementId as string, revisionId: r.body.revisionId as string, code };
};

export const cover = async (st: IStage09, revisionId: string, body: object) => {
  const r = await st.s.manager.post(`/requirement-revisions/${revisionId}/coverage`, body, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body;
};

export const line = (st: IStage09, positionId: string, itemId: string | null) =>
  itemId
    ? { type: 'calculation_revision', calculationRevisionId: st.calcRevisionId, externalPositionId: positionId, externalItemId: itemId, match: 'explicit_line' }
    : { type: 'calculation_revision', calculationRevisionId: st.calcRevisionId, externalPositionId: positionId, match: 'complex_rate' };

export interface IRunView {
  id: string;
  status: string;
  checks: { code: string; outcome: string | null; reason: string | null; counts: Record<string, number> }[];
  summary: { kind: string; text: string };
  freshness: { outdated: boolean; reasons: string[] };
  findings: { byStatus: Record<string, number>; unsettled: number };
  suggestions: { id: string; status: string; title: string }[];
  inputs: Record<string, unknown>;
}

export const startRun = async (st: IStage09, client: TestClient = st.s.eng1, stageId: string = st.s.stageA) => {
  const r = await client.post(`/stages/${stageId}/review-runs`, {}, { headers: idem() });
  expect([200, 201], r.text).toContain(r.status);
  return r.body as { id: string; status: string; reused: boolean };
};

export const runReview = async (st: IStage09, client: TestClient = st.s.eng1, stageId: string = st.s.stageA): Promise<IRunView> => {
  const r = await startRun(st, client, stageId);
  await drain(st.worker);
  const v = await client.get(`/review-runs/${r.id}`);
  expect(v.status, v.text).toBe(200);
  return v.body as IRunView;
};

export interface IFindingView {
  id: string;
  kind: string;
  status: string;
  severity: string;
  confidence: string;
  title: string;
  restricted: boolean;
  suggestedSide: string | null;
  etag: string;
  discrepancyId: string | null;
  requirements: string[];
}

export const findings = async (st: IStage09, client: TestClient = st.s.eng1, q = ''): Promise<IFindingView[]> => {
  const r = await client.get(`/stages/${st.s.stageA}/findings${q}`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as IFindingView[];
};

export const checkOf = (run: IRunView, code: string) => run.checks.find((c) => c.code === code)!;

export const closeHub = async (st: IStage09 | undefined): Promise<void> => {
  if (st) await st.hub.close();
};
