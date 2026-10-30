import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistMailRevision } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, makeApp, type ITestDb, type IScenario } from './helpers.ts';
import { createMailbox, setMailAccess } from './mailFixtures.ts';

let db: ITestDb;
let s: IScenario;
let box: string;
let other: string;
const ids: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db));
  box = await createMailbox(s.admin, 'history@example.test');
  other = await createMailbox(s.admin, 'hidden@example.test');
  await setMailAccess(s.admin, box, s.ids.eng1, ['mail.read']);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const sha = 'a'.repeat(64);
    await client.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'message/rfc822', $1)", [sha]);
    for (let n = 0; n < 207; n += 1) {
      const created = await persistMailRevision(client, {
        mailboxId: box, identity: { kind: 'message_id', value: `history-${n}` }, groupKey: null,
        rawSha256: sha, messageIdHeader: `history-${n}`, subject: n === 0 ? 'Архивный объект ОГНИ 100%_готов' : `История ${n}`,
        sentAt: new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString(), fromAddress: 'sender@example.test',
        participants: [{ role: 'to', address: 'recipient@example.test', name: 'Получатель' }], direction: 'inbound',
        folder: null, inReplyTo: null, references: [], source: 'eml_import', sourceItemId: null, warnings: [],
        blocks: [{ block: 1, quoted: false, text: n === 0 ? 'Секретный маркер тела архивный-лимон-829' : `Текст ${n}` }],
        attachments: n === 0 ? [{ ordinal: 1, filename: 'Смета-Архив.xlsx', mimeType: 'application/octet-stream', sizeBytes: 1, sha256: sha, disposition: 'attachment', contentId: null, status: 'rejected', rejectReason: 'type_not_allowed' }] : [],
        importedBy: s.ids.eng1!, maxFragmentChars: 4000,
      });
      ids.push(created.messageId);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});
afterAll(async () => { await db?.drop(); });

const get = (query = '') => s.eng1.get(`/mailboxes/${box}/messages${query ? `?${query}` : ''}`);

describe('поиск по полной истории и страницы почты', () => {
  it('история после 200-го письма доступна без повторов и потерь', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const response = await get(`page=${page}&pageSize=50`);
      expect(response.status, response.text).toBe(200);
      expect(response.body).toMatchObject({ total: 207, page, pageSize: 50 });
      seen.push(...response.body.items.map((item: { id: string }) => item.id));
    }
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(207);
  });

  it('ищет старое письмо по теме, телу, адресату и имени вложения, регистр не важен', async () => {
    for (const q of ['огни', 'АРХИВНЫЙ-ЛИМОН-829', 'Смета-Архив.xlsx', '100%_готов']) {
      const response = await get(new URLSearchParams({ q }).toString());
      expect(response.status, response.text).toBe(200);
      expect(response.body.total).toBe(1);
      expect(response.body.items[0].id).toBe(ids[0]);
    }
    const recipient = await get('q=recipient%40example.test');
    expect(recipient.body.total).toBe(207);
    expect((await get('q=sender%40example.test')).body.total).toBe(207);
  });

  it('поиск буквальный: символ процента не открывает всю почту; пустой результат и выход за конец корректны', async () => {
    expect((await get('q=%25')).body.total).toBe(1);
    const empty = await get('q=несуществующий-маркер');
    expect(empty.body).toMatchObject({ total: 0, page: 1, items: [] });
    const last = await get('page=99999&pageSize=50');
    expect(last.body).toMatchObject({ page: 5, total: 207 });
    expect(last.body.items).toHaveLength(7);
  });

  it('не раскрывает письма или количество без mail.read и после отзыва', async () => {
    expect((await s.eng2.get(`/mailboxes/${box}/messages?q=огни`)).status).toBe(404);
    expect((await s.admin.get(`/mailboxes/${box}/messages?q=огни`)).status).toBe(403);
    expect((await s.eng1.get(`/mailboxes/${other}/messages?q=огни`)).status).toBe(404);
    await setMailAccess(s.admin, box, s.ids.eng1, []);
    expect((await get('q=огни')).status).toBe(404);
    await setMailAccess(s.admin, box, s.ids.eng1, ['mail.read']);
  });

  it('отклоняет недопустимые размеры страниц и слишком длинный запрос', async () => {
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'pageSize=0', 'pageSize=201', 'pageSize=xyz', `q=${'x'.repeat(501)}`]) {
      expect((await get(query)).status, query).toBe(400);
    }
  });
});
