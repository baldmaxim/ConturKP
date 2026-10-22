// Этап 18 (проект §5–§6): инструменты пилота ops:pilot — схемы эталона и сопоставления, дословность цитаты, интервалы
// активности, ворота и метрики, отказ при несовпадении печати, чтение только на настоящей БД (миграции 0001–0043),
// G2/G3 на минимальных строках (суперпользователь с выключенными триггерами, как в tests/deliverySchema.test.ts).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityIntervals, compareActivity, parseTimelog } from '../scripts/ops/pilot-activity.ts';
import { evaluateCandidate } from '../scripts/ops/pilot-candidate.ts';
import {
  checkLinks,
  evaluateG1,
  evaluateG2,
  evaluateG3,
  evaluateG4,
  evaluateG5,
  evaluateG6,
  evaluateG7,
  evaluateM1,
  evaluateM2,
  evaluateM3,
  evaluateM4,
  parseDefects,
  type ILinkCheck,
  type IPortalObject,
  type ReasonStatus,
} from '../scripts/ops/pilot-gates.ts';
import { PilotError } from '../scripts/ops/pilot-lib.ts';
import {
  assertSealed,
  crossCheck,
  isVerbatim,
  normalizeQuoteText,
  sha256Hex,
  sha256OfFile,
  validateMatching,
  validateReference,
  type IMatching,
  type IReference,
} from '../scripts/ops/pilot-schema.ts';
import { collectActivity, collectCandidate, collectG2, collectG3, collectG4, collectG5, collectPortalObjects, collectReasonStatuses, openReadOnly, portalFindingIds, withReadOnly } from '../scripts/ops/pilot-db.ts';
import { ADMIN_URL, createTestDb, type ITestDb } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TENDER = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222221';
const U2 = '22222222-2222-4222-8222-222222222222';

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'REF-001',
  kind: 'conflict',
  critical: true,
  summary: 'что должно быть найдено',
  sources: [{ document: 'a.pdf', locator: 'п. 1', quote: 'дословный фрагмент' }],
  expected: 'ожидаемый вывод',
  ...over,
});
const refRaw = (items: Record<string, unknown>[] = [item()]): Record<string, unknown> => ({
  schema: 'kontur.pilot-reference.v1',
  tenderId: TENDER,
  author: 'инженер',
  createdAt: '2026-10-21T10:00:00+03:00',
  items,
});
const reference = (items: Record<string, unknown>[] = [item()]): IReference => {
  const r = validateReference(refRaw(items));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
};
const matching = (raw: Record<string, unknown>): IMatching => {
  const r = validateMatching({ schema: 'kontur.pilot-matching.v1', tenderId: TENDER, items: [], findings: [], citations: [], ...raw });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
};
const uid = (n: number): string => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const found = (id: string, n = 1): Record<string, unknown> => ({ id, result: 'found', found: [uid(n)] });
const NO_LINKS: ILinkCheck = { items: [], citations: [] };
const missed = (id: string): Record<string, unknown> => ({ id, result: 'missed' });

