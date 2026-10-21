// Пилот (этап 18, проект §6, М5) — журнал времени участников, интервалы активности по audit_event, сравнение.
// Чистая логика без БД и сети.
import { ACTIVITY_GAP_MINUTES, THRESHOLDS } from './pilot-lib.ts';

export interface IInterval {
  startMs: number;
  endMs: number;
  minutes: number;
}

// Действия одного пользователя по времени; разрыв больше gapMinutes — новый интервал. Длина интервала — от первого до
// последнего действия (интервал из одного действия — 0 минут).
export const activityIntervals = (times: readonly (Date | number)[], gapMinutes = ACTIVITY_GAP_MINUTES): IInterval[] => {
  const ms = times.map((t) => (t instanceof Date ? t.getTime() : t)).sort((a, b) => a - b);
  const gap = gapMinutes * 60_000;
  const out: IInterval[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const t of ms) {
    if (start === null) {
      start = t;
    } else if (t - prev > gap) {
      out.push({ startMs: start, endMs: prev, minutes: (prev - start) / 60_000 });
      start = t;
    }
    prev = t;
  }
  if (start !== null) out.push({ startMs: start, endMs: prev, minutes: (prev - start) / 60_000 });
  return out;
};

export interface ITimelogRow {
  user: string;
  date: string;
  start: string;
  end: string;
  step: string;
  minutes: number;
}

const csvRows = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/u, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
};

const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/u.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
};

// Журнал участников: user,date,start,end,step (user — идентификатор пользователя портала; первая строка-заголовок
// необязательна). Конец позже начала в тот же день.
export const parseTimelog = (csv: string): { rows: ITimelogRow[]; errors: string[] } => {
  const rows: ITimelogRow[] = [];
  const errors: string[] = [];
  const table = csvRows(csv);
  if (table[0]?.[0]?.trim().toLowerCase() === 'user') table.shift();
  table.forEach((cells, i) => {
    const at = `строка ${i + 1}`;
    if (cells.length < 5) {
      errors.push(`${at}: нужны user,date,start,end,step`);
      return;
    }
    const [user, date, start, end, step] = cells.map((c) => c.trim()) as [string, string, string, string, string];
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (!user) errors.push(`${at}: пустой user`);
    else if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) errors.push(`${at}: date в формате ГГГГ-ММ-ДД`);
    else if (s === null || e === null) errors.push(`${at}: start и end в формате ЧЧ:ММ`);
    else if (e <= s) errors.push(`${at}: конец не позже начала`);
    else rows.push({ user, date, start, end, step, minutes: e - s });
  });
  return { rows, errors };
};

export interface IUserActivity {
  userId: string;
  roles: string[];
  eventTimes: (Date | number)[];
}
export interface IActivityRow {
  userId: string;
  roles: string[];
  events: number;
  intervals: number;
  auditMinutes: number;
  loggedMinutes: number | null;
  // (аудит − журнал) / журнал; null — журнала нет или он пуст.
  deviation: number | null;
  flagged: boolean;
}

// М5: журнал участника — основной источник, интервалы по audit_event — контроль. Расхождение больше порога
// отмечается, итог не правится. Пользователь без записей журнала при непустом журнале отмечается тоже.
export const compareActivity = (users: readonly IUserActivity[], log: readonly ITimelogRow[] | null, threshold: number = THRESHOLDS.timelogDeviation): IActivityRow[] => {
  const logged = new Map<string, number>();
  for (const r of log ?? []) logged.set(r.user, (logged.get(r.user) ?? 0) + r.minutes);
  const rows: IActivityRow[] = users.map((u) => {
    const intervals = activityIntervals(u.eventTimes);
    const auditMinutes = intervals.reduce((s, i) => s + i.minutes, 0);
    const lm = log === null ? null : (logged.get(u.userId) ?? 0);
    const deviation = lm !== null && lm > 0 ? (auditMinutes - lm) / lm : null;
    const flagged = log !== null && (lm === 0 || (deviation !== null && Math.abs(deviation) > threshold));
    return { userId: u.userId, roles: u.roles, events: u.eventTimes.length, intervals: intervals.length, auditMinutes, loggedMinutes: lm, deviation, flagged };
  });
  if (log !== null) {
    const known = new Set(users.map((u) => u.userId));
    for (const [userId, lm] of logged) {
      if (!known.has(userId)) rows.push({ userId, roles: [], events: 0, intervals: 0, auditMinutes: 0, loggedMinutes: lm, deviation: -1, flagged: true });
    }
  }
  return rows;
};
