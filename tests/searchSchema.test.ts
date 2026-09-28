// Среда и вторая линия схемы поиска (этап 05; ADR-002 §1, ADR-012 §3–§7, AR05-01, G05-05):
// гейт локали на базе, созданной штатным путём; отказ миграции на неподходящей среде; мутационные
// проверки — нарушение области, происхождения и размерности падает на уровне БД, а не в коде.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNKER_VERSION, MAX_EMBEDDING_DIM } from '../packages/core/src/index.ts';
import { createVersion, dropDatabase, migrate, MigrationError, parseVector, setupDatabase, SetupError } from '../packages/db/src/index.ts';
import { ADMIN_URL, buildScenario, createTestDb, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fragmentIdOf, seedEvidenceRun, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const ids: Record<string, string> = {};

const urlFor = (user: string, name: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${name}`;
  return u.toString();
};

const withClient = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  ids.revA = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ-A.pdf');
  ids.runA = await seedEvidenceRun(db.pool, ids.revA, {
    pages: [{ stamp: 'Шифр АР-01', blocks: ['Фасад облицовывается керамогранитом', { text: 'Описание схемы моделью', origin: 'model_description' }] }],
  });
  ids.revB = await uploadDocument(db, config, s.eng3, s.stageB, 'ТЗ-B.pdf');
  ids.runB = await seedEvidenceRun(db.pool, ids.revB, { pages: [{ blocks: ['Фасад облицовывается керамогранитом'] }] });
  ids.version = await createVersion(db.pool, { chunkerVersion: CHUNKER_VERSION, embedding: null, createdBy: null });
  const chunk = await db.pool.query<{ id: string }>(
    `INSERT INTO search_chunk (index_version_id, tender_id, source_unit_type, source_unit_id, document_revision_id, page_index, part_no, chunk_key, header_text, body_text, text_sha256)
     VALUES ($1, $2, 'recognition_run', $3, $4, 0, 0, 'k-a', '', 'Фасад', repeat('a', 64)) RETURNING id`,
    [ids.version, s.tenderA, ids.runA, ids.revA],
  );
  ids.chunkA = chunk.rows[0]!.id;
});
afterAll(async () => db.drop());

describe('среда: версия PostgreSQL и локаль базы (ADR-002 §1, AR05-01)', () => {
  it('база, созданная штатным путём, — провайдер builtin C.UTF-8; регистр кириллицы приводится', async () => {
    const r = await db.pool.query<{ provider: string; locale: string | null; eq: boolean; low: string }>(
      `SELECT d.datlocprovider AS provider, d.datlocale AS locale,
              to_tsvector('russian', 'Договор') = to_tsvector('russian', 'договор') AS eq, lower('ДОГОВОР') AS low
         FROM pg_database d WHERE d.datname = current_database()`,
    );
    expect(r.rows[0]).toEqual({ provider: 'b', locale: 'C.UTF-8', eq: true, low: 'договор' });
  });

  it('migrate отказывает на PostgreSQL ниже 17 с внятной причиной', async () => {
    const fake = {
      query: async (sql: string) => {
        if (sql.includes('current_database')) return { rows: [{ name: 'kontur_kp_test_fake' }] };
        if (sql.includes('server_version_num')) return { rows: [{ v: '160004' }] };
        throw new Error(`неожиданный запрос: ${sql}`);
      },
    } as unknown as pg.ClientBase;
    await expect(migrate(fake, { testMode: true })).rejects.toThrow(MigrationError);
    await expect(migrate(fake, { testMode: true })).rejects.toThrow(/ниже 17/u);
  });

  it('база с libc-локалью C: db:setup отказывает, миграция поиска не применяется', async () => {
    const name = 'kontur_kp_test_libc';
    await withClient(ADMIN_URL, async (a) => {
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.query(`CREATE DATABASE ${name} OWNER kontur_migrator ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C' TEMPLATE template0`);
    });
    try {
      await expect(setupDatabase(ADMIN_URL, name)).rejects.toThrow(SetupError);
      await withClient(urlFor('postgres', name), async (a) => {
        await a.query('CREATE EXTENSION vector');
        await a.query('CREATE EXTENSION pg_trgm');
        await a.query('GRANT USAGE, CREATE ON SCHEMA public TO kontur_migrator');
      });
      await withClient(urlFor('kontur_migrator', name), async (m) => {
        await expect(migrate(m, { testMode: true })).rejects.toThrow(/0009_search_index.*регистр кириллицы/su);
      });
    } finally {
      await dropDatabase(ADMIN_URL, name);
    }
  });

  it('без расширения vector миграция поиска падает с указанием db:setup', async () => {
    const name = 'kontur_kp_test_novector';
    await withClient(ADMIN_URL, async (a) => {
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.query(`CREATE DATABASE ${name} OWNER kontur_migrator LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' ENCODING 'UTF8' TEMPLATE template0`);
    });
    try {
      await withClient(urlFor('postgres', name), (a) => a.query('GRANT USAGE, CREATE ON SCHEMA public TO kontur_migrator'));
      await withClient(urlFor('kontur_migrator', name), async (m) => {
        await expect(migrate(m, { testMode: true })).rejects.toThrow(/нет расширения vector/u);
      });
    } finally {
      await dropDatabase(ADMIN_URL, name);
    }
  });
});

