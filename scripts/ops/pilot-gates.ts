// Пилот (этап 18, проект §5–§6) — ворота G1–G7 и метрики М1–М5, разбор журнала дефектов. Чистая логика без БД и сети.
import { FINDING_VERDICTS, THRESHOLDS, type GateStatus, type IResult } from './pilot-lib.ts';
import type { IActivityRow } from './pilot-activity.ts';
import { isVerbatim, type IMatching, type IMatchingItem, type IReference } from './pilot-schema.ts';

const percent = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num / den) * 1000) / 10);

const isFound = (m: IMatchingItem | undefined): boolean => m !== undefined && m.result === 'found' && m.found.length > 0;

export const evaluateG1 = (reference: IReference, matching: IMatching): IResult => {
  const byId = new Map(matching.items.map((i) => [i.id, i]));
  const critical = reference.items.filter((i) => i.critical);
  const missed = critical.filter((i) => !isFound(byId.get(i.id))).map((i) => i.id);
  const status: GateStatus = critical.length === 0 ? 'NOT_RUN' : missed.length === 0 ? 'PASS' : 'FAIL';
  return {
    id: 'G1',
    title: 'все критические пункты эталона выявлены',
    status,
    value: null,
    threshold: null,
    detail: critical.length === 0 ? 'в эталоне нет критических пунктов' : `критических ${critical.length}, выявлено ${critical.length - missed.length}`,
    data: { critical: critical.length, found: critical.length - missed.length, missedIds: missed },
  };
};

export const evaluateM1 = (reference: IReference, matching: IMatching): IResult => {
  const byId = new Map(matching.items.map((i) => [i.id, i]));
  const rest = reference.items.filter((i) => !i.critical);
  const found = rest.filter((i) => isFound(byId.get(i.id))).length;
  const value = percent(found, rest.length);
  return {
    id: 'M1',
    title: 'найдено некритических пунктов эталона',
    status: rest.length === 0 ? 'NOT_RUN' : value >= THRESHOLDS.m1Min ? 'PASS' : 'FAIL',
    value: rest.length === 0 ? null : value,
    threshold: `≥ ${THRESHOLDS.m1Min} %`,
    detail: rest.length === 0 ? 'в эталоне нет некритических пунктов' : `найдено ${found} из ${rest.length}`,
    data: { total: rest.length, found },
  };
};

// portalFindingIds — замечания портала по тендеру, которые обязаны быть размечены (кроме устаревших); null — сверка
// с базой не выполнялась.
export const evaluateM2 = (matching: IMatching, portalFindingIds: readonly string[] | null): IResult => {
  const shown = matching.findings.length;
  const falseCount = matching.findings.filter((f) => f.verdict === 'false').length;
  const value = percent(falseCount, shown);
  const marked = new Set(matching.findings.map((f) => f.id.toLowerCase()));
  const portal = portalFindingIds === null ? null : new Set(portalFindingIds.map((i) => i.toLowerCase()));
  const unmarked = portal === null ? [] : [...portal].filter((id) => !marked.has(id));
  const unknown = portal === null ? [] : [...marked].filter((id) => !portal.has(id));
  const covered = unmarked.length === 0 && unknown.length === 0;
  const verdicts = Object.fromEntries(FINDING_VERDICTS.map((v) => [v, matching.findings.filter((f) => f.verdict === v).length]));
  let status: GateStatus = shown === 0 ? 'NOT_RUN' : value <= THRESHOLDS.m2Max ? 'PASS' : 'FAIL';
  let detail = shown === 0 ? 'нет размеченных замечаний' : `ложных ${falseCount} из ${shown} показанных`;
  if (shown > 0 && !covered) {
    status = 'FAIL';
    detail += `; сопоставление не покрывает замечания портала: не размечено ${unmarked.length}, неизвестных ${unknown.length}`;
  }
  return { id: 'M2', title: 'доля ложных замечаний среди показанных', status, value: shown === 0 ? null : value, threshold: `≤ ${THRESHOLDS.m2Max} %`, detail, data: { shown, verdicts, unmarkedIds: unmarked, unknownIds: unknown } };
};

export const evaluateM3 = (matching: IMatching): IResult => {
  const total = matching.citations.length;
  const supports = matching.citations.filter((c) => c.verdict === 'supports').length;
  const value = percent(supports, total);
  return {
    id: 'M3',
    title: 'точность цитат принятых выводов (выборка)',
    status: total === 0 ? 'NOT_RUN' : value >= THRESHOLDS.m3Min ? 'PASS' : 'FAIL',
    value: total === 0 ? null : value,
    threshold: `≥ ${THRESHOLDS.m3Min} %`,
    detail: total === 0 ? 'выборка цитат пуста' : `подтверждено ${supports} из ${total}`,
    data: { sample: total, supports },
  };
};

export type ReasonStatus = 'unknown' | 'hypothesis' | 'confirmed';

