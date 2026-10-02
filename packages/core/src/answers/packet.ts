// Пакет доказательств ответа (этап 08a): перенос Locus `evidence-packet.js`. Правило, не модель. Признак редакции
// основания — из состояния фактов графа D-018 (D-028, `docs/architecture/08a-fact-graph-design.md` §5), посчитанного
// по области хода. Пометка фрагмента — сводка для показа:
//  - `superseded` — все факты фрагмента перекрыты (допсоглашением, решением человека, новой редакцией);
//  - `conflict` — во фрагменте есть факт в конфликте и нет действующего;
//  - `current` — остальное (в том числе фрагменты без фактов и фрагменты, где действующий факт соседствует с заменённым).
// R08a-01: сводка не решает за утверждение — элемент пакета несёт состояния своих фактов, и гейт проверяет тот факт,
// значение которого утверждение использует.
import { crossDocumentCounterparts } from '../facts/graph.ts';
import type { IItemFact, IPacketItem, VersionNote } from './claimChecks.ts';
import type { IAnswerPlan } from './planner.ts';

export const PACKET_VERSION = 'evidence/2-facts';
export const DEFAULT_PACKET_LIMIT = 12;

export interface IPacketCandidate {
  fragmentId: string;
  text: string;
  origin: string;
  sourceUnitId: string;
  // Документ (или письмо, редакция транскрипции): расхождение величин ищется между разными документами.
  documentKey: string;
  // Владелец (тендер или договор).
  ownerKey: string;
  rank: number;
  reason: string;
  // Основание факта плана (донор `factsForPlan`): сохраняет свой порядок — заменённое значение стоит сразу за
  // действующим, чтобы ответ мог назвать изменение; в конец уходят только перекрытые попадания поиска.
  factHit?: boolean;
}

export interface IVersionMark {
  note: VersionNote;
  reason: string;
}

// Факт графа, основанием которого служит фрагмент.
export type IFragmentFact = IItemFact;

// Признак редакции основания по фактам графа области хода.
export const markVersions = (candidates: readonly IPacketCandidate[], factsByFragment: ReadonlyMap<string, readonly IFragmentFact[]>): Map<string, IVersionMark> => {
  const marks = new Map<string, IVersionMark>();
  for (const c of candidates) {
    const facts = factsByFragment.get(c.fragmentId) ?? [];
    const conflict = facts.find((f) => f.status === 'conflict');
    if (conflict && !facts.some((f) => f.status === 'active')) {
      marks.set(c.fragmentId, { note: 'conflict', reason: `fact:${conflict.factType}:conflict` });
      continue;
    }
    if (facts.length && facts.every((f) => f.status === 'superseded')) marks.set(c.fragmentId, { note: 'superseded', reason: `fact:${facts[0]!.factType}:superseded` });
  }
  return marks;
};

// Условия обзорного вопроса («какие основные условия договора») — донор `OVERVIEW_FACT_TYPES`.
export const OVERVIEW_FACT_TYPES = ['contract_price', 'advance_percent', 'warranty_period', 'penalty_rate', 'retention_percent', 'retention_return_term', 'work_start_date', 'work_end_date'];

export interface IPlanFact extends Omit<IFragmentFact, 'rawValue'> {
  validFrom: string | null;
  supersededByFactId: string | null;
  fragmentIds: readonly string[];
}

const isCurrent = (f: IPlanFact): boolean => f.status === 'active' || f.status === 'conflict';
const byNewest = (a: IPlanFact, b: IPlanFact): number => String(b.validFrom ?? '').localeCompare(String(a.validFrom ?? ''));
const byOldest = (a: IPlanFact, b: IPlanFact): number => String(a.validFrom ?? '').localeCompare(String(b.validFrom ?? ''));

/**
 * Фрагменты фактов запланированных типов (донор `factsForPlan`) в порядке типов плана. Внутри типа: «текущая» —
 * действующие значения, за каждым — значения, которые оно заменило (ответ может назвать изменение); «прежняя» —
 * сначала перекрытые; «все редакции» — по времени. Для вопроса о конкретной величине добавляется другая сторона
 * конфликта цены и сметы. Основание факта — его первый фрагмент.
 */
