// Этап 06: вторая линия в БД для расчёта (миграция 0011; урок R05-01) и доменные правила ревизии
// источника (X-01) контрактными тестами на фикстурах. Роль kontur_app вставляет строки содержимого сама,
// поэтому полноту, хэш, линейность ревизий и неизменность держит БД, а не код.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPortalCapture, TenderHubApiSource, TenderHubHttpClient } from '../packages/adapters/src/index.ts';
import { calculationContentHash, CALCULATION_NORMALIZATION_VERSION, KP_TOTAL_RULE_NOT_SET, type ICalcContent } from '../packages/core/src/index.ts';
import {
  findOrCreateContent,
  primaryCalculationSource,
  recordRevisionStatus,
  recordSourceRevision,
  withTransaction,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, createTestDb, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let hub: IFakeTenderHub;
let boss: TestClient;
let owner: pg.Client;
const base = testConfig();
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(TH.tender, standardTender());
  const config = tenderHubConfig(base, hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  boss = await adminMember(db, s, app, s.tenderA);
  await linkSource(boss, s.stageA, TH.tender);
  const cap = await captureNow(db, makeWorker(db, config), s.eng1, s.stageA);
  expect(cap.status).toBe('complete');
  ids.revision = cap.revisionId;
  ids.content = cap.contentId;
  ids.bundle = cap.rawBundleSha256;
  owner = new pg.Client({ connectionString: db.migratorUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await hub.close();
  await db.drop();
});

const tricky = (hash?: string): { content: ICalcContent; hash: string } => {
  const content: ICalcContent = {
    header: {
      normalizationVersion: CALCULATION_NORMALIZATION_VERSION,
      sourceGrandTotal: '-0.5',
      usdRate: '1000000000000000000000',
      eurRate: '0.0000001',
      cnyRate: null,
      kpTotal: null,
      kpTotalCurrency: null,
      kpTotalRule: null,
    },
    positions: [
      {
        externalPositionId: 'aaaaaaaa-0000-4000-8000-000000000002',
        positionNumber: '10.25',
        itemNo: 'п. "1|2"',
        workName: 'Кавычки «ёлочки», "прямые", обратный \\ слэш, перевод\nстроки, таб\t, управляющий \u0001, эмодзи 🏗, �',
        unitCode: 'м²',
        volume: '123456789012345.678901',
        manualVolume: '0',
        manualNote: '|',
        clientNote: '~',
        sectionNumber: null,
        positionName: null,
        isSection: false,
        isAdditional: true,
        hierarchyLevel: 3,
        parentExternalPositionId: null,
        costCategoryName: null,
        totalMaterial: null,
        totalWorks: null,
        materialCostPerUnit: null,
        workCostPerUnit: null,
        totalCommercialMaterial: null,
        totalCommercialWork: null,
        totalCommercialMaterialPerUnit: null,
        totalCommercialWorkPerUnit: null,
        baseTotal: null,
        commercialTotal: null,
        materialCostTotal: null,
        workCostTotal: null,
        markupPercentage: null,
        itemsCount: 0,
        rawLexemes: {},
      },
      {
        externalPositionId: 'aaaaaaaa-0000-4000-8000-000000000001',
        positionNumber: '-1',
        itemNo: null,
        workName: 'Раздел',
        unitCode: null,
        volume: null,
        manualVolume: null,
        manualNote: null,
        clientNote: null,
        sectionNumber: '1',
        positionName: 'Раздел',
        isSection: true,
        isAdditional: null,
        hierarchyLevel: null,
        parentExternalPositionId: null,
        costCategoryName: null,
        totalMaterial: null,
        totalWorks: null,
        materialCostPerUnit: null,
        workCostPerUnit: null,
        totalCommercialMaterial: null,
        totalCommercialWork: null,
        totalCommercialMaterialPerUnit: null,
        totalCommercialWorkPerUnit: null,
        baseTotal: null,
        commercialTotal: null,
        materialCostTotal: null,
        workCostTotal: null,
        markupPercentage: null,
        itemsCount: null,
        rawLexemes: {},
      },
    ],
    lines: [],
  };
  return { content, hash: hash ?? calculationContentHash(content) };
};

const insertContent = (client: pg.ClientBase, c: { content: ICalcContent; hash: string }) =>
  findOrCreateContent(client, { content: c.content, hash: c.hash, headerLexemes: {}, kpTotalSemantics: { ...KP_TOTAL_RULE_NOT_SET } });

const inTx = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
};

describe('содержимое: хэш пересчитывает БД, состав фиксируется транзакцией создания', () => {
  it('хэш приложения и БД совпадают на кавычках, управляющих символах, эмодзи, экспонентах и 21 значащей цифре', async () => {
    const c = tricky();
    const r = await inTx((client) => insertContent(client, c));
    expect(r.created).toBe(true);
    const h = await db.pool.query<{ same: boolean }>('SELECT calculation_content_hash(id) = content_hash AS same FROM calculation_content WHERE id = $1', [r.id]);
    expect(h.rows[0]!.same).toBe(true);
    ids.tricky = r.id;
    // Ревизия выгрузки: пересчёт БД равен хэшу, записанному приложением.
    const rev = await db.pool.query<{ same: boolean }>('SELECT calculation_content_hash(id) = content_hash AS same FROM calculation_content WHERE id = $1', [ids.content]);
    expect(rev.rows[0]!.same).toBe(true);
  });

  it('в зафиксированное содержимое строку не вставить — ни kontur_app, ни владельцу таблиц (55000)', async () => {
    const sql = `INSERT INTO calculation_position (content_id, external_position_id, position_number, work_name, is_section, raw_lexemes)
                 VALUES ($1, '00000000-0000-4000-8000-0000000000ff', 99, 'лишняя', false, '{}')`;
    await expect(db.pool.query(sql, [ids.content])).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/зафиксировано/u) });
    await expect(owner.query(sql, [ids.content])).rejects.toMatchObject({ code: '55000' });
    await expect(db.pool.query('UPDATE calculation_line SET quantity = 0 WHERE content_id = $1', [ids.content])).rejects.toThrow(/permission denied/u);
    await expect(owner.query('UPDATE calculation_line SET quantity = 0 WHERE content_id = $1', [ids.content])).rejects.toThrow(/запрещена/u);
    await expect(owner.query('DELETE FROM calculation_position WHERE content_id = $1', [ids.content])).rejects.toThrow(/запрещена|foreign key/u);
    await expect(owner.query('UPDATE calculation_content SET source_grand_total = 1 WHERE id = $1', [ids.content])).rejects.toThrow(/запрещена/u);
  });

  it('чужой хэш, неполный состав и содержимое без строк не фиксируются', async () => {
    // Хэш другого содержимого — отказ сразу после команды вставки строк.
    const forged = tricky('f'.repeat(64));
    await expect(inTx((client) => insertContent(client, forged))).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/content_hash не соответствует/u) });
    // Заявлено две позиции, вставлена одна отдельной командой — отказ после команды.
    const c = tricky();
    c.content.header.sourceGrandTotal = '7';
    const partialHash = calculationContentHash(c.content);
    await expect(
      inTx(async (client) => {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO calculation_content (content_hash, normalization_version, kp_total_semantics, raw_lexemes, positions_count, lines_count)
           VALUES ($1, 'th1', '{}', '{}', 2, 0) RETURNING id`,
          [partialHash],
        );
        await client.query(
          `INSERT INTO calculation_position (content_id, external_position_id, position_number, work_name, is_section, raw_lexemes)
           VALUES ($1, 'aaaaaaaa-0000-4000-8000-000000000001', -1, 'Раздел', true, '{}')`,
          [ins.rows[0]!.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/состав неполон/u) });
    // Содержимое без единой строки при заявленных двух позициях — COMMIT отклонён.
    await expect(
      inTx((client) =>
        client.query(
          `INSERT INTO calculation_content (content_hash, normalization_version, kp_total_semantics, raw_lexemes, positions_count, lines_count)
           VALUES ($1, 'th1', '{}', '{}', 2, 0)`,
          [partialHash],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/состав неполон/u) });
    const left = await db.pool.query('SELECT 1 FROM calculation_content WHERE content_hash = $1', [partialHash]);
    expect(left.rowCount).toBe(0);
  });

  it('итог КП без правила непредставим (Q-05)', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO calculation_content (content_hash, normalization_version, kp_total, kp_total_currency, kp_total_semantics, raw_lexemes, positions_count, lines_count)
         VALUES (repeat('e', 64), 'th1', 100, 'RUB', '{}', '{}', 0, 0)`,
      ),
    ).rejects.toThrow(/calculation_content_kp_total_shape/u);
  });
});