// Пункт price_reason засчитывается, если найден и у каждой найденной версии причины статус confirmed или unknown
// (явное «не установлена», A23). hypothesis, пропуск и неизвестный портал идентификатор — не засчитываются.
export const evaluateM4 = (reference: IReference, matching: IMatching, reasonStatuses: ReadonlyMap<string, ReasonStatus>): IResult => {
  const byId = new Map(matching.items.map((i) => [i.id, i]));
  const items = reference.items.filter((i) => i.kind === 'price_reason');
  const bad: { id: string; why: string }[] = [];
  for (const it of items) {
    const m = byId.get(it.id);
    if (!isFound(m)) {
      bad.push({ id: it.id, why: 'missed' });
      continue;
    }
    const statuses = m!.found.map((f) => reasonStatuses.get(f.toLowerCase()));
    if (statuses.some((s) => s === undefined)) bad.push({ id: it.id, why: 'not_in_portal' });
    else if (statuses.some((s) => s === 'hypothesis')) bad.push({ id: it.id, why: 'hypothesis' });
  }
  const ok = items.length - bad.length;
  const value = percent(ok, items.length);
  return {
    id: 'M4',
    title: 'причины изменения цены: confirmed или явное «не установлена», без гипотез',
    status: items.length === 0 ? 'NOT_RUN' : value >= THRESHOLDS.m4Min ? 'PASS' : 'FAIL',
    value: items.length === 0 ? null : value,
    threshold: `= ${THRESHOLDS.m4Min} %`,
    detail: items.length === 0 ? 'в эталоне нет пунктов price_reason' : `в порядке ${ok} из ${items.length}`,
    data: { total: items.length, ok, bad },
  };
};

// G2: основания принятых выводов. Цитата проверяется дословно, только если она хранится отдельно от фрагмента; иначе —
// принадлежность фрагмента (источник этого тендера, вход этапа или прогона). Тексты фрагментов в отчёт не попадают.
export interface IEvidenceCheck {
  kind: 'finding' | 'answer';
  objectId: string;
  fragmentId: string;
  owned: boolean;
  inScope: boolean;
  quote?: string | null;
  fragmentText?: string | null;
}
export const evaluateG2 = (checks: readonly IEvidenceCheck[], conclusions: { findings: number; answers: number }, quoteStored: boolean): IResult => {
  const foreign = checks.filter((c) => !c.owned || !c.inScope);
  const notVerbatim = checks.filter((c) => c.owned && c.inScope && c.quote != null && !isVerbatim(c.fragmentText ?? '', c.quote));
  const total = conclusions.findings + conclusions.answers;
  const failed = foreign.length + notVerbatim.length;
  const status: GateStatus = total === 0 ? 'NOT_RUN' : failed > 0 ? 'FAIL' : 'PASS';
  return {
    id: 'G2',
    title: 'нет выдуманных источников в принятых выводах',
    status,
    value: null,
    threshold: null,
    detail: total === 0 ? 'принятых замечаний и ответов нет' : `принятых замечаний ${conclusions.findings}, ответов ${conclusions.answers}; оснований проверено ${checks.length}, нарушений ${failed}`,
    data: {
      acceptedFindings: conclusions.findings,
      acceptedAnswers: conclusions.answers,
      evidenceChecked: checks.length,
      foreignOrOutOfScope: foreign.map((c) => ({ kind: c.kind, objectId: c.objectId, fragmentId: c.fragmentId })),
      quoteNotVerbatim: notVerbatim.map((c) => ({ kind: c.kind, objectId: c.objectId, fragmentId: c.fragmentId })),
      quoteVerbatimChecked: quoteStored,
    },
  };
};

