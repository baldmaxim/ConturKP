// Этап 08: обязательные инварианты БД (D-026, 15 пунктов) и дополнительные (08-requirements-model-design.md §13–15)
// прямым SQL под ролью приложения и владельцем схемы: вторая линия держит их без кода API. Данные — через API.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenderCapabilities, type MemberRole, type Role } from '../packages/core/src/index.ts';
import { createTestDb, createUser, idem, testConfig, type ITestDb } from './helpers.ts';
import { buildStage08, confirm, confirmedRequirement, propose, supports, type IStage08 } from './requirementFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage08;
let req: { candidateId: string; requirementId: string; revisionId: string };
const config = testConfig();

const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
const q = (sql: string, params: unknown[] = []) => code(db.pool.query(sql, params));
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.pool.query(sql, params)).rows[0] as T;

const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: db.migratorUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

// Транзакция под ролью приложения: отложенные проверки срабатывают на COMMIT; итог — код ошибки или ok.
const tx = async (fn: (c: pg.PoolClient) => Promise<void>): Promise<string> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return (e as { code?: string }).code ?? String(e);
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
  req = await confirmedRequirement(st, 'Фасад — клинкерный кирпич', [st.frag.facade]);
});
afterAll(async () => {
  await db.drop();
});

describe('инварианты 1–3: требование, ревизия, подтверждение', () => {
  it('1. требования без действующей ревизии нет', async () => {
    expect(await tx((c) => c.query("INSERT INTO requirement (tender_id, stage_id, code, current_revision_id) VALUES ($1, $2, 'R-9999', $3)", [st.s.tenderA, st.s.stageA, randomUUID()]).then(() => undefined))).toBe('23503');
    expect(await q('UPDATE requirement SET current_revision_id = $2, row_version = row_version + 1 WHERE id = $1', [req.requirementId, randomUUID()])).not.toBe('ok');
  });

  it('2. кандидат не становится подтверждённым вставкой или UPDATE в обход перехода', async () => {
    const c = await propose(st.s.eng1, st.registryId, 'Кровля профнастил', supports(st.frag.roof));
    // UPDATE статуса без ревизии требования — отказ при фиксации.
    expect(await tx((cl) => cl.query("UPDATE requirement_candidate SET status = 'confirmed', decided_by = $2, decided_at = now(), row_version = row_version + 1 WHERE id = $1", [c.id, st.s.ids.manager]).then(() => undefined))).toBe('23514');
    // Инженер не подтверждает даже прямым SQL (has_stage_capability).
    expect(await q("UPDATE requirement_candidate SET status = 'confirmed', decided_by = $2, decided_at = now(), row_version = row_version + 1 WHERE id = $1", [c.id, st.s.ids.eng1])).toBe('42501');
    // Ревизия по кандидату proposed — отказ.
    expect(
      await tx(async (cl) => {
        const id = randomUUID();
        await cl.query("INSERT INTO requirement (tender_id, stage_id, code, current_revision_id) VALUES ($1, $2, 'R-8888', $3)", [st.s.tenderA, st.s.stageA, id]);
        const r = await cl.query<{ id: string }>("SELECT id FROM requirement WHERE code = 'R-8888'");
        await cl.query(
          `INSERT INTO requirement_revision (id, requirement_id, tender_id, stage_id, registry_id, seq, status, change_kind, candidate_id, statement, authored_by, confirmed_by, content_sha256)
           VALUES ($1, $2, $3, $4, $5, 1, 'confirmed', 'confirmation', $6, 'x', $7, $8, repeat('0', 64))`,
          [id, r.rows[0]!.id, st.s.tenderA, st.s.stageA, st.registryId, c.id, st.s.ids.eng1, st.s.ids.manager],
        );
      }),
    ).toBe('23514');
  });

  it('3. ревизия требования неизменяема (роль приложения и владелец схемы)', async () => {
    expect(await q("UPDATE requirement_revision SET statement = 'другое' WHERE id = $1", [req.revisionId])).toBe('42501');
    expect(await q('DELETE FROM requirement_revision WHERE id = $1', [req.revisionId])).toBe('42501');
    expect(await asOwner((c) => code(c.query("UPDATE requirement_revision SET statement = 'другое' WHERE id = $1", [req.revisionId])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('DELETE FROM requirement_revision WHERE id = $1', [req.revisionId])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('TRUNCATE requirement_revision CASCADE')))).toBe('55000');
  });

  it('15. A → B → A: номер ревизии строго следующий; вставка не за последней — отказ', async () => {
    const last = await one<{ seq: number; id: string }>('SELECT seq, id FROM requirement_revision WHERE requirement_id = $1 ORDER BY seq DESC LIMIT 1', [req.requirementId]);
    expect(
      await q(
        `INSERT INTO requirement_revision (requirement_id, tender_id, stage_id, registry_id, seq, supersedes_revision_id, status, change_kind, statement, superseded_by_requirement_id, authored_by, confirmed_by, content_sha256)
         VALUES ($1, $2, $3, $4, $5, NULL, 'superseded', 'supersede', 'x', $1, $6, $6, repeat('0', 64))`,
        [req.requirementId, st.s.tenderA, st.s.stageA, st.registryId, last.seq + 5, st.s.ids.manager],
      ),
    ).not.toBe('ok');
  });
});

