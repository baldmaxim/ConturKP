// Этап 07: 22 обязательных теста безопасности почтового контура (D-025, «Mandatory security tests»).
// Номер теста совпадает с номером в решении владельца. Письма и вложения синтетические.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, recoverExpiredJobs } from '../packages/db/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import {
  buildMailScope,
  eml,
  importEml,
  linkMail,
  MARK,
  postEml,
  postManifest,
  qaManifest,
  setMailAccess,
  type IMailScope,
} from './mailFixtures.ts';
import { buildIndex, fixScope, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let m: IMailScope;
const config = testConfig();

const texts = (body: { fused: { items: { text: string }[] } | null; lexical: { items: { text: string }[] } | null }): string[] =>
  (body.fused?.items ?? body.lexical?.items ?? []).map((i) => i.text);
const search = async (client: TestClient, body: object) => {
  const r = await client.post('/search', body, { headers: idem() });
  expect(r.status, r.text).toBe(200);
  return r.body;
};
const ids = (r: { body: { items: { id: string }[] } }): string[] => r.body.items.map((x) => x.id);

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
  m = await buildMailScope(
    s,
    worker,
    () => uploadDocument(db, config, s.eng1, s.stageA, 'тз-А.pdf'),
    (rev, text) => seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] }),
  );
  await setWorkingSet(s.eng1, s.stageA, [m.tenderDoc]);
  await buildIndex(db, worker);
});
afterAll(async () => {
  await db.drop();
});