export interface IViolation {
  category: string;
  count: number;
  ids: string[];
}
export const evaluateG3 = (violations: readonly IViolation[], checked: Record<string, number>): IResult => {
  const bad = violations.filter((v) => v.count > 0);
  return {
    id: 'G3',
    title: 'нет утечек между тендерами и этапами',
    status: bad.length > 0 ? 'FAIL' : 'PASS',
    value: null,
    threshold: null,
    detail: bad.length > 0 ? `нарушения: ${bad.map((v) => `${v.category} — ${v.count}`).join('; ')}` : `проверено: ${Object.entries(checked).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    data: { checked, violations: bad },
  };
};

export interface IEconomicsView {
  revisionId: string;
  stageId: string;
  seq: number;
  methodVersion: string | null;
  reconciliationStatus: string | null;
  residual: string | null;
  tolerance: string | null;
}
export const evaluateG4 = (latest: IEconomicsView | null): IResult => {
  if (latest === null) {
    return { id: 'G4', title: 'денежная сверка проходит', status: 'NOT_RUN', value: null, threshold: null, detail: 'у тендера нет ревизий расчёта', data: {} };
  }
  const status = latest.reconciliationStatus === 'reconciled' ? 'PASS' : 'FAIL';
  return {
    id: 'G4',
    title: 'денежная сверка проходит',
    status,
    value: null,
    threshold: null,
    detail: latest.reconciliationStatus === null ? 'отчёт сверки последней ревизии не построен (revision_economics пуста)' : `последняя ревизия: ${latest.reconciliationStatus}`,
    data: { ...latest },
  };
};

export interface IDeliveryFiles {
  deliveries: number;
  files: number;
  byState: Record<string, number>;
}
export const evaluateG5 = (d: IDeliveryFiles): IResult => {
  const notVerified = Object.entries(d.byState).filter(([s]) => s !== 'verified').reduce((n, [, c]) => n + c, 0);
  return {
    id: 'G5',
    title: 'одобренные файлы совпадают с размещёнными',
    status: d.deliveries === 0 ? 'NOT_RUN' : notVerified > 0 ? 'FAIL' : 'PASS',
    value: null,
    threshold: null,
    detail: d.deliveries === 0 ? 'размещений нет' : `размещений ${d.deliveries}, файлов ${d.files}, не сверено ${notVerified}`,
    data: { ...d },
  };
};

// G6 подтверждается вручную: ops:backup после цикла и ops:restore-check в тестовом кластере (журнал и его SHA-256).
export const evaluateG6 = (): IResult => ({
  id: 'G6',
  title: 'восстановление подтверждено',
  status: 'MANUAL',
  value: null,
  threshold: null,
  detail: 'подтверждается ops:restore-check; заполните ссылку на журнал',
  data: { evidenceRef: null },
});

export interface IDefectsSummary {
  rows: number;
  blocking: number;
  open: string[];
  unparsed: string[];
}
const DEFECT_STATUS_RE = /^(OPEN|CLOSED|FIXED|REJECTED|WONTFIX|DEFERRED|ACCEPTED|DUPLICATE|INVALID)(?![A-Za-z])/u;

// docs/defects.md: строки таблицы «ID | Этап | Приоритет | …»; статус — первая после приоритета ячейка с известным
// словом статуса (в части старых строк есть лишние пустые ячейки). Блокирующие — P0 и P1.
export const parseDefects = (markdown: string): IDefectsSummary => {
  const out: IDefectsSummary = { rows: 0, blocking: 0, open: [], unparsed: [] };
  for (const line of markdown.split(/\r?\n/u)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const [id, , priority] = cells;
    if (!id || !priority || !/^[A-Z]+\d*-\d+$/u.test(id) || !/^P[0-3]$/u.test(priority)) continue;
    out.rows += 1;
    if (priority !== 'P0' && priority !== 'P1') continue;
    out.blocking += 1;
    const status = cells.slice(3).find((c) => DEFECT_STATUS_RE.test(c));
    if (status === undefined) out.unparsed.push(id);
    else if (status.startsWith('OPEN')) out.open.push(id);
  }
  return out;
};

export const evaluateG7 = (d: IDefectsSummary | null): IResult => {
  if (d === null || d.rows === 0) {
    return { id: 'G7', title: 'нет открытых блокирующих дефектов', status: 'NOT_AVAILABLE', value: null, threshold: null, detail: 'журнал дефектов не прочитан или в нём нет строк таблицы', data: {} };
  }
  const bad = d.open.length + d.unparsed.length;
  return {
    id: 'G7',
    title: 'нет открытых блокирующих дефектов',
    status: bad > 0 ? 'FAIL' : 'PASS',
    value: null,
    threshold: null,
    detail: bad > 0 ? `открытых P0/P1: ${d.open.length}, со статусом не распознан: ${d.unparsed.length}` : `строк ${d.rows}, P0/P1 ${d.blocking}, открытых нет`,
    data: { ...d },
  };
};

export const evaluateM5 = (rows: readonly IActivityRow[], logGiven: boolean): IResult => {
  const flagged = rows.filter((r) => r.flagged);
  const minutes = (n: number): number => Math.round(n * 10) / 10;
  const byRole: Record<string, { audit: number; logged: number }> = {};
  for (const r of rows) {
    const role = r.roles.length > 0 ? r.roles.join('+') : 'не участник';
    const acc = (byRole[role] ??= { audit: 0, logged: 0 });
    acc.audit = minutes(acc.audit + r.auditMinutes);
    acc.logged = minutes(acc.logged + (r.loggedMinutes ?? 0));
  }
  return {
    id: 'M5',
    title: 'время ручной работы по ролям',
    status: 'INFO',
    value: null,
    threshold: null,
    detail: logGiven ? `пользователей ${rows.length}, расхождение > ${THRESHOLDS.timelogDeviation * 100} %: ${flagged.length}` : `пользователей ${rows.length}; журнал участников не передан (--timelog)`,
    data: { users: rows, byRole, logGiven, flaggedUserIds: flagged.map((r) => r.userId) },
  };
};