describe('инварианты 4–5: основания, факт ≠ требование', () => {
  it('4. основание — существующий фрагмент снимка реестра; несуществующий и вне снимка — отказ', async () => {
    const other = await uploadDocument(db, config, st.s.eng3, st.s.stageB, 'чужой.pdf');
    const run = await seedEvidenceRun(db.pool, other, { pages: [{ blocks: ['Чужой тендер: требование'] }] });
    const foreign = (await one<{ id: string }>('SELECT id FROM evidence_fragment WHERE run_id = $1', [run])).id;
    for (const fragmentId of [randomUUID(), foreign]) {
      const r = await st.s.eng1.post(`/requirement-registries/${st.registryId}/requirement-candidates`, { statement: 'x', evidence: supports(fragmentId) }, { headers: idem() });
      expect([404, 409]).toContain(r.status);
    }
    expect(await q('INSERT INTO evidence_link (tender_id, fragment_id, role, requirement_revision_id, created_by) VALUES ($1, $2, $3, $4, $5)', [st.s.tenderA, randomUUID(), 'supports', req.revisionId, st.s.ids.eng1])).not.toBe('ok');
    // Набор оснований неизменен после создания владельца (пишет только его транзакция).
    expect(await q('INSERT INTO evidence_link (tender_id, fragment_id, role, requirement_revision_id, created_by) VALUES ($1, $2, $3, $4, $5)', [st.s.tenderA, st.frag.roof, 'clarifies', req.revisionId, st.s.ids.eng1])).toBe('55000');
    expect(await q('DELETE FROM evidence_link WHERE requirement_revision_id = $1', [req.revisionId])).toBe('42501');
  });

  it('5. у основания ровно один владелец: требование и факт в одной связи — отказ', async () => {
    const fc = await st.s.eng1.post(
      `/requirement-registries/${st.registryId}/fact-candidates`,
      { factKind: 'advance_payment', displayValue: '30 %', normalizedValue: { value: 30 }, evidence: supports(st.frag.advance) },
      { headers: idem() },
    );
    expect(fc.status, fc.text).toBe(201);
    expect(
      await q('INSERT INTO evidence_link (tender_id, fragment_id, role, requirement_revision_id, fact_candidate_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        st.s.tenderA, st.frag.facade, 'supports', req.revisionId, fc.body.id, st.s.ids.eng1,
      ]),
    ).not.toBe('ok');
    const check = await one<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidence_link_owner_shape'");
    expect(check.def).toContain('= 1');
    // Факт и требование — разные таблицы; у ревизии требования нет ссылки на факт.
    const cols = await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'requirement_revision' AND column_name LIKE 'fact%'");
    expect(cols.rows).toEqual([]);
  });

  it('D-018: основание supports факта — письменный текст; описание модели — не основание требования', async () => {
    expect((await one<{ ok: boolean }>("SELECT evidence_origin_reviewable('model_description') AS ok")).ok).toBe(false);
    expect((await one<{ ok: boolean }>("SELECT evidence_origin_fact_basis('negotiation_speech') AS ok")).ok).toBe(false);
    expect((await one<{ ok: boolean }>("SELECT evidence_origin_fact_basis('qa_question') AS ok")).ok).toBe(false);
    expect((await one<{ ok: boolean }>("SELECT evidence_origin_fact_basis('qa_answer') AS ok")).ok).toBe(true);
  });
});

