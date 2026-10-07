// Регрессии Review 12-1 (docs/reviews/12-review-1.md). Написаны до исправления продукта; на коде fedca66 тесты дефектов
// падают, контрольные сценарии (замена документа, который не является основанием; правки только чужого приложения)
// проходят и до, и после исправления. Выбор входа LibreOffice (R12-01) прежняя функция по окружению не делала вовсе.
// R12-01: на Windows выбирается вход LibreOffice, у которого работают определение версии и конвертация (`soffice.com`),
// в том числе при пути к `soffice.exe` из настройки и в стандартном каталоге установки.
// R12-02: комплект не собирается по значению, основание которого уже заменено: прямое основание, решение по требованию
// (R11-03), подтверждённая копия (R11-05); вторая линия БД; после нового значения и «заполнено» — собирается.
// R12-03: актуальность комплекта считается по всем событиям после базы, а не по первым 200.
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSoffice } from '../apps/worker/src/office/libreoffice.ts';
import { buildEcon, closeEcon, type IEcon } from './economicsFixtures.ts';
import { act, createDraft, demoSchema, draftOf, fieldOf, fillAll, KP_FILLED } from './formsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { etagOf } from './mailFixtures.ts';
import { completeDraft, requireConverter, SAMPLES, templateWithMarkedSample, type ICandidateView } from './releaseFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

// Сборки с LibreOffice на Windows под нагрузкой дольше 30 с (Review 12-1): предел теста — с запасом.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const DOCS = { addressee: 'Адресат.pdf', copy: 'Копия.pdf', requirement: 'Требование.pdf', other: 'Прочее.pdf', control: 'Контроль.pdf' } as const;
const TEXT: Record<keyof typeof DOCS, string> = {
  addressee: 'Письмо направляется тендерному управлению заказчика.',
  copy: 'Адресат письма — дирекция строительства.',
  requirement: 'Предложение адресуется отделу закупок заказчика.',
  other: 'Прочие сведения тендера.',
  control: 'Адресат — служба заказчика по контрольному сценарию.',
};

let db: ITestDb;
let e: IEcon;
let revisionId = '';
let scopeId = '';
let registryId = '';
const rev: Record<string, string> = {};
const frag: Record<string, string> = {};

const processEvents = async () => {
  await e.worker.maintain({ checkModel: false });
  await drain(e.worker);
};

// Новая редакция документа, распознанная тем же текстом (как в штатном пути): ID редакции и фрагмент текста.
const replaceDoc = async (key: keyof typeof DOCS): Promise<{ id: string; fragment: string }> => {
  const id = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, DOCS[key]);
  expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [id])).rows[0].supersedes_revision_id).toBe(rev[key]);
  return { id, fragment: await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, id, { pages: [{ blocks: [TEXT[key]] }] }), TEXT[key]) };
};

const filledDraft = async (title: string, addressee: { value: string; bases: { type: string; id: string }[] }) => {
  const d = await createDraft(e.s.eng1, e.s.stageA, revisionId, title);
  await fillAll(e.s.eng1, d.id, Object.fromEntries(Object.entries(KP_FILLED).filter(([k]) => k !== 'addressee')));
  const f = fieldOf(await draftOf(e.s.eng1, d.id), 'addressee');
  const r = await act(e.s.eng1, d.id, 'addressee', f.etag, { action: 'set', value: addressee.value, bases: addressee.bases });
  expect(r.status, r.text).toBe(200);
  return d.id;
};

const assemble = (draftIds: string[]) => e.s.eng1.post(`/stages/${e.s.stageA}/release-candidates`, { mode: 'test', draftIds }, { headers: idem() });

const assembled = async (draftIds: string[]): Promise<ICandidateView> => {
  const r = await assemble(draftIds);
  expect(r.status, r.text).toBe(201);
  await drain(e.worker);
  const v = await e.s.eng1.get(`/release-candidates/${r.body.id}`);
  expect(v.status, v.text).toBe(200);
  return v.body as ICandidateView;
};

// Проба прямой записи: код ошибки или «ok»; транзакция всегда откатывается (кандидат без задания не остаётся).
const probe = async (fn: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return 'ok';
  } catch (x) {
    return (x as { code?: string }).code ?? 'error';
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
};

