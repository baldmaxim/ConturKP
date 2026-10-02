// Пакет доказательств ответа (этап 08a): перенос Locus `evidence-packet.js` и правила `AMENDING_CLAUSE` из
// `fact-extractor.js` / `version-graph.js` по временной трактовке AD-08a-1 (`docs/architecture/08a-answer-core-design.md` §3).
// Правило, не модель. Признак редакции основания:
//  - `superseded` — фрагмент пункта N основного документа договора, если допсоглашение той же семьи (явная связь 06a:
//    `contract_role = addendum`, `main_document_id`) говорит «пункт N … изложить в новой редакции»; при нескольких
//    допсоглашениях к одному пункту перекрыты и ранние — по дате редакции; основание факта, заменённого человеком
//    (этап 08), — тоже перекрыто;
//  - `conflict` — то же правило без явной связи (документы тендера) или без даты хотя бы одной редакции: значение не
//    выбирается, расхождение показывается;
//  - `current` — остальное.
import type { IPacketItem, VersionNote } from './claimChecks.ts';

export const PACKET_VERSION = 'evidence/1-kontur';
export const DEFAULT_PACKET_LIMIT = 12;

// Locus требует «пункт N договора изложить в новой редакции»; здесь слово «договора» необязательно и допустима
// «следующая редакция» — так пишут допсоглашения корпуса. Номер пункта — как у Locus.
export const AMENDING_CLAUSE = /пункт\p{L}*\s+(\d+(?:\.\d+)*)\s+(?:договора\s+)?изложить\s+в\s+(?:новой|следующей)\s+редакции/iu;
const CLAUSE_NUMBER = /^\s*(?:п\.\s*)?(\d+(?:\.\d+)+)\.?\s/u;

export const amendedClause = (text: string): string | null => AMENDING_CLAUSE.exec(text)?.[1] ?? null;
export const clauseNumber = (text: string): string | null => CLAUSE_NUMBER.exec(text)?.[1] ?? null;

export interface IContractFamily {
  // Семья — основной документ договора; у допсоглашения — его `main_document_id`.
  familyId: string;
  role: 'contract' | 'addendum' | 'appendix';
  issuedAt: string | null;
}

export interface IPacketCandidate {
  fragmentId: string;
  text: string;
  origin: string;
  sourceUnitId: string;
  // Документ (или письмо, редакция транскрипции): расхождение величин ищется между разными документами.
  documentKey: string;
  // Владелец (тендер или договор): правило без явной связи сравнивает только документы одного владельца.
  ownerKey: string;
  family: IContractFamily | null;
  rank: number;
  reason: string;
}

export interface IVersionMark {
  note: VersionNote;
  reason: string;
}

// Признаки редакции оснований: правило допсоглашений (A) и решения человека этапа 08 (C).
export const annotateVersions = (
  candidates: readonly IPacketCandidate[],
  human: { superseded: ReadonlySet<string>; current: ReadonlySet<string> } = { superseded: new Set(), current: new Set() },
): Map<string, IVersionMark> => {
  const marks = new Map<string, IVersionMark>();
  const mark = (fragmentId: string, note: VersionNote, reason: string): void => {
    const prev = marks.get(fragmentId);
    // Расхождение сильнее перекрытия: если правило не может выбрать, значение не выбирается вовсе.
    if (prev?.note === 'conflict') return;
    marks.set(fragmentId, { note, reason });
  };

  const amendments = candidates.map((c) => ({ c, clause: amendedClause(c.text) })).filter((a): a is { c: IPacketCandidate; clause: string } => a.clause !== null);
  for (const a of amendments) {
    const linked = a.c.family?.role === 'addendum' ? a.c.family : null;
    if (linked) {
      // Семья с явной связью: основной документ той же семьи и другие допсоглашения к тому же пункту.
      const targets = candidates.filter((t) => t.fragmentId !== a.c.fragmentId && t.family?.familyId === linked.familyId && t.family.role === 'contract' && clauseNumber(t.text) === a.clause);
      targets.forEach((t) => mark(t.fragmentId, 'superseded', `amended:${a.clause}`));
      const rivals = amendments.filter((b) => b.c.fragmentId !== a.c.fragmentId && b.clause === a.clause && b.c.family?.familyId === linked.familyId && b.c.family.role === 'addendum');
      for (const b of rivals) {
        const da = linked.issuedAt;
        const db = b.c.family!.issuedAt;
        if (!da || !db || da === db) {
          mark(a.c.fragmentId, 'conflict', `amendment_order_unknown:${a.clause}`);
          mark(b.c.fragmentId, 'conflict', `amendment_order_unknown:${a.clause}`);
        } else if (db < da) {
          mark(b.c.fragmentId, 'superseded', `amended:${a.clause}`);
        }
      }
    } else {
      // Без явной связи семья неизвестна: пункт N другого документа того же владельца и само изменение —
      // расхождение, показанное, а не разрешённое.
      const others = candidates.filter((t) => t.fragmentId !== a.c.fragmentId && t.ownerKey === a.c.ownerKey && t.documentKey !== a.c.documentKey && clauseNumber(t.text) === a.clause);
      if (others.length) {
        mark(a.c.fragmentId, 'conflict', `amendment_without_link:${a.clause}`);
        others.forEach((t) => mark(t.fragmentId, 'conflict', `amendment_without_link:${a.clause}`));
      }
    }
  }
  for (const c of candidates) {
    if (human.superseded.has(c.fragmentId) && !human.current.has(c.fragmentId)) mark(c.fragmentId, 'superseded', 'fact_superseded_by_human');
  }
  return marks;
};

// Пакет: попадания по рангу, дубли (тот же фрагмент или тот же текст в том же документе) убираются, перекрытые
// основания — после действующих (Locus «stale last»), не больше limit; метки E1…En.
export const buildPacket = (candidates: readonly IPacketCandidate[], marks: ReadonlyMap<string, IVersionMark>, limit = DEFAULT_PACKET_LIMIT): IPacketItem[] => {
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank);
  const stale = (c: IPacketCandidate): boolean => marks.get(c.fragmentId)?.note === 'superseded';
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
      reason: m ? `${c.reason}:${m.reason}` : c.reason,
    });
    if (items.length >= limit) break;
  }
  return items;
};