describe('инварианты 6–7: решения', () => {
  it('6–7. версия решения неизменяема; замена не удаляет прежнюю; вторая замена той же версии — отказ', async () => {
    const d1 = await st.s.manager.post(`/requirements/${req.requirementId}/decisions`, { statement: 'Принять клинкер', rationale: 'по ТЗ' }, { headers: idem() });
    expect(d1.status, d1.text).toBe(201);
    const id = d1.body.decisionId as string;
    expect(await q("UPDATE decision SET statement = 'x' WHERE id = $1", [id])).toBe('42501');
    expect(await asOwner((c) => code(c.query("UPDATE decision SET statement = 'x' WHERE id = $1", [id])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('DELETE FROM decision WHERE id = $1', [id])))).toBe('55000');
    const d2 = await st.s.manager.post(`/requirements/${req.requirementId}/decisions`, { statement: 'Принять клинкер ручной формовки', rationale: 'уточнение', supersedesDecisionId: id }, { headers: idem() });
    expect(d2.status).toBe(201);
    expect(
      await q(
        `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by, supersedes_decision_id)
         VALUES ($1, $2, 'requirement', $3, 'requirement_decision', 'y', 'y', $4, $5)`,
        [st.s.tenderA, st.s.stageA, req.requirementId, st.s.ids.manager, id],
      ),
    ).toBe('23505');
    // Решение по требованию принимает только requirement.decide.
    expect(
      await q(
        `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
         VALUES ($1, $2, 'requirement', $3, 'requirement_decision', 'y', 'y', $4)`,
        [st.s.tenderA, st.s.stageA, req.requirementId, st.s.ids.eng1],
      ),
    ).toBe('42501');
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM decision WHERE subject_id = $1', [req.requirementId])).n).toBe(2);
  });
});

