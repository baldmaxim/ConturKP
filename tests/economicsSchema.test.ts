// Этап 10: вторая линия БД (миграция 0026; проект §9). Прямые записи роли приложения в обход API: неверные суммы
// отчёта и пересчёта, системное подтверждение пар вне правила source_lineage, части сравнения вне транзакции создания,
// несходящееся сравнение, причина «подтверждено» без основания своего вида, изменение экземпляра у завершённой выгрузки.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildEcon, closeEcon, compare, E, unitOf, units, type IEcon } from './economicsFixtures.ts';
import { createTestDb, drain, testConfig, type ITestDb } from './helpers.ts';

let db: ITestDb;
let e: IEcon;
let cmpId = '';
let unitId = '';

const tx = async (fn: (c: pg.PoolClient) => Promise<unknown>): Promise<unknown> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    return err;
  } finally {
    c.release();
  }
};

const rejects = async (fn: (c: pg.PoolClient) => Promise<unknown>, pattern: RegExp) => {
  const err = (await tx(fn)) as { message?: string; code?: string } | null;
  expect(err, 'запись должна быть отвергнута').not.toBeNull();
  expect(`${err!.code} ${err!.message}`).toMatch(pattern);
};

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.pool.query(sql, params)).rows[0] as T;

beforeAll(async () => {
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  expect((await e.s.eng1.get(`/calculation-revisions/${e.rev1}/economics`)).status).toBe(200);
  cmpId = (await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2)).id;
  unitId = unitOf(await units(e.s.eng1, cmpId), E.q.G).id;
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

describe('отчёт ревизии и пересчёт строк', () => {
  it('суммы отчёта сверяются с содержимым ревизии; отчёт — только с пересчётом каждой строки', async () => {
    const sums = await one<{ cost: string; comm: string; gt: string }>(
      `SELECT sum(l.total_amount)::text AS cost,
              sum(coalesce(l.total_commercial_material, 0) + coalesce(l.total_commercial_work, 0)) FILTER (WHERE l.total_commercial_material IS NOT NULL OR l.total_commercial_work IS NOT NULL)::text AS comm,
              c.source_grand_total::text AS gt
         FROM calculation_revision r JOIN calculation_content c ON c.id = r.content_id JOIN calculation_line l ON l.content_id = c.id
        WHERE r.id = $1 GROUP BY c.source_grand_total`,
      [e.rev2],
    );
    const insert = (c: pg.PoolClient, cost: string) =>
      c.query(
        `INSERT INTO revision_economics (tender_id, revision_id, method_version, cost_total, commercial_total, grand_total, residual, tolerance, reconciliation_status,
                                         line_tolerance_rel, line_tolerance_abs, report)
         VALUES ($1, $2, 'test', $3, $4, $5, $5::numeric - round($4::numeric, 2), 0.01, 'residual_unconfirmed', 0.000000001, 0.000001, '{}')`,
        [e.s.tenderA, e.rev2, cost, sums.comm, sums.gt],
      );
    await rejects((c) => insert(c, '1'), /суммы отчёта не совпадают/u);
    await rejects((c) => insert(c, sums.cost), /с пересчётом каждой строки/u);
  });

  it('пересчёт строки — только вместе с отчётом; отклонение — полученное минус пересчитанное', async () => {
    const econ = await one<{ id: string }>('SELECT id FROM revision_economics WHERE revision_id = $1', [e.rev1]);
    const item = await one<{ external_item_id: string }>('SELECT external_item_id FROM revision_line_check WHERE economics_id = $1 LIMIT 1', [econ.id]);
    await rejects(
      (c) => c.query("INSERT INTO revision_line_check (economics_id, external_item_id, formula) VALUES ($1, gen_random_uuid(), 'work')", [econ.id]),
      /вместе с отчётом ревизии/u,
    );
    await rejects((c) => c.query('UPDATE revision_line_check SET deviation = 0 WHERE economics_id = $1 AND external_item_id = $2', [econ.id, item.external_item_id]), /42501|immutable|неизмен|permission/u);
    await rejects((c) => c.query('DELETE FROM revision_economics WHERE id = $1', [econ.id]), /42501|immutable|неизмен|permission/u);
  });
});

describe('сопоставление позиций', () => {
  it('служебный пользователь подтверждает только source_lineage одного экземпляра, тендера и версии; человек — только участник тендера', async () => {
    const system = await one<{ id: string }>("SELECT id FROM app_user WHERE login = 'system.lineage'");
    const ins = (c: pg.PoolClient, method: string, from: string, to: string, by: string | null, status = 'confirmed') =>
      c.query(
        `INSERT INTO position_lineage (tender_id, from_revision_id, from_external_position_id, to_revision_id, to_external_position_id, method, status, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [e.s.tenderA, e.rev1, from, e.rev2, to, method, status, by],
      );
    await rejects((c) => ins(c, 'exact_key', E.p.A, E.q.A, system.id), /система подтверждает только source_lineage/u);
    // Ревизии разных версий тендера TenderHub: экземпляр не совпадает и UUID различны.
    await rejects((c) => ins(c, 'source_lineage', E.p.A, E.q.A, system.id), /система подтверждает только source_lineage/u);
    await rejects((c) => ins(c, 'manual', E.p.A, E.q.A, e.s.ids.eng3), /участник тендера/u);
    await rejects((c) => ins(c, 'manual', E.p.A, E.q.A, null, 'proposed'), /position_lineage_(manual|decision)_shape/u);
  });
});

describe('сравнение', () => {
  it('сравнение создаёт участник с economics.compare и с текущим закреплённым сопоставлением; готовое — неизменно; части — только в транзакции создания', async () => {
    const seq = await one<{ s: string }>('SELECT lineage_pair_seq($1, $2)::text AS s', [e.rev1, e.rev2]);
    const ins = (c: pg.PoolClient, by: string, lineageSeq: string) =>
      c.query(
        `INSERT INTO calculation_comparison (tender_id, stage_id, left_revision_id, right_revision_id, method_version, decomposition_method, method_description, tolerance, lineage_seq, requested_by)
         VALUES ($1, $2, $3, $4, 'test', 'chain_substitution', '{}', 0.01, $5, $6) RETURNING id`,
        [e.s.tenderA, e.s.stageA, e.rev1, e.rev2, lineageSeq, by],
      );
    await rejects((c) => ins(c, e.s.ids.eng3, seq.s), /economics\.compare/u);
    await rejects((c) => ins(c, e.s.ids.eng1, String(Number(seq.s) + 5)), /закреплённое сопоставление/u);
    await rejects((c) => c.query("UPDATE calculation_comparison SET failure_reason = 'x' WHERE id = $1", [cmpId]), /frozen-after/u);
    await rejects(
      (c) => c.query("INSERT INTO comparison_effect (comparison_id, unit_id, measure, component, amount) VALUES ($1, $2, 'cost', 'volume', 1)", [cmpId, unitId]),
      /транзакция его создания/u,
    );
    await rejects((c) => c.query('DELETE FROM comparison_unit WHERE comparison_id = $1', [cmpId]), /42501|immutable|неизмен|permission/u);
    // Сравнение без единиц, переведённое в ready, не проходит итоговую проверку: позиции не покрыты.
    await rejects(async (c) => {
      const id = (await ins(c, e.s.ids.eng1, seq.s)).rows[0].id as string;
      await c.query(
        `UPDATE calculation_comparison SET status = 'ready', finished_at = now(), result_sha256 = repeat('a', 64),
                totals = '{"cost":{"left":"0","right":"0","delta":"0"},"commercial":{"left":"0","right":"0","delta":"0"}}' WHERE id = $1`,
        [id],
      );
    }, /каждая позиция обеих ревизий/u);
  });
});

describe('причины изменений', () => {
  it('«подтверждено» при необработанных событиях этапа отвергается: актуальность оснований не установлена', async () => {
    const pending = await one<{ n: number }>('SELECT count(*)::int AS n FROM stage_input_event e WHERE e.stage_id = $1 AND NOT EXISTS (SELECT 1 FROM stage_input_event_processing p WHERE p.event_id = e.id)', [e.s.stageA]);
    expect(pending.n).toBeGreaterThan(0);
    await rejects(
      (c) =>
        c.query(
          `INSERT INTO change_explanation (tender_id, comparison_id, unit_id, version, reason_kind, reason_status, rationale, actor_user_id)
           VALUES ($1, $2, $3, 1, 'internal_decision', 'confirmed', 'решение', $4)`,
          [e.s.tenderA, cmpId, unitId, e.s.ids.eng1],
        ),
      /необработанные события этапа/u,
    );
    await e.worker.maintain({ checkModel: false });
    await drain(e.worker);
  });

  it('«подтверждено» вида «документ» без основания и «неизвестно» с основанием отвергаются; автор — участник с change_reason.confirm', async () => {
    const ins = (c: pg.PoolClient, kind: string, status: string, by: string) =>
      c.query(
        `INSERT INTO change_explanation (tender_id, comparison_id, unit_id, version, reason_kind, reason_status, rationale, actor_user_id)
         VALUES ($1, $2, $3, 1, $4, $5, CASE WHEN $5 = 'unknown' THEN NULL ELSE 'обоснование' END, $6) RETURNING id`,
        [e.s.tenderA, cmpId, unitId, kind, status, by],
      );
    await rejects((c) => ins(c, 'document', 'confirmed', e.s.ids.eng1), /с основанием подходящего происхождения/u);
    await rejects((c) => ins(c, 'unknown', 'unknown', e.s.ids.eng3), /change_reason\.confirm/u);
    const decision = await one<{ id: string } | undefined>('SELECT id FROM decision WHERE tender_id = $1 LIMIT 1', [e.s.tenderA]);
    void decision;
    await rejects(async (c) => {
      const id = (await ins(c, 'unknown', 'unknown', e.s.ids.eng1)).rows[0].id as string;
      const f = await c.query<{ id: string }>('SELECT f.id FROM evidence_fragment f LIMIT 1');
      if (f.rows[0]) await c.query("INSERT INTO change_explanation_basis (explanation_id, tender_id, basis_type, fragment_id) VALUES ($1, $2, 'fragment', $3)", [id, e.s.tenderA, f.rows[0].id]);
      else throw Object.assign(new Error('у «неизвестно» оснований нет'), { code: '23514' });
    }, /оснований нет|вне этапа/u);
    await rejects(
      (c) => c.query("INSERT INTO change_reason_suggestion (tender_id, stage_id, run_id, unit_id, reason_kind, rationale) VALUES ($1, $2, gen_random_uuid(), $3, 'document', 'x')", [e.s.tenderA, e.s.stageA, unitId]),
      /23503|выполняющийся прогон/u,
    );
  });
});

describe('экземпляр TenderHub у выгрузки', () => {
  it('у завершённой выгрузки экземпляр не меняется; при создании выгрузки экземпляр не задаётся', async () => {
    const cap = await one<{ id: string; source_id: string; stage_id: string }>(
      "SELECT k.id, k.source_id, k.stage_id FROM calculation_capture k WHERE k.status = 'complete' AND k.tender_id = $1 LIMIT 1",
      [e.s.tenderA],
    );
    await rejects((c) => c.query("UPDATE calculation_capture SET source_instance_id = 'th-x', row_version = row_version + 1 WHERE id = $1", [cap.id]), /frozen-after/u);
    await rejects(
      (c) =>
        c.query(
          `INSERT INTO calculation_capture (stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by, source_instance_id)
           VALUES ($1, $2, $3, 'tenderhub', $4, 'portal_capture', 'api', 'manual', $5, 'th-x')`,
          [cap.stage_id, e.s.tenderA, cap.source_id, E.v2, e.s.ids.eng1],
        ),
      /записывает завершение выгрузки/u,
    );
  });
});