beforeAll(async () => {
  requireConverter();
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  for (const k of Object.keys(DOCS) as (keyof typeof DOCS)[]) {
    rev[k] = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, DOCS[k]);
    frag[k] = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev[k]!, { pages: [{ blocks: [TEXT[k]] }] }), TEXT[k]);
  }
  await setWorkingSet(e.s.manager, e.s.stageA, Object.values(rev), true);
  scopeId = await fixScope(e.s.manager, e.s.stageA);
  const reg = await e.s.manager.post(`/stages/${e.s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Реестр Review 12-1' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  registryId = reg.body.id as string;
  await processEvents();
  revisionId = (await templateWithMarkedSample(e.s.manager, { name: 'Письмо КП (Review 12-1)', schema: demoSchema('demo-kp-letter'), marked: SAMPLES.letterMarked, original: SAMPLES.letterOriginal })).revision.id;
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});
// Сценарии независимы: сборка, начатая предыдущим тестом (в том числе ошибочно принятая), завершается до следующего.
beforeEach(async () => {
  await drain(e.worker);
});

describe('R12-01 — вход LibreOffice на Windows', () => {
  const win = (files: string[], pathEnv = '') => ({ platform: 'win32' as const, pathEnv, exists: (p: string) => files.includes(p) });
  const DIR = 'C:\\LO\\program';
  const DEF = 'C:\\Program Files\\LibreOffice\\program';

  it('в PATH есть и soffice.exe, и soffice.com — выбирается soffice.com', () => {
    expect(findSoffice(null, win([`${DIR}\\soffice.exe`, `${DIR}\\soffice.com`], `C:\\Windows;${DIR}`))).toBe(`${DIR}\\soffice.com`);
  });

  it('настройка указывает на soffice.exe, рядом есть soffice.com — используется soffice.com', () => {
    expect(findSoffice(`${DIR}\\soffice.exe`, win([`${DIR}\\soffice.exe`, `${DIR}\\soffice.com`]))).toBe(`${DIR}\\soffice.com`);
  });

  it('стандартный каталог установки без PATH — soffice.com', () => {
    expect(findSoffice(null, win([`${DEF}\\soffice.exe`, `${DEF}\\soffice.com`]))).toBe(`${DEF}\\soffice.com`);
  });

  it('Linux — soffice из PATH; на Windows без соседнего soffice.com — остаётся настроенный файл', () => {
    expect(findSoffice(null, { platform: 'linux', pathEnv: '/usr/local/bin:/usr/bin', exists: (p) => p === '/usr/bin/soffice' })).toBe('/usr/bin/soffice');
    expect(findSoffice(`${DIR}\\soffice.exe`, win([`${DIR}\\soffice.exe`]))).toBe(`${DIR}\\soffice.exe`);
  });
});

describe('R12-02 — комплект не собирается по устаревшему значению', () => {
  it('контроль: новая редакция документа, который не является основанием, сборке не мешает', async () => {
    const d = await filledDraft('Контроль', { value: 'Служба заказчика', bases: [{ type: 'fragment', id: frag.control! }] });
    await completeDraft(e.s.eng1, d);
    await replaceDoc('other');
    const c = await assembled([d]);
    expect(c.status, JSON.stringify(c.failure)).toBe('ready_for_approval');
    expect(c.current).toBe(true);
  });

  it('прямое основание заменено: приложение «заполнено», значение «устарело» — 409; новое значение по новой редакции и «заполнено» — собирается', async () => {
    const d = await filledDraft('Прямое основание', { value: 'Тендерное управление', bases: [{ type: 'fragment', id: frag.addressee! }] });
    await completeDraft(e.s.eng1, d);
    const v2 = await replaceDoc('addressee');
    const view = await draftOf(e.s.eng1, d);
    expect(view.status).toBe('complete');
    expect(fieldOf(view, 'addressee').latest).toMatchObject({ stale: true });
    const r = await assemble([d]);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('drafts_not_complete');
    // Штатный путь: новая редакция распознана, включена в состав источников, снимок зафиксирован; значение — по ней.
    const fresh = v2.fragment;
    const current = (
      await db.pool.query<{ id: string }>(
        'SELECT r.id FROM document_revision r WHERE r.tender_id = $1 AND NOT EXISTS (SELECT 1 FROM document_revision n WHERE n.supersedes_revision_id = r.id)',
        [e.s.tenderA],
      )
    ).rows.map((x) => x.id);
    expect(current).toContain(v2.id);
    await setWorkingSet(e.s.manager, e.s.stageA, current, true);
    await fixScope(e.s.manager, e.s.stageA);
    const f = fieldOf(await draftOf(e.s.eng1, d), 'addressee');
    const upd = await act(e.s.eng1, d, 'addressee', f.etag, { action: 'set', value: 'Тендерное управление', bases: [{ type: 'fragment', id: fresh }] });
    expect(upd.status, upd.text).toBe(200);
    await completeDraft(e.s.eng1, d);
    const c = await assembled([d]);
    expect(c.status, JSON.stringify(c.failure)).toBe('ready_for_approval');
  });

  it('косвенное основание (R11-03): решение по требованию, исходный документ требования заменён — 409', async () => {
    const cand = await e.s.eng1.post(`/requirement-registries/${registryId}/requirement-candidates`, { statement: 'Предложение — отделу закупок.', evidence: [{ fragmentId: frag.requirement, role: 'supports' }] }, { headers: idem() });
    expect(cand.status, cand.text).toBe(201);
    const conf = await e.s.manager.post(`/requirement-candidates/${cand.body.id}/confirm`, {}, { headers: { 'If-Match': await etagOf(e.s.manager, `/requirement-candidates/${cand.body.id}`), ...idem() } });
    expect(conf.status, conf.text).toBe(200);
    const dec = await e.s.manager.post(`/requirements/${conf.body.requirementId}/decisions`, { statement: 'Адресовать отделу закупок', rationale: 'По требованию', evidence: [] }, { headers: idem() });
    expect(dec.status, dec.text).toBe(201);
    const d = await filledDraft('Решение по требованию', { value: 'Отдел закупок', bases: [{ type: 'decision', id: dec.body.decisionId as string }] });
    await completeDraft(e.s.eng1, d);
    await replaceDoc('requirement');
    expect(fieldOf(await draftOf(e.s.eng1, d), 'addressee').latest).toMatchObject({ stale: true });
    const r = await assemble([d]);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('drafts_not_complete');
  });

  it('подтверждённая копия (R11-05): «Подтвердить» значения по фрагменту, документ заменён — 409', async () => {
    const d = await filledDraft('Подтверждённая копия', { value: 'Дирекция строительства', bases: [{ type: 'fragment', id: frag.copy! }] });
    const f = fieldOf(await draftOf(e.s.eng1, d), 'addressee');
    const c = await act(e.s.eng1, d, 'addressee', f.etag, { action: 'confirm' });
    expect(c.status, c.text).toBe(200);
    await completeDraft(e.s.eng1, d);
    await replaceDoc('copy');
    expect(fieldOf(await draftOf(e.s.eng1, d), 'addressee').latest).toMatchObject({ stale: true });
    const r = await assemble([d]);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('drafts_not_complete');
    // После обработки событий (отметки инвалидации) — тоже отказ.
    await processEvents();
    expect((await assemble([d])).status).toBe(409);
  });

  it('вторая линия БД: вход-версия с заменённым основанием и приложение с ней в транзакции создания — 23514', async () => {
    const d = (await db.pool.query<{ id: string }>("SELECT id FROM application_draft WHERE title = 'Подтверждённая копия'")).rows[0]!.id;
    const version = (
      await db.pool.query<{ id: string }>(
        "SELECT v.id FROM draft_field_version v JOIN draft_field f ON f.id = v.field_id WHERE f.draft_id = $1 AND f.field_key = 'addressee' ORDER BY v.version DESC LIMIT 1",
        [d],
      )
    ).rows[0]!.id;
    const insert = (kind: string, ref: string) =>
      probe(async (c) => {
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO release_candidate (tender_id, stage_id, seq, mode, calculation_revision_id, evidence_scope_id, calculation_baseline_version, content_baseline_version, inputs_sha256, created_by)
             VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM release_candidate WHERE stage_id = $2), 'test', $3, $4, 0, 0, repeat('a', 64), $5) RETURNING id`,
            [e.s.tenderA, e.s.stageA, e.rev2, scopeId, e.s.ids.eng1],
          )
        ).rows[0]!.id;
        await c.query('INSERT INTO candidate_input (candidate_id, kind, ref_id, ordinal) VALUES ($1, $2, $3, 0)', [id, kind, ref]);
      });
    expect(await insert('field_version', version)).toBe('23514');
    expect(await insert('application_draft', d)).toBe('23514');
  });
});