describe('видимость письма: ящик × тендер × связь', () => {
  let unlinked: string;

  beforeAll(async () => {
    unlinked = (await importEml(s.eng1, worker, m.boxA, eml({ messageId: 'free@example.test', subject: 'Без связи', text: 'Письмо без связи с тендером' }))).messageId!;
  });

  it('1. письмо без связи и без mail.read — невидимо: ни письма, ни ящика, ни списка тендера', async () => {
    expect((await s.eng2.get(`/mail-messages/${unlinked}`)).status).toBe(404);
    expect((await s.eng2.get(`/mailboxes/${m.boxA}/messages`)).status).toBe(404);
    expect(ids(await s.eng2.get(`/tenders/${s.tenderA}/mail-messages`))).not.toContain(unlinked);
  });

  it('2. письмо без связи при mail.read — видно в контексте ящика, но не в переписке тендера', async () => {
    expect((await s.eng1.get(`/mail-messages/${unlinked}`)).status).toBe(200);
    expect(ids(await s.eng1.get(`/mailboxes/${m.boxA}/messages`))).toContain(unlinked);
    expect(ids(await s.eng1.get(`/tenders/${s.tenderA}/mail-messages`))).not.toContain(unlinked);
  });

  it('3. связь с тендером A и доступ к A без mail.read — письмо невидимо (связь прав не даёт)', async () => {
    expect(ids(await s.eng2.get(`/tenders/${s.tenderA}/mail-messages`))).toEqual([]);
    expect((await s.eng2.get(`/mail-messages/${m.m1}`)).status).toBe(404);
    const b = await search(s.eng2, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'));
    expect(texts(b).join('\n')).not.toContain('ЖЕЛЕЗОБЕТОН');
  });

  it('4. mail.read без доступа к тендеру A — в контексте A невидимо, в контексте ящика видно', async () => {
    await setMailAccess(s.admin, m.boxA, s.ids.eng3, ['mail.read']);
    try {
      expect((await s.eng3.get(`/tenders/${s.tenderA}/mail-messages`)).status).toBe(404);
      expect((await s.eng3.post('/search', searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'), { headers: idem() })).status).toBe(404);
      expect((await s.eng3.get(`/mail-messages/${m.m1}`)).status).toBe(200);
      // Связи с невидимым тендером в карточке письма не называются.
      expect((await s.eng3.get(`/mail-messages/${m.m1}`)).body.tenderLinks).toEqual([]);
    } finally {
      await setMailAccess(s.admin, m.boxA, s.ids.eng3, []);
    }
  });

  it('5. оба права — письмо видно в переписке тендера и находится поиском', async () => {
    expect(ids(await s.eng1.get(`/tenders/${s.tenderA}/mail-messages`))).toEqual(expect.arrayContaining([m.m1, m.m2]));
    const b = await search(s.eng1, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'));
    expect(texts(b).some((t) => t.includes('ЖЕЛЕЗОБЕТОН-7741'))).toBe(true);
  });

  it('6. письмо со связями A и B — одно письмо, по одному разу в каждом контексте', async () => {
    const a = ids(await s.manager.get(`/tenders/${s.tenderA}/mail-messages`));
    const b = ids(await s.manager.get(`/tenders/${s.tenderB}/mail-messages`));
    expect(a.filter((x) => x === m.m2)).toHaveLength(1);
    expect(b.filter((x) => x === m.m2)).toHaveLength(1);
    const card = await s.manager.get(`/mail-messages/${m.m2}`);
    expect(card.body.tenderLinks.map((l: { tenderId: string }) => l.tenderId).sort()).toEqual([s.tenderA, s.tenderB].sort());
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM mail_message WHERE identity_value = 'm2@example.test'");
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('права поверх индекса и снимка', () => {
  it('7. отзыв mail.read после индексации: прогон, сниппет и цитата закрыты сразу, без переиндексации', async () => {
    const b = await search(s.eng1, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'));
    const fragment = (b.fused.items as { text: string; fragmentId: string }[]).find((i) => i.text.includes('ЖЕЛЕЗОБЕТОН-7741'))!.fragmentId;
    const versions = await db.pool.query('SELECT count(*)::int AS n FROM search_index_version');
    await setMailAccess(s.admin, m.boxA, s.ids.eng1, ['mail.import', 'mail.link']);
    try {
      expect((await s.eng1.get(`/search-runs/${b.searchRunId}`)).status).toBe(409);
      expect((await s.eng1.get(`/evidence/${fragment}`)).status).toBe(404);
      const again = await search(s.eng1, searchBody(s.tenderA, s.stageA, 'ЖЕЛЕЗОБЕТОН-7741'));
      expect(texts(again).join('\n')).not.toContain('ЖЕЛЕЗОБЕТОН');
      expect((await db.pool.query('SELECT count(*)::int AS n FROM search_index_version')).rows[0].n).toBe(versions.rows[0].n);
    } finally {
      await setMailAccess(s.admin, m.boxA, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    }
  });

  it('8. администратор без mail.read — только служебные сведения ящика, без содержимого', async () => {
    const list = await s.admin.get('/mailboxes');
    const box = list.body.items.find((x: { id: string }) => x.id === m.boxA);
    expect(box).toMatchObject({ displayName: 'Ящик А', capabilities: [] });
    expect(box.messages).toBeGreaterThan(0);
    for (const path of [`/mail-messages/${m.m1}`, `/mail-message-revisions/${m.m1Revision}`, `/document-revisions/${m.attRevision}/content`]) {
      expect((await s.admin.get(path)).status).toBe(404);
    }
    for (const path of [`/mailboxes/${m.boxA}/messages`, `/mailboxes/${m.boxA}/imports`]) expect((await s.admin.get(path)).status).toBe(403);
    expect(list.text).not.toContain('Гидроизоляция');
  });

  it('9. вложение не утекает через документы: нет в списке документов этапа и в области без включения', async () => {
    const docs = await s.eng1.get(`/stages/${s.stageA}/documents`);
    expect(JSON.stringify(docs.body)).not.toContain('ведомость.csv');
    // В составе этапа только ТЗ: вложение не расширяет область само (D-025).
    const b = await search(s.eng1, searchBody(s.tenderA, s.stageA, MARK.att));
    expect(texts(b).join('\n')).not.toContain(MARK.att);
    // Включить вложение в состав может только читатель ящика.
    const draft = (await s.eng2.get(`/stages/${s.stageA}/source-sets`)).body.items[0].revisions.find((r: { status: string }) => r.status === 'draft');
    const put = await s.eng2.put(
      `/source-set-revisions/${draft.id}/items`,
      { items: [{ documentRevisionId: m.tenderDoc, inclusion: 'included' }, { documentRevisionId: m.attRevision, inclusion: 'included' }] },
      { headers: { 'If-Match': `"${draft.id}:${draft.rowVersion}"` } },
    );
    expect(put.status).toBe(403);
    expect(put.text).not.toContain(m.boxA);
    // Вложение письма, не связанного с тендером этапа, не включается совсем.
    const other = (await s.eng3.get(`/mail-messages/${m.m3}`)).body.current.attachments;
    expect(other).toEqual([]);
  });

  it('10. снятие связи: снимок сохраняет доказательство письма (review), текущий контекст его скрывает', async () => {
    await setWorkingSet(s.eng1, s.stageA, [m.tenderDoc], true);
    const scope = await fixScope(s.eng1, s.stageA);
    const review = { context: { kind: 'tender', tenderId: s.tenderA, mode: 'review', evidenceScopeId: scope }, query: 'КЛИНКЕР-3390 облицовка', limit: 10 };
    expect(texts(await search(s.eng1, review)).some((t) => t.includes('КЛИНКЕР-3390'))).toBe(true);
    const off = await s.eng1.post(`/mail-messages/${m.m2}/tender-links/${s.tenderA}/unlink`, {}, { headers: idem() });
    expect(off.status).toBe(200);
    expect(texts(await search(s.eng1, review)).some((t) => t.includes('КЛИНКЕР-3390'))).toBe(true);
    expect(texts(await search(s.eng1, searchBody(s.tenderA, s.stageA, 'КЛИНКЕР-3390 облицовка'))).join('\n')).not.toContain('КЛИНКЕР-3390');
    const item = await db.pool.query('SELECT 1 FROM evidence_scope_item WHERE scope_id = $1 AND mail_message_id = $2', [scope, m.m2]);
    expect(item.rowCount).toBe(1);
    await linkMail(s.eng1, m.m2, s.tenderA);
  });
});

describe('импорт: идемпотентность, ревизии, хранилище, лимиты', () => {
  it('11. повтор того же EML идемпотентен: та же ревизия, новой нет', async () => {
    const raw = eml({ messageId: 'dup@example.test', subject: 'Повтор', text: 'Одно и то же письмо' });
    const a = await importEml(s.eng1, worker, m.boxA, raw);
    const b = await importEml(s.eng1, worker, m.boxA, raw);
    expect(b).toMatchObject({ status: 'done', messageId: a.messageId, revisionId: a.revisionId, createdRevision: false });
  });

  it('12. тот же Message-ID с другим содержимым — новая ревизия, прежняя не перезаписана', async () => {
    const a = await importEml(s.eng1, worker, m.boxA, eml({ messageId: 'same-id@example.test', subject: 'Версия', text: 'Первая редакция текста' }));
    const b = await importEml(s.eng1, worker, m.boxA, eml({ messageId: 'same-id@example.test', subject: 'Версия', text: 'Вторая редакция текста' }));
    expect(b.messageId).toBe(a.messageId);
    expect(b.revisionId).not.toBe(a.revisionId);
    const first = await s.eng1.get(`/mail-message-revisions/${a.revisionId}`);
    expect(first.body.body.map((x: { text: string }) => x.text).join('\n')).toContain('Первая редакция');
  });

  it('13. одинаковое вложение у двух писем: байты хранятся раз, доступ не объединяется', async () => {
    const same = Buffer.from('Общий файл;1\n', 'utf8');
    const a = await importEml(s.eng1, worker, m.boxA, eml({ subject: 'Вложение A', text: 'a', attachments: [{ name: 'общий.csv', type: 'text/csv', bytes: same }] }));
    const b = await importEml(s.eng3, worker, m.boxB, eml({ subject: 'Вложение B', text: 'b', attachments: [{ name: 'общий.csv', type: 'text/csv', bytes: same }] }));
    const attA = (await s.eng1.get(`/mail-messages/${a.messageId}`)).body.current.attachments[0];
    const attB = (await s.eng3.get(`/mail-messages/${b.messageId}`)).body.current.attachments[0];
    expect(attA.sha256).toBe(attB.sha256);
    expect(attA.id).not.toBe(attB.id);
    expect(attA.documentId).not.toBe(attB.documentId);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM blob WHERE sha256 = $1', [attA.sha256])).rows[0].n).toBe(1);
    expect((await s.eng1.get(`/mail-attachments/${attA.id}/content`)).status).toBe(200);
    expect((await s.eng1.get(`/mail-attachments/${attB.id}/content`)).status).toBe(404);
    expect((await s.eng1.get(`/document-revisions/${attB.documentRevisionId}/content`)).status).toBe(404);
    expect((await s.eng3.get(`/mail-attachments/${attA.id}/content`)).status).toBe(404);
  });

  it('14. повреждённый EML — отказ импорта с причиной, письмо не создаётся', async () => {
    const before = (await db.pool.query('SELECT count(*)::int AS n FROM mail_message')).rows[0].n;
    const r = await importEml(s.eng1, worker, m.boxA, Buffer.from('X-Only: header\r\n\r\n', 'utf8'));
    expect(r).toMatchObject({ status: 'failed', messageId: null });
    expect(r.failureCode).toMatch(/^mail_/u);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mail_message')).rows[0].n).toBe(before);
  });

  it('15. лимиты: вложение сверх предела — отказ вложения без байтов; письмо сверх предела разбора — отказ; сверх загрузки — 413', async () => {
    const small = testConfig({ ...config, limits: { ...config.limits, maxUploadBytes: 256 * 1024 }, mail: { maxEmlBytes: 128 * 1024, maxAttachmentBytes: 16 * 1024 } });
    const app = makeApp(db, undefined, small);
    const c = new TestClient(app);
    await c.login('eng1');
    const big = Buffer.alloc(40 * 1024, 0x41);
    const r = await importEml(c, makeWorker(db, small, 'small-worker'), m.boxA, eml({ subject: 'Большое вложение', text: 'x', attachments: [{ name: 'big.txt', type: 'text/plain', bytes: big }] }));
    expect(r.status).toBe('done');
    const att = (await c.get(`/mail-messages/${r.messageId}`)).body.current.attachments[0];
    expect(att).toMatchObject({ status: 'rejected', rejectReason: 'size_limit', documentId: null, contentUrl: null });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM blob WHERE sha256 = $1', [att.sha256])).rows[0].n).toBe(0);
    const tooBig = await importEml(c, makeWorker(db, small, 'small-worker'), m.boxA, eml({ subject: 'Крупное', text: 'x'.repeat(150 * 1024) }));
    expect(tooBig).toMatchObject({ status: 'failed', failureCode: 'mail_too_large' });
    const huge = await postEml(c, m.boxA, eml({ subject: 'Огромное', text: 'x'.repeat(300 * 1024) }));
    expect(huge.status).toBe(413);
  });
});

describe('очередь разбора', () => {
  it('16. падение worker: брошенное задание после аренды выполняется другим worker один раз', async () => {
    const r = await postEml(s.eng1, m.boxA, eml({ messageId: 'crash@example.test', subject: 'Падение', text: 'Письмо при падении worker' }));
    expect(r.status).toBe(202);
    const dead = (await claimJob(db.pool, { workerId: 'dead-worker', leaseMs: 300, gpuGraceMs: 0, kinds: ['mail.import'] }))!;
    expect(dead.kind).toBe('mail.import');
    await sleep(500);
    expect(await recoverExpiredJobs(db.pool)).toContain(dead.id);
    await drain(makeWorker(db, config, 'restarted'));
    const done = await s.eng1.get(`/mail-imports/${r.body.id}`);
    expect(done.body).toMatchObject({ status: 'done', createdRevision: true });
    const n = await db.pool.query("SELECT count(*)::int AS n FROM mail_message_revision r JOIN mail_message x ON x.id = r.message_id WHERE x.identity_value = 'crash@example.test'");
    expect(n.rows[0].n).toBe(1);
  });

  it('17. детерминированный отказ разбора не повторяется', async () => {
    const r = await importEml(s.eng1, worker, m.boxA, Buffer.from('Garbage: \x01\x02\r\n\r\n', 'latin1'));
    expect(r.status).toBe('failed');
    const job = await db.pool.query("SELECT status, attempts FROM job WHERE kind = 'mail.import' AND payload->>'importId' = $1", [r.id]);
    expect(job.rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await drain(worker)).toBe(0);
  });

  it('18. одновременный импорт одного EML двумя worker — одна ревизия', async () => {
    const raw = eml({ messageId: 'race@example.test', subject: 'Гонка', text: 'Одновременный импорт' });
    const a = await postEml(s.eng1, m.boxA, raw);
    const b = await postEml(s.eng1, m.boxA, raw);
    expect([a.status, b.status]).toEqual([202, 202]);
    const w1 = makeWorker(db, config, 'race-1');
    const w2 = makeWorker(db, config, 'race-2');
    await Promise.all([w1.runOnce(['mail.import']), w2.runOnce(['mail.import'])]);
    await drain(worker);
    const ra = (await s.eng1.get(`/mail-imports/${a.body.id}`)).body;
    const rb = (await s.eng1.get(`/mail-imports/${b.body.id}`)).body;
    expect(ra.revisionId).toBe(rb.revisionId);
    expect([ra.createdRevision, rb.createdRevision].sort()).toEqual([false, true]);
  });
});

describe('вопросы–ответы, отзыв прав, журнал', () => {
  it('19. повтор manifest вопросов–ответов идемпотентен', async () => {
    const man = qaManifest([{ no: '1', question: 'Вопрос безопасности?' }], 'SEC');
    const a = await postManifest(s.eng1, s.tenderA, 'qa', man);
    const b = await postManifest(s.eng1, s.tenderA, 'qa', man);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body).toMatchObject({ reused: true, importId: a.body.importId, newRevisions: 0 });
  });

  it('20. вопросы–ответы A → B → A — три ревизии, история не схлопывается', async () => {
    const q = (answer: string) => qaManifest([{ no: '7', question: 'Цена фиксирована?', answer }], 'ABA');
    for (const ans of ['Да.', 'Нет.', 'Да.']) expect((await postManifest(s.eng1, s.tenderA, 'qa', q(ans))).body.newRevisions).toBe(1);
    const thread = (await s.eng1.get(`/tenders/${s.tenderA}/qa-threads`)).body.items.find((t: { externalRef: string }) => t.externalRef === 'ABA');
    const item = (await s.eng1.get(`/qa-threads/${thread.id}`)).body.questions[0];
    expect(item.history.map((h: { answer: string }) => h.answer)).toEqual(['Да.', 'Нет.', 'Да.']);
  });

  it('21. отозванные права действуют сразу: импорт, связь и переписка тендера', async () => {
    await setMailAccess(s.admin, m.boxA, s.ids.eng1, ['mail.read']);
    try {
      expect((await postEml(s.eng1, m.boxA, eml({ subject: 'x', text: 'y' }))).status).toBe(403);
      expect((await s.eng1.post(`/mail-messages/${m.m1}/tender-links/${s.tenderA}/unlink`, {}, { headers: idem() })).status).toBe(403);
    } finally {
      await setMailAccess(s.admin, m.boxA, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    }
    const etag = (await s.admin.get(`/tenders/${s.tenderA}`)).headers.etag as string;
    const del = await s.admin.delete(`/tenders/${s.tenderA}/members/${s.ids.eng1}`, { headers: { 'If-Match': etag } });
    expect(del.status, del.text).toBe(200);
    expect((await s.eng1.get(`/tenders/${s.tenderA}/mail-messages`)).status).toBe(404);
    expect((await s.eng1.get(`/mail-messages/${m.m1}`)).status).toBe(200);
  });

  it('22. журнал аудита не содержит тел, тем, сниппетов, адресов и имён файлов писем', async () => {
    const rows = await auditRows(db.pool, 'true');
    const all = JSON.stringify(rows);
    for (const forbidden of [MARK.m1, MARK.m1Quote, MARK.att, MARK.m2, MARK.m3, MARK.sib, 'Гидроизоляция', 'customer@example.test', 'ведомость.csv', 'Одно и то же письмо']) {
      expect(all, forbidden).not.toContain(forbidden.slice(0, 18));
    }
  });
});