describe('ревизия и выгрузка: линейность и неизменность в БД', () => {
  it('завершённая выгрузка неизменна; журнал попыток только дописывается; закреплённые поля не меняются', async () => {
    const cap = (await db.pool.query<{ id: string }>('SELECT capture_id AS id FROM calculation_revision WHERE id = $1', [ids.revision])).rows[0]!.id;
    await expect(db.pool.query("UPDATE calculation_capture SET failure_detail = 'x', row_version = row_version + 1 WHERE id = $1", [cap])).rejects.toThrow(/frozen-after/u);
    await expect(db.pool.query('DELETE FROM calculation_capture WHERE id = $1', [cap])).rejects.toThrow(/permission denied|запрещена/u);
    // Незавершённая выгрузка: журнал попыток нельзя переписать, внешний тендер — сменить.
    const src = (await primaryCalculationSource(db.pool, s.stageA))!;
    const active = await db.pool.query<{ id: string }>(
      `INSERT INTO calculation_capture (stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by)
       VALUES ($1, $2, $3, 'tenderhub', $4, 'portal_capture', 'api', 'manual', $5) RETURNING id`,
      [s.stageA, s.tenderA, src.id, TH.tender, s.ids.eng1],
    );
    const id = active.rows[0]!.id;
    await db.pool.query(`UPDATE calculation_capture SET attempts = attempts || '[{"no":1}]'::jsonb, row_version = row_version + 1 WHERE id = $1`, [id]);
    await expect(db.pool.query(`UPDATE calculation_capture SET attempts = '[{"no":9}]'::jsonb, row_version = row_version + 1 WHERE id = $1`, [id])).rejects.toThrow(
      /только дописывается/u,
    );
    await expect(
      db.pool.query("UPDATE calculation_capture SET external_tender_id = '00000000-0000-4000-8000-000000000000', row_version = row_version + 1 WHERE id = $1", [id]),
    ).rejects.toThrow(/закреплённые поля/u);
    // Выгрузка создаётся только capturing; завершённая без ревизии непредставима.
    await expect(
      db.pool.query(
        `INSERT INTO calculation_capture (stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by, status, finished_at)
         VALUES ($1, $2, $3, 'tenderhub', $4, 'portal_capture', 'api', 'manual', $5, 'complete', now())`,
        [s.stageA, s.tenderA, src.id, TH.tender, s.ids.eng1],
      ),
    ).rejects.toThrow(/capturing|complete_shape|calculation_capture_active_key/u);
    await db.pool.query(
      "UPDATE calculation_capture SET status = 'failed', failure_code = 'test', finished_at = now(), row_version = row_version + 1 WHERE id = $1",
      [id],
    );
  });

  it('номер ревизии — следующий, перекрывается только последняя ревизия, повтор содержимого новой provisional не создаёт', async () => {
    const src = (await primaryCalculationSource(db.pool, s.stageA))!;
    const base = await db.pool.query<{ seq: number; content_id: string }>('SELECT seq, content_id FROM calculation_revision WHERE id = $1', [ids.revision]);
    const cap = await db.pool.query<{ id: string }>(
      `INSERT INTO calculation_capture (stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by)
       VALUES ($1, $2, $3, 'tenderhub', $4, 'portal_capture', 'api', 'manual', $5) RETURNING id`,
      [s.stageA, s.tenderA, src.id, TH.tender, s.ids.eng1],
    );
    const insert = (seq: number, supersedes: string | null, content: string, kind = 'provisional') =>
      db.pool.query(
        `INSERT INTO calculation_revision (stage_id, tender_id, content_id, capture_id, seq, kind, system, external_tender_id, supersedes_revision_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'tenderhub', $7, $8)`,
        [s.stageA, s.tenderA, content, cap.rows[0]!.id, seq, kind, TH.tender, supersedes],
      );
    const next = base.rows[0]!.seq + 1;
    await expect(insert(next + 1, ids.revision!, ids.tricky!)).rejects.toThrow(/следующий по порядку/u);
    await expect(insert(next, null, ids.tricky!)).rejects.toThrow(/только последнюю ревизию/u);
    await expect(insert(next, ids.revision!, base.rows[0]!.content_id)).rejects.toThrow(/совпадает с последней ревизией/u);
    await expect(insert(next, ids.revision!, ids.tricky!, 'verified')).rejects.toThrow(/вид ревизии/u);
    await db.pool.query(
      "UPDATE calculation_capture SET status = 'failed', failure_code = 'test', finished_at = now(), row_version = row_version + 1 WHERE id = $1",
      [cap.rows[0]!.id],
    );
  });
});

