// Этап 11: вторая линия БД (миграция 0029; проект §9) — прямые записи роли приложения в обход API: утверждённая
// ревизия неизменна, ревизия заказчика без основания, шаблон компании не руководителем, «заполнено» с пустым
// обязательным полем и при «перенесено», версия не участником, не следующая, у заменённого приложения, перенос вне
// транзакции переноса, принятое предложение без основания, поле вне ревизии, удаление.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDraft, createTemplateWithRevision, demoSchema, fieldOf, type IDraftView } from './formsFixtures.ts';
import { buildScenario, createTestDb, makeApp, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let draft: IDraftView;
const ids: Record<string, string> = {};

const tx = async (fn: (c: pg.PoolClient) => Promise<unknown>): Promise<{ code?: string; message?: string } | null> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    return err as { code?: string; message?: string };
  } finally {
    c.release();
  }
};

const rejects = async (fn: (c: pg.PoolClient) => Promise<unknown>, pattern: RegExp) => {
  const err = await tx(fn);
  expect(err, 'запись должна быть отвергнута').not.toBeNull();
  expect(`${err!.code} ${err!.message}`).toMatch(pattern);
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db));
  const t = await createTemplateWithRevision(s.manager, { name: 'Письмо КП (демо)', schema: demoSchema('demo-kp-letter') });
  Object.assign(ids, { template: t.templateId, revision: t.revisionId });
  draft = await createDraft(s.eng1, s.stageA, t.revisionId, 'Письмо КП');
});
afterAll(async () => {
  await db.drop();
});

describe('шаблоны и формулировки', () => {
  it('утверждённая ревизия неизменна; шаблон компании создаёт только руководитель; шаблон заказчика без основания не утверждается', async () => {
    await rejects((c) => c.query("UPDATE template_revision SET field_schema = '{}'::jsonb, row_version = row_version + 1 WHERE id = $1", [ids.revision]), /55000.*содержание ревизии неизменно/u);
    await rejects((c) => c.query("INSERT INTO application_template (owner_kind, name, created_by) VALUES ('company', 'x', $1)", [s.ids.eng1]), /42501/u);
    await rejects(async (c) => {
      const t = (await c.query<{ id: string }>("INSERT INTO application_template (owner_kind, tender_id, name, created_by) VALUES ('customer', $1, 'Форма', $2) RETURNING id", [s.tenderA, s.ids.manager])).rows[0]!.id;
      const r = (
        await c.query<{ id: string }>(
          `INSERT INTO template_revision (template_id, tender_id, seq, schema_version, field_schema, schema_sha256, field_keys, required_keys, created_by)
           VALUES ($1, $2, 1, 'forms/1', '{}'::jsonb, repeat('a', 64), '{a}', '{}', $3) RETURNING id`,
          [t, s.tenderA, s.ids.manager],
        )
      ).rows[0]!.id;
      await c.query("UPDATE template_revision SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [r, s.ids.manager]);
    }, /23514.*с основанием/u);
    await rejects((c) => c.query('DELETE FROM application_template WHERE id = $1', [ids.template]), /42501|55000|frozen-after/u);
  });

  it('формулировку утверждает руководитель; текст версии неизменен', async () => {
    await rejects(async (c) => {
      const w = (await c.query<{ id: string }>("INSERT INTO wording (title, created_by) VALUES ('Ф', $1) RETURNING id", [s.ids.eng1])).rows[0]!.id;
      const v = (await c.query<{ id: string }>("INSERT INTO wording_version (wording_id, version, text, proposed_by) VALUES ($1, 1, 'текст', $2) RETURNING id", [w, s.ids.eng1])).rows[0]!.id;
      await c.query("UPDATE wording_version SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [v, s.ids.eng1]);
    }, /42501.*утверждает/u);
  });
});

describe('приложения и версии', () => {
  const insertVersion = (c: pg.PoolClient, fieldId: string, o: { version?: number; actor?: string; state?: string; origin?: string; value?: string | null; carried?: string | null } = {}) =>
    c.query(
      `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, actor_user_id, carried_from_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [fieldId, draft.id, s.tenderA, o.version ?? 1, o.value === undefined ? '"1"' : o.value, o.state ?? 'edited', o.origin ?? 'manual', o.actor ?? s.ids.eng1, o.carried ?? null],
    );

  it('версию вносит участник с application.fill; номер — следующий; поле — из ревизии; перенос — только в транзакции переноса', async () => {
    const f = fieldOf(draft, 'letter_number');
    await rejects((c) => insertVersion(c, f.fieldId, { actor: s.ids.eng3 }), /42501.*application\.fill/u);
    await rejects((c) => insertVersion(c, f.fieldId, { version: 3 }), /23514.*следующая версия/u);
    await rejects((c) => c.query('INSERT INTO draft_field (draft_id, tender_id, field_key) VALUES ($1, $2, $3)', [draft.id, s.tenderA, 'extra']), /23514.*вместе с приложением/u);
    await rejects(async (c) => {
      const src = (await insertVersion(c, f.fieldId)).rows[0]!.id as string;
      await insertVersion(c, fieldOf(draft, 'addressee').fieldId, { state: 'carried_over', origin: 'carried_over', carried: src });
    }, /23514.*перенос/u);
  });

  it('принятое предложение системы без основания и модель без предложения отвергаются', async () => {
    const f = fieldOf(draft, 'addressee');
    await rejects((c) => insertVersion(c, f.fieldId, { state: 'accepted', origin: 'system_suggestion' }), /23514.*с основанием/u);
    await rejects((c) => insertVersion(c, f.fieldId, { state: 'accepted', origin: 'model_suggestion' }), /23514|draft_field_version_origin_shape/u);
  });

  it('«заполнено» с пустым обязательным полем отвергается; версии неизменны; удаления нет', async () => {
    await rejects((c) => c.query("UPDATE application_draft SET status = 'complete', completed_by = $2, completed_at = now(), row_version = row_version + 1 WHERE id = $1", [draft.id, s.ids.eng1]), /23514.*required_empty/u);
    const ok = await tx((c) => insertVersion(c, fieldOf(draft, 'letter_number').fieldId));
    expect(ok).toBeNull();
    await rejects((c) => c.query("UPDATE draft_field_version SET value = '\"2\"' WHERE field_id = $1", [fieldOf(draft, 'letter_number').fieldId]), /42501|55000|immutable/u);
    await rejects((c) => c.query('DELETE FROM draft_field_version WHERE field_id = $1', [fieldOf(draft, 'letter_number').fieldId]), /42501|55000|immutable/u);
    await rejects((c) => c.query("UPDATE application_draft SET status = 'superseded', row_version = row_version + 1 WHERE id = $1", [draft.id]), /23514.*переносом/u);
  });
});
