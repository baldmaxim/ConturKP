// Этап 06a: инварианты БД владения договора (AD-06a-1 §13, матрица docs/architecture/06a-ownership-chain.md §7).
// Каждая проверка — прямой операцией под ролью приложения (или владельцем схемы, где у приложения нет
// права): вторая линия держит инвариант без кода API. Данные — через API, как у пользователя.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, linkContract, setAccess, uploadContractRevision, uploadMain } from './contractFixtures.ts';
import { buildScenario, createTestDb, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
let c1: string;
let c2: string;
let main1: { documentId: string; revisionId: string };
let main2: { documentId: string; revisionId: string };
let tenderRev: string;
let tenderDoc: string;
let runC1: string;
let runC2: string;
let runT: string;
let scope1: string;
let versionId: string;

const config = testConfig();

// Код ошибки PostgreSQL или 'ok'.
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

const newBlob = async (): Promise<string> => {
  const sha = randomBytes(32).toString('hex');
  await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/pdf', $2)", [sha, `s06a/${sha}`]);
  return sha;
};

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  await grantCreator(s.admin, s.ids.manager);
  c1 = await createContract(s.manager, 'С-1');
  c2 = await createContract(s.manager, 'С-2');
  await setAccess(s.admin, c1, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  main1 = await uploadMain(s.manager, c1, 'договор-1.pdf', fakePdf('договор 1'));
  main2 = await uploadMain(s.manager, c2, 'договор-2.pdf', fakePdf('договор 2'));
  await linkContract(s.manager, c1, s.tenderA);
  tenderRev = await uploadDocument(db, config, s.eng1, s.stageA, 'тз.pdf');
  tenderDoc = (await db.pool.query<{ document_id: string }>('SELECT document_id FROM document_revision WHERE id = $1', [tenderRev])).rows[0]!.document_id;
  runC1 = await seedEvidenceRun(db.pool, main1.revisionId, { pages: [{ blocks: ['Аванс составляет 30 процентов цены договора.'] }] });
  runC2 = await seedEvidenceRun(db.pool, main2.revisionId, { pages: [{ blocks: ['Неустойка 0,1 процента в день.'] }] });
  runT = await seedEvidenceRun(db.pool, tenderRev, { pages: [{ blocks: ['Техническое задание на фасад.'] }] });
  await setWorkingSet(s.manager, s.stageA, [tenderRev, main1.revisionId], true);
  scope1 = await fixScope(s.manager, s.stageA);
  versionId = (await db.pool.query<{ id: string }>("INSERT INTO search_index_version (seq, chunker_version) VALUES (900, 'test') RETURNING id")).rows[0]!.id;
});
afterAll(async () => {
  await db.drop();
});