describe('инварианты 8–11: покрытие, прогон, полнота, область', () => {
  it('8. покрытие — к текущей ревизии требования; не текущая или без ревизии — отказ', async () => {
    expect(await q("INSERT INTO requirement_coverage (tender_id, stage_id, seq, state, origin, assessed_by) VALUES ($1, $2, 1, 'uncovered', 'human', $3)", [st.s.tenderA, st.s.stageA, st.s.ids.manager])).not.toBe('ok');
    const r2 = await propose(st.s.eng1, st.registryId, 'Фасад — клинкер, цвет красный', supports(st.frag.facade), { targetRequirementId: req.requirementId });
    expect((await confirm(st.s.manager, r2.id)).status).toBe(200);
    expect(await q("INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, state, origin, assessed_by) VALUES ($1, $2, $3, 1, 'uncovered', 'human', $4)", [st.s.tenderA, st.s.stageA, req.revisionId, st.s.ids.manager])).toBe('23514');
    // Системную пометку приложение не пишет.
    const cur = (await one<{ current_revision_id: string }>('SELECT current_revision_id FROM requirement WHERE id = $1', [req.requirementId])).current_revision_id;
    expect(await q("INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, state, origin, trigger_calculation_revision_id) VALUES ($1, $2, $3, 1, 'needs_review', 'system', NULL)", [st.s.tenderA, st.s.stageA, cur])).toBe('23514');
    // covered без объекта — отказ при фиксации.
    expect(await tx((c) => c.query("INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, state, origin, assessed_by) VALUES ($1, $2, $3, 1, 'covered', 'human', $4)", [st.s.tenderA, st.s.stageA, cur, st.s.ids.manager]).then(() => undefined))).toBe('23514');
  });

  it('9. прогон закреплён на снимке: условия неизменны, вход — из снимка прогона', async () => {
    const run = await st.s.eng1.post(`/requirement-registries/${st.registryId}/analysis-runs`, { task: 'requirement_extraction' }, { headers: idem() });
    expect(run.status, run.text).toBe(201);
    expect(await q('UPDATE analysis_run SET evidence_scope_id = $2, row_version = row_version + 1 WHERE id = $1', [run.body.id, randomUUID()])).not.toBe('ok');
    expect(await q("UPDATE analysis_run SET prompt_sha256 = repeat('b', 64), row_version = row_version + 1 WHERE id = $1", [run.body.id])).toBe('55000');
    expect(await q('INSERT INTO analysis_run_input (run_id, fragment_id) VALUES ($1, $2)', [run.body.id, st.frag.roof])).not.toBe('ok');
    expect(await q('DELETE FROM analysis_run WHERE id = $1', [run.body.id])).toBe('42501');
  });

  it('10. завершение прохода невозможно при unreviewed > 0 (CHECK и охранник)', async () => {
    expect(
      await q(
        `INSERT INTO requirement_registry_review (tender_id, registry_id, seq, total_units, reviewed_units, covered_units, explicit_not_requirement_units, unreviewed_units, empty_units, completed_by)
         VALUES ($1, $2, 1, 5, 1, 1, 0, 4, 0, $3)`,
        [st.s.tenderA, st.registryId, st.s.ids.manager],
      ),
    ).toBe('23514');
    expect(
      await q(
        `INSERT INTO requirement_registry_review (tender_id, registry_id, seq, total_units, reviewed_units, covered_units, explicit_not_requirement_units, unreviewed_units, empty_units, completed_by)
         VALUES ($1, $2, 1, 5, 5, 1, 0, 0, 0, $3)`,
        [st.s.tenderA, st.registryId, st.s.ids.manager],
      ),
    ).toBe('23514');
  });

  it('11. кандидат прежнего реестра не подтверждается в новом без явного переноса', async () => {
    const old = await propose(st.s.eng1, st.registryId, 'Кровля — уклон 3 %', supports(st.frag.roof));
    const doc = await uploadDocument(db, config, st.s.eng1, st.s.stageA, 'доп.pdf');
    await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Дополнительный документ'] }] });
    await setWorkingSet(st.s.manager, st.s.stageA, [st.docRev, doc], true);
    const scope2 = await fixScope(st.s.manager, st.s.stageA);
    const reg2 = await st.s.manager.post(`/stages/${st.s.stageA}/requirement-registries`, { evidenceScopeId: scope2, reason: 'Новый снимок' }, { headers: idem() });
    expect(reg2.status, reg2.text).toBe(201);
    expect(reg2.body.carry).toMatchObject({ requirementsCarried: 1 });
    const r = await confirm(st.s.manager, old.id);
    expect(r.status).toBe(409);
    expect(await q("UPDATE requirement_candidate SET status = 'rejected', status_reason = 'x', decided_by = $2, decided_at = now(), row_version = row_version + 1 WHERE id = $1", [old.id, st.s.ids.manager])).toBe('23514');
    // Явный перенос: новый кандидат в активном реестре, исходный не меняется.
    const moved = await st.s.eng1.post(`/requirement-candidates/${old.id}/rebase`, {}, { headers: idem() });
    expect(moved.status, moved.text).toBe(201);
    expect(moved.body).toMatchObject({ registryId: reg2.body.id, rebasedFromCandidateId: old.id, origin: 'carried', status: 'proposed' });
    expect((await st.s.eng1.get(`/requirement-candidates/${old.id}`)).body.status).toBe('proposed');
    expect((await confirm(st.s.manager, moved.body.id)).status).toBe(200);
    // Старый реестр не меняется: ревизии требований в нём прежние.
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM requirement_revision WHERE registry_id = $1', [st.registryId])).n).toBeGreaterThan(0);
    expect(await q('UPDATE requirement_registry_active SET registry_id = $2, updated_by = $3, row_version = row_version + 1 WHERE stage_id = $1', [st.s.stageA, st.registryId, st.s.ids.manager])).toBe('23514');
    // Второй преемник того же реестра — отказ.
    expect(
      await q("INSERT INTO requirement_registry (tender_id, stage_id, evidence_scope_id, seq, previous_registry_id, reason, created_by) VALUES ($1, $2, $3, 3, $4, 'x', $5)", [
        st.s.tenderA, st.s.stageA, st.scopeId, st.registryId, st.s.ids.manager,
      ]),
    ).not.toBe('ok');
    st.registryId = reg2.body.id;
  });
});

