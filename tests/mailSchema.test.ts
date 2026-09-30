// Этап 07: 18 обязательных инвариантов БД почтовой модели (docs/architecture/07-mail-model-design.md §15,
// D-025). Каждая проверка — прямой SQL под ролью приложения (или владельцем схемы, где у приложения нет
// права): вторая линия держит инвариант без кода API. Данные — через API, как у пользователя.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let boxA: string;
let boxB: string;
let msg: { messageId: string; revisionId: string };
let attachmentId: string;
let attachmentDoc: string;
let attachmentRev: string;
let tenderRev: string;
let tenderDoc: string;
let tenderRun: string;
const config = testConfig();

const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
const q = (sql: string, params: unknown[] = []) => code(db.pool.query(sql, params));

const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: db.migratorUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

// Транзакция под ролью приложения, всегда откатываемая: проверка внутри транзакции создания ревизии.
const inRollback = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
};

const newBlob = async (): Promise<string> => {
  const sha = randomBytes(32).toString('hex');
  await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'message/rfc822', $2)", [sha, `s07/${sha}`]);
  return sha;
};

// Новое письмо и его первая ревизия в транзакции c (охранники состава пропускают только её).
const freshRevision = async (c: pg.PoolClient, mailboxId = boxA): Promise<{ message: string; revision: string }> => {
  const comm = (await c.query<{ id: string }>('INSERT INTO mail_communication DEFAULT VALUES RETURNING id')).rows[0]!.id;
  const message = (
    await c.query<{ id: string }>(
      "INSERT INTO mail_message (mailbox_id, communication_id, identity_kind, identity_value, created_by) VALUES ($1, $2, 'raw_sha256', $3, $4) RETURNING id",
      [mailboxId, comm, randomUUID(), s.ids.eng1],
    )
  ).rows[0]!.id;
  const revision = (
    await c.query<{ id: string }>(
      "INSERT INTO mail_message_revision (message_id, seq, raw_blob_sha256, direction, source, imported_by) VALUES ($1, 1, $2, 'inbound', 'eml_import', $3) RETURNING id",
      [message, await newBlob(), s.ids.eng1],
    )
  ).rows[0]!.id;
  return { message, revision };
};