describe('владелец документа (AD-06a-1 §5, §13 п. 1–4)', () => {
  it('1–2: у документа ровно один владелец; тендерный не становится договорным и наоборот', async () => {
    expect(await q("INSERT INTO document (tender_id, contract_id, contract_role, title, name_key) VALUES ($1, $2, 'contract', 'x', 'x')", [s.tenderA, c2])).toBe('23514');
    expect(await q('UPDATE document SET contract_id = $2 WHERE id = $1', [tenderDoc, c1])).toBe('55000');
    expect(await q('UPDATE document SET tender_id = $2 WHERE id = $1', [main1.documentId, s.tenderA])).toBe('55000');
    expect(await q("UPDATE document SET contract_role = 'appendix' WHERE id = $1", [main1.documentId])).toBe('55000');
  });

  it('3: документ без владельца, роль у тендерного и документ договора без роли не записываются', async () => {
    expect(await q("INSERT INTO document (title, name_key) VALUES ('x', 'x')")).toBe('23514');
    expect(await q("INSERT INTO document (tender_id, contract_role, title, name_key) VALUES ($1, 'appendix', 'x', 'x')", [s.tenderA])).toBe('23514');
    expect(await q("INSERT INTO document (contract_id, title, name_key) VALUES ($1, 'x', 'x')", [c2])).toBe('23514');
  });

  it('4: contract_id обязан существовать', async () => {
    expect(await q("INSERT INTO document (contract_id, contract_role, title, name_key) VALUES (gen_random_uuid(), 'contract', 'x', 'x')")).toBe('23503');
  });

  it('основной документ у договора один; допсоглашение ссылается только на основной документ своего договора', async () => {
    expect(await q("INSERT INTO document (contract_id, contract_role, title, name_key) VALUES ($1, 'contract', 'второй', 'x')", [c1])).toBe('23505');
    expect(await q("INSERT INTO document (contract_id, contract_role, main_document_id, title, name_key) VALUES ($1, 'addendum', $2, 'дс', 'x')", [c1, main2.documentId])).toBe('23503');
    const app = await db.pool.query<{ id: string }>(
      "INSERT INTO document (contract_id, contract_role, main_document_id, title, name_key) VALUES ($1, 'appendix', $2, 'прил', 'x') RETURNING id",
      [c1, main1.documentId],
    );
    expect(await q("INSERT INTO document (contract_id, contract_role, main_document_id, title, name_key) VALUES ($1, 'addendum', $2, 'дс', 'x')", [c1, app.rows[0]!.id])).toBe('23503');
    expect(await q("INSERT INTO document (contract_id, contract_role, title, name_key) VALUES ($1, 'addendum', 'дс', 'x')", [c1])).toBe('23514');
  });
});

