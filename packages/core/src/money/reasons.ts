// Причины изменений (проект §5.8; D-030 В-10-8; I11, I12, A23): модель только предлагает вид причины с цитатами из
// пакета, человек подтверждает. Числа модели в суммы не превращаются (ADR-009): ответ — вид, обоснование и ссылки.
// «Внутреннее решение» и «неизвестно» ставит только человек.
export type ReasonKind = 'document' | 'answer' | 'supplier' | 'internal_decision' | 'unknown';
export const REASON_KINDS: readonly ReasonKind[] = ['document', 'answer', 'supplier', 'internal_decision', 'unknown'];
export type ModelReasonKind = 'document' | 'answer' | 'supplier';
const MODEL_KINDS: readonly ModelReasonKind[] = ['document', 'answer', 'supplier'];

// Какие происхождения фрагмента могут быть основанием вида причины.
export const REASON_BASIS_ORIGINS: Record<'document' | 'answer' | 'supplier', readonly string[]> = {
  document: ['document_text', 'recognized_text', 'attachment_text'],
  answer: ['qa_answer', 'email_body', 'attachment_text'],
  supplier: ['document_text', 'recognized_text', 'attachment_text', 'email_body'],
};

export const REASON_PROMPT_VERSION = 'change-reasons/10-1';

export const reasonSystemPrompt = (): string =>
  [
    'Ты помогаешь инженеру сметного отдела объяснить изменение стоимости позиции между двумя ревизиями расчёта.',
    'Для каждой единицы сравнения выбери вид причины только по приведённым фрагментам: document — документ заказчика (ТЗ, проект, договор);',
    'answer — ответ заказчика или письмо; supplier — предложение поставщика. Если фрагменты не объясняют изменение, единицу не включай.',
    'Не считай и не пересчитывай суммы: числа даны только как контекст. Не придумывай фрагменты — ссылайся только на fragmentId из входа своей единицы.',
    'Ответ — только JSON: {"reasons":[{"unitId":"…","reasonKind":"document|answer|supplier","rationale":"кратко, по-русски","fragmentIds":["…"]}]}',
  ].join('\n');

export interface IReasonUnitInput {
  unitId: string;
  title: string;
  unitCode: string | null;
  effects: Record<string, string>;
  fragments: { fragmentId: string; origin: string; text: string }[];
}

export interface IReasonInput {
  units: IReasonUnitInput[];
}

export const reasonUserContent = (input: IReasonInput): string => JSON.stringify({ units: input.units });

export interface IParsedReason {
  unitId: string;
  reasonKind: ModelReasonKind;
  rationale: string;
  fragmentIds: string[];
}

// Ответ модели проверяется до записи: единица — из пакета, вид — из разрешённых модели, ссылки — на фрагменты этой
// единицы подходящего происхождения. Непрошедшие элементы отбрасываются и считаются.
export const parseReasons = (content: string, input: IReasonInput): { ok: true; items: IParsedReason[]; dropped: number } | { ok: false } => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false };
  }
  const list = (raw as { reasons?: unknown })?.reasons;
  if (!Array.isArray(list)) return { ok: false };
  const units = new Map(input.units.map((u) => [u.unitId, u]));
  const items: IParsedReason[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const r of list as Record<string, unknown>[]) {
    const unit = typeof r?.unitId === 'string' ? units.get(r.unitId) : undefined;
    const kind = r?.reasonKind as ModelReasonKind;
    const rationale = typeof r?.rationale === 'string' ? r.rationale.trim().slice(0, 2000) : '';
    const ids = Array.isArray(r?.fragmentIds) ? [...new Set((r.fragmentIds as unknown[]).filter((x): x is string => typeof x === 'string'))] : [];
    if (!unit || seen.has(unit.unitId) || !MODEL_KINDS.includes(kind) || rationale.length === 0 || ids.length === 0) {
      dropped += 1;
      continue;
    }
    const origins = new Map(unit.fragments.map((f) => [f.fragmentId, f.origin]));
    if (!ids.every((id) => origins.has(id) && REASON_BASIS_ORIGINS[kind].includes(origins.get(id)!))) {
      dropped += 1;
      continue;
    }
    seen.add(unit.unitId);
    items.push({ unitId: unit.unitId, reasonKind: kind, rationale, fragmentIds: ids.slice(0, 10) });
  }
  return { ok: true, items, dropped };
};