const mailFragment = (c: pg.PoolClient, revision: string, extra: Record<string, unknown> = {}) => {
  const cols = { source_unit_type: 'mail_message_revision', source_unit_id: revision, mail_message_revision_id: revision, origin: 'email_body', ...extra };
  const names = [...Object.keys(cols), 'fragment_kind', 'fragment_key', 'ordinal', 'text', 'text_sha256', 'locator'];
  const values = [...Object.values(cols), 'text_block', `k${randomUUID()}`, 1, 'текст', 'a'.repeat(64), JSON.stringify({ kind: 'mail_body', block: 1, quoted: false })];
  return code(c.query(`INSERT INTO evidence_fragment (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, values));
};

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  const worker = makeWorker(db, config);
  boxA = await createMailbox(s.admin, 'schema-a@example.test');
  boxB = await createMailbox(s.admin, 'schema-b@example.test');
  await setMailAccess(s.admin, boxA, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
  await setMailAccess(s.admin, boxB, s.ids.eng1, ['mail.read', 'mail.import']);
  const raw = eml({ messageId: 'schema@example.test', subject: 'Схема', text: 'Тело письма', attachments: [{ name: 'a.csv', type: 'text/csv', bytes: Buffer.from('a;b\n1;2\n') }] });
  const r = await importEml(s.eng1, worker, boxA, raw);
  msg = { messageId: r.messageId!, revisionId: r.revisionId! };
  await importEml(s.eng1, worker, boxB, raw);
  await linkMail(s.eng1, msg.messageId, s.tenderA);
  const att = (await db.pool.query('SELECT a.id, d.id AS doc, dr.id AS rev FROM mail_attachment a JOIN document d ON d.mail_attachment_id = a.id JOIN document_revision dr ON dr.document_id = d.id WHERE a.revision_id = $1', [msg.revisionId])).rows[0];
  attachmentId = att.id;
  attachmentDoc = att.doc;
  attachmentRev = att.rev;
  tenderRev = await uploadDocument(db, config, s.eng1, s.stageA, 'тз.pdf');
  tenderDoc = (await db.pool.query<{ document_id: string }>('SELECT document_id FROM document_revision WHERE id = $1', [tenderRev])).rows[0]!.document_id;
  tenderRun = await seedEvidenceRun(db.pool, tenderRev, { pages: [{ blocks: ['Текст ТЗ'] }] });
});
afterAll(async () => {
  await db.drop();
});

describe('письмо, ревизия, коммуникация', () => {
  it('1. у письма ровно один ящик', async () => {
    const comm = (await db.pool.query<{ id: string }>('INSERT INTO mail_communication DEFAULT VALUES RETURNING id')).rows[0]!.id;
    expect(await q("INSERT INTO mail_message (communication_id, identity_kind, identity_value, created_by) VALUES ($1, 'raw_sha256', 'x', $2)", [comm, s.ids.eng1])).toBe('23502');
  });

  it('2. ревизия принадлежит ровно одному письму', async () => {
    expect(await q("INSERT INTO mail_message_revision (seq, raw_blob_sha256, direction, source, imported_by) VALUES (1, $1, 'inbound', 'eml_import', $2)", [await newBlob(), s.ids.eng1])).toBe('23502');
    expect(await asOwner((c) => code(c.query('UPDATE mail_message_revision SET message_id = message_id WHERE id = $1', [msg.revisionId])))).toBe('55000');
  });

  it('3. коммуникация объединяет несколько копий письма', async () => {
    const r = await db.pool.query<{ n: number; boxes: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT mailbox_id)::int AS boxes FROM mail_message WHERE identity_value = 'schema@example.test'",
    );
    expect(r.rows[0]).toEqual({ n: 2, boxes: 2 });
    const comm = await db.pool.query("SELECT count(DISTINCT communication_id)::int AS n FROM mail_message WHERE identity_value = 'schema@example.test'");
    expect(comm.rows[0].n).toBe(1);
  });

  it('4. копию нельзя перепривязать к другому ящику', async () => {
    expect(await q('UPDATE mail_message SET mailbox_id = $2 WHERE id = $1', [msg.messageId, boxB])).toBe('42501');
    expect(await asOwner((c) => code(c.query('UPDATE mail_message SET mailbox_id = $2 WHERE id = $1', [msg.messageId, boxB])))).toBe('55000');
  });
});

describe('фрагмент доказательства', () => {
  it('5. у фрагмента письма ровно одна ревизия-источник; дописать фрагмент к готовой ревизии нельзя', async () => {
    await inRollback(async (c) => {
      const a = await freshRevision(c);
      const b = await freshRevision(c);
      expect(await mailFragment(c, a.revision)).toBe('ok');
      await c.query('SAVEPOINT sp');
      expect(await mailFragment(c, a.revision, { source_unit_id: b.revision })).toBe('23514');
      await c.query('ROLLBACK TO sp');
      expect(await mailFragment(c, a.revision, { tender_id: s.tenderA })).toBe('23514');
    });
    expect(await inRollback((c) => mailFragment(c, msg.revisionId))).toBe('55000');
  });

  it('6. доказательство документа и письма одновременно невозможно', async () => {
    await inRollback(async (c) => {
      const a = await freshRevision(c);
      // Первым отказывает охранник прогона (0006: фрагменты пишет только идущий прогон) или CHECK вида источника.
      expect(['23514', '55000']).toContain(await mailFragment(c, a.revision, { run_id: tenderRun, document_revision_id: tenderRev }));
    });
    expect(
      await q(
        `INSERT INTO evidence_fragment (source_unit_type, source_unit_id, run_id, document_revision_id, tender_id, mail_message_revision_id, origin,
                                        fragment_kind, fragment_key, text, text_sha256)
         VALUES ('recognition_run', $1, $1, $2, $3, $4, 'document_text', 'text_block', 'mix', 'x', $5)`,
        [tenderRun, tenderRev, s.tenderA, msg.revisionId, 'a'.repeat(64)],
      ),
    ).not.toBe('ok');
  });
});

describe('реплика переговоров — ветка тендера (И-07-7)', () => {
  it('тендер фрагмента реплики — тендер редакции транскрипции: чужой тендер и фрагмент без тендера — отказ', async () => {
    const result = await inRollback(async (c) => {
      const blob = await newBlob();
      const imp = (await c.query<{ id: string }>("INSERT INTO negotiation_import (tender_id, seq, manifest_blob_sha256, format_version, imported_by) VALUES ($1, 1, $2, 'kontur.negotiation.v1', $3) RETURNING id", [s.tenderA, blob, s.ids.eng1])).rows[0]!.id;
      const session = (await c.query<{ id: string }>("INSERT INTO negotiation_session (tender_id, external_session_id, started_at, source, created_by) VALUES ($1, 'S', now(), 'manifest_import', $2) RETURNING id", [s.tenderA, s.ids.eng1])).rows[0]!.id;
      const rev = (await c.query<{ id: string }>("INSERT INTO transcript_revision (session_id, tender_id, seq, source_revision, content_sha256, import_id) VALUES ($1, $2, 1, 'r1', $3, $4) RETURNING id", [session, s.tenderA, 'c'.repeat(64), imp])).rows[0]!.id;
      const seg = (await c.query<{ id: string }>("INSERT INTO transcript_segment (revision_id, tender_id, segment_no, speaker_label, t_start_ms, t_end_ms, segment_kind, text) VALUES ($1, $2, 1, 'S1', 0, 1, 'speech', 'речь') RETURNING id", [rev, s.tenderA])).rows[0]!.id;
      const frag = (tender: string | null) => {
        const names = ['source_unit_type', 'source_unit_id', 'transcript_revision_id', 'transcript_segment_id', 'tender_id', 'origin', 'fragment_kind', 'fragment_key', 'text', 'text_sha256', 'locator'];
        const values = ['transcript_revision', rev, rev, seg, tender, 'negotiation_speech', 'text_block', `s${randomUUID()}`, 'речь', 'a'.repeat(64), JSON.stringify({ kind: 'transcript_segment', segment: 1, startMs: 0, endMs: 1 })];
        return code(c.query(`INSERT INTO evidence_fragment (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, values));
      };
      const out: string[] = [];
      for (const t of [s.tenderB, null, s.tenderA]) {
        await c.query('SAVEPOINT f');
        out.push(await frag(t));
        await c.query('ROLLBACK TO f');
      }
      return out;
    });
    expect(result).toEqual(['23503', '23514', 'ok']);
  });
});

