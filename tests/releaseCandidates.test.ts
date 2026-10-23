// Этап 12 — комплект-кандидат через API на настоящем worker и LibreOffice (D-032; ADR-013; проверки задания):
// разметка ревизии и её утверждение; сборка из закреплённых входов с точными файлами, превью и манифестом; чтение не
// пересобирает; идемпотентность; числа с расчётом; пометки режимов в документах и превью; права при сборке и при каждом
// получении содержимого (отзыв доступа закрывает файлы); неактуальность при изменении использованного поля и
// независимость от чужих приложений; новый кандидат заменяет прежний (A09); вложения «как есть»; ZIP комплекта;
// конвертер не найден и подмена шрифта — сборка не проходит.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareWithCalculation, DEMO_MARK, TEST_MARK } from '../packages/core/src/index.ts';
import { inspectPdf } from '../packages/adapters/src/index.ts';
import { buildEcon, closeEcon, type IEcon } from './economicsFixtures.ts';
import { createDraft, demoSchema, KEY_FILLED, KP_FILLED, setValue, fillAll } from './formsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { completeDraft, requireConverter, SAMPLES, templateWithMarkedSample, uploadSample, uploadSampleFile, type ICandidateView } from './releaseFixtures.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

// Сборки и конвертации LibreOffice на Windows под нагрузкой дольше 30 с (Review 12-1: тест двух сборок превысил предел,
// следующий получил `candidate_assembling`): предел теста — с запасом, ожидания не меняются.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const MAIL_ACCESS = ['mail.read', 'mail.import', 'mail.link'];
const SECRET = 'Закрытое условие письма для комплекта';

let db: ITestDb;
let e: IEcon;
let box = '';
let letterRevision = '';
let conditionsRevision = '';
let kpPrice = '';
const frag: Record<string, string> = {};
const drafts = {} as Record<'letter' | 'conditions' | 'other', string>;
let first: ICandidateView;

