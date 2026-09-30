// Этап 07: обновление схемы 0016 → 0018 на данных принятого 05a (D-025): тендер с историей RDWeb и
// локальным прогоном, снимок области, строки индекса, прогон поиска и договор 06a. Все новые и
// ослабленные ограничения проверяются на существующих строках; хэш прежнего снимка не меняется
// (слоты 4–5 формулы пусты); состояние индексации сохраняет единицу под новым именем столбца;
// приложение читает прежние снимок и прогон поиска, а на обновлённой базе работает импорт письма.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceScopeContentHash, sourceSetContentHash } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, listMigrations, migrate, MIGRATIONS_DIR, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { ADMIN_URL, createUser, makeApp, makeWorker, TestClient, testConfig, type ITestDb } from './helpers.ts';
import { completeLocalRun, descriptorOf, insertLocalRun, newRevision } from './localRecognitionFixtures.ts';
import { eml, importEml } from './mailFixtures.ts';

const name = `kontur_kp_test_upgrade07_${Date.now().toString(36)}`;
const urlFor = (user: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${name}`;
  return u.toString();
};
const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

let pool: Pool;

beforeAll(async () => {
  await setupDatabase(ADMIN_URL, name);
  const dir = mkdtempSync(join(tmpdir(), 'kontur-mig07-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 16)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await m.connect();
  try {
    expect(await migrate(m, { testMode: true, dir })).toHaveLength(16);
  } finally {
    await m.end();
  }
  pool = createPool(urlFor('kontur_app'), 5);
});
afterAll(async () => {
  await pool.end();
  await dropDatabase(ADMIN_URL, name);
});

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await pool.query(sql, params)).rows[0] as T;

const rdwebRun = async (o: { rev: string; tender: string | null; contract: string | null; text: string }) => {
  const zip = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/zip', $2)", [zip, `m/${zip}`]);
  const { id } = await one<{ id: string }>(
    "INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256) VALUES ($1, $2, $3, 'rdweb_export', $4) RETURNING id",
    [o.rev, o.tender, o.contract, zip],
  );
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
  await pool.query("INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status) VALUES ($1, 0, '1', 2480, 3508, 0, 'recognized')", [id]);
  const { id: fragment } = await one<{ id: string }>(
    `INSERT INTO evidence_fragment (tender_id, contract_id, source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind, fragment_key, ordinal, page_index, text, text_sha256)
     VALUES ($1, $2, 'recognition_run', $3, $3, $4, 'recognized_text', 'text_block', 'b1', 1, 0, $5, $6) RETURNING id`,
    [o.tender, o.contract, id, o.rev, o.text, sha(o.text)],
  );
  await pool.query(
    "UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
    [id],
  );
  return { run: id, fragment };
};

const seed05a = async () => {
  const admin = await createUser(pool, 'admin', ['admin'], 'Администратор');
  const eng = await createUser(pool, 'eng1', ['engineer'], 'Инженер 1');
  const { id: tender } = await one<{ id: string }>("INSERT INTO tender (code, title, created_by) VALUES ('U-7', 'Тендер U-7', $1) RETURNING id", [admin]);
  await pool.query("INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, 'engineer', $3)", [tender, eng, admin]);
  const { id: stage } = await one<{ id: string }>("INSERT INTO tender_stage (tender_id, seq, title, created_by) VALUES ($1, 1, 'Этап', $2) RETURNING id", [tender, eng]);
  const pdf = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/pdf', $2)", [pdf, `m/${pdf}`]);
  const { id: doc } = await one<{ id: string }>("INSERT INTO document (tender_id, title, name_key) VALUES ($1, 'тз.pdf', 'тз.pdf') RETURNING id", [tender]);
  const { id: rev } = await one<{ id: string }>(
    'INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, $3, 1, $4) RETURNING id',
    [doc, tender, pdf, eng],
  );
  const r = await rdwebRun({ rev, tender, contract: null, text: 'Аванс 30 процентов.' });
  // Локальный прогон 05a с якорем (DOCX) — фрагменты с locator переживают новый охранник якорей.
  const docx = await newRevision(pool, { tenderId: tender, format: 'docx', userId: eng });
  const local = await insertLocalRun(pool, docx.revisionId, descriptorOf('docx'), null);
  await completeLocalRun(pool, local, [{ kind: 'docx_body' }], ['Локальный текст: гарантия пять лет.']);
  const { id: set } = await one<{ id: string }>("INSERT INTO source_set (stage_id, purpose) VALUES ($1, 'working') RETURNING id", [stage]);
  const { id: setRev } = await one<{ id: string }>('INSERT INTO source_set_revision (source_set_id, seq, created_by) VALUES ($1, 1, $2) RETURNING id', [set, eng]);
  await pool.query("INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by) VALUES ($1, $2, 'included', $3)", [setRev, rev, eng]);
  const setHash = sourceSetContentHash([{ documentRevisionId: rev, blobSha256: pdf, inclusion: 'included' }]);
  await pool.query("UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), frozen_by = $2, content_hash = $3, row_version = row_version + 1 WHERE id = $1", [
    setRev,
    eng,
    setHash,
  ]);
  const scopeHash = evidenceScopeContentHash(setHash, [{ unitType: 'document_recognition', documentRevisionId: rev, recognitionRunId: r.run }]);
  const client = await pool.connect();
  let scope: string;
  try {
    await client.query('BEGIN');
    scope = (
      await client.query<{ id: string }>(
        'INSERT INTO evidence_scope (stage_id, tender_id, source_set_revision_id, input_version, content_hash, created_by) VALUES ($1, $2, $3, 0, $4, $5) RETURNING id',
        [stage, tender, setRev, scopeHash, eng],
      )
    ).rows[0]!.id;
    await client.query(
      "INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, document_revision_id, recognition_run_id, inclusion_reason) VALUES ($1, $2, 'document_recognition', $3, $4, 'source_set_included')",
      [scope, tender, rev, r.run],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  // Договор 06a с распознанной редакцией.
  const { id: contract } = await one<{ id: string }>("INSERT INTO contract (number, title, created_by) VALUES ('Д-7', 'Договор Д-7', $1) RETURNING id", [eng]);
  const cpdf = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/pdf', $2)", [cpdf, `m/${cpdf}`]);
  const { id: cdoc } = await one<{ id: string }>(
    "INSERT INTO document (contract_id, contract_role, title, name_key, doc_type) VALUES ($1, 'contract', 'договор.pdf', 'договор.pdf', 'contract') RETURNING id",
    [contract],
  );
  const { id: crev } = await one<{ id: string }>(
    'INSERT INTO document_revision (document_id, contract_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, $3, 1, $4) RETURNING id',
    [cdoc, contract, cpdf, eng],
  );
  await rdwebRun({ rev: crev, tender: null, contract, text: 'Цена договора 245 000 000.' });
  // Строки индекса по прогону тендера (как пишет index.build) и состояние индексации его фрагмента.
  const { id: version } = await one<{ id: string }>("INSERT INTO search_index_version (seq, chunker_version) VALUES (1, 'c1') RETURNING id", []);
  await pool.query(
    "INSERT INTO search_index_unit (index_version_id, source_unit_type, source_unit_id, tender_id, chunks, fragments_indexed, fragments_skipped) VALUES ($1, 'recognition_run', $2, $3, 1, 1, 0)",
    [version, r.run, tender],
  );
  const { id: chunk } = await one<{ id: string }>(
    `INSERT INTO search_chunk (index_version_id, tender_id, source_unit_type, source_unit_id, document_revision_id, page_index, part_no, chunk_key, body_text, text_sha256)
     VALUES ($1, $2, 'recognition_run', $3, $4, 0, 0, $5, 'Аванс 30 процентов.', $6) RETURNING id`,
    [version, tender, r.run, rev, `${r.run}:p0:c0`, sha('\nАванс 30 процентов.')],
  );
  await pool.query(
    "INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, tender_id, fragment_id, ordinal, role, char_start, char_end) VALUES ($1, $2, $3, $4, $5, 0, 'body', 1, 20)",
    [chunk, version, r.run, tender, r.fragment],
  );
  await pool.query("INSERT INTO fragment_index_state (index_version_id, index_system, fragment_id, run_id, status) VALUES ($1, 'portal_fts', $2, $3, 'indexed')", [version, r.fragment, r.run]);
  const { id: searchRun } = await one<{ id: string }>(
    `INSERT INTO search_run (context_kind, tender_id, stage_id, mode, requested_by, query_text, query_sha256, query_normalization_version, result_limit,
                             scope_hash, allowed_source_unit_ids, index_version_id, ranking_version, semantic_status, deadline_at)
     VALUES ('tender', $1, $2, 'working', $3, 'аванс', $4, 'n1', 10, $5, $6::uuid[], $7, 'r1', 'running', now() + interval '1 minute') RETURNING id`,
    [tender, stage, eng, sha('аванс'), scopeHash, [r.run], version],
  );
  return { tender, rev, run: r.run, fragment: r.fragment, scope, scopeHash, searchRun, admin, eng };
};

const TABLES = [
  'document',
  'document_revision',
  'recognition_run',
  'evidence_fragment',
  'evidence_scope',
  'evidence_scope_item',
  'search_index_unit',
  'search_chunk',
  'search_chunk_fragment',
  'fragment_index_state',
  'search_run',
];
const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`, [])).n;
  return out;
};