describe('ревизия источника и статус закрытия (X-01) — контракт на фикстурах', () => {
  // Выгрузка вида tenderhub_revision в продукте не создаётся: адаптера ревизий нет (BLOCKED_EXTERNAL).
  const revisionCapture = async (): Promise<string> => {
    const src = (await primaryCalculationSource(db.pool, s.stageA))!;
    const r = await db.pool.query<{ id: string }>(
      `INSERT INTO calculation_capture (stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by)
       VALUES ($1, $2, $3, 'tenderhub', $4, 'tenderhub_revision', 'api', 'manual', $5) RETURNING id`,
      [s.stageA, s.tenderA, src.id, TH.tender, s.ids.eng1],
    );
    return r.rows[0]!.id;
  };

  const currentContent = async () => {
    const http = new TenderHubHttpClient({ baseUrl: hub.url, apiKey: TH_KEY, timeoutMs: 2000, rateLimitPerMinute: 1000, maxResponseBytes: 8 << 20, rateLimitWaits: 0 });
    const r = await runPortalCapture(new TenderHubApiSource(http), TH.tender);
    return { content: r.content!, hash: calculationContentHash(r.content!), headerLexemes: r.headerLexemes };
  };

  const verified = (captureId: string, ref: string, c: Awaited<ReturnType<typeof currentContent>>) =>
    withTransaction(db.pool, (client) =>
      recordSourceRevision(client, {
        captureId,
        externalRevisionRef: ref,
        content: c.content,
        contentHash: c.hash,
        headerLexemes: c.headerLexemes,
        kpTotalSemantics: { ...KP_TOTAL_RULE_NOT_SET },
        rawBundleSha256: ids.bundle!,
        contractVersion: 'x01-contract-fixture',
      }),
    );

  it('verified без ссылки на внешнюю ревизию непредставима (CHECK), даже у выгрузки вида tenderhub_revision', async () => {
    const cap = await revisionCapture();
    await expect(
      db.pool.query(
        `INSERT INTO calculation_revision (stage_id, tender_id, content_id, capture_id, seq, kind, system, external_tender_id, supersedes_revision_id)
         VALUES ($1, $2, $3, $4, (SELECT max(seq) + 1 FROM calculation_revision WHERE stage_id = $1), 'verified', 'tenderhub', $5, $6)`,
        [s.stageA, s.tenderA, ids.tricky, cap, TH.tender, ids.revision],
      ),
    ).rejects.toThrow(/calculation_revision_kind_shape/u);
    await db.pool.query("UPDATE calculation_capture SET status = 'failed', failure_code = 'test', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [cap]);
  });

  it('verified с тем же содержимым, что у provisional, — новая запись; повтор той же внешней ревизии идемпотентен', async () => {
    const c = await currentContent();
    const prov = await db.pool.query<{ content_hash: string }>(
      'SELECT c.content_hash FROM calculation_revision r JOIN calculation_content c ON c.id = r.content_id WHERE r.id = $1',
      [ids.revision],
    );
    expect(c.hash).toBe(prov.rows[0]!.content_hash);
    const r1 = await verified(await revisionCapture(), 'TH-88', c);
    expect(r1.created).toBe(true);
    const rows = await db.pool.query<{ kind: string; content_id: string; supersedes_revision_id: string | null; external_revision_ref: string | null }>(
      'SELECT kind, content_id, supersedes_revision_id, external_revision_ref FROM calculation_revision WHERE id = ANY($1::uuid[]) ORDER BY seq',
      [[ids.revision, r1.revisionId]],
    );
    expect(rows.rows[0]).toMatchObject({ kind: 'provisional', external_revision_ref: null });
    expect(rows.rows[1]).toMatchObject({ kind: 'verified', external_revision_ref: 'TH-88', content_id: rows.rows[0]!.content_id, supersedes_revision_id: ids.revision });
    const again = await verified(await revisionCapture(), 'TH-88', c);
    expect(again).toEqual({ revisionId: r1.revisionId, created: false });
    ids.verified = r1.revisionId;
  });

  it('закрытие — событие; повторное событие закрытия не пишется; переоткрытие; новая ревизия после открытия не меняет прежнюю', async () => {
    const at = new Date('2026-10-15T09:00:00Z');
    const status = (revisionId: string, st: 'closed_at_source' | 'reopened_at_source' | 'superseded_at_source') =>
      withTransaction(db.pool, (client) => recordRevisionStatus(client, { revisionId, status: st, observedAt: at, sourceRawSha256: ids.bundle! }));
    expect(await status(ids.verified!, 'closed_at_source')).toEqual({ recorded: true });
    expect(await status(ids.verified!, 'closed_at_source')).toEqual({ recorded: false });
    expect(await status(ids.verified!, 'reopened_at_source')).toEqual({ recorded: true });
    // Исправление после открытия — новая ревизия источника; прежняя и её события не меняются.
    hub.tenders.get(TH.tender)!.cached_grand_total = n('1999.99');
    const next = await verified(await revisionCapture(), 'TH-89', await currentContent());
    expect(next.created).toBe(true);
    expect(await status(ids.verified!, 'superseded_at_source')).toEqual({ recorded: true });
    const view = (await s.eng1.get(`/calculation-revisions/${ids.verified}`)).body;
    expect(view.sourceStatus.map((e: { status: string }) => e.status)).toEqual(['closed_at_source', 'reopened_at_source', 'superseded_at_source']);
    expect(view.productionGate).toEqual({ mode: 'production', allowed: true, blockers: [] });
    // Прямой вставкой в БД: статус у provisional и переоткрытие без закрытия непредставимы.
    await expect(
      db.pool.query(
        "INSERT INTO calculation_revision_status_event (revision_id, seq, status, observed_at, source_raw_sha256) VALUES ($1, 1, 'closed_at_source', now(), $2)",
        [ids.revision, ids.bundle],
      ),
    ).rejects.toThrow(/только у ревизии verified/u);
    await expect(
      db.pool.query(
        "INSERT INTO calculation_revision_status_event (revision_id, seq, status, observed_at, source_raw_sha256) VALUES ($1, 1, 'reopened_at_source', now(), $2)",
        [next.revisionId, ids.bundle],
      ),
    ).rejects.toThrow(/недопустимый переход/u);
    await expect(db.pool.query('DELETE FROM calculation_revision_status_event WHERE revision_id = $1', [ids.verified])).rejects.toThrow(/permission denied|запрещена/u);
    hub.tenders.get(TH.tender)!.cached_grand_total = n('1860.9');
  });
});

describe('lineage позиций (хранение и решения человека)', () => {
  it('If-Match по числу записей, append-only, позиции только из своих ревизий, чужой тендер — нет', async () => {
    const to = ids.verified!;
    const from = ids.revision!;
    const cur = await s.eng1.get(`/calculation-revisions/${to}/lineage`);
    expect(cur.status).toBe(200);
    expect(cur.headers.etag).toBe(`"${to}:0"`);
    const body = { fromRevisionId: from, links: [{ fromPositionId: TH.p1, toPositionId: TH.p1, status: 'confirmed' }, { fromPositionId: TH.p2, toPositionId: TH.p3, status: 'rejected' }] };
    expect((await s.eng1.post(`/calculation-revisions/${to}/lineage`, body)).status).toBe(428);
    const ok = await s.eng1.post(`/calculation-revisions/${to}/lineage`, body, { headers: { 'If-Match': cur.headers.etag as string } });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.items).toHaveLength(2);
    expect(ok.body.items[0]).toMatchObject({ method: 'manual', status: 'confirmed', decidedBy: s.ids.eng1 });
    const stale = await s.eng2.post(`/calculation-revisions/${to}/lineage`, body, { headers: { 'If-Match': cur.headers.etag as string } });
    expect(stale.status).toBe(412);
    const missing = await s.eng1.post(
      `/calculation-revisions/${to}/lineage`,
      { fromRevisionId: from, links: [{ fromPositionId: '00000000-0000-4000-8000-0000000000ee', toPositionId: TH.p1, status: 'confirmed' }] },
      { headers: { 'If-Match': ok.headers.etag as string } },
    );
    expect(missing.status).toBe(409);
    const self = await s.eng1.post(`/calculation-revisions/${to}/lineage`, { ...body, fromRevisionId: to }, { headers: { 'If-Match': ok.headers.etag as string } });
    expect(self.status).toBe(400);
    expect((await s.eng3.get(`/calculation-revisions/${to}/lineage`)).status).toBe(404);
    await expect(db.pool.query("UPDATE position_lineage SET status = 'rejected' WHERE to_revision_id = $1", [to])).rejects.toThrow(/permission denied|запрещена/u);
  });
});

