// Этап 06a: документы договора (T06A-2) — основной договор, допсоглашение, приложение; редакции,
// повторная и конкурентная загрузка, архив без удаления (OD-5), договор без распознавания и с
// распознаванием существующим конвейером импорта RDWeb (OD-4).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createContract,
  etagOf,
  grantCreator,
  linkContract,
  octet,
  setAccess,
  uploadContractDocument,
  uploadContractRevision,
  uploadMain,
} from './contractFixtures.ts';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildRdwebExport } from './rdweb.ts';
import { setWorkingSet } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
let c1: string;

const config = testConfig();

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  await grantCreator(s.admin, s.ids.manager);
  c1 = await createContract(s.manager, 'Д-10');
});
afterAll(async () => {
  await db.drop();
});

describe('документы договора (T06A-2)', () => {
  let main: { documentId: string; revisionId: string };

  it('основной договор, допсоглашение и приложение; приложение связано с основным договором', async () => {
    const early = await uploadContractDocument(s.manager, c1, 'дс-1.pdf', fakePdf('дс без основного'), { role: 'addendum' });
    expect(early.status).toBe(409);
    expect(early.body.current).toMatchObject({ reason: 'main_document_missing' });
    main = await uploadMain(s.manager, c1, 'договор подряда.pdf', fakePdf('основной договор, редакция 1'));
    const second = await uploadContractDocument(s.manager, c1, 'второй.pdf', fakePdf('второй основной'));
    expect(second.status).toBe(409);
    expect(second.body.current).toMatchObject({ reason: 'main_document_exists', documentId: main.documentId });
    const addendum = await uploadContractDocument(s.manager, c1, 'дс-1.pdf', fakePdf('дополнительное соглашение 1'), { role: 'addendum', mainDocumentId: main.documentId });
    expect(addendum.status, addendum.text).toBe(201);
    const appendix = await uploadContractDocument(s.manager, c1, 'смета.xlsx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)]), {
      role: 'appendix',
      mainDocumentId: main.documentId,
      title: 'Приложение 1. Смета',
    });
    expect(appendix.status, appendix.text).toBe(201);
    // Приложение к приложению не принимается: ссылка — только на основной документ договора.
    const wrong = await uploadContractDocument(s.manager, c1, 'прил-к-прил.pdf', fakePdf('не туда'), { role: 'appendix', mainDocumentId: appendix.body.documentId });
    expect(wrong.status).toBe(409);
    const list = await s.manager.get(`/contracts/${c1}/documents`);
    expect(list.body.items.map((d: { role: string; mainDocumentId: string | null; title: string }) => [d.role, d.mainDocumentId, d.title])).toEqual([
      ['contract', null, 'договор подряда.pdf'],
      ['addendum', main.documentId, 'дс-1.pdf'],
      ['appendix', main.documentId, 'Приложение 1. Смета'],
    ]);
    // Без распознавания договор существует и хранится (OD-4): прогона нет.
    expect(list.body.items[0].latestRevision).toMatchObject({ seq: 1, runStatus: null, mediaType: 'application/pdf' });
    const owners = await db.pool.query('SELECT tender_id, contract_id FROM document WHERE contract_id = $1', [c1]);
    expect(owners.rows.every((r) => r.tender_id === null && r.contract_id === c1)).toBe(true);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM document_occurrence o JOIN document_revision r ON r.id = o.document_revision_id WHERE r.contract_id = $1', [c1])).rows[0].n).toBe(0);
  });

  it('повтор того же файла — та же редакция; то же имя с другим содержимым — новая редакция', async () => {
    const same = await uploadContractDocument(s.manager, c1, 'копия.pdf', fakePdf('основной договор, редакция 1'), { role: 'appendix', mainDocumentId: main.documentId });
    expect(same.status, same.text).toBe(200);
    expect(same.body).toMatchObject({ status: 'duplicate', documentId: main.documentId, revisionId: main.revisionId });
    const v2 = await uploadContractRevision(s.manager, main.documentId, 'договор подряда.pdf', fakePdf('основной договор, редакция 2'));
    expect(v2.status, v2.text).toBe(201);
    expect(v2.body).toMatchObject({ status: 'registered', documentId: main.documentId, revisionSeq: 2 });
    const doc = await s.manager.get(`/contract-documents/${main.documentId}`);
    expect(doc.body.revisionList.map((r: { seq: number; id: string }) => r.seq)).toEqual([2, 1]);
    expect(doc.body.revisionList[1].id).toBe(main.revisionId);
    const supersedes = await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [v2.body.revisionId]);
    expect(supersedes.rows[0].supersedes_revision_id).toBe(main.revisionId);
    // То же содержимое другим документом договора — отказ: одно содержимое в договоре — одна редакция.
    const addendumId = (await s.manager.get(`/contracts/${c1}/documents`)).body.items[1].id as string;
    const clash = await uploadContractRevision(s.manager, addendumId, 'дс-1.pdf', fakePdf('основной договор, редакция 2'));
    expect(clash.status).toBe(409);
    expect(clash.body.current).toMatchObject({ reason: 'content_in_other_document', documentId: main.documentId });
    // Имя — не идентичность: другой документ с тем же именем и другим содержимым.
    const namesake = await uploadContractDocument(s.manager, c1, 'договор подряда.pdf', fakePdf('другое содержимое'), { role: 'appendix', mainDocumentId: main.documentId });
    expect(namesake.status, namesake.text).toBe(201);
    expect(namesake.body.documentId).not.toBe(main.documentId);
  });

  it('конкурентная загрузка одного файла даёт одну редакцию', async () => {
    const body = fakePdf('конкурентная загрузка');
    const [a, b] = await Promise.all([
      uploadContractDocument(s.manager, c1, 'прил-2.pdf', body, { role: 'appendix', mainDocumentId: main.documentId }),
      uploadContractDocument(s.manager, c1, 'прил-2.pdf', body, { role: 'appendix', mainDocumentId: main.documentId }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.revisionId).toBe(b.body.revisionId);
    const n = await db.pool.query(
      "SELECT count(*)::int AS n FROM document_revision r JOIN blob b ON b.sha256 = r.blob_sha256 WHERE r.contract_id = $1 AND b.sha256 = encode(sha256($2::bytea), 'hex')",
      [c1, body],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('загрузка требует чтения и ведения; архив и тип файла проверяются', async () => {
    await setAccess(s.admin, c1, s.ids.eng1, ['contract.read']);
    const noManage = await uploadContractDocument(s.eng1, c1, 'прил-3.pdf', fakePdf('без ведения'), { role: 'appendix', mainDocumentId: main.documentId });
    expect(noManage.status).toBe(403);
    const zip = await uploadContractDocument(s.manager, c1, 'пакет.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]), { role: 'appendix', mainDocumentId: main.documentId });
    expect(zip.status).toBe(400);
    const renamed = await s.manager.patch(`/contract-documents/${main.documentId}`, { title: 'Договор подряда № 10' }, { headers: { 'If-Match': await etagOf(s.manager, `/contract-documents/${main.documentId}`) } });
    expect(renamed.status, renamed.text).toBe(200);
    const dl = await s.manager.get(`/document-revisions/${main.revisionId}/content`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-disposition'])).toContain(encodeURIComponent('Договор подряда № 10.pdf'));
  });

  it('архив договора без физического удаления: документы, редакции и выдачи остаются', async () => {
    const before = await db.pool.query('SELECT count(*)::int AS n FROM document_revision WHERE contract_id = $1', [c1]);
    const arch = await s.manager.post(`/contracts/${c1}/archive`, {}, { headers: { 'If-Match': await etagOf(s.manager, `/contracts/${c1}`) } });
    expect(arch.status, arch.text).toBe(200);
    expect(arch.body).toMatchObject({ status: 'archived' });
    expect((await s.manager.get(`/contracts/${c1}/documents`)).body.items.length).toBeGreaterThan(0);
    const late = await uploadContractDocument(s.manager, c1, 'поздний.pdf', fakePdf('после архива'), { role: 'appendix', mainDocumentId: main.documentId });
    expect(late.status).toBe(409);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM document_revision WHERE contract_id = $1', [c1])).rows[0].n).toBe(before.rows[0].n);
    await expect(db.pool.query('DELETE FROM contract WHERE id = $1', [c1])).rejects.toMatchObject({ code: '42501' });
    const back = await s.manager.post(`/contracts/${c1}/restore`, {}, { headers: { 'If-Match': arch.headers.etag as string } });
    expect(back.status, back.text).toBe(200);
    const actions = (await auditRows(db.pool, "action IN ('contract.archive', 'contract.restore') AND entity_id = $1", [c1])).map((e) => e.action);
    expect(actions).toEqual(['contract.archive', 'contract.restore']);
  });
});

describe('распознавание договора существующим конвейером (OD-4)', () => {
  it('импорт экспорта RDWeb по редакции договора: прогон и фрагменты принадлежат договору, этап — только включивший', async () => {
    const worker = makeWorker(db, config);
    const fx = buildRdwebExport({ docName: 'Договор-фикстура', pages: 2 });
    const c = await createContract(s.manager, 'Д-11');
    await setAccess(s.admin, c, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    const up = await uploadContractDocument(s.manager, c, 'Договор-фикстура.pdf', fx.pdf);
    expect(up.status, up.text).toBe(201);
    const revisionId = up.body.revisionId as string;
    await linkContract(s.manager, c, s.tenderA);
    await setWorkingSet(s.manager, s.stageA, [revisionId]);
    const eventsA = async () => (await s.manager.get(`/stages/${s.stageA}/input-events`)).body.items.map((e: { eventType: string }) => e.eventType);
    const eventsB = async () => (await s.manager.get(`/stages/${s.stageB}/input-events`)).body.items.map((e: { eventType: string }) => e.eventType);
    const beforeB = await eventsB();
    // Без contract.manage импорт по редакции договора не принимается.
    await setAccess(s.admin, c, s.ids.eng1, ['contract.read']);
    const denied = await s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, fx.zip, { headers: { ...octet, ...idem() } });
    expect(denied.status).toBe(403);
    const accepted = await s.manager.post(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, fx.zip, { headers: { ...octet, ...idem() } });
    expect(accepted.status, accepted.text).toBe(202);
    await drain(worker);
    const run = await s.manager.get(`/recognition-runs/${accepted.body.id}`);
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('complete');
    const owner = await db.pool.query('SELECT tender_id, contract_id FROM recognition_run WHERE id = $1', [accepted.body.id]);
    expect(owner.rows[0]).toEqual({ tender_id: null, contract_id: c });
    const frag = await db.pool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE contract_id = $2 AND tender_id IS NULL)::int AS own FROM evidence_fragment WHERE run_id = $1', [
      accepted.body.id,
      c,
    ]);
    expect(frag.rows[0].n).toBeGreaterThan(0);
    expect(frag.rows[0].own).toBe(frag.rows[0].n);
    expect(await eventsA()).toContain('recognition_run_completed');
    expect(await eventsB()).toEqual(beforeB);
    // Чтение прогона, фрагментов и цитаты — только с contract.read.
    const fragmentId = (await db.pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE run_id = $1 LIMIT 1', [accepted.body.id])).rows[0]!.id;
    expect((await s.eng2.get(`/recognition-runs/${accepted.body.id}`)).status).toBe(404);
    expect((await s.eng2.get(`/recognition-runs/${accepted.body.id}/fragments`)).status).toBe(404);
    expect((await s.eng2.get(`/evidence/${fragmentId}`)).status).toBe(404);
    expect((await s.admin.get(`/evidence/${fragmentId}`)).status).toBe(404);
    expect((await s.eng1.get(`/evidence/${fragmentId}`)).status).toBe(200);
  });
});
