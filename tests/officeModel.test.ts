// «Офис» в администрировании: роли по видам заданий, позы по приоритету, папки по тендерам и нет живого worker'а.
// Чистая логика веб-модуля, без БД (образец — menuAim.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FOLDER_HIDDEN_TITLE,
  FOLDER_NONE_TITLE,
  IDLE_ACTIVITIES,
  OFFICE_ROLES,
  RECENT_FAILURE_MS,
  type IOfficeItemView,
  type IOfficeView,
  ROLE_KINDS,
  buildOffice,
  idleActivity,
  roleOfKind,
} from '../apps/web/src/pages/admin/office/officeModel.ts';

const AT = '2026-10-21T12:00:00.000Z';
const agoIso = (ms: number): string => new Date(Date.parse(AT) - ms).toISOString();

const item = (o: Partial<IOfficeItemView> & Pick<IOfficeItemView, 'kind' | 'status'>): IOfficeItemView => ({
  tenderId: null,
  hidden: false,
  count: 1,
  lastErrorCode: null,
  lastFailedAt: null,
  ...o,
});
const failed = (kind: string, agoMs: number, o: Partial<IOfficeItemView> = {}): IOfficeItemView =>
  item({ kind, status: 'failed', lastErrorCode: 'E_TEST', lastFailedAt: agoIso(agoMs), ...o });

const view = (items: IOfficeItemView[], o: Partial<IOfficeView> = {}): IOfficeView => ({ at: AT, items, tenders: [], workersAlive: 1, ...o });
const deskOf = (v: IOfficeView, role: string) => buildOffice(v).desks.find((d) => d.role === role);
const loungeOf = (v: IOfficeView, role: string) => buildOffice(v).lounge.find((r) => r.role === role);

// Виды заданий worker'а читаем из текста: тяжёлые модули обработчиков не импортируются.
const handlerKinds = (): string[] => {
  const index = readFileSync(new URL('../apps/worker/src/handlers/index.ts', import.meta.url), 'utf8');
  const body = /export const HANDLERS[^=]*=\s*\{([\s\S]*?)\n\};/u.exec(index)?.[1] ?? '';
  const literal = [...body.matchAll(/^\s*'([a-z]+\.[a-z]+)'\s*:/gmu)].map((m) => m[1]!);
  const probe = /MODEL_PROBE_KIND\s*=\s*'([^']+)'/u.exec(readFileSync(new URL('../apps/worker/src/handlers/modelProbe.ts', import.meta.url), 'utf8'))?.[1];
  return [...literal, ...(body.includes('[MODEL_PROBE_KIND]') && probe ? [probe] : [])];
};

