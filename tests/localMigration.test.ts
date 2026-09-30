// Этап 05a: обновление схемы 0013 → 0014 на данных принятого 06a (тест 22 решения владельца): тендер
// с историей из двух прогонов RDWeb, снимок области и прогон поиска, договор с распознанной редакцией.
// Все новые ограничения проверяются на существующих строках; выбор прогона для прежних данных не
// меняется (предпочтительный = хвост цепочки); приложение читает прежние снимок и прогон поиска, а на
// обновлённой базе работает локальное распознавание. Данные до обновления пишутся прямо в БД.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceScopeContentHash, sourceSetContentHash } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, listMigrations, migrate, MIGRATIONS_DIR, preferredRunId, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { ADMIN_URL, createUser, makeApp, TestClient, testConfig, type ITestDb } from './helpers.ts';
import { completeLocalRun, descriptorOf, insertLocalRun, newRevision } from './localRecognitionFixtures.ts';

const name = `kontur_kp_test_upgrade05a_${Date.now().toString(36)}`;
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
  const dir = mkdtempSync(join(tmpdir(), 'kontur-mig05a-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 13)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await m.connect();
  try {
    expect(await migrate(m, { testMode: true, dir })).toHaveLength(13);
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

// Прогон RDWeb с одной распознанной страницей и одним фрагментом по настоящей машине состояний.
const rdwebRun = async (o: { rev: string; tender: string | null; contract: string | null; supersedes: string | null; text: string }) => {
  const zip = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/zip', $2)", [zip, `m/${zip}`]);
  const { id } = await one<{ id: string }>(
    "INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, supersedes_run_id) VALUES ($1, $2, $3, 'rdweb_export', $4, $5) RETURNING id",
    [o.rev, o.tender, o.contract, zip, o.supersedes],
  );
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
  await pool.query("INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status) VALUES ($1, 0, '1', 2480, 3508, 0, 'recognized')", [id]);
  await pool.query(
    `INSERT INTO evidence_fragment (tender_id, contract_id, source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind, fragment_key, ordinal, page_index, text, text_sha256)
     VALUES ($1, $2, 'recognition_run', $3, $3, $4, 'recognized_text', 'text_block', 'b1', 1, 0, $5, $6)`,
    [o.tender, o.contract, id, o.rev, o.text, sha(o.text)],
  );
  await pool.query(
    "UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
    [id],
  );
  return id;
};

const seed06a = async () => {
  const admin = await createUser(pool, 'admin', ['admin'], 'Администратор');
  const eng = await createUser(pool, 'eng1', ['engineer'], 'Инженер 1');
  const { id: tender } = await one<{ id: string }>("INSERT INTO tender (code, title, created_by) VALUES ('U-5', 'Тендер U-5', $1) RETURNING id", [admin]);
  await pool.query("INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, 'engineer', $3)", [tender, eng, admin]);
  const { id: stage } = await one<{ id: string }>("INSERT INTO tender_stage (tender_id, seq, title, created_by) VALUES ($1, 1, 'Этап', $2) RETURNING id", [tender, eng]);
  const pdf = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/pdf', $2)", [pdf, `m/${pdf}`]);
  const { id: doc } = await one<{ id: string }>("INSERT INTO document (tender_id, title, name_key) VALUES ($1, 'тз.pdf', 'тз.pdf') RETURNING id", [tender]);
  const { id: rev } = await one<{ id: string }>(
    'INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, $3, 1, $4) RETURNING id',
    [doc, tender, pdf, eng],
  );
  const first = await rdwebRun({ rev, tender, contract: null, supersedes: null, text: 'Аванс 30 процентов.' });
  const tail = await rdwebRun({ rev, tender, contract: null, supersedes: first, text: 'Аванс 30 процентов, уточнённое распознавание.' });
  const { id: set } = await one<{ id: string }>("INSERT INTO source_set (stage_id, purpose) VALUES ($1, 'working') RETURNING id", [stage]);
  const { id: setRev } = await one<{ id: string }>('INSERT INTO source_set_revision (source_set_id, seq, created_by) VALUES ($1, 1, $2) RETURNING id', [set, eng]);
  await pool.query("INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by) VALUES ($1, $2, 'included', $3)", [setRev, rev, eng]);
  const setHash = sourceSetContentHash([{ documentRevisionId: rev, blobSha256: pdf, inclusion: 'included' }]);
  await pool.query("UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), frozen_by = $2, content_hash = $3, row_version = row_version + 1 WHERE id = $1", [
    setRev,
    eng,
    setHash,
  ]);
  const scopeHash = evidenceScopeContentHash(setHash, [{ unitType: 'document_recognition', documentRevisionId: rev, recognitionRunId: tail }]);
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
      [scope, tender, rev, tail],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  // Договор этапа 06a с распознанной редакцией основного документа.
  const { id: contract } = await one<{ id: string }>("INSERT INTO contract (number, title, created_by) VALUES ('Д-5', 'Договор Д-5', $1) RETURNING id", [eng]);
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
  const crun = await rdwebRun({ rev: crev, tender: null, contract, supersedes: null, text: 'Цена договора 245 000 000.' });
  const { id: version } = await one<{ id: string }>("INSERT INTO search_index_version (seq, chunker_version) VALUES (1, 'c1') RETURNING id", []);
  const { id: searchRun } = await one<{ id: string }>(
    `INSERT INTO search_run (context_kind, tender_id, stage_id, mode, requested_by, query_text, query_sha256, query_normalization_version, result_limit,
                             scope_hash, allowed_source_unit_ids, index_version_id, ranking_version, semantic_status, deadline_at)
     VALUES ('tender', $1, $2, 'working', $3, 'аванс', $4, 'n1', 10, $5, $6::uuid[], $7, 'r1', 'running', now() + interval '1 minute') RETURNING id`,
    [tender, stage, eng, sha('аванс'), scopeHash, [tail], version],
  );
  return { tender, rev, first, tail, scope, crev, crun, searchRun, eng };
};

const TABLES = ['document', 'document_revision', 'recognition_run', 'recognition_page', 'evidence_fragment', 'evidence_scope', 'evidence_scope_item', 'search_run'];
const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`, [])).n;
  return out;
};

describe('обновление схемы 0013 → 0014 (D-024, тест 22)', () => {
  it('данные 06a переживают 0014: ограничения проверены, выбор прогона прежний, приложение читает снимок и поиск', async () => {
    const seed = await seed06a();
    const before = await counts();
    const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
    await m.connect();
    try {
      expect(await migrate(m, { testMode: true })).toEqual(listMigrations().filter((f) => f.version > 13).map((f) => f.version));
      const invalid = await m.query("SELECT conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace");
      expect(invalid.rows).toEqual([]);
    } finally {
      await m.end();
    }
    expect(await counts()).toEqual(before);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM document WHERE recognition_route <> 'auto'", [])).n).toBe(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM recognition_run WHERE recognizer IS NOT NULL OR recognizer_fingerprint IS NOT NULL', [])).n).toBe(0);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM recognition_page WHERE unit_kind <> 'pdf_page'", [])).n).toBe(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM evidence_fragment WHERE locator IS NOT NULL', [])).n).toBe(0);
    // Для истории только из RDWeb предпочтительный прогон — прежний хвост цепочки.
    expect(await preferredRunId(pool, seed.rev)).toBe(seed.tail);
    expect(await preferredRunId(pool, seed.crev)).toBe(seed.crun);
    await pool.query('SELECT evidence_scope_verify($1)', [seed.scope]);
    const db = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool, drop: async () => undefined } as ITestDb;
    const eng = new TestClient(makeApp(db, undefined, testConfig()));
    expect((await eng.login('eng1')).status).toBe(200);
    const scope = await eng.get(`/evidence-scopes/${seed.scope}`);
    expect(scope.status, scope.text).toBe(200);
    expect(scope.body.items).toEqual([expect.objectContaining({ documentRevisionId: seed.rev, recognitionRunId: seed.tail })]);
    const runs = await eng.get(`/document-revisions/${seed.rev}/recognition-runs`);
    expect(runs.body.items.map((r: { id: string; preferred: boolean; outcome: string }) => [r.id, r.preferred, r.outcome])).toEqual(
      expect.arrayContaining([
        [seed.tail, true, 'complete'],
        [seed.first, false, 'complete'],
      ]),
    );
    expect((await eng.get(`/search-runs/${seed.searchRun}`)).status).toBe(200);
    // На обновлённой базе работает локальное распознавание.
    const docx = await newRevision(pool, { tenderId: seed.tender, format: 'docx', userId: seed.eng });
    const local = await insertLocalRun(pool, docx.revisionId, descriptorOf('docx'), null);
    await completeLocalRun(pool, local, [{ kind: 'docx_body' }], ['Договор подряда: аванс 10 процентов.']);
    expect(await preferredRunId(pool, docx.revisionId)).toBe(local);
  });
});