describe('редакция, распознавание, индекс (AD-06a-1 §6, §9, §13 п. 5–7, 10)', () => {
  it('5: договор не удаляется — редакции не осиротеют', async () => {
    expect(await q('DELETE FROM contract WHERE id = $1', [c2])).toBe('42501');
    expect(await asOwner((c) => code(c.query('DELETE FROM contract WHERE id = $1', [c2])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('TRUNCATE contract CASCADE')))).toBe('55000');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM document_revision WHERE contract_id = $1', [c2])).rows[0].n).toBe(1);
  });

  it('6: владелец редакции не меняется задним числом; редакция не записывается чужому владельцу документа', async () => {
    expect(await q('UPDATE document_revision SET contract_id = $2 WHERE id = $1', [main1.revisionId, c2])).toBe('42501');
    expect(await asOwner((c) => code(c.query('UPDATE document_revision SET contract_id = $2 WHERE id = $1', [main1.revisionId, c2])))).toBe('55000');
    const sha = await newBlob();
    expect(await q('INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq) VALUES ($1, $2, $3, 9)', [main1.documentId, s.tenderA, sha])).toBe('23503');
    expect(await q('INSERT INTO document_revision (document_id, contract_id, blob_sha256, revision_seq) VALUES ($1, $2, $3, 9)', [main1.documentId, c2, sha])).toBe('23503');
    expect(await q('INSERT INTO document_revision (document_id, contract_id, blob_sha256, revision_seq) VALUES ($1, $2, $3, 9)', [tenderDoc, c1, sha])).toBe('23503');
    expect(await q('INSERT INTO document_revision (document_id, blob_sha256, revision_seq) VALUES ($1, $2, 9)', [main1.documentId, sha])).toBe('23514');
  });

  it('7: прогон не ссылается на редакцию другого владельца поддельным ID', async () => {
    const sha = await newBlob();
    // Подложный прогон встаёт за хвостом истории редакции: иначе его раньше FK отсечёт охранник линейности (R04-12).
    const tail = (rev: string) => (rev === tenderRev ? runT : runC1);
    const ins = (rev: string, tender: string | null, contract: string | null) =>
      q(
        `INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, supersedes_run_id)
         VALUES ($1, $2, $3, 'rdweb_export', $4, $5)`,
        [rev, tender, contract, sha, tail(rev)],
      );
    expect(await ins(main1.revisionId, s.tenderA, null)).toBe('23503');
    expect(await ins(main1.revisionId, null, c2)).toBe('23503');
    expect(await ins(tenderRev, null, c1)).toBe('23503');
    expect(await ins(main1.revisionId, s.tenderA, c1)).toBe('23514');
    expect(await ins(main1.revisionId, null, null)).toBe('23514');
    const frag = (run: string, rev: string, tender: string | null, contract: string | null) =>
      q(
        `INSERT INTO evidence_fragment (tender_id, contract_id, source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind,
                                        fragment_key, text, text_sha256)
         VALUES ($3, $4, 'recognition_run', $1, $1, $2, 'recognized_text', 'text_block', 'forged', 'x', repeat('0', 64))`,
        [run, rev, tender, contract],
      );
    // Фрагменты принимает только прогон в состоянии running (этап 04): временные прогоны за хвостом истории.
    const running = async (rev: string) => {
      const r = await db.pool.query<{ id: string }>(
        `INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, supersedes_run_id)
         SELECT dr.id, dr.tender_id, dr.contract_id, 'rdweb_export', $2, $3 FROM document_revision dr WHERE dr.id = $1 RETURNING id`,
        [rev, sha, tail(rev)],
      );
      await db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [r.rows[0]!.id]);
      return r.rows[0]!.id;
    };
    const rc = await running(main1.revisionId);
    const rt = await running(tenderRev);
    expect(await frag(rc, main1.revisionId, s.tenderA, null)).toBe('23503');
    expect(await frag(rc, main1.revisionId, null, c2)).toBe('23503');
    expect(await frag(rt, tenderRev, null, c1)).toBe('23503');
    expect(await frag(rc, main1.revisionId, null, null)).toBe('23514');
    expect(await frag(rc, main1.revisionId, null, c1)).toBe('ok');
    await db.pool.query("UPDATE recognition_run SET status = 'cancelled', finished_at = now(), row_version = row_version + 1 WHERE id = ANY($1::uuid[])", [[rc, rt]]);
    const own = await db.pool.query('SELECT tender_id, contract_id FROM recognition_run WHERE id = $1', [runC1]);
    expect(own.rows[0]).toEqual({ tender_id: null, contract_id: c1 });
  });

  it('10: строку индекса нельзя привязать к чужому договору или к тендеру', async () => {
    const chunk = (unit: string, rev: string, tender: string | null, contract: string | null, key: string) =>
      q(
        `INSERT INTO search_chunk (index_version_id, tender_id, contract_id, source_unit_type, source_unit_id, document_revision_id, part_no, chunk_key, body_text, text_sha256)
         VALUES ($1, $2, $3, 'recognition_run', $4, $5, 0, $6, 'x', repeat('0', 64))`,
        [versionId, tender, contract, unit, rev, key],
      );
    expect(await chunk(runC1, main1.revisionId, null, c2, 'k1')).toBe('23503');
    expect(await chunk(runC1, main1.revisionId, s.tenderA, null, 'k2')).toBe('23503');
    expect(await chunk(runT, tenderRev, null, c1, 'k3')).toBe('23503');
    expect(await chunk(runC1, main1.revisionId, null, null, 'k4')).toBe('23514');
    expect(await chunk(runC1, main1.revisionId, null, c1, 'k5')).toBe('ok');
    const unit = (run: string, tender: string | null, contract: string | null) =>
      q(
        `INSERT INTO search_index_unit (index_version_id, source_unit_type, source_unit_id, tender_id, contract_id, chunks, fragments_indexed, fragments_skipped)
         VALUES ($1, 'recognition_run', $2, $3, $4, 0, 0, 0)`,
        [versionId, run, tender, contract],
      );
    expect(await unit(runC1, s.tenderA, null)).toBe('23503');
    expect(await unit(runC2, null, c1)).toBe('23503');
    expect(await unit(runC1, null, c1)).toBe('ok');
    const chunkId = (await db.pool.query<{ id: string }>("SELECT id FROM search_chunk WHERE chunk_key = 'k5'")).rows[0]!.id;
    const fragOfC2 = (await db.pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE run_id = $1 LIMIT 1', [runC2])).rows[0]!.id;
    const link = (fragment: string, contract: string) =>
      q(
        `INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, contract_id, fragment_id, ordinal, role, char_start, char_end)
         VALUES ($1, $2, $3, $4, $5, 0, 'body', 0, 1)`,
        [chunkId, versionId, runC1, contract, fragment],
      );
    expect(await link(fragOfC2, c1)).toBe('23503');
    expect(await link(fragOfC2, c2)).toBe('23503');
  });
});