describe('роли по видам заданий', () => {
  it('каждый вид, который регистрирует worker, попадает в роль, кроме «Разнорабочего»', () => {
    const kinds = handlerKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(24);
    expect(kinds).toContain('model.probe');
    expect(kinds.filter((k) => roleOfKind(k) === 'other')).toEqual([]);
  });

  it('виды ролей не повторяются, незнакомый вид — «Разнорабочий»', () => {
    const all = Object.values(ROLE_KINDS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(roleOfKind('totally.unknown')).toBe('other');
    expect(OFFICE_ROLES[0]).toBe('intake');
    expect(OFFICE_ROLES.at(-1)).toBe('other');
  });
});

describe('позы', () => {
  it('выполняющееся задание — поза роли', () => {
    const poses = Object.fromEntries(
      (['intake', 'recognition', 'archive', 'analyst', 'estimator', 'reviewer', 'assembler', 'courier', 'model'] as const).map((role) => [
        role,
        deskOf(view([item({ kind: ROLE_KINDS[role][0]!, status: 'running' })]), role)?.pose,
      ]),
    );
    expect(poses).toEqual({ intake: 'read', recognition: 'read', archive: 'work', analyst: 'think', estimator: 'edit', reviewer: 'read', assembler: 'edit', courier: 'web', model: 'agent' });
    expect(deskOf(view([item({ kind: 'weird.kind', status: 'running' })]), 'other')?.pose).toBe('work');
  });

  it('приоритет: выполняется > отказ за час > очередь > отдых', () => {
    const run = item({ kind: 'review.run', status: 'running' });
    const queued = item({ kind: 'review.run', status: 'queued', count: 3 });
    const recent = failed('review.run', RECENT_FAILURE_MS - 1000);
    const old = failed('review.run', RECENT_FAILURE_MS + 1000);

    expect(deskOf(view([run, queued, recent]), 'reviewer')).toMatchObject({ mood: 'working', pose: 'read' });
    expect(deskOf(view([queued, recent]), 'reviewer')).toMatchObject({ mood: 'alarm', pose: 'wait' });
    expect(deskOf(view([queued, old]), 'reviewer')).toMatchObject({ mood: 'dozing', pose: 'idle' });
    expect(deskOf(view([queued]), 'reviewer')).toMatchObject({ mood: 'dozing', pose: 'idle', queued: 3 });
    // Старый отказ без очереди — человек в комнате отдыха, но ошибка за 24 ч остаётся видна.
    expect(deskOf(view([old]), 'reviewer')).toBeUndefined();
    expect(loungeOf(view([old]), 'reviewer')).toMatchObject({ failed: 1, lastErrorCode: 'E_TEST' });
    expect(loungeOf(view([]), 'reviewer')).toMatchObject({ failed: 0 });
  });

  it('«Разнорабочий» появляется, только если у него есть задания; занятие в комнате отдыха стабильно', () => {
    expect(loungeOf(view([]), 'other')).toBeUndefined();
    expect(deskOf(view([]), 'other')).toBeUndefined();
    const office = buildOffice(view([]));
    expect(office.desks).toEqual([]);
    expect(office.lounge.map((r) => r.role)).toEqual(OFFICE_ROLES.filter((r) => r !== 'other'));
    for (const r of office.lounge) {
      expect(IDLE_ACTIVITIES).toContain(r.activity);
      expect(idleActivity(r.role)).toBe(r.activity);
    }
  });

  it('число отказов считается по 24 ч, код — последнего отказа', () => {
    const v = view([failed('review.run', 5 * 3_600_000, { count: 2, lastErrorCode: 'OLD' }), failed('stage.invalidate', 600_000, { lastErrorCode: 'NEW' })]);
    expect(deskOf(v, 'reviewer')).toMatchObject({ failed: 3, lastErrorCode: 'NEW', pose: 'wait' });
    expect(buildOffice(v).totals.failed).toBe(3);
  });
});

describe('папки по тендерам', () => {
  const titles = [{ id: 't1', title: 'Школа №5' }, { id: 't2', title: 'Мост' }];

  it('закрытые тендеры сливаются в одну папку суммой, без тендера — отдельная, видимые — ссылкой с названием', () => {
    const v = view(
      [
        item({ kind: 'recognition.import', status: 'running', hidden: true, count: 2 }),
        item({ kind: 'recognition.local', status: 'queued', hidden: true, count: 3 }),
        failed('recognition.import', 60_000, { hidden: true, count: 1 }),
        item({ kind: 'recognition.import', status: 'queued', tenderId: 't1', count: 6 }),
        item({ kind: 'recognition.import', status: 'running', tenderId: 't1' }),
        item({ kind: 'recognition.import', status: 'queued' }),
      ],
      { tenders: titles },
    );
    const folders = deskOf(v, 'recognition')!.folders;
    expect(folders.map((f) => f.title)).toEqual(['Школа №5', FOLDER_HIDDEN_TITLE, FOLDER_NONE_TITLE]);
    expect(folders.find((f) => f.hidden)).toMatchObject({ tenderId: null, running: 2, queued: 3, failed: 1 });
    expect(folders.find((f) => f.title === 'Школа №5')).toMatchObject({ tenderId: 't1', running: 1, queued: 6 });
    expect(folders.find((f) => f.title === FOLDER_NONE_TITLE)).toMatchObject({ tenderId: null, hidden: false, queued: 1 });
    // Закрытая папка не несёт идентификатора ни в каком виде.
    expect(JSON.stringify(folders.filter((f) => f.hidden))).not.toMatch(/t1|t2/u);
  });

  it('счётчики стола — суммы по всем папкам', () => {
    const v = view([item({ kind: 'index.build', status: 'running', count: 2, tenderId: 't1' }), item({ kind: 'index.embed', status: 'queued', count: 5, hidden: true })], { tenders: titles });
    expect(deskOf(v, 'archive')).toMatchObject({ running: 2, queued: 5, mood: 'working' });
    expect(buildOffice(v).totals).toMatchObject({ running: 2, queued: 5, failed: 0 });
  });
});

describe('нет живого worker', () => {
  it('очередь есть, worker\'ов нет: все с очередью дремлют даже при отказе, баннер включён', () => {
    const v = view([item({ kind: 'review.run', status: 'queued' }), failed('review.run', 60_000), item({ kind: 'delivery.place', status: 'running' }), failed('fact.extract', 60_000)], { workersAlive: 0 });
    const office = buildOffice(v);
    expect(office.workerDown).toBe(true);
    expect(office.desks.filter((d) => d.queued > 0 || d.running > 0).map((d) => [d.role, d.pose])).toEqual([['reviewer', 'idle'], ['courier', 'idle']]);
    // Отказ без очереди остаётся поднятой рукой: ошибка — факт, а не дремота.
    expect(deskOf(v, 'analyst')).toMatchObject({ mood: 'alarm', pose: 'wait' });
    expect(office.totals.workersAlive).toBe(0);
  });

  it('очереди нет — баннера нет; worker жив — баннера нет', () => {
    expect(buildOffice(view([], { workersAlive: 0 })).workerDown).toBe(false);
    expect(buildOffice(view([item({ kind: 'review.run', status: 'running' })], { workersAlive: 0 })).workerDown).toBe(false);
    expect(buildOffice(view([item({ kind: 'review.run', status: 'queued' })], { workersAlive: 1 })).workerDown).toBe(false);
  });
});