describe('вложение и его документ (матрица B)', () => {
  it('7. вложение — одной ревизии письма; перепривязать или дописать к готовой ревизии нельзя', async () => {
    expect(await asOwner((c) => code(c.query('UPDATE mail_attachment SET revision_id = revision_id WHERE id = $1', [attachmentId])))).toBe('55000');
    expect(
      await q(
        "INSERT INTO mail_attachment (revision_id, ordinal, filename, mime_type, size_bytes, sha256, disposition, status, reject_reason) VALUES ($1, 9, 'x', 'text/plain', 1, $2, 'attachment', 'rejected', 'corrupt')",
        [msg.revisionId, 'b'.repeat(64)],
      ),
    ).toBe('55000');
  });

  it('8. документ вложения — ровно одного вложения', async () => {
    expect(await q("INSERT INTO document (title, name_key, doc_type, mail_attachment_id) VALUES ('копия', 'копия', 'other', $1)", [attachmentId])).toBe('23505');
  });

  it('9. у документа вложения нет тендера и договора', async () => {
    const doc = await db.pool.query('SELECT tender_id, contract_id FROM document WHERE id = $1', [attachmentDoc]);
    expect(doc.rows[0]).toEqual({ tender_id: null, contract_id: null });
    expect(await q("INSERT INTO document (title, name_key, doc_type, tender_id, mail_attachment_id) VALUES ('x', 'x', 'other', $1, $2)", [s.tenderA, attachmentId])).toBe('23514');
  });

  it('10. редакция вложения не меняет владельца: смена вложения и вторая редакция — отказ', async () => {
    expect(await q('UPDATE document SET mail_attachment_id = NULL, tender_id = $2 WHERE id = $1', [attachmentDoc, s.tenderA])).toBe('55000');
    const blob = (await db.pool.query('SELECT blob_sha256 FROM document_revision WHERE id = $1', [attachmentRev])).rows[0].blob_sha256;
    expect(await q('INSERT INTO document_revision (document_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, 2, $3)', [attachmentDoc, blob, s.ids.eng1])).toBe('23514');
    expect(await q('INSERT INTO document_revision (document_id, blob_sha256, revision_seq, registered_by, tender_id) VALUES ($1, $2, 2, $3, $4)', [attachmentDoc, blob, s.ids.eng1, s.tenderA])).not.toBe('ok');
  });
});

