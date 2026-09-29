// Этап 06a: права договора (D-022 OD-2, fail-closed) и связь договора с тендером (OD-1, многие ко многим).
// Невидимый договор — 404, видимый без нужной возможности — 403; администратор договоров видит только
// административные метаданные; выдача действует при роли инженера или руководителя.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSearch, createContract, etagOf, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { auditRows, buildScenario, createTestDb, createUser, idem, makeApp, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let app: ReturnType<typeof makeApp>;
let c1: string;
let main1: { documentId: string; revisionId: string };

const config = testConfig();

beforeAll(async () => {
  db = await createTestDb();
  app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  await grantCreator(s.admin, s.ids.manager);
  c1 = await createContract(s.manager, 'Д-1', { counterparty: 'ООО «Заказчик»', signedOn: '2026-09-01' });
  main1 = await uploadMain(s.manager, c1);
});
afterAll(async () => {
  await db.drop();
});

describe('права договора (D-022 OD-2)', () => {
  it('contract.create — только явной выдачей; создатель получает чтение и ведение, но не связь', async () => {
    expect((await s.eng1.post('/contracts', { number: 'X-1', title: 'Без права' }, { headers: idem() })).status).toBe(403);
    expect((await s.admin.post('/contracts', { number: 'X-2', title: 'Администратор' }, { headers: idem() })).status).toBe(403);
    // Администратору без роли инженера или руководителя выдача не даётся: она бы не действовала.
    expect((await s.admin.put(`/admin/contract-creators/${s.ids.admin}`, {})).status).toBe(409);
    await grantCreator(s.admin, s.ids.eng1);
    const r = await s.eng1.post('/contracts', { number: 'X-3', title: 'Договор инженера' }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ restricted: false, capabilities: ['contract.read', 'contract.manage'] });
    const rows = await db.pool.query("SELECT capability, source FROM contract_access WHERE contract_id = $1 AND revoked_at IS NULL ORDER BY capability", [r.body.id]);
    expect(rows.rows).toEqual([
      { capability: 'contract.manage', source: 'creator' },
      { capability: 'contract.read', source: 'creator' },
    ]);
    const revoke = await s.admin.delete(`/admin/contract-creators/${s.ids.eng1}`);
    expect(revoke.status).toBe(200);
    expect((await s.eng1.post('/contracts', { number: 'X-4', title: 'После отзыва' }, { headers: idem() })).status).toBe(403);
  });

  it('пользователь без выдачи не видит договор ни списком, ни по ID, ни документами, ни поиском', async () => {
    const list = await s.eng2.get('/contracts');
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(c1);
    expect((await s.eng2.get(`/contracts/${c1}`)).status).toBe(404);
    expect((await s.eng2.get(`/contracts/${c1}/documents`)).status).toBe(404);
    expect((await s.eng2.get(`/contract-documents/${main1.documentId}`)).status).toBe(404);
    expect((await s.eng2.get(`/document-revisions/${main1.revisionId}/content`)).status).toBe(404);
    expect((await contractSearch(s.eng2, c1, 'договор')).status).toBe(404);
    const denied = await auditRows(db.pool, "action = 'contract.read' AND outcome = 'denied' AND entity_id = $1", [c1]);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('администратор договоров без contract.read видит только административные метаданные', async () => {
    const list = await s.admin.get('/contracts');
    const card = list.body.items.find((c: { id: string }) => c.id === c1);
    expect(card).toMatchObject({ number: 'Д-1', restricted: true, counterparty: null, signedOn: null, capabilities: [] });
    const one = await s.admin.get(`/contracts/${c1}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ restricted: true, counterparty: null });
    expect((await s.admin.get(`/contracts/${c1}/documents`)).status).toBe(403);
    expect((await s.admin.get(`/contract-documents/${main1.documentId}`)).status).toBe(404);
    expect((await s.admin.get(`/document-revisions/${main1.revisionId}/content`)).status).toBe(404);
    expect((await contractSearch(s.admin, c1, 'договор')).status).toBe(403);
    // Себе администратор без роли инженера или руководителя чтение не выдаст: строка бы не действовала.
    const self = await s.admin.put(`/contracts/${c1}/access/${s.ids.admin}`, { capabilities: ['contract.read'] }, { headers: { 'If-Match': await etagOf(s.admin, `/contracts/${c1}`) } });
    expect(self.status).toBe(409);
  });

  it('создатель видит карточку целиком; выдача contract.read открывает содержимое, отзыв действует сразу', async () => {
    const own = await s.manager.get(`/contracts/${c1}`);
    expect(own.body).toMatchObject({ restricted: false, counterparty: 'ООО «Заказчик»', signedOn: '2026-09-01' });
    await setAccess(s.admin, c1, s.ids.eng2, ['contract.read']);
    expect((await s.eng2.get(`/contracts/${c1}`)).body).toMatchObject({ restricted: false, capabilities: ['contract.read'] });
    expect((await s.eng2.get(`/contracts/${c1}/documents`)).status).toBe(200);
    expect((await s.eng2.get(`/document-revisions/${main1.revisionId}/content`)).status).toBe(200);
    await setAccess(s.admin, c1, s.ids.eng2, []);
    expect((await s.eng2.get(`/contracts/${c1}`)).status).toBe(404);
    expect((await s.eng2.get(`/document-revisions/${main1.revisionId}/content`)).status).toBe(404);
    const events = await auditRows(db.pool, "action IN ('contract.access.grant', 'contract.access.revoke') AND entity_id = $1", [s.ids.eng2]);
    expect(events.map((e) => [e.action, e.details.capability])).toEqual([
      ['contract.access.grant', 'contract.read'],
      ['contract.access.revoke', 'contract.read'],
    ]);
  });

  it('без contract.read карточка — только метаданные, а содержательные поля не меняются', async () => {
    await setAccess(s.admin, c1, s.ids.eng2, ['contract.manage']);
    const card = await s.eng2.get(`/contracts/${c1}`);
    expect(card.body).toMatchObject({ restricted: true, counterparty: null, capabilities: ['contract.manage'] });
    expect((await s.eng2.get(`/contracts/${c1}/documents`)).status).toBe(403);
    const etag = card.headers.etag as string;
    expect((await s.eng2.patch(`/contracts/${c1}`, { counterparty: 'Другой' }, { headers: { 'If-Match': etag } })).status).toBe(403);
    const renamed = await s.eng2.patch(`/contracts/${c1}`, { title: 'Договор подряда Д-1' }, { headers: { 'If-Match': etag } });
    expect(renamed.status, renamed.text).toBe(200);
    await setAccess(s.admin, c1, s.ids.eng2, []);
  });

  it('выдача действует, пока у пользователя есть роль инженера или руководителя', async () => {
    const lawyerId = await createUser(db.pool, 'lawyer', ['engineer'], 'Юрист');
    const lawyer = new TestClient(app);
    expect((await lawyer.login('lawyer')).status).toBe(200);
    await setAccess(s.admin, c1, lawyerId, ['contract.read']);
    expect((await lawyer.get(`/contracts/${c1}`)).status).toBe(200);
    const u = (await s.admin.get('/admin/users')).body.items.find((x: { id: string }) => x.id === lawyerId);
    const off = await s.admin.patch(`/admin/users/${lawyerId}`, { roles: [] }, { headers: { 'If-Match': `"${lawyerId}:${u.rowVersion}"` } });
    expect(off.status, off.text).toBe(200);
    expect((await lawyer.get(`/contracts/${c1}`)).status).toBe(404);
    expect((await lawyer.get('/me')).body).toMatchObject({ contractsAvailable: false });
  });
});

describe('связь договора с тендером (D-022 OD-1)', () => {
  let c2: string;

  beforeAll(async () => {
    await setAccess(s.admin, c1, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    c2 = await createContract(s.manager, 'Д-2');
    await setAccess(s.admin, c2, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  });

  it('один договор ↔ два тендера и два договора ↔ один тендер', async () => {
    const a = await s.manager.post(`/contracts/${c1}/tenders`, { tenderId: s.tenderA, note: 'основной подряд' }, { headers: idem() });
    expect(a.status, a.text).toBe(201);
    expect(a.body).toMatchObject({ contractId: c1, tenderId: s.tenderA, status: 'active', note: 'основной подряд' });
    await linkContract(s.manager, c1, s.tenderB);
    await linkContract(s.manager, c2, s.tenderA);
    const ofContract = await s.manager.get(`/contracts/${c1}/tenders`);
    expect(ofContract.body.items.map((l: { tenderId: string }) => l.tenderId).sort()).toEqual([s.tenderA, s.tenderB].sort());
    const ofTender = await s.manager.get(`/tenders/${s.tenderA}/contracts`);
    expect(ofTender.body.items.map((l: { contractId: string }) => l.contractId).sort()).toEqual([c1, c2].sort());
    const rows = await db.pool.query('SELECT count(*)::int AS n FROM contract_tender');
    expect(rows.rows[0].n).toBe(3);
  });

  it('без связи договор тендеру не показывается; участник без выдачи связи не видит', async () => {
    const c3 = await createContract(s.manager, 'Д-3');
    const ofTender = await s.manager.get(`/tenders/${s.tenderB}/contracts`);
    expect(ofTender.body.items.map((l: { contractId: string }) => l.contractId)).not.toContain(c3);
    const eng2 = await s.eng2.get(`/tenders/${s.tenderA}/contracts`);
    expect(eng2.status).toBe(200);
    expect(eng2.body.items).toEqual([]);
    const candidates = await s.eng2.get(`/stages/${s.stageA}/contract-candidates`);
    expect(candidates.body.items).toEqual([]);
  });

  it('связь подтверждает только пользователь с contract.link по договору и source.write по тендеру', async () => {
    const c4 = await createContract(s.manager, 'Д-4');
    await setAccess(s.admin, c4, s.ids.eng1, ['contract.read']);
    expect((await s.eng1.post(`/contracts/${c4}/tenders`, { tenderId: s.tenderA }, { headers: idem() })).status).toBe(403);
    await setAccess(s.admin, c4, s.ids.eng3, ['contract.link']);
    // Инженер 3 — не участник тендера A: тендер для него не существует.
    expect((await s.eng3.post(`/contracts/${c4}/tenders`, { tenderId: s.tenderA }, { headers: idem() })).status).toBe(404);
    const ok = await s.eng3.post(`/contracts/${c4}/tenders`, { tenderId: s.tenderB }, { headers: idem() });
    expect(ok.status, ok.text).toBe(201);
    // Только связь: содержимое договора этой возможностью не открывается.
    expect((await s.eng3.get(`/contracts/${c4}/documents`)).status).toBe(403);
    expect((await s.eng3.get(`/contracts/${c4}`)).body).toMatchObject({ restricted: true });
  });

  it('повтор, изменение, архив и возврат связи — с аудитом; удаления нет', async () => {
    const dup = await s.manager.post(`/contracts/${c1}/tenders`, { tenderId: s.tenderA }, { headers: idem() });
    expect(dup.status).toBe(409);
    const link = (await s.manager.get(`/contracts/${c1}/tenders`)).body.items.find((l: { tenderId: string }) => l.tenderId === s.tenderA);
    const etag = `"${link.id}:${link.rowVersion}"`;
    const foreignStage = await s.manager.patch(`/contract-tender-links/${link.id}`, { stageId: s.stageB }, { headers: { 'If-Match': etag } });
    expect(foreignStage.status).toBe(404);
    const upd = await s.manager.patch(`/contract-tender-links/${link.id}`, { stageId: s.stageA, note: 'этап A1' }, { headers: { 'If-Match': etag } });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.body).toMatchObject({ stageId: s.stageA, note: 'этап A1' });
    const arch = await s.manager.post(`/contract-tender-links/${link.id}/archive`, { reason: 'ошибочная связь' }, { headers: { 'If-Match': upd.headers.etag as string } });
    expect(arch.status, arch.text).toBe(200);
    expect(arch.body).toMatchObject({ status: 'archived', archiveReason: 'ошибочная связь' });
    expect((await s.manager.post(`/contract-tender-links/${link.id}/archive`, { reason: 'ещё раз' }, { headers: { 'If-Match': arch.headers.etag as string } })).status).toBe(409);
    const back = await s.manager.post(`/contracts/${c1}/tenders`, { tenderId: s.tenderA }, { headers: idem() });
    expect(back.status, back.text).toBe(200);
    expect(back.body).toMatchObject({ id: link.id, status: 'active', archiveReason: null });
    const actions = (await auditRows(db.pool, "entity_type = 'contract_tender' AND entity_id = $1 AND outcome = 'allowed'", [link.id])).map((e) => e.action);
    expect(actions).toEqual(['contract.tender.link', 'contract.tender.update', 'contract.tender.archive', 'contract.tender.restore']);
    await expect(db.pool.query('DELETE FROM contract_tender WHERE id = $1', [link.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('журналы: связь не попадает в журнал тендера, события договора — без содержательных полей', async () => {
    // Журнал тендера видит руководитель тендера, в том числе без выдачи по договору.
    const tenderLog = await s.manager.get(`/tenders/${s.tenderA}/audit-events?limit=200`);
    expect(tenderLog.status).toBe(200);
    expect(tenderLog.body.items.filter((e: { action: string }) => e.action.startsWith('contract.'))).toEqual([]);
    expect(JSON.stringify(tenderLog.body)).not.toContain(c1);
    const links = await auditRows(db.pool, "action = 'contract.tender.link' AND details->>'contractId' = $1", [c1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((e) => e.tender_id === null && typeof e.details.tenderId === 'string')).toBe(true);
    // Контрагент меняет только читатель договора, а в журнал попадает лишь признак изменения.
    const card = await s.manager.get(`/contracts/${c1}`);
    const upd = await s.manager.patch(`/contracts/${c1}`, { counterparty: 'ООО «Новый заказчик»' }, { headers: { 'If-Match': card.headers.etag as string } });
    expect(upd.status, upd.text).toBe(200);
    const last = (await auditRows(db.pool, "action = 'contract.update' AND entity_id = $1", [c1])).at(-1)!;
    expect(last.details).toMatchObject({ changes: { counterparty: { changed: true } } });
    expect(JSON.stringify(last.details)).not.toContain('Новый заказчик');
    const uploads = await auditRows(db.pool, "action = 'contract.document.upload' AND details->>'contractId' = $1", [c1]);
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((e) => !('fileName' in e.details) && !JSON.stringify(e.details).includes('договор.pdf'))).toBe(true);
  });

  it('архивный договор с тендером не связывается', async () => {
    const c5 = await createContract(s.manager, 'Д-5');
    await setAccess(s.admin, c5, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    const arch = await s.manager.post(`/contracts/${c5}/archive`, {}, { headers: { 'If-Match': await etagOf(s.manager, `/contracts/${c5}`) } });
    expect(arch.status, arch.text).toBe(200);
    expect((await s.manager.post(`/contracts/${c5}/tenders`, { tenderId: s.tenderA }, { headers: idem() })).status).toBe(409);
  });
});