describe('R12-03 — актуальность по всем событиям после базы', () => {
  it('200 правок чужого приложения — комплект актуален (контроль); затем правка использованного поля — неактуален в карточке и списке', async () => {
    const a = await filledDraft('Приложение A', { value: 'Служба заказчика', bases: [] });
    await completeDraft(e.s.eng1, a);
    const c = await assembled([a]);
    expect(c.status, JSON.stringify(c.failure)).toBe('ready_for_approval');
    const b = await createDraft(e.s.eng1, e.s.stageA, revisionId, 'Приложение B');
    let etag = fieldOf(await draftOf(e.s.eng1, b.id), 'letter_number').etag;
    for (let n = 1; n <= 200; n += 1) {
      const r = await act(e.s.eng1, b.id, 'letter_number', etag, { action: 'set', value: `Б-${n}`, bases: [] });
      expect(r.status, r.text).toBe(200);
      etag = r.headers.etag as string;
    }
    const listed = async () => ((await e.s.eng1.get(`/stages/${e.s.stageA}/release-candidates`)).body.items as { id: string; current: boolean }[]).find((x) => x.id === c.id)!;
    expect((await e.s.eng1.get(`/release-candidates/${c.id}`)).body.current).toBe(true);
    expect((await listed()).current).toBe(true);
    const f = fieldOf(await draftOf(e.s.eng1, a), 'subject');
    expect((await act(e.s.eng1, a, 'subject', f.etag, { action: 'set', value: 'Изменённый предмет', bases: [] })).status).toBe(200);
    const after = (await e.s.eng1.get(`/release-candidates/${c.id}`)).body as ICandidateView & { eventsAfter: { affects: boolean }[] };
    expect(after.current).toBe(false);
    expect(after.eventsAfter.some((x) => x.affects)).toBe(true);
    expect((await listed()).current).toBe(false);
  });
});