describe('связь с тендером и снимок', () => {
  it('11. связь с тендером не меняет источник: письмо и тендер пары неизменны', async () => {
    expect(await q('UPDATE mail_message_tender SET message_id = message_id, tender_id = $2 WHERE message_id = $1', [msg.messageId, s.tenderB])).toBe('55000');
  });

  it('12. снятие связи не удаляет письмо, ревизию и пару', async () => {
    expect(await q('DELETE FROM mail_message_tender WHERE message_id = $1', [msg.messageId])).toBe('42501');
    expect(await asOwner((c) => code(c.query('DELETE FROM mail_message_tender WHERE message_id = $1', [msg.messageId])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('DELETE FROM mail_message_revision WHERE id = $1', [msg.revisionId])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('DELETE FROM mail_message WHERE id = $1', [msg.messageId])))).toBe('55000');
  });

  it('13. снимок фиксирует конкретную ревизию письма и не дописывается', async () => {
    await setWorkingSet(s.eng1, s.stageA, [tenderRev], true);
    const scope = await fixScope(s.eng1, s.stageA);
    const item = await db.pool.query('SELECT mail_message_revision_id FROM evidence_scope_item WHERE scope_id = $1 AND unit_type = $2', [scope, 'mail_message']);
    expect(item.rows).toEqual([{ mail_message_revision_id: msg.revisionId }]);
    expect(await asOwner((c) => code(c.query('UPDATE evidence_scope_item SET mail_message_revision_id = mail_message_revision_id WHERE scope_id = $1', [scope])))).not.toBe('ok');
    expect(
      await q(
        "INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, mail_message_id, mail_message_revision_id, inclusion_reason) VALUES ($1, $2, 'mail_message', $3, $4, 'x')",
        [scope, s.tenderA, msg.messageId, msg.revisionId],
      ),
    ).not.toBe('ok');
  });
});