describe('вторая линия: область, происхождение и размерность в схеме (ADR-012 §3, §6, §22)', () => {
  it('связь чанка с фрагментом чужой единицы или чужого тендера непредставима', async () => {
    const foreign = await fragmentIdOf(db.pool, ids.runB!, 'Фасад облицовывается керамогранитом');
    await expect(
      db.pool.query(
        `INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, tender_id, fragment_id, ordinal, role, char_start, char_end)
         VALUES ($1, $2, $3, $4, $5, 0, 'body', 0, 5)`,
        [ids.chunkA, ids.version, ids.runA, s.tenderA, foreign],
      ),
    ).rejects.toThrow(/search_chunk_fragment_fragment_fk/u);
    // Подмена единицы в самой связи тоже не проходит: связь обязана совпасть с чанком.
    await expect(
      db.pool.query(
        `INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, tender_id, fragment_id, ordinal, role, char_start, char_end)
         VALUES ($1, $2, $3, $4, $5, 0, 'body', 0, 5)`,
        [ids.chunkA, ids.version, ids.runB, s.tenderB, foreign],
      ),
    ).rejects.toThrow(/search_chunk_fragment_chunk_fk/u);
  });

  it('чанк единицы чужого тендера непредставим', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO search_chunk (index_version_id, tender_id, source_unit_type, source_unit_id, document_revision_id, part_no, chunk_key, body_text, text_sha256)
         VALUES ($1, $2, 'recognition_run', $3, $4, 0, 'k-x', 'x', repeat('a', 64))`,
        [ids.version, s.tenderA, ids.runB, ids.revB],
      ),
    ).rejects.toThrow(/search_chunk_unit_fk/u);
  });

  it('описание модели не связывается с чанком (I06)', async () => {
    const described = await fragmentIdOf(db.pool, ids.runA!, 'Описание схемы моделью');
    await expect(
      db.pool.query(
        `INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, tender_id, fragment_id, ordinal, role, char_start, char_end)
         VALUES ($1, $2, $3, $4, $5, 1, 'body', 0, 5)`,
        [ids.chunkA, ids.version, ids.runA, s.tenderA, described],
      ),
    ).rejects.toThrow(/недоказательного происхождения/u);
  });

  it('вектор версии без модели и вектор чужой размерности непредставимы', async () => {
    await expect(
      db.pool.query(`INSERT INTO search_chunk_vector (chunk_id, index_version_id, source_unit_id, tender_id, dim, embedding) VALUES ($1, $2, $3, $4, 3, '[1,2,3]')`, [
        ids.chunkA,
        ids.version,
        ids.runA,
        s.tenderA,
      ]),
    ).rejects.toThrow(/search_chunk_vector_dim_fk/u);
    await expect(
      db.pool.query(`INSERT INTO search_chunk_vector (chunk_id, index_version_id, source_unit_id, tender_id, dim, embedding) VALUES ($1, $2, $3, $4, 4, '[1,2,3]')`, [
        ids.chunkA,
        ids.version,
        ids.runA,
        s.tenderA,
      ]),
    ).rejects.toThrow(/search_chunk_vector_dim_shape|search_chunk_vector_dim_fk/u);
  });

  it('параметры версии неизменны, переходы — только по машине состояний, удаления нет', async () => {
    await expect(db.pool.query("UPDATE search_index_version SET chunker_version = 'x', row_version = row_version + 1 WHERE id = $1", [ids.version])).rejects.toThrow(
      /параметры версии неизменны/u,
    );
    await expect(db.pool.query("UPDATE search_index_version SET status = 'retired', retired_at = now(), row_version = row_version + 1 WHERE id = $1", [ids.version])).rejects.toThrow(
      /недопустимый переход/u,
    );
    await expect(db.pool.query('DELETE FROM search_index_version WHERE id = $1', [ids.version])).rejects.toThrow(/permission denied|не удаляется/u);
    await expect(createVersion(db.pool, { chunkerVersion: CHUNKER_VERSION, embedding: null, createdBy: null })).rejects.toThrow(/search_index_version_building_key/u);
  });

  it('прогон поиска: создаётся только pending, единицы — только своего тендера; результат — только из закреплённой области', async () => {
    const base = [s.tenderA, s.ids.eng1, ids.version];
    const insert = (status: string, units: string[]) =>
      db.pool.query(
        `INSERT INTO search_run (context_kind, tender_id, stage_id, mode, requested_by, query_text, query_sha256, query_normalization_version,
                                 result_limit, scope_hash, allowed_source_unit_ids, index_version_id, ranking_version, status, semantic_status, deadline_at)
         VALUES ('tender', $1, $4, 'working', $2, 'q', repeat('a', 64), 'q1', 10, repeat('b', 64), $5::uuid[], $3, 'r1', $6, 'running', now() + interval '1 minute')
         RETURNING id`,
        [...base, s.stageA, units, status],
      );
    await expect(insert('complete', [ids.runA!])).rejects.toThrow(/создаётся в состоянии pending|search_run_finished_shape/u);
    await expect(insert('pending', [ids.runB!])).rejects.toThrow(/не принадлежит тендеру/u);
    const run = (await insert('pending', [ids.runA!])).rows[0]!.id;
    const foreign = await fragmentIdOf(db.pool, ids.runB!, 'Фасад облицовывается керамогранитом');
    await expect(
      db.pool.query("INSERT INTO search_run_result (run_id, branch, rank, fragment_id, origin, score) VALUES ($1, 'fts', 1, $2, 'recognized_text', 1)", [run, foreign]),
    ).rejects.toThrow(/вне закреплённой области/u);
    const described = await fragmentIdOf(db.pool, ids.runA!, 'Описание схемы моделью');
    await expect(
      db.pool.query("INSERT INTO search_run_result (run_id, branch, rank, fragment_id, origin, score) VALUES ($1, 'fts', 1, $2, 'model_description', 1)", [run, described]),
    ).rejects.toThrow(/недоказательного происхождения/u);
    await expect(db.pool.query("UPDATE search_run SET query_text = 'другой' WHERE id = $1", [run])).rejects.toThrow(/закреплённые поля/u);
  });
});

describe('граничная размерность halfvec при STORAGE PLAIN (G05-05)', () => {
  it(`вектор размерности ${MAX_EMBEDDING_DIM} со всеми служебными колонками записывается и читается; ${MAX_EMBEDDING_DIM + 1} — нет`, async () => {
    const storage = await db.pool.query<{ attstorage: string }>(
      "SELECT attstorage FROM pg_attribute WHERE attrelid = 'search_chunk_vector'::regclass AND attname = 'embedding'",
    );
    expect(storage.rows[0]!.attstorage).toBe('p');
    const probe = Array.from({ length: MAX_EMBEDDING_DIM }, (_, i) => ((i % 97) - 48) / 64);
    // Отдельная версия с моделью наибольшей допустимой размерности (строящаяся уже есть — выводим её).
    await db.pool.query("UPDATE search_index_version SET status = 'failed', failure_code = 'test', row_version = row_version + 1 WHERE id = $1", [ids.version]);
    const v = await createVersion(db.pool, {
      chunkerVersion: CHUNKER_VERSION,
      embedding: { inputVersion: 'plain:2000:1', model: 'max-dim', fingerprint: 'f'.repeat(64), dim: MAX_EMBEDDING_DIM, probe },
      createdBy: null,
    });
    const chunk = await db.pool.query<{ id: string }>(
      `INSERT INTO search_chunk (index_version_id, tender_id, source_unit_type, source_unit_id, document_revision_id, page_index, part_no, chunk_key, header_text, body_text, text_sha256)
       VALUES ($1, $2, 'recognition_run', $3, $4, 0, 0, 'k-max', '', 'Фасад', repeat('a', 64)) RETURNING id`,
      [v, s.tenderA, ids.runA, ids.revA],
    );
    await db.pool.query(
      `INSERT INTO search_chunk_vector (chunk_id, index_version_id, source_unit_id, tender_id, dim, embedding) VALUES ($1, $2, $3, $4, $5, $6::halfvec)`,
      [chunk.rows[0]!.id, v, ids.runA, s.tenderA, MAX_EMBEDDING_DIM, `[${probe.join(',')}]`],
    );
    const back = await db.pool.query<{ e: string; size: number }>('SELECT embedding::text AS e, pg_column_size(t.*) AS size FROM search_chunk_vector t WHERE chunk_id = $1', [chunk.rows[0]!.id]);
    const read = parseVector(back.rows[0]!.e)!;
    expect(read).toHaveLength(MAX_EMBEDDING_DIM);
    // halfvec хранит половинную точность: значения фикстуры в ней представимы точно.
    expect(read).toEqual(probe);
    expect(back.rows[0]!.size).toBeLessThan(8160);
    await db.pool.query(
      `INSERT INTO embedding_cache (text_sha256, purpose, embedding_model, embedding_model_fingerprint, embedding_input_version, dim, embedding)
       VALUES (repeat('c', 64), 'index', 'max-dim', repeat('f', 64), 'plain:2000:1', $1, $2::halfvec)`,
      [MAX_EMBEDDING_DIM, `[${probe.join(',')}]`],
    );
    const tooBig = `[${[...probe, 0.5].join(',')}]`;
    await expect(
      db.pool.query(
        `INSERT INTO embedding_cache (text_sha256, purpose, embedding_model, embedding_model_fingerprint, embedding_input_version, dim, embedding)
         VALUES (repeat('d', 64), 'index', 'max-dim', repeat('f', 64), 'plain:2000:1', $1, $2::halfvec)`,
        [MAX_EMBEDDING_DIM + 1, tooBig],
      ),
    ).rejects.toThrow(/dim|check/iu);
  });
});
