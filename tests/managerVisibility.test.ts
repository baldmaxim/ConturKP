import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessFingerprint, loadAccessContext } from '../packages/db/src/index.ts';
import { tenderCapabilities } from '../packages/core/src/index.ts';
import { buildScenario, createTestDb, createUser, idem, makeApp, makeWorker, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { createContract, grantCreator, uploadMain } from './contractFixtures.ts';
import { createMailbox, eml, importEml, setMailAccess } from './mailFixtures.ts';
import { buildIndex, fragmentIdOf, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let reader: TestClient;
let readerId: string;
let contract: string;
let contractDocument: string;
let contractRevision: string;
let tenderRevision: string;
let tenderFragment: string;
let contractFragment: string;
let mailbox: string;
let message: string;
let mailRevision: string;
let attachment: string;
let savedSearch: string;
const config = testConfig();
const MARKER = 'Фасад облицовывается гранитными плитами';

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  readerId = await createUser(db.pool, 'all-reader', ['manager']);
  reader = new TestClient(app);
  expect((await reader.login('all-reader')).status).toBe(200);
  await grantCreator(s.admin, s.ids.eng1);
  contract = await createContract(s.eng1, 'VIS-1');
  const main = await uploadMain(s.eng1, contract);
  contractDocument = main.documentId;
  contractRevision = main.revisionId;
  const contractRun = await seedEvidenceRun(db.pool, contractRevision, { pages: [{ blocks: [MARKER] }] });
  contractFragment = await fragmentIdOf(db.pool, contractRun, MARKER);
  tenderRevision = await uploadDocument(db, config, s.eng1, s.stageA, 'visibility.pdf');
  const tenderRun = await seedEvidenceRun(db.pool, tenderRevision, { pages: [{ blocks: [MARKER] }] });
  tenderFragment = await fragmentIdOf(db.pool, tenderRun, MARKER);
  await setWorkingSet(s.eng1, s.stageA, [tenderRevision]);
  mailbox = await createMailbox(s.admin, 'visibility@example.test');
  await setMailAccess(s.admin, mailbox, s.ids.eng1, ['mail.read', 'mail.import']);
  const worker = makeWorker(db, config);
  const imported = await importEml(s.eng1, worker, mailbox, eml({ text: MARKER, attachments: [{ name: 'test.txt', type: 'text/plain', bytes: Buffer.from(MARKER) }] }));
  expect(imported.status).toBe('done');
  message = imported.messageId!;
  mailRevision = imported.revisionId!;
  attachment = (await db.pool.query<{ id: string }>('SELECT id FROM mail_attachment WHERE revision_id = $1', [mailRevision])).rows[0]!.id;
  await buildIndex(db, worker);
}, 180_000);
afterAll(async () => { await db?.drop(); });

const itemIds = (body: { items: { id: string }[] }): string[] => body.items.map((item) => item.id);