describe('схема эталона', () => {
  it('валидный эталон принимается; шаблон docs/pilot проходит схему и согласован с шаблоном сопоставления', () => {
    expect(validateReference(refRaw()).ok).toBe(true);
    const tpl = validateReference(JSON.parse(readFileSync(join(ROOT, 'docs', 'pilot', 'reference-template.json'), 'utf8')));
    const mat = validateMatching(JSON.parse(readFileSync(join(ROOT, 'docs', 'pilot', 'matching-template.json'), 'utf8')));
    expect(tpl.ok && mat.ok).toBe(true);
    if (tpl.ok && mat.ok) expect(crossCheck(tpl.value, mat.value)).toEqual([]);
  });

  it('невалидный эталон: схема, uuid, вид, дата, пустые поля — ошибки по путям', () => {
    const bad = validateReference({ ...refRaw([item({ kind: 'other', summary: ' ' })]), schema: 'v2', tenderId: 'x', createdAt: '2026-10-21' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.errors.join('\n');
      expect(text).toContain('schema');
      expect(text).toContain('tenderId');
      expect(text).toContain('createdAt');
      expect(text).toContain('items[0] (REF-001).kind');
      expect(text).toContain('summary');
    }
    expect(validateReference(null).ok).toBe(false);
    expect(validateReference({ ...refRaw(), items: [] }).ok).toBe(false);
  });

  it('дубликат id отклоняется', () => {
    const r = validateReference(refRaw([item(), item({ critical: false })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('повторяющийся id');
  });

  it('критический пункт без цитаты — ошибка; некритический без источников допустим', () => {
    const noQuote = validateReference(refRaw([item({ sources: [{ document: 'a.pdf', locator: '', quote: '   ' }] })]));
    expect(noQuote.ok).toBe(false);
    if (!noQuote.ok) expect(noQuote.errors.join()).toContain('у критического пункта нужен хотя бы один источник с непустой цитатой');
    expect(validateReference(refRaw([item({ sources: [] })])).ok).toBe(false);
    expect(validateReference(refRaw([item({ critical: false, sources: [] })])).ok).toBe(true);
    // Достаточно одного источника с цитатой.
    const mixed = item({ sources: [{ document: 'a.pdf', locator: '', quote: '' }, { document: 'b.pdf', locator: 'п. 2', quote: 'текст' }] });
    expect(validateReference(refRaw([mixed])).ok).toBe(true);
  });
});

describe('печать эталона', () => {
  it('SHA-256 файла и сверка с печатью', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const file = join(ROOT, 'docs', 'pilot', 'reference-template.json');
    expect(sha256OfFile(file)).toBe(sha256Hex(readFileSync(file)));
    const sha = sha256Hex('x');
    expect(() => assertSealed(sha, sha)).not.toThrow();
    expect(() => assertSealed(sha, sha.toUpperCase())).not.toThrow();
    expect(() => assertSealed(sha, sha256Hex('y'))).toThrow(PilotError);
    expect(() => assertSealed(sha, 'abc')).toThrow(/SHA-256/u);
  });
});

describe('дословность цитаты', () => {
  const frag = 'Срок поставки\nсоставляет  30\tкалендарных дней\r\nс даты подписания.';
  it('переносы и повторные пробелы нормализуются в один пробел', () => {
    expect(normalizeQuoteText('  а\n\n б \t в  ')).toBe('а б в');
    expect(isVerbatim(frag, 'Срок поставки составляет 30 календарных дней')).toBe(true);
    expect(isVerbatim(frag, 'дней с даты подписания.')).toBe(true);
  });
  it('неразрывный пробел равен пробелу', () => {
    expect(isVerbatim('цена 100 000 руб.', 'цена 100 000 руб.')).toBe(true);
    expect(isVerbatim('цена 100 000 руб.', 'цена 100 000 руб.')).toBe(true);
  });
  it('мягкий перенос удаляется с обеих сторон', () => {
    expect(isVerbatim('догово­рная цена', 'договорная цена')).toBe(true);
    expect(isVerbatim('договорная цена', 'догово­рная цена')).toBe(true);
  });
  it('несовпадение: другой регистр, другое слово, пропущенное слово, пустая цитата', () => {
    expect(isVerbatim('Срок поставки 30 дней', 'срок поставки 30 дней')).toBe(false);
    expect(isVerbatim('Срок поставки 30 дней', 'Срок поставки 45 дней')).toBe(false);
    expect(isVerbatim('Срок поставки 30 дней', 'Срок 30 дней')).toBe(false);
    expect(isVerbatim('Срок поставки 30 дней', '  \n ')).toBe(false);
  });
  it('G2: цитата, хранимая отдельно, проверяется дословно', () => {
    const base = { kind: 'finding' as const, objectId: uid(1), fragmentId: uid(2), owned: true, inScope: true };
    const ok = evaluateG2([{ ...base, quote: 'срок  поставки', fragmentText: 'Срок поставки'.toLowerCase() }], { findings: 1, answers: 0 }, true);
    expect(ok.status).toBe('PASS');
    const bad = evaluateG2([{ ...base, quote: 'выдумка', fragmentText: 'Срок поставки' }], { findings: 1, answers: 0 }, true);
    expect(bad.status).toBe('FAIL');
    expect(bad.data.quoteNotVerbatim).toHaveLength(1);
  });
});

describe('интервалы активности и журнал времени', () => {
  const t = (min: number): number => Date.UTC(2026, 9, 21, 9, 0) + min * 60_000;
  it('разрыв больше 15 минут — новый интервал; ровно 15 — тот же; порядок входа не важен', () => {
    const iv = activityIntervals([t(41), t(0), t(25), t(10)]);
    expect(iv.map((i) => [i.startMs - t(0), i.minutes])).toEqual([[0, 25], [41 * 60_000, 0]]);
    expect(activityIntervals([t(0), t(16)])).toHaveLength(2);
    expect(activityIntervals([t(0), t(15)])).toHaveLength(1);
    expect(activityIntervals([])).toEqual([]);
    expect(activityIntervals([new Date(t(5)), new Date(t(7))])[0]?.minutes).toBe(2);
  });
  it('журнал: разбор, кавычки, заголовок, ошибки', () => {
    const ok = parseTimelog('﻿user,date,start,end,step\r\nu1,2026-10-21,09:00,10:30,"Загрузка, источники"\nu2,2026-10-21,9:00,09:45,Проверки\n');
    expect(ok.errors).toEqual([]);
    expect(ok.rows.map((r) => [r.user, r.minutes, r.step])).toEqual([['u1', 90, 'Загрузка, источники'], ['u2', 45, 'Проверки']]);
    const bad = parseTimelog('u1,21.10.2026,09:00,10:00,x\nu1,2026-10-21,10:00,09:00,x\nu1,2026-10-21,09:00\n');
    expect(bad.rows).toEqual([]);
    expect(bad.errors).toHaveLength(3);
  });
  it('расхождение больше 30 % отмечается, итог не правится', () => {
    const users = [
      { userId: U1, roles: ['engineer'], eventTimes: [0, 10, 20, 30, 40, 50, 60].map(t) },
      { userId: U2, roles: ['manager'], eventTimes: [0, 10, 20, 30, 40, 50, 60].map(t) },
    ];
    const log = [
      { user: U1, date: '2026-10-21', start: '09:00', end: '10:20', step: 'a', minutes: 80 },
      { user: U2, date: '2026-10-21', start: '09:00', end: '10:40', step: 'a', minutes: 100 },
      { user: 'ghost', date: '2026-10-21', start: '09:00', end: '09:10', step: 'a', minutes: 10 },
    ];
    const rows = compareActivity(users, log);
    expect(rows[0]).toMatchObject({ auditMinutes: 60, loggedMinutes: 80, flagged: false });
    expect(rows[0]!.deviation).toBeCloseTo(-0.25);
    expect(rows[1]).toMatchObject({ loggedMinutes: 100, flagged: true });
    expect(rows[1]!.deviation).toBeCloseTo(-0.4);
    expect(rows[2]).toMatchObject({ userId: 'ghost', flagged: true });
    expect(compareActivity(users, null).every((r) => !r.flagged && r.loggedMinutes === null)).toBe(true);
  });
});

describe('ворота G1–G7 и метрики М1–М4 из входных данных', () => {
  const items = [
    item({ id: 'REF-001' }),
    item({ id: 'REF-002', critical: false }),
    item({ id: 'REF-003', critical: false }),
    item({ id: 'REF-004', critical: false }),
    item({ id: 'REF-005', critical: false }),
    item({ id: 'REF-006', critical: false }),
  ];
  const ref = reference(items);

  it('G1: все критические найдены — PASS, пропущенный критический — FAIL с id', () => {
    const all = matching({ items: items.map((i, n) => found(i.id as string, n + 1)) });
    expect(evaluateG1(ref, all, NO_LINKS).status).toBe('PASS');
    const lost = matching({ items: [missed('REF-001'), ...items.slice(1).map((i, n) => found(i.id as string, n + 2))] });
    const g1 = evaluateG1(ref, lost, NO_LINKS);
    expect(g1.status).toBe('FAIL');
    expect(g1.data.missedIds).toEqual(['REF-001']);
    expect(evaluateG1(reference([item({ critical: false })]), matching({ items: [found('REF-001')] }), NO_LINKS).status).toBe('NOT_RUN');
  });

  it('М1: порог 80 % по некритическим пунктам', () => {
    const four = matching({ items: [found('REF-001'), found('REF-002'), found('REF-003'), found('REF-004'), found('REF-005'), missed('REF-006')] });
    expect(evaluateM1(ref, four, NO_LINKS)).toMatchObject({ status: 'PASS', value: 80 });
    const three = matching({ items: [found('REF-001'), found('REF-002'), found('REF-003'), found('REF-004'), missed('REF-005'), missed('REF-006')] });
    expect(evaluateM1(ref, three, NO_LINKS)).toMatchObject({ status: 'FAIL', value: 60 });
  });

  it('М2: порог 25 % ложных среди показанных; сопоставление должно покрывать замечания портала', () => {
    const verdicts = (v: string[]) => matching({ findings: v.map((verdict, n) => ({ id: uid(100 + n), verdict })) });
    const ok = verdicts(['true', 'false', 'valid_extra', 'duplicate']);
    expect(evaluateM2(ok, null)).toMatchObject({ status: 'PASS', value: 25 });
    expect(evaluateM2(verdicts(['true', 'false', 'false', 'duplicate']), null)).toMatchObject({ status: 'FAIL', value: 50 });
    const portal = [uid(100), uid(101), uid(102), uid(103)];
    expect(evaluateM2(ok, portal).status).toBe('PASS');
    const partial = evaluateM2(ok, [...portal, uid(999)]);
    expect(partial.status).toBe('FAIL');
    expect(partial.data.unmarkedIds).toEqual([uid(999)]);
    expect(evaluateM2(matching({}), null).status).toBe('NOT_RUN');
  });

  it('М3: порог 95 % подтверждённых цитат', () => {
    const sample = (bad: number) => matching({ citations: Array.from({ length: 20 }, (_, n) => ({ ref: uid(200 + n), verdict: n < bad ? 'does_not_support' : 'supports' })) });
    expect(evaluateM3(sample(1), NO_LINKS)).toMatchObject({ status: 'PASS', value: 95 });
    expect(evaluateM3(sample(2), NO_LINKS)).toMatchObject({ status: 'FAIL', value: 90 });
  });

  it('checkLinks: неизвестный, чужой, другого вида или статуса идентификатор не засчитывается (G1, М1, М3 — FAIL)', () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const obj = (kind: IPortalObject['kind'], status: string, over: Partial<IPortalObject> = {}): IPortalObject => ({ kind, tenderId: TENDER, status, answerStatus: null, ...over });
    const objects = new Map<string, IPortalObject>([
      [uid(1), obj('finding', 'resolved')],
      [uid(2), obj('discrepancy', 'open')],
      [uid(3), obj('reason', 'confirmed')],
      [uid(4), obj('finding', 'resolved', { tenderId: OTHER.toUpperCase() })],
      [uid(5), obj('finding', 'rejected')],
      [uid(6), obj('finding', 'stale')],
      [uid(7), obj('finding', 'open')],
      [uid(8), obj('answer', 'completed', { answerStatus: 'confirmed_by_citations' })],
      [uid(9), obj('answer', 'completed', { answerStatus: 'citations_disagree' })],
      [uid(10), obj('discrepancy', 'stale')],
    ]);
    const r3 = reference([item({ id: 'C-1' }), item({ id: 'N-1', kind: 'change', critical: false }), item({ id: 'P-1', kind: 'price_reason', critical: false })]);
    const run = (c1: string, n1: string, p1: string, cites: { ref: string; verdict?: string }[] = []) => {
      const m = matching({
        items: [{ id: 'C-1', result: 'found', found: [c1] }, { id: 'N-1', result: 'found', found: [n1] }, { id: 'P-1', result: 'found', found: [p1] }],
        citations: cites.map((c) => ({ ref: c.ref, verdict: c.verdict ?? 'supports' })),
      });
      const links = checkLinks(r3, m, TENDER, objects);
      return { links, g1: evaluateG1(r3, m, links), m1: evaluateM1(r3, m, links), m3: evaluateM3(m, links) };
    };

    // Положительный контроль: допустимые объекты; регистр идентификаторов не важен, статус причины — дело М4.
    const ok = run(uid(1), uid(2), uid(3), [{ ref: uid(1) }, { ref: uid(8).toUpperCase() }]);
    expect(ok.links).toEqual({ items: [], citations: [] });
    expect([ok.g1.status, ok.m1.status, ok.m3.status]).toEqual(['PASS', 'PASS', 'PASS']);
    expect(run(uid(8), uid(1), uid(3)).g1.status).toBe('PASS');

    // not_in_portal.
    const missing = run(uid(99), uid(2), uid(3), [{ ref: uid(98) }]);
    expect(missing.links.items).toEqual([{ item: 'C-1', id: uid(99), why: 'not_in_portal' }]);
    expect(missing.links.citations).toEqual([{ item: null, id: uid(98), why: 'not_in_portal' }]);
    expect(missing.g1).toMatchObject({ status: 'FAIL', data: { missedIds: ['C-1'], linkErrors: [{ item: 'C-1', id: uid(99), why: 'not_in_portal' }] } });
    expect(missing.g1.detail).toContain('ошибок идентификаторов 1');
    expect(missing.m3).toMatchObject({ status: 'FAIL', value: 0, data: { sample: 1, supports: 0, linkErrors: [{ why: 'not_in_portal' }] } });

    // other_tender: у некритического пункта процент найденных не спасает.
    const foreign = run(uid(1), uid(4), uid(3), [{ ref: uid(4) }]);
    expect(foreign.links.items).toEqual([{ item: 'N-1', id: uid(4), why: 'other_tender' }]);
    expect(foreign.links.citations[0]?.why).toBe('other_tender');
    expect(foreign.g1.status).toBe('PASS');
    expect(foreign.m1).toMatchObject({ status: 'FAIL', value: 50, data: { total: 2, found: 1, linkErrors: [{ why: 'other_tender' }] } });
    expect(foreign.m3.status).toBe('FAIL');

    // wrong_kind: причина в пункте conflict, замечание в price_reason, разногласие и причина в цитатах.
    const kind = run(uid(3), uid(2), uid(1), [{ ref: uid(2) }, { ref: uid(3) }]);
    expect(kind.links.items.map((e) => [e.item, e.why])).toEqual([['C-1', 'wrong_kind'], ['P-1', 'wrong_kind']]);
    expect(kind.links.citations.map((e) => e.why)).toEqual(['wrong_kind', 'wrong_kind']);
    expect([kind.g1.status, kind.m1.status, kind.m3.status]).toEqual(['FAIL', 'FAIL', 'FAIL']);

    // not_accepted: rejected и stale замечание и разногласие в found; открытое замечание и несогласованный ответ в цитатах.
    const stale = run(uid(5), uid(6), uid(3), [{ ref: uid(7) }, { ref: uid(9) }]);
    expect(stale.links.items.map((e) => [e.item, e.why])).toEqual([['C-1', 'not_accepted'], ['N-1', 'not_accepted']]);
    expect(stale.links.citations.map((e) => e.why)).toEqual(['not_accepted', 'not_accepted']);
    expect([stale.g1.status, stale.m1.status, stale.m3.status]).toEqual(['FAIL', 'FAIL', 'FAIL']);
    expect(run(uid(1), uid(10), uid(3)).links.items).toEqual([{ item: 'N-1', id: uid(10), why: 'not_accepted' }]);

    // Одна из нескольких ссылок пункта неверна — пункт не выявлен; supports без ошибок ссылок не нулевой.
    const m = matching({ items: [{ id: 'C-1', result: 'found', found: [uid(1), uid(99)] }, missed('N-1'), missed('P-1')], citations: [{ ref: uid(1), verdict: 'supports' }, { ref: uid(7), verdict: 'supports' }] });
    const links = checkLinks(r3, m, TENDER, objects);
    expect(evaluateG1(r3, m, links).status).toBe('FAIL');
    expect(evaluateM3(m, links)).toMatchObject({ status: 'FAIL', value: 50 });
    expect(evaluateM3(matching({}), NO_LINKS).status).toBe('NOT_RUN');
  });

  it('М4: confirmed и unknown — в порядке, hypothesis, пропуск и неизвестный идентификатор — нет', () => {
    const r4 = reference([item({ id: 'P-1', kind: 'price_reason' }), item({ id: 'P-2', kind: 'price_reason', critical: false }), item({ id: 'C-1', critical: false })]);
    const statuses = new Map<string, ReasonStatus>([[uid(1), 'confirmed'], [uid(2), 'unknown'], [uid(3), 'hypothesis']]);
    const pass = evaluateM4(r4, matching({ items: [found('P-1', 1), found('P-2', 2), missed('C-1')] }), statuses);
    expect(pass).toMatchObject({ status: 'PASS', value: 100 });
    const hyp = evaluateM4(r4, matching({ items: [found('P-1', 1), found('P-2', 3), missed('C-1')] }), statuses);
    expect(hyp).toMatchObject({ status: 'FAIL', value: 50 });
    expect(hyp.data.bad).toEqual([{ id: 'P-2', why: 'hypothesis' }]);
    expect(evaluateM4(r4, matching({ items: [found('P-1', 1), missed('P-2'), missed('C-1')] }), statuses).data.bad).toEqual([{ id: 'P-2', why: 'missed' }]);
    expect(evaluateM4(r4, matching({ items: [found('P-1', 7), found('P-2', 2), missed('C-1')] }), statuses).data.bad).toEqual([{ id: 'P-1', why: 'not_in_portal' }]);
    expect(evaluateM4(reference(), matching({ items: [found('REF-001')] }), statuses).status).toBe('NOT_RUN');
  });

  it('сопоставление: схема, found/missed, согласованность с эталоном', () => {
    expect(validateMatching({ schema: 'kontur.pilot-matching.v1', tenderId: TENDER, items: [{ id: 'REF-001', result: 'found', found: [] }] }).ok).toBe(false);
    expect(validateMatching({ schema: 'kontur.pilot-matching.v1', tenderId: TENDER, items: [{ id: 'REF-001', result: 'missed', found: [uid(1)] }] }).ok).toBe(false);
    expect(validateMatching({ schema: 'kontur.pilot-matching.v1', tenderId: TENDER, items: [], findings: [{ id: uid(1), verdict: 'maybe' }] }).ok).toBe(false);
    const problems = crossCheck(ref, matching({ tenderId: U1, items: [found('REF-001'), found('REF-777')] }));
    expect(problems.join('\n')).toContain('tenderId');
    expect(problems.join('\n')).toContain('REF-777');
    expect(problems.join('\n')).toContain('REF-002 не размечен');
  });

  it('G3/G4/G5/G6/G7: оценка из входных данных', () => {
    expect(evaluateG3([{ category: 'a', count: 0, ids: [] }], {}).status).toBe('PASS');
    expect(evaluateG3([{ category: 'a', count: 2, ids: ['x'] }], {}).status).toBe('FAIL');
    const rev = { revisionId: uid(1), stageId: uid(2), seq: 1, methodVersion: 'v1', residual: '0', tolerance: '0.01' };
    expect(evaluateG4({ ...rev, reconciliationStatus: 'reconciled' }).status).toBe('PASS');
    expect(evaluateG4({ ...rev, reconciliationStatus: 'residual_unconfirmed' })).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('residual_unconfirmed') });
    expect(evaluateG4({ ...rev, reconciliationStatus: null }).status).toBe('FAIL');
    expect(evaluateG4(null).status).toBe('NOT_RUN');
    expect(evaluateG5({ deliveries: 0, files: 0, byState: {} }).status).toBe('NOT_RUN');
    expect(evaluateG5({ deliveries: 1, files: 3, byState: { verified: 3 } }).status).toBe('PASS');
    expect(evaluateG5({ deliveries: 1, files: 3, byState: { verified: 2, conflict: 1 } }).status).toBe('FAIL');
    expect(evaluateG6()).toMatchObject({ status: 'MANUAL', data: { evidenceRef: null } });
    const md = [
      '| ID | Этап | Приоритет | Влияние | Инвариант | Статус |',
      '|---|---|---|---|---|---|',
      '| R01-01 | 01 | P1 | x | I02 | CLOSED_BY_REVIEW |',
      '| R02-01 | 02 | P1 | x | I13 | | CLOSED_BY_REVIEW | `abc` |',
      '| R03-01 | 03 | P2 | x | I13 | OPEN |',
      '| S18-01 | 18 | P1 | x | — | OPEN — этап 18 |',
      '| S18-02 | 18 | P0 | x | — | FIXED_PENDING_REVIEW |',
      '| S18-03 | 18 | P1 | x | — | неизвестно |',
    ].join('\n');
    const d = parseDefects(md);
    expect(d).toMatchObject({ rows: 6, blocking: 5, open: ['S18-01'], unparsed: ['S18-03'] });
    expect(evaluateG7(d).status).toBe('FAIL');
    expect(evaluateG7(parseDefects(md.split('\n').slice(0, 4).join('\n'))).status).toBe('PASS');
    expect(evaluateG7(null).status).toBe('NOT_AVAILABLE');
  });

  it('журнал дефектов проекта разбирается целиком: статус распознан у каждого P0/P1', () => {
    const d = parseDefects(readFileSync(join(ROOT, 'docs', 'defects.md'), 'utf8'));
    expect(d.rows).toBeGreaterThan(100);
    expect(d.unparsed).toEqual([]);
  });

  it('кандидат: SUITABLE и список недостающего', () => {
    const base = {
      tenderId: TENDER,
      sends: { registered: 1, verified: 1, disputed: 3 },
      documentsByType: [{ docType: 'tz', documents: 1, multiRevision: 1 }, { docType: 'contract', documents: 1, multiRevision: 0 }],
      linkedContracts: 0,
      linkedMailMessages: 0,
      qaThreads: 0,
      negotiationSessions: 0,
      calculationRevisions: { provisional: 1, verified: 0 },
      stages: [],
    };
    expect(evaluateCandidate(base)).toMatchObject({ verdict: 'SUITABLE', missing: [] });
    const lacking = evaluateCandidate({ ...base, sends: { registered: 1, disputed: 5 }, documentsByType: [{ docType: 'other', documents: 2, multiRevision: 0 }] });
    expect(lacking.verdict).toBe('INCOMPLETE');
    expect(lacking.missing).toHaveLength(4);
    expect(lacking.missing.join('\n')).toContain('отправок КП меньше двух');
    expect(lacking.missing.join('\n')).toContain('нет документа с двумя и более редакциями');
  });
});