const getBytes = async (client: TestClient, path: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> => {
  const r = await client.getBuffer(path);
  return { status: r.status, body: r.body as Buffer, headers: r.headers as Record<string, string> };
};

const view = async (client: TestClient, id: string): Promise<ICandidateView> => {
  const r = await client.get(`/release-candidates/${id}`);
  expect(r.status, r.text).toBe(200);
  return r.body as ICandidateView;
};

const assemble = async (client: TestClient, body: Record<string, unknown>, headers: Record<string, string> = idem()) => {
  const r = await client.post(`/stages/${e.s.stageA}/release-candidates`, body, { headers });
  return r;
};

const created = async (client: TestClient, body: Record<string, unknown>): Promise<ICandidateView> => {
  const r = await assemble(client, body);
  expect(r.status, r.text).toBe(201);
  expect(r.body.status).toBe('assembling');
  await drain(e.worker);
  return view(client, r.body.id as string);
};

const filled = async (client: TestClient, key: 'letter' | 'conditions', title: string) => {
  const d = await createDraft(client, e.s.stageA, key === 'letter' ? letterRevision : conditionsRevision, title);
  await fillAll(client, d.id, key === 'letter' ? { ...KP_FILLED, kp_price: kpPrice } : KEY_FILLED);
  await completeDraft(client, d.id);
  return d.id;
};

beforeAll(async () => {
  requireConverter();
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  box = await createMailbox(e.s.admin, 'release-12@contractor.example.test', 'Ящик комплекта');
  for (const id of [e.s.ids.eng1, e.s.ids.manager]) await setMailAccess(e.s.admin, box, id, MAIL_ACCESS);
  const letter = await importEml(e.s.eng1, e.worker, box, eml({ messageId: 'release-12@example.test', subject: 'Условие', text: SECRET }));
  await linkMail(e.s.eng1, letter.messageId!, e.s.tenderA, e.s.stageA);
  frag.letter = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [letter.revisionId])).rows[0]!.id;
  const doc = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  frag.tz = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Техническое задание демонстрационного объекта.'] }] }), 'Техническое задание демонстрационного объекта.');
  await setWorkingSet(e.s.manager, e.s.stageA, [doc], true);
  await fixScope(e.s.manager, e.s.stageA);
  const grand = (await db.pool.query<{ g: string }>('SELECT cc.source_grand_total AS g FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id WHERE r.id = $1', [e.rev2])).rows[0]!.g;
  const m = compareWithCalculation({ unit: 'млн руб.', currency: 'RUB', scale: 2 }, '0', 'source_grand_total', grand);
  kpPrice = m.outcome === 'unverified' ? '0' : m.expected;
  letterRevision = (await templateWithMarkedSample(e.s.manager, { name: 'Письмо КП (демо)', schema: demoSchema('demo-kp-letter'), marked: SAMPLES.letterMarked, original: SAMPLES.letterOriginal })).revision.id;
  conditionsRevision = (await templateWithMarkedSample(e.s.manager, { name: 'Ключевые условия (демо)', schema: demoSchema('demo-key-conditions'), marked: SAMPLES.conditionsMarked, original: SAMPLES.conditionsOriginal, audience: 'internal' })).revision.id;
  drafts.letter = await filled(e.s.eng1, 'letter', 'Письмо КП');
  drafts.conditions = await filled(e.s.eng1, 'conditions', 'Ключевые условия');
  drafts.other = await filled(e.s.eng1, 'letter', 'Письмо КП, второй вариант');
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

describe('разметка образца при создании ревизии (D-032 В-12-3)', () => {
  it('размеченная копия проверена; копия без плейсхолдеров не утверждается (API 409, БД 23514)', async () => {
    const bad = await templateWithMarkedSample(e.s.manager, { name: 'Без разметки', schema: demoSchema('demo-kp-letter'), marked: SAMPLES.letterOriginal, approve: false });
    expect(bad.revision).toMatchObject({ outputFormat: 'docx', markup: { ok: false } });
    expect(bad.revision.markup!.issues.map((i) => i.code)).toContain('no_placeholders');
    const a = await e.s.manager.post(`/template-revisions/${bad.revision.id}/approve`, { basisFragmentIds: [] }, { headers: { 'If-Match': bad.revision.etag } });
    expect(a.status, a.text).toBe(409);
    expect(a.body.current.reason).toBe('markup_invalid');
    const err = await db.pool
      .query("UPDATE template_revision SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [bad.revision.id, e.s.ids.manager])
      .then(() => null, (x: { code?: string }) => x.code);
    expect(err).toBe('23514');
    const sha = await uploadSampleFile(e.s.manager, SAMPLES.letterMarked);
    const dry = await e.s.manager.post('/template-markup-check', { schema: demoSchema('demo-kp-letter'), markedSample: { sha256: sha } });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body).toMatchObject({ outputFormat: 'docx', markup: { ok: true } });
    expect((await e.s.eng1.post('/template-markup-check', { schema: demoSchema('demo-kp-letter'), markedSample: { sha256: sha } })).status).toBe(403);
  });
});

describe('сборка комплекта (проверки задания)', () => {
  it('тестовый комплект: точные файлы, превью, манифест; отметки в документах и превью; числа с расчётом', async () => {
    first = await created(e.s.eng1, { mode: 'test', draftIds: [drafts.letter, drafts.conditions] });
    expect(first.status, JSON.stringify(first.failure ?? first.checks.filter((c) => c.outcome === 'failed'))).toBe('ready_for_approval');
    expect(first.converterVersion).toMatch(/LibreOffice/u);
    expect(first.files.map((f) => [f.path, f.role, f.audience])).toEqual([
      ['01 Письмо КП.docx', 'document', 'customer'],
      ['03 Ключевые условия.xlsx', 'document', 'internal'],
    ]);
    expect(first.previews).toHaveLength(2);
    expect(first.checks.filter((c) => c.outcome === 'failed')).toEqual([]);
    expect(first.checks.find((c) => c.code === 'numbers_match_calculation')).toMatchObject({ outcome: 'passed' });
    // Правило итога КП теперь ставит захват (D-044); сверка экономики захваченной ревизии не сведена.
    expect(first.notes.join('\n')).toMatch(/KP_TOTAL_UNRECONCILED/u);
    expect(first.knownProductionBlockers).toEqual([]);
    const docx = await getBytes(e.s.eng1, `/candidate-files/${first.files[0]!.id}/content`);
    expect(docx.status).toBe(200);
    expect(docx.headers['x-content-sha256']).toBe(first.files[0]!.sha256);
    expect(createHash('sha256').update(docx.body).digest('hex')).toBe(first.files[0]!.sha256);
    expect(docx.headers['content-disposition']).toMatch(/^attachment/u);
    const pdf = await getBytes(e.s.eng1, `/candidate-files/${first.files[0]!.previewFileId}/content`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-security-policy']).toMatch(/sandbox/u);
    const text = (await inspectPdf(pdf.body)).pageTexts.join(' ').replace(/\s+/gu, ' ');
    for (const s of [TEST_MARK, DEMO_MARK, KP_FILLED.letter_number as string, '06.10.2026']) expect(text).toContain(s);
    const manifest = await getBytes(e.s.eng1, `/release-candidates/${first.id}/manifest`);
    expect(createHash('sha256').update(manifest.body).digest('hex')).toBe(first.contentHash);
    const mj = JSON.parse(manifest.body.toString('utf8')) as { files: { path: string; sha256: string; size: number; audience: string }[]; converter: { version: string }; inputs: { calculationRevision: { id: string } } };
    expect(mj.inputs.calculationRevision.id).toBe(e.rev2);
    expect(mj.converter.version).toBe(first.converterVersion);
    for (const f of first.files) expect(mj.files).toContainEqual(expect.objectContaining({ path: f.path, sha256: f.sha256, size: f.sizeBytes, audience: f.audience }));
  });

  it('чтение не пересобирает: тот же хэш, те же байты, задание сборки одно', async () => {
    const again = await view(e.s.manager, first.id);
    expect(again.contentHash).toBe(first.contentHash);
    expect(again.files).toEqual(first.files);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM job WHERE kind = 'candidate.assemble' AND payload->>'candidateId' = $1", [first.id])).rows[0].n).toBe(1);
  });

  it('ZIP комплекта: заказчику — только файлы для заказчика; «все» — с превью и манифестом', async () => {
    const z = await getBytes(e.s.eng1, `/release-candidates/${first.id}/archive`);
    expect(z.status).toBe(200);
    expect(Object.keys(new PizZip(z.body).files)).toEqual(['01 Письмо КП.docx']);
    const all = await getBytes(e.s.eng1, `/release-candidates/${first.id}/archive?set=all`);
    expect(Object.keys(new PizZip(all.body).files).sort()).toEqual(['01 Письмо КП (превью).pdf', '01 Письмо КП.docx', '03 Ключевые условия (превью).pdf', '03 Ключевые условия.xlsx', 'manifest.json'].sort());
  });

  it('идемпотентность: тот же ключ — тот же кандидат; пока собирается — второй не создаётся', async () => {
    const key = idem();
    const a = await assemble(e.s.eng1, { mode: 'test', draftIds: [drafts.letter] }, key);
    expect(a.status, a.text).toBe(201);
    const b = await assemble(e.s.eng1, { mode: 'test', draftIds: [drafts.letter] }, key);
    expect(b.body.id).toBe(a.body.id);
    const c = await assemble(e.s.eng1, { mode: 'test', draftIds: [drafts.letter] });
    expect(c.status).toBe(409);
    expect(c.body.current.reason).toBe('candidate_assembling');
    await drain(e.worker);
    expect((await view(e.s.eng1, a.body.id as string)).status).toBe('ready_for_approval');
    expect((await view(e.s.eng1, first.id)).status).toBe('superseded');
  });
});

describe('актуальность и новый кандидат (D-032 В-12-9; A09)', () => {
  it('правка чужого приложения — комплект актуален; правка использованного поля — неактуален; новый кандидат заменяет прежний', async () => {
    const cand = await created(e.s.eng1, { mode: 'test', draftIds: [drafts.letter] });
    expect(cand.current).toBe(true);
    await setValue(e.s.eng1, drafts.other, 'validity_days', '45');
    const after = await view(e.s.eng1, cand.id);
    expect(after.current).toBe(true);
    expect(after.eventsAfter.map((x) => [x.type, x.affects])).toEqual([['draft_field_changed', false]]);
    await setValue(e.s.eng1, drafts.letter, 'validity_days', '60');
    const stale = await view(e.s.eng1, cand.id);
    expect(stale.current).toBe(false);
    expect(stale.eventsAfter.some((x) => x.type === 'draft_field_changed' && x.affects)).toBe(true);
    expect(stale.contentHash).toBe(cand.contentHash);
    const notComplete = await assemble(e.s.eng1, { mode: 'test', draftIds: [drafts.letter] });
    expect(notComplete.status).toBe(409);
    expect(notComplete.body.current.reason).toBe('drafts_not_complete');
    await completeDraft(e.s.eng1, drafts.letter);
    const next = await created(e.s.eng1, { mode: 'test', draftIds: [drafts.letter] });
    expect(next.status).toBe('ready_for_approval');
    expect(next.contentHash).not.toBe(cand.contentHash);
    expect((await view(e.s.eng1, cand.id)).status).toBe('superseded');
  });
});

describe('боевой режим и блокеры (D-032 В-12-8)', () => {
  it('боевой комплект на демо-форме и предварительном расчёте собирается без тестовой отметки, блокеры показаны', async () => {
    const p = await created(e.s.manager, { mode: 'production', draftIds: [drafts.letter] });
    expect(p.status).toBe('ready_for_approval');
    expect(p.knownProductionBlockers.sort()).toEqual(['CALCULATION_PROVISIONAL', 'TEMPLATE_DEMO']);
    const pdf = await getBytes(e.s.manager, `/candidate-files/${p.files[0]!.previewFileId}/content`);
    const text = (await inspectPdf(pdf.body)).pageTexts.join(' ');
    expect(text).toContain(DEMO_MARK);
    expect(text).not.toContain(TEST_MARK);
  });
});

describe('числа с расчётом (D-032 В-12-6)', () => {
  it('цена КП не совпадает с итогом источника — сборка не проходит', async () => {
    const d = await createDraft(e.s.eng1, e.s.stageA, letterRevision, 'Письмо с другой ценой');
    await fillAll(e.s.eng1, d.id, { ...KP_FILLED, kp_price: '1.01' });
    await completeDraft(e.s.eng1, d.id);
    const c = await created(e.s.eng1, { mode: 'test', draftIds: [d.id] });
    expect(c.status).toBe('assembly_failed');
    expect(c.failure!.code).toBe('numbers_match_calculation');
    expect(c.files).toEqual([]);
  });
});

describe('права (D-032 В-12-7)', () => {
  it('значение по закрытому письму: инженер без mail.read комплект не собирает и не видит; отзыв права закрывает файлы', async () => {
    const d = await createDraft(e.s.manager, e.s.stageA, letterRevision, 'Письмо по закрытому условию');
    await fillAll(e.s.manager, d.id, { ...KP_FILLED, kp_price: kpPrice });
    await setValue(e.s.manager, d.id, 'conditions_text', SECRET, [{ type: 'fragment', id: frag.letter! }]);
    await completeDraft(e.s.manager, d.id);
    await setMailAccess(e.s.admin, box, e.s.ids.eng1, []);
    try {
      const denied = await assemble(e.s.eng1, { mode: 'test', draftIds: [d.id] });
      expect(denied.status).toBe(409);
      expect(denied.body.current.reason).toBe('restricted_inputs');
      const c = await created(e.s.manager, { mode: 'test', draftIds: [d.id] });
      expect(c.status).toBe('ready_for_approval');
      const shell = await view(e.s.eng1, c.id);
      expect(shell).toMatchObject({ restricted: true });
      expect((shell as unknown as { files?: unknown }).files).toBeUndefined();
      for (const path of [`/candidate-files/${c.files[0]!.id}/content`, `/candidate-files/${c.files[0]!.previewFileId}/content`, `/release-candidates/${c.id}/manifest`, `/release-candidates/${c.id}/archive`]) {
        const r = await e.s.eng1.get(path);
        expect(r.status, path).toBe(409);
        expect(JSON.stringify(r.body)).not.toContain(SECRET);
      }
      expect((await e.s.eng3.get(`/release-candidates/${c.id}`)).status).toBe(404);
      await setMailAccess(e.s.admin, box, e.s.ids.manager, []);
      expect(await view(e.s.manager, c.id)).toMatchObject({ restricted: true });
      expect((await e.s.manager.get(`/candidate-files/${c.files[0]!.id}/content`)).status).toBe(409);
    } finally {
      await setMailAccess(e.s.admin, box, e.s.ids.eng1, MAIL_ACCESS);
      await setMailAccess(e.s.admin, box, e.s.ids.manager, MAIL_ACCESS);
    }
  });
});

describe('вложения «как есть» (D-032 В-12-4)', () => {
  it('утверждённое вложение входит в комплект байт-в-байт с превью', async () => {
    const a = await e.s.manager.post('/standard-attachments', { title: 'Руководство (демо)' }, { headers: idem() });
    expect(a.status, a.text).toBe(201);
    const sha = await uploadSampleFile(e.s.manager, SAMPLES.letterOriginal);
    const r = await e.s.manager.post(`/standard-attachments/${a.body.id}/revisions`, { sha256: sha, fileName: 'Руководство.docx' }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    expect((await e.s.eng1.post(`/standard-attachment-revisions/${r.body.revisionId}/approve`, {}, { headers: { 'If-Match': r.headers.etag as string } })).status).toBe(403);
    const ok = await e.s.manager.post(`/standard-attachment-revisions/${r.body.revisionId}/approve`, {}, { headers: { 'If-Match': r.headers.etag as string } });
    expect(ok.status, ok.text).toBe(200);
    const c = await created(e.s.eng1, { mode: 'test', draftIds: [drafts.letter], attachmentRevisionIds: [r.body.revisionId] });
    expect(c.status, JSON.stringify(c.failure)).toBe('ready_for_approval');
    const att = c.files.find((f) => f.role === 'attachment')!;
    expect(att).toMatchObject({ path: '03 Руководство.docx', audience: 'customer', sha256: sha });
    expect(createHash('sha256').update(readFileSync(SAMPLES.letterOriginal)).digest('hex')).toBe(sha);
  });
});

describe('форматы — только заявленные (ADR-013; проверка задания)', () => {
  it('размеченная копия — DOCX или XLSX, вложение — DOCX, XLSX, DOC или PDF; расширение файла — по содержимому', async () => {
    const pdf = await uploadSample(e.s.manager, Buffer.from(await requireConverter().toPdf(readFileSync(SAMPLES.letterOriginal), 'docx')), 'образец.pdf');
    const doc = await uploadSample(e.s.manager, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]), 'образец.doc');
    const txt = await uploadSample(e.s.manager, Buffer.from('{{letter_number}}', 'utf8'), 'образец.txt');
    const t = await e.s.manager.post('/application-templates', { ownerKind: 'company', name: 'Форматы', isDemo: true }, { headers: idem() });
    for (const sha of [pdf, doc, txt]) {
      const r = await e.s.manager.post(`/application-templates/${t.body.id}/revisions`, { schema: demoSchema('demo-kp-letter'), markedSample: { sha256: sha, name: 'копия' } }, { headers: idem() });
      expect(r.status, r.text).toBe(400);
      expect(r.text).toMatch(/DOCX или XLSX/u);
    }
    const a = await e.s.manager.post('/standard-attachments', { title: 'Перечень (демо)' }, { headers: idem() });
    const bad = await e.s.manager.post(`/standard-attachments/${a.body.id}/revisions`, { sha256: txt, fileName: 'Перечень.txt' }, { headers: idem() });
    expect(bad.status, bad.text).toBe(400);
    const r = await e.s.manager.post(`/standard-attachments/${a.body.id}/revisions`, { sha256: pdf, fileName: 'Перечень.docx' }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    expect(r.body.mediaType).toBe('application/pdf');
    const ok = await e.s.manager.post(`/standard-attachment-revisions/${r.body.revisionId}/approve`, {}, { headers: { 'If-Match': r.headers.etag as string } });
    expect(ok.status, ok.text).toBe(200);
    const c = await created(e.s.eng1, { mode: 'test', attachmentRevisionIds: [r.body.revisionId] });
    expect(c.status, JSON.stringify(c.failure)).toBe('ready_for_approval');
    expect(c.files.find((f) => f.role === 'attachment')).toMatchObject({ path: '01 Перечень.pdf', mediaType: 'application/pdf', sha256: pdf });
  });
});

describe('переполнение ячейки XLSX (проверка задания: длинные тексты)', () => {
  it('длинный текст в строке с заданной высотой — cell_overflow с адресом ячейки, сборка не проходит', async () => {
    const z = new PizZip(readFileSync(SAMPLES.conditionsMarked));
    const sheet = z.file('xl/worksheets/sheet1.xml')!.asText();
    expect(sheet).toContain('<row r="4">');
    z.file('xl/worksheets/sheet1.xml', sheet.replace('<row r="4">', '<row r="4" ht="12.75" customHeight="1">'));
    const t = await templateWithMarkedSample(e.s.manager, { name: 'Условия с фиксированной строкой', schema: demoSchema('demo-key-conditions'), marked: z.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), audience: 'internal' });
    expect(t.revision.status).toBe('approved');
    const d = await createDraft(e.s.eng1, e.s.stageA, t.revision.id, 'Условия с длинным текстом');
    await fillAll(e.s.eng1, d.id, { ...KEY_FILLED, estimate_units: 'Сметы составляются по этажам и секциям или комплексом работ. '.repeat(6).trim() });
    await completeDraft(e.s.eng1, d.id);
    const c = await created(e.s.eng1, { mode: 'test', draftIds: [d.id] });
    expect(c.status).toBe('assembly_failed');
    const k = c.checks.find((x) => x.code === 'cell_overflow')!;
    expect(k).toMatchObject({ outcome: 'failed' });
    expect(k.detail).toMatch(/Условия!C4/u);
    expect(c.files).toEqual([]);
  });
});

describe('сборка не проходит (D-032 В-12-2)', () => {
  it('конвертер не найден — «сборка не удалась: converter_unavailable»', async () => {
    const r = await assemble(e.s.eng1, { mode: 'test', draftIds: [drafts.conditions] });
    expect(r.status, r.text).toBe(201);
    await drain(workerWithChat(db, { ...e.config, office: { sofficePath: '/nonexistent/soffice', convertTimeoutMs: 1000 } }, null, 'no-converter'));
    const c = await view(e.s.eng1, r.body.id as string);
    expect(c).toMatchObject({ status: 'assembly_failed', failure: { code: 'converter_unavailable' } });
  });

  it('шрифт образца не установлен — подмена видна, сборка не проходит', async () => {
    const z = new PizZip(readFileSync(SAMPLES.letterMarked));
    z.file('word/styles.xml', z.file('word/styles.xml')!.asText().replace(/Liberation Serif/gu, 'Kontur Nonexistent Serif'));
    const t = await templateWithMarkedSample(e.s.manager, { name: 'Письмо с чужим шрифтом', schema: demoSchema('demo-kp-letter'), marked: z.generate({ type: 'nodebuffer' }) });
    const d = await createDraft(e.s.eng1, e.s.stageA, t.revision.id, 'Письмо с чужим шрифтом');
    await fillAll(e.s.eng1, d.id, { ...KP_FILLED, kp_price: kpPrice });
    await completeDraft(e.s.eng1, d.id);
    const c = await created(e.s.eng1, { mode: 'test', draftIds: [d.id] });
    expect(c.status).toBe('assembly_failed');
    expect(c.failure!.code).toBe('font_substituted');
    expect(c.checks.find((k) => k.code === 'font_substituted')!.detail).toMatch(/Kontur Nonexistent Serif/u);
  });
});