describe('права не выводятся из связи и снимка', () => {
  it('14. включение письма в снимок не даёт mail.read', async () => {
    const scope = (await db.pool.query<{ id: string }>('SELECT scope_id AS id FROM evidence_scope_item WHERE mail_message_id = $1 LIMIT 1', [msg.messageId])).rows[0]!.id;
    const view = await s.eng2.get(`/evidence-scopes/${scope}`);
    expect(view.status).toBe(200);
    expect(view.body.items.find((i: { unitType: string }) => i.unitType === 'mail_message')).toMatchObject({ restricted: true, mailMessageId: null, mailSubject: null });
    expect((await s.eng2.get(`/mail-messages/${msg.messageId}`)).status).toBe(404);
    const grants = await db.pool.query('SELECT count(*)::int AS n FROM mail_access WHERE user_id = $1', [s.ids.eng2]);
    expect(grants.rows[0].n).toBe(0);
  });

  it('15. отзыв mail.read сразу закрывает письмо', async () => {
    await setMailAccess(s.admin, boxA, s.ids.eng1, ['mail.import', 'mail.link']);
    try {
      expect((await s.eng1.get(`/mail-messages/${msg.messageId}`)).status).toBe(404);
      expect((await s.eng1.get(`/mail-message-revisions/${msg.revisionId}`)).status).toBe(404);
    } finally {
      await setMailAccess(s.admin, boxA, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    }
  });

  it('16. одна коммуникация в двух ящиках не объединяет копии', async () => {
    const copies = await db.pool.query<{ id: string; mailbox_id: string }>("SELECT id, mailbox_id FROM mail_message WHERE identity_value = 'schema@example.test' ORDER BY mailbox_id");
    expect(new Set(copies.rows.map((x) => x.id)).size).toBe(2);
    const revs = await db.pool.query('SELECT count(DISTINCT message_id)::int AS n FROM mail_message_revision WHERE message_id = ANY($1::uuid[])', [copies.rows.map((x) => x.id)]);
    expect(revs.rows[0].n).toBe(2);
    const other = copies.rows.find((x) => x.mailbox_id === boxB)!.id;
    const links = await db.pool.query('SELECT count(*)::int AS n FROM mail_message_tender WHERE message_id = $1', [other]);
    expect(links.rows[0].n).toBe(0);
  });

  it('17. один blob вложения у двух писем — две строки вложения и два документа', async () => {
    const rows = await db.pool.query<{ id: string; doc: string }>(
      'SELECT a.id, d.id AS doc FROM mail_attachment a JOIN document d ON d.mail_attachment_id = a.id WHERE a.sha256 = (SELECT sha256 FROM mail_attachment WHERE id = $1)',
      [attachmentId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((x) => x.doc)).size).toBe(2);
  });
});

describe('18. прямой SQL не создаёт неоднозначного владения', () => {
  it('документ, редакция, прогон, фрагмент и строки индекса без владельца — только в почтовой ветке', async () => {
    const blob = (await db.pool.query('SELECT blob_sha256 FROM document_revision WHERE id = $1', [tenderRev])).rows[0].blob_sha256;
    expect(await q("INSERT INTO document (title, name_key, doc_type) VALUES ('ничей', 'ничей', 'other')")).toBe('23514');
    expect(await q('INSERT INTO document_revision (document_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, 99, $3)', [tenderDoc, blob, s.ids.eng1])).toBe('23514');
    expect(await q("INSERT INTO recognition_run (document_revision_id, engine, source_artifact_sha256) VALUES ($1, 'rdweb_export', $2)", [tenderRev, blob])).toBe('23514');
    expect(
      await q(
        `INSERT INTO evidence_fragment (source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind, fragment_key, text, text_sha256)
         VALUES ('recognition_run', $1, $1, $2, 'document_text', 'text_block', 'orphan', 'x', $3)`,
        [tenderRun, tenderRev, 'a'.repeat(64)],
      ),
    ).not.toBe('ok');
    const version = (await db.pool.query<{ id: string }>('SELECT id FROM search_index_version ORDER BY seq DESC LIMIT 1')).rows[0]?.id;
    if (version) {
      expect(
        await q("INSERT INTO search_index_unit (index_version_id, source_unit_type, source_unit_id, chunks, fragments_indexed, fragments_skipped) VALUES ($1, 'recognition_run', $2, 0, 0, 0)", [version, tenderRun]),
      ).toBe('23514');
    }
    expect(
      await q(
        "INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, document_revision_id, mail_message_id, inclusion_reason) VALUES ($1, $2, 'document_recognition', $3, $4, 'x')",
        [randomUUID(), s.tenderA, tenderRev, msg.messageId],
      ),
    ).not.toBe('ok');
    expect(await asOwner((c) => code(c.query('UPDATE document SET tender_id = NULL, mail_attachment_id = $2 WHERE id = $1', [tenderDoc, attachmentId])))).not.toBe('ok');
    expect((await s.eng1.post('/mailboxes', { system: 'manual', externalAccountId: 'x', displayName: 'x' }, { headers: idem() })).status).toBe(403);
  });
});