describe('автоматический просмотр руководителя без назначений и выдач', () => {
  it('открывает все рабочие разделы и сохраняет реальные пустые назначения', async () => {
    const me = await reader.get('/me');
    expect(me.body).toMatchObject({ roles: ['manager'], memberships: [], contractsAvailable: true, mailAvailable: true });
    expect(me.body.capabilities).toEqual(['admin.templates', 'wording.approve', 'office.read', 'templates.read', 'tender.read.all', 'contract.read.all', 'mail.read.all', 'history.read', 'history.write']);
    const rows = await db.pool.query<{ n: number }>(
      'SELECT ((SELECT count(*) FROM tender_member WHERE user_id = $1) + (SELECT count(*) FROM contract_access WHERE user_id = $1) + (SELECT count(*) FROM mail_access WHERE user_id = $1))::int AS n', [readerId]);
    expect(rows.rows[0]!.n).toBe(0);
    expect(itemIds((await reader.get('/tenders')).body)).toEqual(expect.arrayContaining([s.tenderA, s.tenderB]));
    expect(itemIds((await reader.get('/contracts')).body)).toContain(contract);
    expect(itemIds((await reader.get('/mailboxes')).body)).toContain(mailbox);
    for (const path of [
      '/admin/office', '/tenders/' + s.tenderA, '/tenders/' + s.tenderB + '/stages', '/tenders/' + s.tenderA + '/members',
      '/tenders/' + s.tenderA + '/audit-events', '/stages/' + s.stageA, '/contracts/' + contract,
      '/contracts/' + contract + '/documents', '/contract-documents/' + contractDocument,
      '/document-revisions/' + contractRevision + '/content', '/document-revisions/' + tenderRevision + '/content',
      '/mailboxes/' + mailbox + '/messages', '/mail-messages/' + message, '/mail-message-revisions/' + mailRevision,
      '/mail-attachments/' + attachment + '/content', '/evidence/' + tenderFragment, '/evidence/' + contractFragment,
    ]) {
      const r = await reader.get(path);
      expect(r.status, path + ': ' + r.text).toBe(200);
    }
    expect((await reader.get('/contracts/' + contract)).body.capabilities).toEqual(['contract.read']);
    expect((await reader.get('/mailboxes/' + mailbox)).body.capabilities).toEqual(['mail.read']);
  });

  it('поиск и SQL-проверки видят ту же область, права изменения не добавлены', async () => {
    for (const body of [searchBody(s.tenderA, s.stageA, 'гранитными'), { context: { kind: 'contract', contractId: contract }, query: 'гранитными' }]) {
      const r = await reader.post('/search', body, { headers: idem() });
      expect(r.status, r.text).toBe(200);
      expect(JSON.stringify(r.body.fused ?? r.body.lexical)).toContain(MARKER);
      savedSearch = r.body.searchRunId;
    }
    const caps = (await db.pool.query<{ caps: string[] }>('SELECT tender_capabilities($1, $2) AS caps', [readerId, s.tenderA])).rows[0]!.caps;
    expect(caps).toEqual(tenderCapabilities(new Set(['manager']), null));
    expect(caps).toEqual(['tender.read', 'requirement.read', 'fact.read', 'audit.read']);
    expect((await db.pool.query<{ ok: boolean }>('SELECT contract_readable_by($1, $2) AS ok', [readerId, contract])).rows[0]!.ok).toBe(true);
    const dialog = await reader.post('/dialogs', { context: { kind: 'contract', contractId: contract }, title: 'Просмотр договора' }, { headers: idem() });
    expect(dialog.status, dialog.text).toBe(201);
  });

  it('администрирование, изменение данных и согласование остаются закрытыми без своих прав', async () => {
    for (const path of ['/admin/users', '/admin/audit-events', '/admin/operations', '/admin/roles', '/contracts/' + contract + '/access', '/mailboxes/' + mailbox + '/access']) {
      const r = await reader.get(path);
      expect(r.status, path).toBe(403);
    }
    const tender = await reader.get('/tenders/' + s.tenderA);
    expect((await reader.post('/tenders/' + s.tenderA + '/stages', { title: 'Запрещено' }, { headers: idem() })).status).toBe(403);
    expect((await reader.put('/tenders/' + s.tenderA + '/members/' + readerId, { memberRole: 'manager' }, { headers: { 'If-Match': tender.headers.etag } })).status).toBe(403);
    expect((await reader.patch('/stages/' + s.stageA, { title: 'Запрещено' }, { headers: { 'If-Match': '"' + s.stageA + ':1"' } })).status).toBe(403);
    expect((await reader.post('/contracts', { number: 'DENIED', title: 'Запрещено' }, { headers: idem() })).status).toBe(403);
    expect((await reader.post('/mailboxes', { system: 'manual', externalAccountId: 'denied@example.test', displayName: 'Запрещено' }, { headers: idem() })).status).toBe(403);
    expect((await reader.patch('/contracts/' + contract, { title: 'Запрещено' }, { headers: { 'If-Match': '"' + contract + ':1"' } })).status).toBe(403);
    expect((await reader.post('/stages/' + s.stageA + '/review-runs', {}, { headers: idem() })).status).toBe(403);
  });

  it('новые объекты доступны в той же сессии и не меняют отпечаток ролевых прав', async () => {
    const before = accessFingerprint((await loadAccessContext(db.pool, readerId, 'before'))!);
    const t = await s.admin.post('/tenders', { code: 'VIS-NEW', title: 'Новый тендер' }, { headers: idem() });
    expect(t.status, t.text).toBe(201);
    const c = await createContract(s.eng1, 'VIS-NEW');
    const m = await createMailbox(s.admin, 'visibility-new@example.test');
    expect((await reader.get('/tenders/' + t.body.id)).status).toBe(200);
    expect((await reader.get('/contracts/' + c)).status).toBe(200);
    expect((await reader.get('/mailboxes/' + m)).status).toBe(200);
    expect(accessFingerprint((await loadAccessContext(db.pool, readerId, 'after'))!)).toBe(before);
  });

  it('снятие роли сразу закрывает весь автоматический просмотр без перевхода', async () => {
    const users = await s.admin.get('/admin/users');
    const user = users.body.items.find((u: { id: string }) => u.id === readerId);
    const update = await s.admin.patch('/admin/users/' + readerId, { roles: ['engineer'] }, { headers: { 'If-Match': '"' + readerId + ':' + user.rowVersion + '"' } });
    expect(update.status, update.text).toBe(200);
    try {
      const me = await reader.get('/me');
      expect(me.body).toMatchObject({ roles: ['engineer'], contractsAvailable: false, mailAvailable: false });
      expect(itemIds((await reader.get('/tenders')).body)).toEqual([]);
      for (const path of ['/tenders/' + s.tenderA, '/stages/' + s.stageA, '/contracts/' + contract,
        '/contract-documents/' + contractDocument, '/mail-messages/' + message, '/evidence/' + tenderFragment, '/evidence/' + contractFragment,
        '/document-revisions/' + contractRevision + '/content', '/mail-attachments/' + attachment + '/content']) {
        expect((await reader.get(path)).status, path).toBe(404);
      }
      expect((await reader.get('/search-runs/' + savedSearch)).status).toBe(404);
      expect((await db.pool.query<{ ok: boolean }>('SELECT contract_readable_by($1, $2) AS ok', [readerId, contract])).rows[0]!.ok).toBe(false);
    } finally {
      const back = await s.admin.patch('/admin/users/' + readerId, { roles: ['manager'] }, { headers: { 'If-Match': update.headers.etag } });
      expect(back.status, back.text).toBe(200);
    }
    expect((await reader.get('/stages/' + s.stageA)).status).toBe(200);
  });

  it('изоляция инженера и администратора без содержательной роли сохраняется', async () => {
    expect((await s.eng3.get('/tenders/' + s.tenderA)).status).toBe(404);
    expect((await s.eng3.get('/contracts/' + contract)).status).toBe(404);
    expect((await s.eng3.get('/mail-messages/' + message)).status).toBe(404);
    expect((await s.admin.get('/stages/' + s.stageA)).status).toBe(404);
    expect((await s.admin.get('/document-revisions/' + contractRevision + '/content')).status).toBe(404);
    expect((await s.admin.get('/mail-messages/' + message)).status).toBe(404);
  });
});
