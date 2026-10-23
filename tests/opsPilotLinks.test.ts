// Этап 18, повторное ревью 18-1 (R18-01, R18-02): отчёт пилота на штатных данных портала.
// R18-02: фрагмент тела письма и фрагмент вложения письма, связанного с тендером, — источник этого тендера (G2/G3);
//   письмо без связи или связанное только с другим тендером — нарушение.
// R18-01: идентификаторы сопоставления сверяются с БД — случайный uuid, замечание другого тендера и непринятое замечание
//   в цитатах дают FAIL по G1, М1, М3; настоящее принятое замечание тендера — PASS. Данные вымышленные.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectG2, collectG3, withReadOnly } from '../scripts/ops/pilot-db.ts';
import { evaluateG2, evaluateG3 } from '../scripts/ops/pilot-gates.ts';
import { sha256Hex } from '../scripts/ops/pilot-schema.ts';
import { ADMIN_URL, createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { buildStage09, closeHub, type IStage09 } from './reviewFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ROOT = resolve(import.meta.dirname, '..');
const CATEGORY = 'фрагмент основания замечания не из источников тендера';

let db: ITestDb;
let st: IStage09;
let su: pg.Client;

const hex = (): string => randomUUID().replace(/-/gu, '').repeat(2);

// Замечание этапа A через API (201) с основанием-фрагментом; решённое — через переход resolved (200).
const createFinding = async (title: string, fragmentId: string): Promise<string> => {
  const r = await st.s.eng1.post(`/stages/${st.s.stageA}/findings`, { title, severity: 'major', confidence: 'high', evidence: [{ side: 'left', fragmentId }] }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};
const toResolved = async (id: string): Promise<void> => {
  const etag = (await st.s.eng1.get(`/findings/${id}`)).headers.etag as string;
  const r = await st.s.eng1.post(`/findings/${id}/transitions`, { to: 'resolved', reason: 'Согласовано письмом заказчика', statement: 'Принято к исполнению' }, { headers: { 'If-Match': etag, ...idem() } });
  expect(r.status, r.text).toBe(200);
};
const resolvedFinding = async (title: string, fragmentId: string): Promise<string> => {
  const id = await createFinding(title, fragmentId);
  await toResolved(id);
  return id;
};

// Письмо, импортированное в портал, и фрагмент его тела; связь с тендером — по желанию (linkTo).
const importLetter = async (tag: string, linkTo: { tenderId: string; stageId: string } | null): Promise<string> => {
  const box = await createMailbox(st.s.admin, `${tag}@contractor.example.test`, `Ящик ${tag}`);
  for (const id of [st.s.ids.eng1, st.s.ids.manager]) await setMailAccess(st.s.admin, box, id, ['mail.read', 'mail.import', 'mail.link']);
  const done = await importEml(st.s.eng1, st.worker, box, eml({ messageId: `${tag}@example.test`, subject: `Письмо ${tag}`, text: `Текст письма ${tag}.` }));
  if (linkTo) await linkMail(st.s.manager, done.messageId!, linkTo.tenderId, linkTo.stageId);
  const r = await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [done.revisionId]);
  return r.rows[0]!.id;
};

const evidenceIds = async (findingId: string): Promise<string[]> => (await su.query<{ id: string }>('SELECT id FROM finding_evidence WHERE finding_id = $1', [findingId])).rows.map((r) => r.id);
const g3Ids = async (): Promise<string[]> => (await withReadOnly(db.appUrl, (c) => collectG3(c, st.s.tenderA))).violations.find((v) => v.category === CATEGORY)?.ids ?? [];

beforeAll(async () => {
  db = await createTestDb();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db.name}`;
  su = new pg.Client({ connectionString: u.toString() });
  await su.connect();
  await su.query("SET session_replication_role = 'replica'");
  st = await buildStage09(db, testConfig());
});
afterAll(async () => {
  await su?.end();
  await closeHub(st);
  await db?.drop();
});

describe('R18-02: фрагмент письма — источник тендера, с которым письмо связано', () => {
  it('замечание с фрагментом письма тендера: создано (201), решено (200); G2 PASS, G3 без нарушений по нему', async () => {
    const id = await resolvedFinding('Замена светильника по письму', st.frag.letter);
    const frag = (await su.query<{ source_unit_type: string; tender_id: string | null; contract_id: string | null; in_stage: boolean }>(
      'SELECT source_unit_type, tender_id, contract_id, fragment_in_stage(id, $2) AS in_stage FROM evidence_fragment WHERE id = $1',
      [st.frag.letter, st.s.stageA],
    )).rows[0];
    expect(frag).toEqual({ source_unit_type: 'mail_message_revision', tender_id: null, contract_id: null, in_stage: true });
    const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, st.s.tenderA));
    expect(g2.checks.filter((c) => c.objectId === id)).toEqual([expect.objectContaining({ fragmentId: st.frag.letter, owned: true, inScope: true })]);
    expect(evaluateG2(g2.checks, g2.conclusions, false).status).toBe('PASS');
    const g3 = await withReadOnly(db.appUrl, (c) => collectG3(c, st.s.tenderA));
    expect(g3.violations.filter((v) => v.count > 0)).toEqual([]);
    expect(evaluateG3(g3.violations, g3.checked).status).toBe('PASS');
  });

  it('положительный контроль: замечание с фрагментом документа тендера — owned, G2 PASS', async () => {
    const id = await resolvedFinding('Светильники по ТЗ', st.frag.lamp);
    const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, st.s.tenderA));
    expect(g2.checks.filter((c) => c.objectId === id)).toEqual([expect.objectContaining({ fragmentId: st.frag.lamp, owned: true, inScope: true })]);
    // Только своё замечание: общий итог G2 зависит от замечания с письмом из предыдущего теста.
    const r = evaluateG2(g2.checks, g2.conclusions, false);
    expect((r.data.foreignOrOutOfScope as { objectId: string }[]).filter((x) => x.objectId === id)).toEqual([]);
    expect(await g3Ids()).not.toContain((await evidenceIds(id))[0]);
  });

  for (const [name, linkTo] of [['связанного только с тендером B', 'B'], ['не связанного ни с одним тендером', null]] as const) {
    it(`фрагмент письма, ${name}, в основании принятого замечания A: нарушение G2 и G3 по этому id`, async () => {
      const foreign = await importLetter(linkTo === null ? 'unlinked' : 'tender-b', linkTo === null ? null : { tenderId: st.s.tenderB, stageId: st.s.stageB });
      const id = await resolvedFinding(`Основание из чужого письма (${name})`, st.frag.lamp);
      // API чужой фрагмент в основании не примет — добавляем строкой, как данные в обход портала.
      await su.query("INSERT INTO finding_evidence (finding_id, tender_id, side, object_type, fragment_id) VALUES ($1, $2, 'right', 'fragment', $3)", [id, st.s.tenderA, foreign]);
      const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, st.s.tenderA));
      expect(g2.checks.filter((c) => c.objectId === id && c.fragmentId === foreign)).toEqual([expect.objectContaining({ owned: false })]);
      const r = evaluateG2(g2.checks, g2.conclusions, false);
      expect(r.status).toBe('FAIL');
      expect((r.data.foreignOrOutOfScope as { objectId: string; fragmentId: string }[]).filter((x) => x.objectId === id)).toEqual([{ kind: 'finding', objectId: id, fragmentId: foreign }]);
      const ev = (await su.query<{ id: string }>('SELECT id FROM finding_evidence WHERE finding_id = $1 AND fragment_id = $2', [id, foreign])).rows[0]!.id;
      expect(await g3Ids()).toContain(ev);
      // Основание-фрагмент тендера у того же замечания нарушением не стало.
      expect(await g3Ids()).not.toContain((await evidenceIds(id)).find((x) => x !== ev));
    });
  }
});

describe('R18-01: отчёт пилота сверяет идентификаторы сопоставления с БД', () => {
  const work = mkdtempSync(join(tmpdir(), 'kontur-pilot-links-'));
  const write = (name: string, value: unknown): string => {
    const path = join(work, name);
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
  };
  const run = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
    new Promise((done) => {
      execFile(process.execPath, [join(ROOT, 'scripts', 'ops', 'pilot.ts'), ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: db.appUrl }, timeout: 60_000 }, (error, out, err) => {
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err });
      });
    });

  const refRaw = {
    schema: 'kontur.pilot-reference.v1',
    tenderId: '',
    author: 'инженер',
    createdAt: '2026-10-21T10:00:00+03:00',
    items: [
      { id: 'REF-001', kind: 'conflict', critical: true, summary: 'критический конфликт', sources: [{ document: 'a.pdf', locator: 'п. 1', quote: 'дословный фрагмент' }], expected: 'ожидаемый вывод' },
      { id: 'REF-002', kind: 'change', critical: false, summary: 'изменение', sources: [], expected: 'ожидаемый вывод' },
    ],
  };

  interface IStatuses {
    G1: string;
    M1: string;
    M3: string;
    linkErrors: Record<'G1' | 'M1' | 'M3', { why: string }[]>;
  }
  // found — идентификаторы для REF-001 и REF-002, cited — выборка цитат; М2 размечен по всем замечаниям тендера кроме stale.
  const report = async (name: string, found: [string, string], cited: string[]): Promise<IStatuses> => {
    const tender = st.s.tenderA;
    const refPath = write(`ref-${name}.json`, { ...refRaw, tenderId: tender });
    const marked = (await su.query<{ id: string }>("SELECT id FROM finding WHERE tender_id = $1 AND status <> 'stale' ORDER BY id", [tender])).rows;
    const matchPath = write(`match-${name}.json`, {
      schema: 'kontur.pilot-matching.v1',
      tenderId: tender,
      items: [{ id: 'REF-001', result: 'found', found: [found[0]] }, { id: 'REF-002', result: 'found', found: [found[1]] }],
      findings: marked.map((f) => ({ id: f.id, verdict: 'true' })),
      citations: cited.map((ref) => ({ ref, verdict: 'supports' })),
    });
    const out = join(work, `out-${name}`);
    const r = await run(['report', '--tender', tender, '--reference', refPath, '--sealed', sha256Hex(readFileSync(refPath)), '--matching', matchPath, '--out', out, '--defects', join(work, 'нет-журнала.md')]);
    expect(r.err, r.err).not.toContain('отказ');
    // Код возврата может быть 1 из-за других ворот (G4, G5, G7): проверяются только G1, М1, М3.
    const json = JSON.parse(readFileSync(join(out, 'pilot-report.json'), 'utf8')) as { gates: { id: string; status: string; data: { linkErrors?: { why: string }[] } }[]; metrics: { id: string; status: string; data: { linkErrors?: { why: string }[] } }[] };
    const by = Object.fromEntries([...json.gates, ...json.metrics].map((x) => [x.id, x]));
    return {
      G1: by.G1!.status,
      M1: by.M1!.status,
      M3: by.M3!.status,
      linkErrors: { G1: by.G1!.data.linkErrors ?? [], M1: by.M1!.data.linkErrors ?? [], M3: by.M3!.data.linkErrors ?? [] },
    };
  };

  let accepted: string;
  let open: string;
  let foreign: string;
  beforeAll(async () => {
    accepted = await resolvedFinding('Принятое замечание пилота', st.frag.masonry);
    open = await createFinding('Открытое замечание пилота', st.frag.facade);
    // Замечание другого тендера: строка в обход портала (второй тендер сценария, его этап).
    foreign = randomUUID();
    await su.query(
      "INSERT INTO finding (id, tender_id, stage_id, finding_key, kind, origin, title, severity, confidence, status, created_by, created_input_version) VALUES ($1, $2, $3, $4, 'k', 'human', 'T', 'major', 'high', 'resolved', $5, 0)",
      [foreign, st.s.tenderB, st.s.stageB, hex(), st.s.ids.manager],
    );
  });

  it('(1) случайный uuid в found и citations: G1, М1, М3 — FAIL, ошибки not_in_portal в отчёте', async () => {
    const r = await report('random', [randomUUID(), randomUUID()], [randomUUID()]);
    expect([r.G1, r.M1, r.M3]).toEqual(['FAIL', 'FAIL', 'FAIL']);
    expect(r.linkErrors.G1.map((e) => e.why)).toEqual(['not_in_portal']);
    expect(r.linkErrors.M1.map((e) => e.why)).toEqual(['not_in_portal']);
    expect(r.linkErrors.M3.map((e) => e.why)).toEqual(['not_in_portal']);
  });

  it('(2) замечание другого тендера: other_tender, показатели FAIL', async () => {
    const r = await report('foreign', [foreign, foreign], [foreign]);
    expect([r.G1, r.M1, r.M3]).toEqual(['FAIL', 'FAIL', 'FAIL']);
    expect(r.linkErrors.G1.map((e) => e.why)).toEqual(['other_tender']);
    expect(r.linkErrors.M1.map((e) => e.why)).toEqual(['other_tender']);
    expect(r.linkErrors.M3.map((e) => e.why)).toEqual(['other_tender']);
  });

  it('(3) открытое замечание в цитатах: М3 FAIL с not_accepted', async () => {
    const r = await report('open', [accepted, accepted], [open]);
    expect(r.M3).toBe('FAIL');
    expect(r.linkErrors.M3.map((e) => e.why)).toEqual(['not_accepted']);
    expect([r.G1, r.M1]).toEqual(['PASS', 'PASS']);
  });

  it('(4) положительный контроль: принятое замечание тендера в found обоих пунктов и в цитатах — G1, М1, М3 PASS', async () => {
    const r = await report('ok', [accepted, accepted], [accepted]);
    expect([r.G1, r.M1, r.M3]).toEqual(['PASS', 'PASS', 'PASS']);
    expect(r.linkErrors).toEqual({ G1: [], M1: [], M3: [] });
  });
});