describe('инвариант 12 и права (Р-08-8)', () => {
  it('12. основания не удаляются никем; связь основания неизменна', async () => {
    expect(await asOwner((c) => code(c.query('DELETE FROM evidence_link WHERE requirement_revision_id = $1', [req.revisionId])))).toBe('55000');
    expect(await asOwner((c) => code(c.query('TRUNCATE evidence_link CASCADE')))).toBe('55000');
  });

  it('tender_capabilities в БД совпадает с tenderCapabilities кода для всех сочетаний ролей', async () => {
    const combos: { roles: Role[]; member: MemberRole | null }[] = [
      { roles: ['engineer'], member: 'engineer' },
      { roles: ['manager'], member: 'manager' },
      { roles: ['engineer'], member: 'manager' },
      { roles: ['admin'], member: null },
      { roles: ['admin', 'manager'], member: 'manager' },
      { roles: ['manager', 'engineer'], member: 'engineer' },
      { roles: ['engineer'], member: null },
    ];
    for (const [i, combo] of combos.entries()) {
      // Назначение требует роли назначения; затем роли приводятся к сочетанию (снятая роль гасит назначение).
      const id = await createUser(db.pool, `cap${i}`, [...new Set<Role>([...combo.roles, ...(combo.member ? [combo.member] : [])])]);
      const t = await st.s.admin.post('/tenders', { code: `CAP-${i}`, title: `Права ${i}` }, { headers: idem() });
      expect(t.status, t.text).toBe(201);
      if (combo.member) {
        await db.pool.query('INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, $3, $4)', [t.body.id, id, combo.member, st.s.ids.admin]);
      }
      await db.pool.query('DELETE FROM user_role WHERE user_id = $1 AND NOT (role = ANY($2::text[]))', [id, combo.roles]);
      const dbCaps = (await one<{ caps: string[] }>('SELECT tender_capabilities($1, $2) AS caps', [id, t.body.id])).caps;
      expect([...dbCaps].sort(), JSON.stringify(combo)).toEqual([...tenderCapabilities(new Set(combo.roles), combo.member)].sort());
    }
  });

  it('пометка этапа неизменяема; вопрос после отправки не меняет текст (прямой SQL)', async () => {
    const n = await st.s.eng1.post(`/stages/${st.s.stageA}/notes`, { text: 'Заметка' }, { headers: idem() });
    expect(await q("UPDATE stage_note SET text = 'x' WHERE id = $1", [n.body.id])).toBe('42501');
    const qn = await st.s.eng1.post(`/stages/${st.s.stageA}/customer-questions`, { text: 'Вопрос' }, { headers: idem() });
    await db.pool.query("UPDATE customer_question SET status = 'sent', asked_at = now(), updated_by = $2, row_version = row_version + 1 WHERE id = $1", [qn.body.id, st.s.ids.eng1]);
    expect(await q("UPDATE customer_question SET text = 'другой', updated_by = $2, row_version = row_version + 1 WHERE id = $1", [qn.body.id, st.s.ids.eng1])).toBe('23514');
    expect(await q("UPDATE customer_question SET status = 'draft', asked_at = NULL, updated_by = $2, row_version = row_version + 1 WHERE id = $1", [qn.body.id, st.s.ids.eng1])).toBe('23514');
  });
});