describe('связь, снимок и архив (AD-06a-1 §8, §13 п. 8–9, 11–14)', () => {
  it('8: снимок принимает редакцию договора — с владельцем-договором, выведенным из редакции', async () => {
    const items = await db.pool.query('SELECT document_revision_id, contract_id, unit_tender_id, tender_id FROM evidence_scope_item WHERE scope_id = $1 ORDER BY contract_id NULLS FIRST', [scope1]);
    expect(items.rows).toEqual([
      { document_revision_id: tenderRev, contract_id: null, unit_tender_id: s.tenderA, tender_id: s.tenderA },
      { document_revision_id: main1.revisionId, contract_id: c1, unit_tender_id: null, tender_id: s.tenderA },
    ]);
  });

  it('единица договора без владельца-договора в снимок не записывается (FK на редакцию тендера)', async () => {
    const scope = (await db.pool.query<{ source_set_revision_id: string; stage_id: string }>('SELECT source_set_revision_id, stage_id FROM evidence_scope WHERE id = $1', [scope1])).rows[0]!;
    const client = new pg.Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const sc = await client.query<{ id: string }>(
        `INSERT INTO evidence_scope (stage_id, tender_id, source_set_revision_id, input_version, content_hash, created_by)
         VALUES ($1, $2, $3, 0, repeat('a', 64), $4) RETURNING id`,
        [scope.stage_id, s.tenderA, scope.source_set_revision_id, s.ids.manager],
      );
      const r = await code(
        client.query(
          `INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, document_revision_id, recognition_run_id, inclusion_reason)
           VALUES ($1, $2, 'document_recognition', $3, $4, 'forged')`,
          [sc.rows[0]!.id, s.tenderA, main1.revisionId, runC1],
        ),
      );
      expect(r).toBe('23503');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('9: исторический снимок сохраняет старую редакцию после появления новой', async () => {
    const v2 = await uploadContractRevision(s.manager, main1.documentId, 'договор-1.pdf', fakePdf('договор 1, редакция 2'));
    expect(v2.status, v2.text).toBe(201);
    const items = await db.pool.query('SELECT document_revision_id FROM evidence_scope_item WHERE scope_id = $1 AND contract_id = $2', [scope1, c1]);
    expect(items.rows).toEqual([{ document_revision_id: main1.revisionId }]);
    const again = await s.manager.get(`/evidence-scopes/${scope1}`);
    expect(again.body.items.find((i: { contractId: string | null }) => i.contractId === c1)).toMatchObject({ documentRevisionId: main1.revisionId, revisionSeq: 1 });
  });

  it('11–12: договор связан с двумя тендерами, тендер — с двумя договорами', async () => {
    expect(await q('INSERT INTO contract_tender (contract_id, tender_id, confirmed_by) VALUES ($1, $2, $3)', [c1, s.tenderB, s.ids.manager])).toBe('ok');
    expect(await q('INSERT INTO contract_tender (contract_id, tender_id, confirmed_by) VALUES ($1, $2, $3)', [c2, s.tenderA, s.ids.manager])).toBe('ok');
    expect(await q('INSERT INTO contract_tender (contract_id, tender_id, confirmed_by) VALUES ($1, $2, $3)', [c1, s.tenderA, s.ids.manager])).toBe('23505');
  });

  it('13: архив и попытка удаления связи не меняют владельца исторической редакции и снимок', async () => {
    const before = await db.pool.query('SELECT content_hash FROM evidence_scope WHERE id = $1', [scope1]);
    await db.pool.query(
      "UPDATE contract_tender SET status = 'archived', archived_at = now(), archived_by = $3, archive_reason = 'тест' WHERE contract_id = $1 AND tender_id = $2",
      [c1, s.tenderA, s.ids.manager],
    );
    expect(await q('DELETE FROM contract_tender WHERE contract_id = $1 AND tender_id = $2', [c1, s.tenderA])).toBe('42501');
    expect(await asOwner((c) => code(c.query('DELETE FROM contract_tender WHERE contract_id = $1 AND tender_id = $2', [c1, s.tenderA])))).toBe('55000');
    expect(await q('UPDATE contract_tender SET tender_id = $3 WHERE contract_id = $1 AND tender_id = $2', [c1, s.tenderA, s.tenderB])).toBe('55000');
    expect((await db.pool.query('SELECT contract_id, tender_id FROM document_revision WHERE id = $1', [main1.revisionId])).rows[0]).toEqual({ contract_id: c1, tender_id: null });
    expect((await db.pool.query('SELECT content_hash FROM evidence_scope WHERE id = $1', [scope1])).rows[0]).toEqual(before.rows[0]);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM evidence_scope_item WHERE scope_id = $1', [scope1])).rows[0].n).toBe(2);
    await db.pool.query(
      "UPDATE contract_tender SET status = 'active', archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE contract_id = $1 AND tender_id = $2",
      [c1, s.tenderA],
    );
  });

  it('14: архив договора не удаляет доказательств', async () => {
    const count = async () =>
      (
        await db.pool.query(
          `SELECT (SELECT count(*) FROM document_revision WHERE contract_id = $1)::int AS revisions,
                  (SELECT count(*) FROM recognition_run WHERE contract_id = $1)::int AS runs,
                  (SELECT count(*) FROM evidence_fragment WHERE contract_id = $1)::int AS fragments,
                  (SELECT count(*) FROM evidence_scope_item WHERE contract_id = $1)::int AS scope_items`,
          [c1],
        )
      ).rows[0];
    const before = await count();
    await db.pool.query("UPDATE contract SET status = 'archived', archived_at = now(), archived_by = $2 WHERE id = $1", [c1, s.ids.manager]);
    expect(await count()).toEqual(before);
    await db.pool.query("UPDATE contract SET status = 'active', archived_at = NULL, archived_by = NULL WHERE id = $1", [c1]);
  });
});

describe('прогон поиска вида contract и строки доступа', () => {
  const run = (o: { kind: 'tender' | 'contract'; tender?: string | null; contract?: string | null; stage?: string | null; units: string[] }) =>
    q(
      `INSERT INTO search_run (context_kind, tender_id, contract_id, stage_id, mode, requested_by, query_text, query_sha256, query_normalization_version,
                               result_limit, scope_hash, allowed_source_unit_ids, index_version_id, ranking_version, semantic_status, deadline_at)
       VALUES ($1, $2, $3, $4, 'working', $5, 'q', repeat('0', 64), 'n1', 10, repeat('0', 64), $6::uuid[], $7, 'r1', 'running', now() + interval '1 minute')`,
      [o.kind, o.tender ?? null, o.contract ?? null, o.stage ?? null, s.ids.manager, o.units, versionId],
    );

  it('владелец контекста — ровно один; единица — только своего договора или связанного с тендером', async () => {
    expect(await run({ kind: 'contract', contract: c1, tender: s.tenderA, units: [runC1] })).toBe('23514');
    expect(await run({ kind: 'contract', contract: c1, stage: s.stageA, units: [runC1] })).toBe('23514');
    expect(await run({ kind: 'contract', contract: c1, units: [runC2] })).toBe('23514');
    expect(await run({ kind: 'contract', contract: c1, units: [runT] })).toBe('23514');
    // Договор С-2 связан только с тендером A: в прогоне тендера B его единица не принимается.
    expect(await run({ kind: 'tender', tender: s.tenderB, stage: s.stageB, units: [runC2] })).toBe('23514');
    expect(await run({ kind: 'contract', contract: c1, units: [runC1] })).toBe('ok');
    expect(await run({ kind: 'tender', tender: s.tenderA, stage: s.stageA, units: [runT, runC1] })).toBe('ok');
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM search_run WHERE context_kind = 'contract' AND status = 'pending' LIMIT 1")).rows[0]!.id;
    expect(await q('UPDATE search_run SET contract_id = $2 WHERE id = $1', [id, c2])).toBe('55000');
  });

  it('строка создателя — только у автора договора; одна действующая выдача; меняется лишь отметка отзыва', async () => {
    expect(await q("INSERT INTO contract_access (contract_id, user_id, capability, source, granted_by) VALUES ($1, $2, 'contract.read', 'creator', $2)", [c1, s.ids.eng1])).toBe('23503');
    expect(await q("INSERT INTO contract_access (contract_id, user_id, capability, source, granted_by) VALUES ($1, $2, 'contract.read', 'admin', $3)", [c1, s.ids.manager, s.ids.admin])).toBe('23505');
    expect(await q("INSERT INTO contract_access (contract_id, user_id, capability, source, granted_by) VALUES ($1, $2, 'contract.create', 'admin', $3)", [c1, s.ids.eng1, s.ids.admin])).toBe('23514');
    expect(await q("INSERT INTO contract_access (user_id, capability, source, granted_by) VALUES ($1, 'contract.create', 'admin', $2)", [s.ids.manager, s.ids.admin])).toBe('23505');
    expect(await q("UPDATE contract_access SET capability = 'contract.link' WHERE contract_id = $1 AND user_id = $2 AND capability = 'contract.read'", [c1, s.ids.manager])).toBe('55000');
    expect(await q('DELETE FROM contract_access WHERE contract_id = $1', [c1])).toBe('42501');
  });
});

describe('15: одновременное создание конфликтующей связи владения завершается отказом БД', () => {
  const race = async (sql: string, params: unknown[]): Promise<string[]> => {
    const a = new pg.Client({ connectionString: db.appUrl });
    const b = new pg.Client({ connectionString: db.appUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await code(a.query(sql, params));
      const second = code(b.query(sql, params));
      await a.query('COMMIT');
      const r2 = await second;
      await b.query(r2 === 'ok' ? 'COMMIT' : 'ROLLBACK');
      return [first, r2];
    } finally {
      await a.end();
      await b.end();
    }
  };

  it('одна пара «договор, тендер», один основной документ, одно содержимое в договоре', async () => {
    const c3 = await createContract(s.manager, 'С-3');
    expect(await race('INSERT INTO contract_tender (contract_id, tender_id, confirmed_by) VALUES ($1, $2, $3)', [c3, s.tenderB, s.ids.manager])).toEqual(['ok', '23505']);
    expect(await race("INSERT INTO document (contract_id, contract_role, title, name_key) VALUES ($1, 'contract', 'осн', 'осн')", [c3])).toEqual(['ok', '23505']);
    const doc = (await db.pool.query<{ id: string }>("SELECT id FROM document WHERE contract_id = $1 AND contract_role = 'contract'", [c3])).rows[0]!.id;
    const sha = await newBlob();
    const r = await race('INSERT INTO document_revision (document_id, contract_id, blob_sha256, revision_seq) VALUES ($1, $2, $3, 1)', [doc, c3, sha]);
    expect(r).toEqual(['ok', '23505']);
  });
});