// ---------------------------------------------------------------- Настоящая БД

let db: ITestDb;
let su: pg.Client;
const A = randomUUID();
const B = randomUUID();
const STAGE_A = randomUUID();
const STAGE_B = randomUUID();
const ENG = randomUUID();
const MGR = randomUUID();
const SECRET_TITLE = 'Секретное название тендера пилота';
const SECRET_TEXT = 'Секретный текст фрагмента источника';
const RUN_A = randomUUID();
const RUN_B = randomUUID();
const FRAG_A = randomUUID();
const FRAG_B = randomUUID();
const hex = (): string => randomUUID().replace(/-/gu, '').repeat(2);

// Вставка строки суперпользователем с выключенными триггерами и внешними ключами (session_replication_role = replica):
// так выглядят данные, попавшие в обход портала, — ровно то, что ворота G2/G3 обязаны увидеть.
const ins = async (table: string, row: Record<string, unknown>): Promise<void> => {
  const keys = Object.keys(row);
  const values = keys.map((k) => {
    const v = row[k];
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  await su.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, values);
};

const finding = async (tender: string, stage: string, status: string, fragment: string): Promise<string> => {
  const id = randomUUID();
  await ins('finding', { id, tender_id: tender, stage_id: stage, finding_key: hex(), kind: 'k', origin: 'human', title: 'T', severity: 'major', confidence: 'high', status, created_by: ENG, created_input_version: 0 });
  await ins('finding_evidence', { finding_id: id, tender_id: tender, side: 'left', object_type: 'fragment', fragment_id: fragment });
  return id;
};

const answer = async (fragment: string): Promise<string> => {
  const dialog = randomUUID();
  const search = randomUUID();
  const run = randomUUID();
  const msg = randomUUID();
  await ins('dialog', { id: dialog, context_kind: 'tender', tender_id: A, stage_id: STAGE_A, mode: 'working', title: 'D', created_by: ENG });
  await ins('search_run', {
    id: search, context_kind: 'tender', tender_id: A, stage_id: STAGE_A, mode: 'working', requested_by: ENG, query_text: 'q', query_sha256: hex(),
    query_normalization_version: 'v1', result_limit: 10, scope_hash: hex(), allowed_source_unit_ids: [RUN_A], index_version_id: randomUUID(),
    ranking_version: 'r1', status: 'complete', semantic_status: 'complete', deadline_at: new Date(), finished_at: new Date(),
  });
  await ins('answer_run', {
    id: run, dialog_id: dialog, seq: 1, question_message_id: msg, search_run_id: search, requested_by: ENG, status: 'completed', answer_status: 'confirmed_by_citations',
    plan: {}, planner_version: 'p1', prompt_version: 'v1', prompt_sha256: hex(), verifier_mode: 'off', verification_level: 'hard_checks', started_at: new Date(), finished_at: new Date(),
  });
  await ins('answer_evidence', { run_id: run, label: 'E1', ordinal: 1, fragment_id: fragment, origin: 'document_text', version_note: 'current', reason: 'r' });
  return run;
};

beforeAll(async () => {
  db = await createTestDb();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db.name}`;
  su = new pg.Client({ connectionString: u.toString() });
  await su.connect();
  await su.query("SET session_replication_role = 'replica'");
  await ins('app_user', { id: ENG, kind: 'human', login: 'pilot-eng', display_name: 'Инженер Секретный' });
  await ins('app_user', { id: MGR, kind: 'human', login: 'pilot-mgr', display_name: 'Руководитель Секретный' });
  await ins('tender', { id: A, code: 'PILOT-A', title: SECRET_TITLE, created_by: MGR });
  await ins('tender', { id: B, code: 'PILOT-B', title: 'Другой тендер', created_by: MGR });
  await ins('tender_stage', { id: STAGE_A, tender_id: A, seq: 1, title: 'Этап', created_by: MGR });
  await ins('tender_stage', { id: STAGE_B, tender_id: B, seq: 1, title: 'Этап', created_by: MGR });
  await ins('tender_member', { tender_id: A, user_id: ENG, member_role: 'engineer', assigned_by: MGR });
  await ins('tender_member', { tender_id: A, user_id: MGR, member_role: 'manager', assigned_by: MGR });
  // Фрагмент тендера A входит в снимок области этапа A (по прогону RUN_A); фрагмент тендера B — чужой.
  for (const [frag, run, tender] of [[FRAG_A, RUN_A, A], [FRAG_B, RUN_B, B]] as const) {
    await ins('evidence_fragment', {
      id: frag, tender_id: tender, source_unit_type: 'recognition_run', source_unit_id: run, run_id: run, document_revision_id: randomUUID(), origin: 'document_text', fragment_kind: 'text_block',
      fragment_key: `k-${frag}`, text: SECRET_TEXT, text_sha256: hex(),
    });
  }
  const scope = randomUUID();
  await ins('evidence_scope', { id: scope, stage_id: STAGE_A, tender_id: A, source_set_revision_id: randomUUID(), input_version: 0, content_hash: hex(), created_by: MGR });
  await ins('evidence_scope_item', { scope_id: scope, tender_id: A, unit_type: 'document_recognition', document_revision_id: randomUUID(), recognition_run_id: RUN_A, inclusion_reason: 'x' });
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

describe('только чтение', () => {
  it('сеанс команды в режиме READ ONLY: запись, обновление и создание объектов отклоняются, данные не меняются', async () => {
    const c = await openReadOnly(db.appUrl);
    try {
      expect((await c.query<{ s: string }>("SELECT current_setting('default_transaction_read_only') AS s")).rows[0]?.s).toBe('on');
      expect((await c.query<{ s: string }>("SELECT current_setting('transaction_read_only') AS s")).rows[0]?.s).toBe('on');
      await c.query('SAVEPOINT s1');
      await expect(c.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ('pilot', 'worker', 1, now(), now())")).rejects.toThrow(/read-only transaction/u);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await expect(c.query("UPDATE tender SET status = 'archived' WHERE id = $1", [A])).rejects.toThrow(/read-only transaction/u);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await expect(c.query('CREATE TABLE pilot_probe (id int)')).rejects.toThrow(/read-only transaction/u);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect((await su.query('SELECT status FROM tender WHERE id = $1', [A])).rows[0]).toEqual({ status: 'active' });
    expect((await su.query("SELECT 1 FROM process_heartbeat WHERE process_id = 'pilot'")).rowCount).toBe(0);
  });

  it('withReadOnly: запись внутри колбэка падает', async () => {
    await expect(withReadOnly(db.appUrl, (c) => c.query("UPDATE tender SET status = 'archived' WHERE id = $1", [A]))).rejects.toThrow(/read-only transaction/u);
  });
});

describe('candidate по настоящей БД', () => {
  it('пустой тендер: INCOMPLETE; отправки, документы, редакции и ревизии расчёта считаются', async () => {
    const empty = evaluateCandidate(await withReadOnly(db.appUrl, (c) => collectCandidate(c, A)));
    expect(empty.verdict).toBe('INCOMPLETE');
    expect(empty.missing).toHaveLength(4);

    const release = randomUUID();
    for (const seq of [1, 2]) {
      await ins('send_event', {
        release_id: release, tender_id: A, stage_id: STAGE_A, seq, channel: 'other', sent_at: new Date(), evidence_kind: 'manual_note', note: 'отправлено вручную, проверено',
        attachment_check: 'not_checked', kit_sha256: hex(), release_manifest_sha256: hex(), status: 'registered', registered_by: MGR, idempotency_key: `key-send-${seq}-${release}`,
      });
    }
    for (const [type, revisions] of [['tz', 2], ['contract', 1]] as const) {
      const doc = randomUUID();
      await ins('document', { id: doc, tender_id: A, title: `Документ ${type}`, name_key: type, doc_type: type });
      for (let n = 1; n <= revisions; n += 1) {
        const sha = hex();
        await ins('blob', { sha256: sha, size_bytes: 1, media_type: 'application/pdf', storage_key: `k-${sha}` });
        await ins('document_revision', { document_id: doc, tender_id: A, blob_sha256: sha, revision_seq: n });
      }
    }
    await ins('calculation_revision', {
      id: randomUUID(), stage_id: STAGE_A, tender_id: A, content_id: randomUUID(), capture_id: randomUUID(), seq: 1, kind: 'provisional', system: 'tenderhub', external_tender_id: randomUUID(),
    });
    const r = evaluateCandidate(await withReadOnly(db.appUrl, (c) => collectCandidate(c, A)));
    expect(r).toMatchObject({ verdict: 'SUITABLE', missing: [] });
    expect(r.data).toMatchObject({
      sendsCounted: 2,
      documentsWithManyRevisions: 1,
      calculationRevisions: { provisional: 1, verified: 0 },
      stages: [{ id: STAGE_A, seq: 1, status: 'active' }],
    });
    expect(r.data.documentsByType).toEqual([{ docType: 'contract', documents: 1, multiRevision: 0 }, { docType: 'tz', documents: 1, multiRevision: 1 }]);
    // Тендер B ничего этого не видит.
    expect(evaluateCandidate(await withReadOnly(db.appUrl, (c) => collectCandidate(c, B))).verdict).toBe('INCOMPLETE');
  });
});

describe('G2 и G3 по настоящей БД', () => {
  it('принятое замечание и принятый ответ с основаниями тендера: G2 и G3 — PASS; открытое замечание не считается', async () => {
    await finding(A, STAGE_A, 'resolved', FRAG_A);
    await finding(A, STAGE_A, 'open', FRAG_B);
    await answer(FRAG_A);
    const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, A));
    expect(g2.conclusions).toEqual({ findings: 1, answers: 1 });
    expect(g2.checks).toHaveLength(2);
    expect(evaluateG2(g2.checks, g2.conclusions, false).status).toBe('PASS');
    const g3 = await withReadOnly(db.appUrl, (c) => collectG3(c, A));
    // Открытое замечание с чужим фрагментом — утечка для G3 даже вне G2.
    expect(g3.violations.filter((v) => v.count > 0).map((v) => v.category)).toEqual([
      'фрагмент основания замечания не из источников тендера',
      'фрагмент основания замечания вне входа его этапа',
    ]);
    expect(evaluateG3(g3.violations, g3.checked).status).toBe('FAIL');
  });

  it('G3: основание из другого тендера даёт FAIL с id; без чужих оснований — PASS', async () => {
    const clean = await withReadOnly(db.appUrl, (c) => collectG3(c, B));
    expect(evaluateG3(clean.violations, clean.checked).status).toBe('PASS');
    const bad = await finding(A, STAGE_A, 'accepted_risk', FRAG_B);
    const g3 = await withReadOnly(db.appUrl, (c) => collectG3(c, A));
    const result = evaluateG3(g3.violations, g3.checked);
    expect(result.status).toBe('FAIL');
    const own = g3.violations.find((v) => v.category === 'фрагмент основания замечания не из источников тендера');
    expect(own?.count).toBe(2);
    const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, A));
    const g2r = evaluateG2(g2.checks, g2.conclusions, false);
    expect(g2r.status).toBe('FAIL');
    expect((g2r.data.foreignOrOutOfScope as { objectId: string }[]).map((x) => x.objectId)).toEqual([bad]);
  });

  it('G3: основание, тендер которого не совпал с тендером замечания, и чужой фрагмент в ответе', async () => {
    const f = await finding(A, STAGE_A, 'resolved', FRAG_A);
    await ins('finding_evidence', { finding_id: f, tender_id: B, side: 'right', object_type: 'fragment', fragment_id: FRAG_A });
    const run = await answer(FRAG_B);
    const g3 = await withReadOnly(db.appUrl, (c) => collectG3(c, A));
    const byCat = new Map(g3.violations.map((v) => [v.category, v]));
    expect(byCat.get('основание замечания другого тендера')?.count).toBe(1);
    expect(byCat.get('основание ответа не из источников тендера')?.ids).toEqual([`${run}:E1`]);
    expect(byCat.get('основание ответа вне входа прогона поиска')?.count).toBe(1);
  });

  it('замечания портала для М2: все, кроме устаревших', async () => {
    await finding(A, STAGE_A, 'stale', FRAG_A);
    const ids = await withReadOnly(db.appUrl, (c) => portalFindingIds(c, A));
    const all = (await su.query<{ id: string }>("SELECT id FROM finding WHERE tender_id = $1 AND status <> 'stale'", [A])).rows.map((r) => r.id).sort();
    expect([...ids].sort()).toEqual(all);
  });
});

describe('R18-01: объекты портала для сверки идентификаторов', () => {
  it('collectPortalObjects: замечание, разногласие (статус замечания), ответ, причина; чужой тендер — с его tenderId; неизвестный отсутствует', async () => {
    const fa = await finding(A, STAGE_A, 'accepted_risk', FRAG_A);
    const fd = await finding(A, STAGE_A, 'rejected', FRAG_A);
    const disc = randomUUID();
    await ins('discrepancy', { id: disc, tender_id: A, stage_id: STAGE_A, finding_id: fd, topic: 'T', created_by: ENG });
    const run = await answer(FRAG_A);
    const reason = randomUUID();
    await ins('change_explanation', { id: reason, tender_id: A, comparison_id: randomUUID(), unit_id: randomUUID(), version: 1, reason_kind: 'document', reason_status: 'hypothesis', rationale: 'основание', actor_user_id: ENG });
    const foreign = await finding(B, STAGE_B, 'open', FRAG_B);
    const unknown = randomUUID();
    const map = await withReadOnly(db.appUrl, (c) => collectPortalObjects(c, [fa, disc.toUpperCase(), run, reason, foreign, unknown]));
    expect(map.get(fa)).toEqual({ kind: 'finding', tenderId: A, status: 'accepted_risk', answerStatus: null });
    expect(map.get(disc)).toEqual({ kind: 'discrepancy', tenderId: A, status: 'rejected', answerStatus: null });
    expect(map.get(run)).toEqual({ kind: 'answer', tenderId: A, status: 'completed', answerStatus: 'confirmed_by_citations' });
    expect(map.get(reason)).toEqual({ kind: 'reason', tenderId: A, status: 'hypothesis', answerStatus: null });
    expect(map.get(foreign)).toEqual({ kind: 'finding', tenderId: B, status: 'open', answerStatus: null });
    expect(map.has(unknown)).toBe(false);
    expect(map.size).toBe(5);
    expect((await withReadOnly(db.appUrl, (c) => collectPortalObjects(c, []))).size).toBe(0);
  });
});

describe('R18-02: письмо и вложение письма — источники тендера', () => {
  // Письмо с тендерами links; kind = body: фрагмент тела (mail_message_revision), attachment: фрагмент прогона документа вложения.
  // Единица входит в снимок области этапа A, чтобы владение проверялось отдельно от входа этапа.
  const mailFragment = async (kind: 'body' | 'attachment', links: string[]): Promise<string> => {
    const message = randomUUID();
    const revision = randomUUID();
    const fragment = randomUUID();
    const scope = (await su.query<{ id: string }>('SELECT id FROM evidence_scope WHERE stage_id = $1 LIMIT 1', [STAGE_A])).rows[0]!.id;
    await ins('mail_message', { id: message, mailbox_id: randomUUID(), communication_id: randomUUID(), identity_kind: 'source_id', identity_value: `id-${message}`, created_by: MGR });
    await ins('mail_message_revision', { id: revision, message_id: message, seq: 1, raw_blob_sha256: hex(), direction: 'inbound', source: 'eml_import', imported_by: MGR });
    for (const tender of links) await ins('mail_message_tender', { message_id: message, tender_id: tender, linked_by: MGR, updated_by: MGR });
    const base = { id: fragment, origin: 'email_body', fragment_kind: 'text_block', fragment_key: `k-${fragment}`, text: SECRET_TEXT, text_sha256: hex() };
    if (kind === 'body') {
      await ins('evidence_fragment', { ...base, source_unit_type: 'mail_message_revision', source_unit_id: revision, mail_message_revision_id: revision });
      await ins('evidence_scope_item', { scope_id: scope, tender_id: A, unit_type: 'mail_message', mail_message_revision_id: revision, mail_message_id: message, inclusion_reason: 'x' });
      return fragment;
    }
    const attachment = randomUUID();
    const doc = randomUUID();
    const docRevision = randomUUID();
    const recognition = randomUUID();
    const sha = hex();
    await ins('mail_attachment', { id: attachment, revision_id: revision, ordinal: 1, filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: 1, sha256: sha, disposition: 'attachment', status: 'registered', blob_sha256: sha });
    await ins('document', { id: doc, mail_attachment_id: attachment, title: 'Вложение', name_key: 'a.pdf', doc_type: 'letter' });
    await ins('document_revision', { id: docRevision, document_id: doc, blob_sha256: sha, revision_seq: 1 });
    await ins('evidence_fragment', { ...base, origin: 'recognized_text', source_unit_type: 'recognition_run', source_unit_id: recognition, run_id: recognition, document_revision_id: docRevision });
    await ins('evidence_scope_item', { scope_id: scope, tender_id: A, unit_type: 'document_recognition', document_revision_id: docRevision, recognition_run_id: recognition, mail_message_id: message, inclusion_reason: 'x' });
    return fragment;
  };
  const g3Ids = async (category: string): Promise<string[]> => (await withReadOnly(db.appUrl, (c) => collectG3(c, A))).violations.find((v) => v.category === category)?.ids ?? [];
  const evidenceId = async (f: string): Promise<string> => (await su.query<{ id: string }>('SELECT id FROM finding_evidence WHERE finding_id = $1', [f])).rows[0]!.id;
  const CATEGORY = 'фрагмент основания замечания не из источников тендера';

  for (const kind of ['attachment', 'body'] as const) {
    it(`${kind === 'body' ? 'фрагмент тела письма' : 'фрагмент вложения письма'}, связанного с тендером: G2 owned, в G3 нарушения нет`, async () => {
      const f = await finding(A, STAGE_A, 'resolved', await mailFragment(kind, [A, B]));
      const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, A));
      expect(g2.checks.filter((x) => x.objectId === f)).toEqual([expect.objectContaining({ owned: true, inScope: true })]);
      expect(await g3Ids(CATEGORY)).not.toContain(await evidenceId(f));
      expect(await g3Ids('фрагмент основания замечания вне входа его этапа')).not.toContain(await evidenceId(f));
    });

    it(`${kind === 'body' ? 'фрагмент тела письма' : 'фрагмент вложения письма'}, связанного только с другим тендером или ни с каким: нарушение G2 и G3`, async () => {
      for (const links of [[B], []]) {
        const f = await finding(A, STAGE_A, 'accepted_risk', await mailFragment(kind, links));
        const g2 = await withReadOnly(db.appUrl, (c) => collectG2(c, A));
        expect(g2.checks.filter((x) => x.objectId === f)).toEqual([expect.objectContaining({ owned: false })]);
        const r = evaluateG2(g2.checks, g2.conclusions, false);
        expect(r.status).toBe('FAIL');
        expect((r.data.foreignOrOutOfScope as { objectId: string }[]).map((x) => x.objectId)).toContain(f);
        expect(await g3Ids(CATEGORY)).toContain(await evidenceId(f));
      }
    });
  }

  it('G3: редакция документа вложения письма тендера в основании — не нарушение; письма только другого тендера — нарушение', async () => {
    const docRevisionOf = async (links: string[]): Promise<string> => {
      const fragment = await mailFragment('attachment', links);
      return (await su.query<{ document_revision_id: string }>('SELECT document_revision_id FROM evidence_fragment WHERE id = $1', [fragment])).rows[0]!.document_revision_id;
    };
    const mk = async (docRevision: string): Promise<string> => {
      const f = await finding(A, STAGE_A, 'open', FRAG_A);
      await ins('finding_evidence', { finding_id: f, tender_id: A, side: 'right', object_type: 'document_revision', document_revision_id: docRevision });
      return f;
    };
    const good = await mk(await docRevisionOf([A]));
    const bad = await mk(await docRevisionOf([B]));
    const ids = await g3Ids('редакция документа основания замечания не из источников тендера');
    const evId = async (f: string): Promise<string> => (await su.query<{ id: string }>('SELECT id FROM finding_evidence WHERE finding_id = $1 AND document_revision_id IS NOT NULL', [f])).rows[0]!.id;
    expect(ids).toContain(await evId(bad));
    expect(ids).not.toContain(await evId(good));
  });
});

describe('G4, G5, М4, М5 по настоящей БД', () => {
  it('G4: последняя ревизия — reconciled PASS; позже появилась нерассверенная — FAIL со статусом', async () => {
    expect(await withReadOnly(db.appUrl, (c) => collectG4(c, B))).toBeNull();
    const rev1 = randomUUID();
    const base = { stage_id: STAGE_A, tender_id: A, content_id: randomUUID(), capture_id: randomUUID(), kind: 'provisional', system: 'tenderhub', external_tender_id: randomUUID() };
    await su.query('DELETE FROM calculation_revision WHERE tender_id = $1', [A]);
    await ins('calculation_revision', { id: rev1, ...base, seq: 1, created_at: new Date('2026-10-20T10:00:00Z') });
    const eco = { tender_id: A, method_version: 'm1', cost_total: 100, commercial_total: 100, line_tolerance_rel: 0.01, line_tolerance_abs: 0.01, report: {} };
    await ins('revision_economics', { ...eco, revision_id: rev1, grand_total: 100, residual: 0, tolerance: 0.01, reconciliation_status: 'reconciled' });
    const ok = evaluateG4(await withReadOnly(db.appUrl, (c) => collectG4(c, A)));
    expect(ok.status).toBe('PASS');
    const rev2 = randomUUID();
    await ins('calculation_revision', { id: rev2, ...base, seq: 2, created_at: new Date('2026-10-21T10:00:00Z') });
    expect(evaluateG4(await withReadOnly(db.appUrl, (c) => collectG4(c, A))).detail).toContain('не построен');
    await ins('revision_economics', { ...eco, revision_id: rev2, grand_total: 105, residual: 5, tolerance: 0.01, reconciliation_status: 'residual_unconfirmed' });
    const bad = evaluateG4(await withReadOnly(db.appUrl, (c) => collectG4(c, A)));
    expect(bad).toMatchObject({ status: 'FAIL', data: { reconciliationStatus: 'residual_unconfirmed', revisionId: rev2 } });
  });

  it('G5: нет размещений — NOT_RUN; все файлы verified — PASS; один conflict — FAIL; заменённое размещение не считается', async () => {
    expect(evaluateG5(await withReadOnly(db.appUrl, (c) => collectG5(c, A))).status).toBe('NOT_RUN');
    const mk = async (status: string): Promise<string> => {
      const id = randomUUID();
      await ins('delivery', {
        id, release_id: randomUUID(), tender_id: A, stage_id: STAGE_A, destination_id: randomUUID(), destination_version_id: randomUUID(), kind: 'smb', environment: 'test',
        target_folder: 'test', file_set: 'customer', placement: {}, placement_sha256: hex(), status, delivered_at: status === 'delivered' ? new Date() : null, cloud_state: 'not_applicable',
        superseded_by_delivery_id: status === 'superseded' ? id : null,
      });
      return id;
    };
    const file = async (delivery: string, ordinal: number, state: string): Promise<void> => {
      const sha = hex();
      await ins('delivery_file_state', { delivery_id: delivery, ordinal, path: `f${ordinal}.pdf`, kind: 'file', sha256: sha, size_bytes: 1, remote_state: state, remote_sha256: state === 'verified' ? sha : null });
    };
    const d1 = await mk('delivered');
    await file(d1, 1, 'verified');
    await file(d1, 2, 'verified');
    expect(evaluateG5(await withReadOnly(db.appUrl, (c) => collectG5(c, A)))).toMatchObject({ status: 'PASS', data: { deliveries: 1, files: 2 } });
    const old = await mk('superseded');
    await file(old, 1, 'absent');
    expect(evaluateG5(await withReadOnly(db.appUrl, (c) => collectG5(c, A))).status).toBe('PASS');
    await file(d1, 3, 'conflict');
    expect(evaluateG5(await withReadOnly(db.appUrl, (c) => collectG5(c, A)))).toMatchObject({ status: 'FAIL', data: { byState: { verified: 2, conflict: 1 } } });
  });

  it('М4: статусы причин читаются по идентификаторам версий и только своего тендера', async () => {
    const mk = async (tender: string, status: ReasonStatus): Promise<string> => {
      const id = randomUUID();
      await ins('change_explanation', {
        id, tender_id: tender, comparison_id: randomUUID(), unit_id: randomUUID(), version: 1, reason_kind: status === 'unknown' ? 'unknown' : 'document', reason_status: status,
        rationale: status === 'unknown' ? null : 'основание', actor_user_id: ENG,
      });
      return id;
    };
    const confirmed = await mk(A, 'confirmed');
    const hypothesis = await mk(A, 'hypothesis');
    const foreign = await mk(B, 'confirmed');
    const map = await withReadOnly(db.appUrl, (c) => collectReasonStatuses(c, A, [confirmed, hypothesis, foreign]));
    expect([...map.entries()].sort()).toEqual([[confirmed, 'confirmed'], [hypothesis, 'hypothesis']].sort());
  });

  it('М5: события участников тендера, интервалы по 15 минутам; чужие и не-человеческие события не считаются', async () => {
    const at = (min: number): Date => new Date(Date.UTC(2026, 9, 21, 6, 0) + min * 60_000);
    const ev = async (user: string | null, tender: string, min: number, over: Record<string, unknown> = {}): Promise<void> =>
      ins('audit_event', { occurred_at: at(min), actor_user_id: user, principal_id: user, principal_kind: 'human', action: 'test.action', tender_id: tender, outcome: 'allowed', ...over });
    for (const m of [0, 5, 10, 40]) await ev(ENG, A, m);
    await ev(ENG, B, 12);
    await ev(ENG, A, 13, { outcome: 'denied' });
    await ev(ENG, A, 14, { principal_kind: 'model_via_mcp', on_behalf_of_user_id: ENG });
    await ev(MGR, A, 0);
    const users = await withReadOnly(db.appUrl, (c) => collectActivity(c, A));
    expect(users.map((u) => [u.userId, u.roles, u.eventTimes.length]).sort()).toEqual([[ENG, ['engineer'], 4], [MGR, ['manager'], 1]].sort());
    const rows = compareActivity(users, null);
    expect(rows.find((r) => r.userId === ENG)).toMatchObject({ intervals: 2, auditMinutes: 10 });
    expect(rows.find((r) => r.userId === MGR)).toMatchObject({ intervals: 1, auditMinutes: 0 });
  });
});

describe('команды CLI', () => {
  const run = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> =>
    new Promise((done) => {
      execFile(process.execPath, [join(ROOT, 'scripts', 'ops', 'pilot.ts'), ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: db.appUrl, ...env }, timeout: 60_000 }, (error, out, err) => {
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err });
      });
    });
  const work = mkdtempSync(join(tmpdir(), 'kontur-pilot-'));
  const write = (name: string, value: unknown): string => {
    const path = join(work, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return path;
  };
  const refItems = [item({ id: 'REF-001' }), item({ id: 'REF-002', critical: false }), item({ id: 'REF-003', kind: 'price_reason', critical: false })];
  const refFor = (tender: string) => ({ ...refRaw(refItems), tenderId: tender });

  it('reference-seal: печатает SHA-256, число пунктов и критических; ошибка схемы — код 1 без печати', async () => {
    const good = write('ref-seal.json', refFor(A));
    const r = await run(['reference-seal', '--file', good]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`SHA-256: ${sha256Hex(readFileSync(good))}`);
    expect(r.out).toContain('пунктов: 3');
    expect(r.out).toContain('критических: 1');
    const bad = await run(['reference-seal', '--file', write('ref-bad.json', refRaw([item({ sources: [] })]))]);
    expect(bad.code).toBe(1);
    expect(bad.out).not.toContain('SHA-256');
    expect(bad.err).toContain('у критического пункта нужен хотя бы один источник с непустой цитатой');
    expect((await run(['reference-seal', '--file', write('not-json.json', '{')])).code).toBe(1);
    expect((await run(['reference-seal'])).code).toBe(2);
    expect((await run(['unknown'])).code).toBe(2);
  });

  it('report: SHA-256 эталона не равен печати — отказ (код 1), отчёт не создан', async () => {
    const out = join(work, 'out-refused');
    const refPath = write('ref-refused.json', refFor(A));
    const matchPath = write('match-refused.json', { schema: 'kontur.pilot-matching.v1', tenderId: A, items: [] });
    const r = await run(['report', '--tender', A, '--reference', refPath, '--sealed', sha256Hex('другое содержимое'), '--matching', matchPath, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('SHA-256 эталона не равен печати');
    expect(existsSync(join(out, 'pilot-report.json'))).toBe(false);
    // Эталон правили после печати: отказ и при верном формате.
    const edited = write('ref-edited.json', refFor(A));
    const sealed = sha256Hex(readFileSync(edited));
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n`);
    const again = await run(['report', '--tender', A, '--reference', edited, '--sealed', sealed, '--matching', matchPath, '--out', out]);
    expect(again.code).toBe(1);
    expect(existsSync(join(out, 'pilot-report.json'))).toBe(false);
  });

  it('report: отчёт JSON и Markdown по БД; без названий, текстов источников, ФИО и адреса БД', async () => {
    const out = join(work, 'out-ok');
    const refPath = write('ref-ok.json', refFor(A));
    const findingIds = (await su.query<{ id: string }>("SELECT id FROM finding WHERE tender_id = $1 AND status <> 'stale' ORDER BY id", [A])).rows.map((r) => r.id);
    // Найденное и цитируемое — принятое замечание тендера (resolved, accepted_risk): иначе сверка идентификаторов даёт FAIL.
    const acceptedId = (await su.query<{ id: string }>("SELECT id FROM finding WHERE tender_id = $1 AND status IN ('resolved', 'accepted_risk') ORDER BY id", [A])).rows[0]!.id;
    const reasonId = (await su.query<{ id: string }>("SELECT id FROM change_explanation WHERE tender_id = $1 AND reason_status = 'confirmed'", [A])).rows[0]!.id;
    const matchPath = write('match-ok.json', {
      schema: 'kontur.pilot-matching.v1',
      tenderId: A,
      items: [{ id: 'REF-001', result: 'found', found: [acceptedId] }, { id: 'REF-002', result: 'missed' }, { id: 'REF-003', result: 'found', found: [reasonId] }],
      findings: findingIds.map((id, n) => ({ id, verdict: n === 0 ? 'false' : 'true' })),
      citations: [{ ref: acceptedId, verdict: 'supports' }],
    });
    const log = write('timelog.csv', `user,date,start,end,step\n${ENG},2026-10-21,09:00,09:20,Проверки\n`);
    const defects = write('defects.md', '| ID | Этап | Приоритет | Влияние | Инвариант | Статус |\n|---|---|---|---|---|---|\n| X-01 | 18 | P1 | x | — | CLOSED_BY_REVIEW |\n');
    const sealed = sha256Hex(readFileSync(refPath));
    const r = await run(['report', '--tender', A, '--reference', refPath, '--sealed', sealed, '--matching', matchPath, '--out', out, '--timelog', log, '--defects', defects]);
    expect(r.err).not.toContain('отказ');
    expect(r.code).toBe(1); // в данных теста есть нарушения G2/G3 — отчёт построен, код 1
    const json = JSON.parse(readFileSync(join(out, 'pilot-report.json'), 'utf8')) as { schema: string; referenceSha256: string; gates: { id: string; status: string }[]; metrics: { id: string; status: string; value: number | null }[]; summary: { failed: string[] } };
    expect(json.schema).toBe('kontur.pilot-report.v1');
    expect(json.referenceSha256).toBe(sealed);
    const status = Object.fromEntries([...json.gates, ...json.metrics].map((x) => [x.id, x.status]));
    expect(status).toMatchObject({ G1: 'PASS', G2: 'FAIL', G3: 'FAIL', G4: 'FAIL', G5: 'FAIL', G6: 'MANUAL', G7: 'PASS', M4: 'PASS', M5: 'INFO' });
    expect(json.summary.failed).toContain('G3');
    const md = readFileSync(join(out, 'pilot-report.md'), 'utf8');
    for (const text of [md, readFileSync(join(out, 'pilot-report.json'), 'utf8'), r.out]) {
      expect(text).not.toContain(SECRET_TITLE);
      expect(text).not.toContain(SECRET_TEXT);
      expect(text).not.toContain('Секретный');
      expect(text).not.toContain('PILOT-A');
      expect(text).not.toContain('postgresql://');
    }
    expect(md).toContain('# Отчёт пилота Контур КП');
    expect(md).toContain(ENG);
  });

  it('candidate: итог и счётчики без названий; неизвестный тендер — код 1; без DATABASE_URL — код 2', async () => {
    const r = await run(['candidate', '--tender', A]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Итог: SUITABLE');
    expect(r.out).not.toContain(SECRET_TITLE);
    expect(r.out).not.toContain('PILOT-A');
    expect((await run(['candidate', '--tender', B])).code).toBe(1);
    expect((await run(['candidate', '--tender', randomUUID()])).code).toBe(1);
    expect((await run(['candidate', '--tender', 'не-uuid'])).code).toBe(2);
    expect((await run(['candidate', '--tender', A], { DATABASE_URL: '' })).code).toBe(2);
  });
});