describe('обновление схемы 0016 → 0018 (D-025)', () => {
  it('данные 05a/06a переживают 0017–0018; хэш снимка прежний; приложение читает снимок и поиск; импорт письма работает', async () => {
    const seed = await seed05a();
    const before = await counts();
    const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
    await m.connect();
    try {
      expect(await migrate(m, { testMode: true })).toEqual(listMigrations().filter((f) => f.version > 16).map((f) => f.version));
      const invalid = await m.query("SELECT conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace");
      expect(invalid.rows).toEqual([]);
    } finally {
      await m.end();
    }
    expect(await counts()).toEqual(before);
    // Прежние строки остались в своих ветках: у документов нет вложения, у фрагментов — прежний вид.
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM document WHERE mail_attachment_id IS NOT NULL', [])).n).toBe(0);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM evidence_fragment WHERE source_unit_type <> 'recognition_run'", [])).n).toBe(0);
    const state = await one<{ source_unit_id: string }>('SELECT source_unit_id FROM fragment_index_state WHERE fragment_id = $1', [seed.fragment]);
    expect(state.source_unit_id).toBe(seed.run);
    // Хэш прежнего снимка по новой формуле совпадает с сохранённым (слоты 4–5 пусты).
    expect((await one<{ h: string }>('SELECT evidence_scope_composition_hash($1) AS h', [seed.scope])).h).toBe(seed.scopeHash);
    await pool.query('SELECT evidence_scope_verify($1)', [seed.scope]);
    const db = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool, drop: async () => undefined } as ITestDb;
    const config = testConfig();
    const app = makeApp(db, undefined, config);
    const eng = new TestClient(app);
    expect((await eng.login('eng1')).status).toBe(200);
    const scope = await eng.get(`/evidence-scopes/${seed.scope}`);
    expect(scope.status, scope.text).toBe(200);
    expect(scope.body.items).toEqual([expect.objectContaining({ unitType: 'document_recognition', documentRevisionId: seed.rev, recognitionRunId: seed.run })]);
    expect((await eng.get(`/search-runs/${seed.searchRun}`)).status).toBe(200);
    expect((await eng.get(`/evidence/${seed.fragment}`)).status).toBe(200);
    // На обновлённой базе работает импорт письма в зарегистрированный ящик.
    const admin = new TestClient(app);
    expect((await admin.login('admin')).status).toBe(200);
    const box = await admin.post('/mailboxes', { system: 'manual', externalAccountId: 'upgrade@example.test', displayName: 'После обновления' }, { headers: { 'Idempotency-Key': `mig-${randomBytes(6).toString('hex')}` } });
    expect(box.status, box.text).toBe(201);
    const etag = (await admin.get(`/mailboxes/${box.body.id}`)).headers.etag as string;
    expect((await admin.put(`/mailboxes/${box.body.id}/access/${seed.eng}`, { capabilities: ['mail.read', 'mail.import'] }, { headers: { 'If-Match': etag } })).status).toBe(200);
    const r = await importEml(eng, makeWorker(db, config), box.body.id, eml({ subject: 'После обновления', text: 'Письмо на обновлённой базе' }));
    expect(r).toMatchObject({ status: 'done', createdRevision: true });
  });
});
