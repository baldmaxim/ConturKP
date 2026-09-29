// Этап 06a: обновление схемы 0011 → 0012 на базе с данными этапов 03–05 — документ, редакция, происхождение,
// прогон распознавания, фрагмент, индекс, состав этапа, снимок области и прогон поиска. Миграция 0012 меняет
// десять таблиц цепочки (D-023): новые FK и CHECK проверяются на существующих строках, снимок пересобирает
// генерируемую колонку. Данные до обновления пишутся прямо в БД — код приложения работает только на
// актуальной схеме (сервер при расхождении не стартует).
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceScopeContentHash, sourceSetContentHash } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, listMigrations, migrate, MIGRATIONS_DIR, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { ADMIN_URL, createUser, makeApp, TestClient, testConfig, type ITestDb } from './helpers.ts';

const name = `kontur_kp_test_upgrade06a_${Date.now().toString(36)}`;
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
  const dir = mkdtempSync(join(tmpdir(), 'kontur-mig06-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 11)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await m.connect();
  try {
    expect(await migrate(m, { testMode: true, dir })).toHaveLength(11);
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

// Цепочка этапов 03–05 одного тендера: всё, что миграция 0012 меняет или от чего зависит.
const seedStage05 = async () => {
  const admin = await createUser(pool, 'admin', ['admin'], 'Администратор');
  const eng = await createUser(pool, 'eng1', ['engineer'], 'Инженер 1');
  const { id: tender } = await one<{ id: string }>("INSERT INTO tender (code, title, created_by) VALUES ('M-1', 'Тендер M-1', $1) RETURNING id", [admin]);
  await pool.query("INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, 'engineer', $3)", [tender, eng, admin]);
  const { id: stage } = await one<{ id: string }>("INSERT INTO tender_stage (tender_id, seq, title, created_by) VALUES ($1, 1, 'Этап', $2) RETURNING id", [tender, eng]);
  const pdf = randomBytes(32).toString('hex');
  const zip = randomBytes(32).toString('hex');
  for (const [s, type] of [[pdf, 'application/pdf'], [zip, 'application/zip']] as const) {
    await pool.query('INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, $2, $3)', [s, type, `m/${s}`]);
  }
  const { id: doc } = await one<{ id: string }>("INSERT INTO document (tender_id, title, name_key) VALUES ($1, 'тз.pdf', 'тз.pdf') RETURNING id", [tender]);
  const { id: rev } = await one<{ id: string }>(
    'INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, $3, 1, $4) RETURNING id',
    [doc, tender, pdf, eng],
  );
  await pool.query("INSERT INTO document_occurrence (document_revision_id, tender_id, source_kind, source_locator, observed_name) VALUES ($1, $2, 'upload', 'upload:тз.pdf', 'тз.pdf')", [rev, tender]);
  const { id: run } = await one<{ id: string }>(
    "INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256) VALUES ($1, $2, 'rdweb_export', $3) RETURNING id",
    [rev, tender, zip],
  );
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [run]);
  await pool.query("INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status) VALUES ($1, 0, '1', 2480, 3508, 0, 'recognized')", [run]);
  const text = 'Аванс составляет 30 процентов.';
  const { id: fragment } = await one<{ id: string }>(
    `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind, fragment_key, ordinal, page_index, text, text_sha256)
     VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', 'b1', 1, 0, $4, $5) RETURNING id`,
    [tender, run, rev, text, sha(text)],
  );
  await pool.query(
    "UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
    [run],
  );
  const { id: set } = await one<{ id: string }>("INSERT INTO source_set (stage_id, purpose) VALUES ($1, 'working') RETURNING id", [stage]);
  const { id: setRev } = await one<{ id: string }>('INSERT INTO source_set_revision (source_set_id, seq, created_by) VALUES ($1, 1, $2) RETURNING id', [set, eng]);
  await pool.query("INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by) VALUES ($1, $2, 'included', $3)", [setRev, rev, eng]);
  const setHash = sourceSetContentHash([{ documentRevisionId: rev, blobSha256: pdf, inclusion: 'included' }]);
  await pool.query(
    "UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), frozen_by = $2, content_hash = $3, row_version = row_version + 1 WHERE id = $1",
    [setRev, eng, setHash],
  );
  const scopeHash = evidenceScopeContentHash(setHash, [{ unitType: 'document_recognition', documentRevisionId: rev, recognitionRunId: run }]);
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
      [scope, tender, rev, run],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const { id: version } = await one<{ id: string }>("INSERT INTO search_index_version (seq, chunker_version) VALUES (1, 'c1') RETURNING id", []);
  const { id: chunk } = await one<{ id: string }>(
    `INSERT INTO search_chunk (index_version_id, tender_id, source_unit_type, source_unit_id, document_revision_id, page_index, part_no, chunk_key, body_text, text_sha256)
     VALUES ($1, $2, 'recognition_run', $3, $4, 0, 0, 'k1', $5, $6) RETURNING id`,
    [version, tender, run, rev, text, sha(text)],
  );
  await pool.query(
    "INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, tender_id, fragment_id, ordinal, role, char_start, char_end) VALUES ($1, $2, $3, $4, $5, 0, 'body', 0, 10)",
    [chunk, version, run, tender, fragment],
  );
  await pool.query(
    "INSERT INTO search_index_unit (index_version_id, source_unit_type, source_unit_id, tender_id, chunks, fragments_indexed, fragments_skipped) VALUES ($1, 'recognition_run', $2, $3, 1, 1, 0)",
    [version, run, tender],
  );
  const { id: searchRun } = await one<{ id: string }>(
    `INSERT INTO search_run (context_kind, tender_id, stage_id, mode, requested_by, query_text, query_sha256, query_normalization_version, result_limit,
                             scope_hash, allowed_source_unit_ids, index_version_id, ranking_version, semantic_status, deadline_at)
     VALUES ('tender', $1, $2, 'working', $3, 'аванс', $4, 'n1', 10, $5, $6::uuid[], $7, 'r1', 'running', now() + interval '1 minute') RETURNING id`,
    [tender, stage, eng, sha('аванс'), scopeHash, [run], version],
  );
  await pool.query("INSERT INTO search_run_result (run_id, branch, rank, fragment_id, origin, score) VALUES ($1, 'fused', 1, $2, 'recognized_text', 1)", [searchRun, fragment]);
  await pool.query("UPDATE search_run SET status = 'degraded', semantic_status = 'unavailable', semantic_reason = 'index_without_embeddings', finished_at = now() WHERE id = $1", [searchRun]);
  return { tender, rev, run, scope, searchRun };
};

const TABLES = [
  'document',
  'document_revision',
  'document_occurrence',
  'recognition_run',
  'evidence_fragment',
  'search_index_unit',
  'search_chunk',
  'search_chunk_fragment',
  'evidence_scope',
  'evidence_scope_item',
  'search_run',
  'search_run_result',
];

const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`, [])).n;
  return out;
};

describe('обновление схемы 0011 → 0012 (D-023, ADR-002 §5)', () => {
  it('данные этапов 03–05 переживают 0012 без изменений: владелец — тендер, снимок и прогон поиска целы', async () => {
    const seed = await seedStage05();
    const before = await counts();
    const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
    await m.connect();
    try {
      expect(await migrate(m, { testMode: true })).toEqual(listMigrations().filter((f) => f.version > 11).map((f) => f.version));
      // Все новые ограничения проверены на существующих строках, а не добавлены NOT VALID.
      const invalid = await m.query("SELECT conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace");
      expect(invalid.rows).toEqual([]);
    } finally {
      await m.end();
    }
    expect(await counts()).toEqual(before);
    for (const t of ['document', 'document_revision', 'recognition_run', 'evidence_fragment', 'search_index_unit', 'search_chunk', 'search_chunk_fragment']) {
      const r = await one<{ bad: number }>(`SELECT count(*) FILTER (WHERE contract_id IS NOT NULL OR tender_id IS DISTINCT FROM $1)::int AS bad FROM ${t}`, [seed.tender]);
      expect(r.bad, t).toBe(0);
    }
    expect(await one('SELECT contract_id, unit_tender_id FROM evidence_scope_item WHERE scope_id = $1', [seed.scope])).toEqual({ contract_id: null, unit_tender_id: seed.tender });
    await pool.query('SELECT evidence_scope_verify($1)', [seed.scope]);
    expect(await one('SELECT context_kind, tender_id, contract_id FROM search_run WHERE id = $1', [seed.searchRun])).toEqual({
      context_kind: 'tender',
      tender_id: seed.tender,
      contract_id: null,
    });
    // Приложение на обновлённой базе читает прежние снимок и прогон поиска.
    const db = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool, drop: async () => undefined } as ITestDb;
    const eng = new TestClient(makeApp(db, undefined, testConfig()));
    expect((await eng.login('eng1')).status).toBe(200);
    const scope = await eng.get(`/evidence-scopes/${seed.scope}`);
    expect(scope.status, scope.text).toBe(200);
    expect(scope.body.items).toEqual([expect.objectContaining({ documentRevisionId: seed.rev, contractId: null, restricted: false, recognitionRunId: seed.run })]);
    const run = await eng.get(`/search-runs/${seed.searchRun}`);
    expect(run.status, run.text).toBe(200);
    expect(run.body).toMatchObject({ status: 'degraded', context: { kind: 'tender', tenderId: seed.tender, contractId: null } });
    expect(run.body.fused.items).toHaveLength(1);
  });
});
