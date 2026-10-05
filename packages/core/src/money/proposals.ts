// Предложения сопоставления позиций между ревизиями (проект §5.3; D-030 В-10-5 и «Дополнение»). Система подтверждает
// только source_lineage — и только при совпадении экземпляра TenderHub, тендера, версии и UUID позиции с соответствием
// один к одному. Совпадение ключей или номера позиции — предложение, которое подтверждает инженер (в том числе пакетом).
// Расхождение двух ключей и повторы ключа — ручная проверка; разделы не сопоставляются; повторно предложение не делается.
import { clonePositionKey, exactPositionKey, groupByKey, type IPositionKeyInput } from './keys.ts';

export type LineageMethod = 'source_lineage' | 'exact_key' | 'position_key' | 'manual';

// Идентичность источника обеих ревизий: same — один экземпляр (идентификатор из конфигурации), тендер и версия;
// unknown — экземпляр не установлен; different — разные экземпляр, тендер или версия.
export type SourceIdentity = 'same' | 'unknown' | 'different';

export interface ILineageState {
  from: string;
  to: string;
  status: 'proposed' | 'confirmed' | 'rejected';
}

export interface IProposalPlan {
  systemConfirmed: { from: string; to: string }[];
  proposals: { from: string; to: string; method: Exclude<LineageMethod, 'manual'>; keysAgree: boolean }[];
  ambiguous: { reason: 'duplicate_key' | 'keys_disagree'; left: string[]; right: string[] }[];
}

export const planProposals = (
  left: readonly IPositionKeyInput[],
  right: readonly IPositionKeyInput[],
  current: readonly ILineageState[],
  identity: SourceIdentity,
): IProposalPlan => {
  const plan: IProposalPlan = { systemConfirmed: [], proposals: [], ambiguous: [] };
  const busy = new Set<string>();
  const rejected = new Set<string>();
  for (const s of current) {
    if (s.status === 'rejected') rejected.add(`${s.from}>${s.to}`);
    else {
      busy.add(`L:${s.from}`);
      busy.add(`R:${s.to}`);
    }
  }
  const free = (side: 'L' | 'R', p: IPositionKeyInput) => !p.isSection && !busy.has(`${side}:${p.externalPositionId}`);
  let ls = left.filter((p) => free('L', p));
  let rs = right.filter((p) => free('R', p));
  const take = (from: string, to: string) => {
    ls = ls.filter((p) => p.externalPositionId !== from);
    rs = rs.filter((p) => p.externalPositionId !== to);
  };
  const allowed = (from: string, to: string) => !rejected.has(`${from}>${to}`);

  // 1. Та же внешняя позиция (UUID совпадает; уникален в содержимом ревизии — соответствие один к одному).
  if (identity !== 'different') {
    const rightIds = new Set(rs.map((p) => p.externalPositionId));
    for (const p of [...ls]) {
      if (!rightIds.has(p.externalPositionId) || !allowed(p.externalPositionId, p.externalPositionId)) continue;
      if (identity === 'same') plan.systemConfirmed.push({ from: p.externalPositionId, to: p.externalPositionId });
      else plan.proposals.push({ from: p.externalPositionId, to: p.externalPositionId, method: 'source_lineage', keysAgree: false });
      take(p.externalPositionId, p.externalPositionId);
    }
  }

  // 2–3. Ключи change-impact и clone: уникальные с обеих сторон.
  const uniquePairs = (keyOf: (p: IPositionKeyInput) => string) => {
    const lk = groupByKey(ls, keyOf);
    const rk = groupByKey(rs, keyOf);
    const pairs = new Map<string, string>();
    for (const [k, a] of lk) {
      const b = rk.get(k);
      if (b && a.length === 1 && b.length === 1) pairs.set(a[0]!.externalPositionId, b[0]!.externalPositionId);
    }
    return { pairs, lk, rk };
  };
  const exact = uniquePairs(exactPositionKey);
  const clone = uniquePairs(clonePositionKey);
  const exactTo = new Set(exact.pairs.values());
  const cloneTo = new Map([...clone.pairs].map(([f, t]) => [t, f]));
  for (const [from, to] of exact.pairs) {
    const viaClone = clone.pairs.get(from);
    const cloneFromForTo = cloneTo.get(to);
    if ((viaClone !== undefined && viaClone !== to) || (cloneFromForTo !== undefined && cloneFromForTo !== from)) {
      plan.ambiguous.push({ reason: 'keys_disagree', left: [...new Set([from, ...(cloneFromForTo ? [cloneFromForTo] : [])])], right: [...new Set([to, ...(viaClone ? [viaClone] : [])])] });
      continue;
    }
    if (allowed(from, to)) plan.proposals.push({ from, to, method: 'exact_key', keysAgree: viaClone === to });
  }
  const disputed = new Set(plan.ambiguous.flatMap((a) => [...a.left.map((x) => `L:${x}`), ...a.right.map((x) => `R:${x}`)]));
  for (const [from, to] of clone.pairs) {
    if (exact.pairs.has(from) || exactTo.has(to) || disputed.has(`L:${from}`) || disputed.has(`R:${to}`)) continue;
    if (allowed(from, to)) plan.proposals.push({ from, to, method: 'position_key', keysAgree: false });
  }
  for (const p of plan.proposals) take(p.from, p.to);
  for (const id of disputed) {
    if (id.startsWith('L:')) ls = ls.filter((p) => p.externalPositionId !== id.slice(2));
    else rs = rs.filter((p) => p.externalPositionId !== id.slice(2));
  }

  // Повторы ключа change-impact среди оставшихся: одна работа в разных секциях и этажах — только вручную.
  const lk = groupByKey(ls, exactPositionKey);
  const rk = groupByKey(rs, exactPositionKey);
  for (const [k, a] of lk) {
    const b = rk.get(k);
    if (b && (a.length > 1 || b.length > 1)) plan.ambiguous.push({ reason: 'duplicate_key', left: a.map((p) => p.externalPositionId), right: b.map((p) => p.externalPositionId) });
  }
  return plan;
};
