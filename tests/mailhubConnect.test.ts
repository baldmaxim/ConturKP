import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MailHubReader,
  MAILHUB_CONTRACT,
  type IMailHubPage,
} from '../packages/adapters/src/index.ts';
import {
  createMailbox,
  listMailboxMessages,
  saveMailHubPage,
  scheduleMailHub,
} from '../packages/db/src/index.ts';
import {
  createTestDb,
  createUser,
  testConfig,
  makeWorker,
  type ITestDb,
} from './helpers.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { eml } from './mailFixtures.ts';

const itemId = randomUUID();
const raw = eml({
  messageId: 'all-five@example.test',
  subject: 'Same letter',
  text: 'Hello.',
  attachments: [
    {
      name: 'spec.csv',
      type: 'text/csv',
      bytes: Buffer.from('item,quantity\r\nWork,5\r\n'),
    },
  ],
});
const copies = Array.from({ length: 5 }, (_, i) => ({
  mailboxId: randomUUID(),
  mailbox: `box${i}`,
  folder: 'INBOX',
  role: 'inbox',
}));
const stamp = new Date().toISOString();
const page: IMailHubPage = {
  contract: MAILHUB_CONTRACT,
  items: [
    {
      id: itemId,
      messageId: 'all-five@example.test',
      threadId: null,
      changedAt: stamp,
      copies,
    },
  ],
  nextCursor: 'one',
  hasMore: false,
};
let server: Server;
let baseUrl: string;
let db: ITestDb;
let mailboxId: string;
let actorId: string;
const config = testConfig();
let api: MailHubReader;
let emlReads = 0;
beforeAll(async () => {
  db = await createTestDb();
  actorId = await createUser(
    db.pool,
    'mailhub-admin',
    ['admin', 'manager'],
    'MailHub test',
  );
  const mailbox = await createMailbox(db.pool, {
    system: 'mailhub',
    externalAccountId: 'test',
    displayName: 'All five',
    createdBy: actorId,
  });
  if (!('id' in mailbox)) throw new Error('Mailbox exists');
  mailboxId = mailbox.id;
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer synthetic-secret') {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.includes('/messages/')) {
      emlReads++;
      res.writeHead(200, {
        'x-content-sha256': createHash('sha256').update(raw).digest('hex'),
      });
      res.end(raw);
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.mailhub = { baseUrl, token: 'synthetic-secret' };
  api = new MailHubReader({
    ...config.mailhub,
    maxEmlBytes: config.mail.maxEmlBytes,
  });
  await new BlobStore(config.storageRoot).init();
  await db.pool.query(
    'INSERT INTO mailhub_connection(source_key,mailbox_id,actor_user_id,allowed_mailboxes) VALUES($1,$2,$3,$4::uuid[])',
    [api.sourceKey, mailboxId, actorId, copies.map((x) => x.mailboxId)],
  );
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.drop();
});

describe('MailHub: five copies, one original', () => {
  it('полный цикл worker: одно письмо, одна ревизия и все пять ящиков', async () => {
    const worker = makeWorker(db, config);
    await scheduleMailHub(db.pool, api.sourceKey);
    expect(await worker.runOnce(['mailhub.sync'])).toBe(true);
    await scheduleMailHub(db.pool, api.sourceKey);
    expect(await worker.runOnce(['mailhub.fetch'])).toBe(true);
    expect(await worker.runOnce(['mail.import'])).toBe(true);
    const list = await listMailboxMessages(db.pool, mailboxId);
    expect(list).toHaveLength(1);
    expect(list[0]!.received_in).toEqual(copies.map((x) => x.mailbox));
    expect(list[0]!.revisions).toBe(1);
    expect(list[0]!.attachments).toBe(1);
    const source = (
      await db.pool.query(
        'SELECT source,source_item_id FROM mail_message_revision WHERE message_id=$1',
        [list[0]!.id],
      )
    ).rows[0];
    expect(source).toMatchObject({
      source: 'mailhub_api',
      source_item_id: itemId,
    });
    expect(emlReads).toBe(1);
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM mail_attachment'))
        .rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM document WHERE mail_attachment_id IS NOT NULL',
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('повтор страницы, параллельное планирование и поздняя копия не дублируют импорт', async () => {
    const worker = makeWorker(db, config);
    await saveMailHubPage(db.pool, api.sourceKey, page);
    await Promise.all([
      scheduleMailHub(db.pool, api.sourceKey),
      scheduleMailHub(db.pool, api.sourceKey),
    ]);
    expect(await worker.runOnce(['mailhub.fetch'])).toBe(false);
    expect(await listMailboxMessages(db.pool, mailboxId)).toHaveLength(1);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM mail_import WHERE mailbox_id=$1',
          [mailboxId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(emlReads).toBe(1);
  });
  it('пять копий занимают одну запись очереди источника', async () => {
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM mailhub_message WHERE source_key=$1',
          [api.sourceKey],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('позднее вхождение меняет происхождение, сохраняя письмо и вложение', async () => {
    const updated = {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        copies: [...item.copies, { ...copies[0]!, folder: 'Archive' }],
      })),
    };
    await saveMailHubPage(db.pool, api.sourceKey, updated);
    await scheduleMailHub(db.pool, api.sourceKey);
    expect(await makeWorker(db, config).runOnce(['mailhub.fetch'])).toBe(false);
    expect(
      (await listMailboxMessages(db.pool, mailboxId))[0]!.received_in,
    ).toEqual(copies.map((x) => x.mailbox));
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM mail_attachment'))
        .rows[0].n,
    ).toBe(1);
  });
  it('не пересылает ключ при редиректе, проверяет размер и контрольную сумму', async () => {
    let seen: RequestInit | undefined;
    const redirected = new MailHubReader({
      baseUrl,
      token: 'synthetic-secret',
      maxEmlBytes: 1000,
      fetchImpl: async (_url, options) => {
        seen = options;
        return new Response('', { status: 302 });
      },
    });
    await expect(redirected.eml(itemId)).rejects.toMatchObject({
      code: 'HTTP_302',
      retryable: false,
    });
    expect(seen?.redirect).toBe('manual');
    const badHash = new MailHubReader({
      baseUrl,
      token: 'synthetic-secret',
      maxEmlBytes: 1000,
      fetchImpl: async () =>
        new Response('content', {
          headers: { 'x-content-sha256': '0'.repeat(64) },
        }),
    });
    await expect(badHash.eml(itemId)).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    });
    const huge = new MailHubReader({
      baseUrl,
      token: 'synthetic-secret',
      maxEmlBytes: 3,
      fetchImpl: async () => new Response('content'),
    });
    await expect(huge.eml(itemId)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });
});