describe('связь этапа и внешние идентификаторы', () => {
  it('связь не переносится на другой этап или тендер TenderHub и не удаляется; идентичность тендера неизменна', async () => {
    const src = (await primaryCalculationSource(db.pool, s.stageA))!;
    await expect(
      db.pool.query("UPDATE stage_calculation_source SET external_tender_id = '00000000-0000-4000-8000-000000000000', row_version = row_version + 1 WHERE id = $1", [src.id]),
    ).rejects.toThrow(/неизменны/u);
    await expect(owner.query('DELETE FROM stage_calculation_source WHERE id = $1', [src.id])).rejects.toThrow(/запрещена|foreign key/u);
    const ref = await db.pool.query<{ external_id: string; tender_id: string }>("SELECT external_id, tender_id FROM external_ref WHERE system = 'tenderhub'");
    expect(ref.rows).toEqual([{ external_id: 'TH-2026-001', tender_id: s.tenderA }]);
    await expect(owner.query("UPDATE external_ref SET tender_id = tender_id WHERE system = 'tenderhub'")).rejects.toThrow(/запрещена/u);
    const status = await db.pool.query<{ component: string; status: string }>("SELECT component, status FROM integration_status WHERE system = 'tenderhub' ORDER BY component");
    expect(status.rows).toEqual([
      { component: 'TenderHubReader', status: 'VERIFIED_FIXTURE' },
      { component: 'TenderHubRevisionReader', status: 'BLOCKED_EXTERNAL' },
    ]);
  });
});