export const factsForPlan = (plan: Pick<IAnswerPlan, 'intent' | 'entities' | 'versionPolicy'>, facts: readonly IPlanFact[]): { fragmentId: string; reason: string }[] => {
  const types = plan.entities.length ? plan.entities : plan.intent === 'overview' ? OVERVIEW_FACT_TYPES : [];
  const ordered: IPlanFact[] = [];
  for (const type of types) {
    const ofType = facts.filter((f) => f.factType === type);
    if (plan.versionPolicy === 'all') {
      ordered.push(...[...ofType].sort(byOldest));
      continue;
    }
    const current = ofType.filter(isCurrent).sort(byNewest);
    const superseded = ofType.filter((f) => !isCurrent(f)).sort(byNewest);
    if (plan.versionPolicy === 'historical') {
      ordered.push(...superseded, ...current);
      continue;
    }
    for (const f of current) {
      ordered.push(f);
      ordered.push(...superseded.filter((old) => old.supersededByFactId === f.factId));
    }
    ordered.push(...superseded.filter((old) => !ordered.includes(old)));
  }
  const counterparts = plan.entities.length ? crossDocumentCounterparts(types) : [];
  ordered.push(...facts.filter((f) => counterparts.includes(f.factType as never) && f.status === 'conflict'));
  const seen = new Set<string>();
  return ordered.flatMap((f) => {
    const fragmentId = f.fragmentIds[0];
    if (!fragmentId || seen.has(fragmentId)) return [];
    seen.add(fragmentId);
    return [{ fragmentId, reason: `fact:${f.factType}:${f.status}` }];
  });
};

// Состояния фактов фрагмента в причине основания (`answer_evidence.reason`): след проверки по фактам.
const factsReason = (facts: readonly IItemFact[] | undefined): string[] => (facts?.length ? [`facts:${facts.map((f) => `${f.factType}=${f.status}`).join(',')}`] : []);

// Пакет: попадания по рангу, дубли (тот же фрагмент или тот же текст в том же документе) убираются, перекрытые
// попадания поиска — после действующих (Locus «stale last»; основания фактов плана — на своём месте), не больше limit;
// метки E1…En.
export const buildPacket = (
  candidates: readonly IPacketCandidate[],
  marks: ReadonlyMap<string, IVersionMark>,
  limit = DEFAULT_PACKET_LIMIT,
  // Факты фрагментов по графу области хода; без карты элементы пакета сведений о фактах не несут.
  factsByFragment?: ReadonlyMap<string, readonly IItemFact[]>,
): IPacketItem[] => {
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank);
  const stale = (c: IPacketCandidate): boolean => !c.factHit && marks.get(c.fragmentId)?.note === 'superseded';
  const seenIds = new Set<string>();
  const seenTexts = new Set<string>();
  const items: IPacketItem[] = [];
  for (const c of [...ordered.filter((c) => !stale(c)), ...ordered.filter(stale)]) {
    const textKey = `${c.documentKey}|${c.text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (seenIds.has(c.fragmentId) || seenTexts.has(textKey)) continue;
    seenIds.add(c.fragmentId);
    seenTexts.add(textKey);
    const m = marks.get(c.fragmentId);
    items.push({
      label: `E${items.length + 1}`,
      fragmentId: c.fragmentId,
      text: c.text,
      origin: c.origin,
      sourceUnitId: c.sourceUnitId,
      documentKey: c.documentKey,
      versionNote: m?.note ?? 'current',
      // Не длиннее 200 символов (`answer_evidence.reason`).
      reason: [m ? `${c.reason}:${m.reason}` : c.reason, ...factsReason(factsByFragment?.get(c.fragmentId))].join(';').slice(0, 200),
      ...(factsByFragment ? { facts: factsByFragment.get(c.fragmentId) ?? [] } : {}),
    });
    if (items.length >= limit) break;
  }
  return items;
};
