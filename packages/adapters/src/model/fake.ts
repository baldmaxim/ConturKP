// Поддельная генеративная модель (OD-08-2): детерминированные ответы для тестов и разработки без GPU.
// Не «качество модели», а исполнимый контракт: тот же вход даёт тот же ответ. Тест может подменить
// ответ сценарием (отказ, невалидный JSON, ложная цитата). В production запрещена конфигурацией.
import { chatError, type ChatModelResult, type IChatCompleteInput, type IChatCompletion, type IModelGatewayChat } from './types.ts';

export type FakeChatScript = (input: IChatCompleteInput, call: number) => ChatModelResult<string> | null;

interface IFragmentIn {
  fragmentId: string;
  origin: string;
  text: string;
}

const REQUIREMENT_RE = /(долж(?:ен|на|но|ны)|требуется|необходимо|не допускается|обязан[аоы]?)/iu;
const FACT_BASIS = new Set(['document_text', 'recognized_text', 'email_body', 'attachment_text', 'qa_answer']);

const sentenceWith = (text: string, re: RegExp): string | null => {
  const sentence = text.split(/(?<=[.!?;])\s+/u).find((s) => re.test(s));
  return sentence ? sentence.trim().slice(0, 400) : null;
};

const numberOf = (raw: string): number => Number(raw.replace(/\s+/gu, '').replace(',', '.'));

const factsOf = (f: IFragmentIn, kinds: ReadonlySet<string>): unknown[] => {
  if (!FACT_BASIS.has(f.origin)) return [];
  const out: unknown[] = [];
  const advance = /аванс[^.]*?(\d+(?:[.,]\d+)?)\s*(%|процент)/iu.exec(f.text);
  if (advance && kinds.has('advance_payment')) {
    const value = numberOf(advance[1]!);
    out.push({ factKind: 'advance_payment', displayValue: `${advance[1]} %`, normalizedValue: { value, unit: '%' }, unit: '%', rationale: 'Поддельная модель: процент аванса в тексте', confidence: 0.6, evidence: [{ fragmentId: f.fragmentId, role: 'supports' }] });
  }
  const price = /цена договора[^.]*?(\d[\d\s]*(?:[.,]\d+)?)\s*(руб|тенге|тг|₸)/iu.exec(f.text);
  if (price && kinds.has('contract_price')) {
    const value = numberOf(price[1]!);
    out.push({ factKind: 'contract_price', displayValue: `${price[1]!.trim()} ${price[2]}`, normalizedValue: { value, currency: price[2] }, unit: price[2], rationale: 'Поддельная модель: цена договора в тексте', confidence: 0.6, evidence: [{ fragmentId: f.fragmentId, role: 'supports' }] });
  }
  return out;
};

// ---------------------------------------------------------------- Ответное ядро (этап 08a)

interface IAnswerEvidenceIn {
  label: string;
  status: string;
  text: string;
}

const stemsOf = (text: string): Set<string> =>
  new Set((text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\d]+/gu) ?? []).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));

const kindOf = (sentence: string): string =>
  /%|процент/iu.test(sentence) ? 'percentage' : /руб|₽/iu.test(sentence) ? 'amount' : /\d{2}\.\d{2}\.\d{4}/u.test(sentence) ? 'date' : /(?:дн|день|недел|месяц|год|лет)/iu.test(sentence) ? 'period' : 'fact';

// Черновик поддельной модели: на каждое основание, разделяющее с вопросом основу слова, — первое такое предложение
// дословно, со ссылкой на метку. Заменённые редакции пропускаются, если не спрашивают о прежней. Не «качество модели»,
// а исполнимый контракт: тот же вход — тот же черновик.
const fakeDraft = (user: string): string => {
  const input = JSON.parse(user) as { question: string; plan?: { versionPolicy?: string }; evidence: IAnswerEvidenceIn[] };
  const wanted = stemsOf(input.question);
  const historical = input.plan?.versionPolicy === 'historical';
  const claims = input.evidence
    .filter((e) => historical || !e.status.startsWith('заменённая'))
    .flatMap((e) => {
      const sentence = e.text.split(/(?<=[.!?;])\s+/u).find((s) => [...stemsOf(s)].some((stem) => wanted.has(stem)));
      return sentence ? [{ claim_id: `c${e.label}`, text: sentence.trim().slice(0, 400), kind: kindOf(sentence), evidence_ids: [e.label] }] : [];
    })
    .slice(0, 6);
  return JSON.stringify({ claims, summary: 'Поддельная модель', open_questions: claims.length ? [] : ['В основаниях нет ответа на вопрос'] });
};

// Проверяющий поддельной модели: каждое утверждение подтверждено своими ссылками.
const fakeVerdict = (user: string): string => {
  const input = JSON.parse(user) as { claims: { claim_id: string; evidence_ids: string[] }[] };
  return JSON.stringify({ overall: 'pass', claims: input.claims.map((c) => ({ claim_id: c.claim_id, status: 'supported', supported_by: c.evidence_ids, issues: [] })), conflicts: [] });
};

// Гипотезы поддельной модели (этап 09): требование, ни одна позиция которого не разделяет с формулировкой основу слова,
// — «возможно, не отражено в расчёте». Не качество модели, а исполнимый контракт: тот же вход — те же гипотезы.
const fakeHypotheses = (user: string): string => {
  const input = JSON.parse(user) as { requirements: { code: string; statement: string; fragments: { fragmentId: string }[] }[]; positions: { positionId: string; text: string }[] };
  const positionStems = input.positions.map((p) => stemsOf(p.text));
  const hypotheses = input.requirements
    .filter((r) => r.fragments.length > 0 && !positionStems.some((ps) => [...stemsOf(r.statement)].some((s) => ps.has(s))))
    .map((r) => ({ title: `${r.code}: возможно, не отражено в расчёте`, rationale: 'Поддельная модель: ни одна позиция не разделяет слов с формулировкой', left: { fragmentId: r.fragments[0]!.fragmentId }, right: null }));
  return JSON.stringify({ hypotheses });
};

// Причины изменений поддельной модели (этап 10): первый фрагмент единицы, разделяющий с её наименованием основу слова, —
// ответ заказчика (вопросы–ответы, письмо) или документ. Не качество модели, а исполнимый контракт.
const fakeReasons = (user: string): string => {
  const input = JSON.parse(user) as { units: { unitId: string; title: string; fragments: { fragmentId: string; origin: string; text: string }[] }[] };
  const reasons = input.units.flatMap((u) => {
    const stems = stemsOf(u.title);
    const f = u.fragments.find((x) => [...stemsOf(x.text)].some((s) => stems.has(s)));
    if (!f) return [];
    const reasonKind = f.origin === 'qa_answer' || f.origin === 'email_body' ? 'answer' : 'document';
    return [{ unitId: u.unitId, reasonKind, rationale: 'Поддельная модель: фрагмент разделяет слова с наименованием позиции', fragmentIds: [f.fragmentId] }];
  });
  return JSON.stringify({ reasons });
};

// Предложения полей приложения (этап 11): для поля — первое предложение фрагмента, разделяющее основу слова с подписью;
// число и дата — записанные в этом предложении, вариант — с общей основой подписи. Цитата — само предложение.
const fakeFormSuggestions = (user: string): string => {
  const input = JSON.parse(user) as {
    fields: { fieldKey: string; label: string; type: string; unit: string | null; options: { value: string; label: string }[] | null; fragments: { label: string; text: string }[] }[];
  };
  const fields = input.fields.flatMap((f) => {
    const stems = stemsOf(f.label);
    for (const fr of f.fragments) {
      const sentence = fr.text.split(/(?<=[.!?;])\s+/u).find((x) => [...stemsOf(x)].some((w) => stems.has(w)));
      if (!sentence) continue;
      const quote = sentence.trim().slice(0, 400);
      let value: string | null = null;
      if (f.type === 'number') value = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:%|мес|дн|лет|год|руб|млн)/u.exec(quote)?.[1]?.replace(',', '.') ?? null;
      else if (f.type === 'date') {
        const m = /(\d{2})\.(\d{2})\.(\d{4})/u.exec(quote);
        value = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
      } else if (f.type === 'choice') value = f.options?.find((o) => [...stemsOf(o.label)].some((w) => stemsOf(quote).has(w)))?.value ?? null;
      else value = quote;
      if (value === null) continue;
      return [{ fieldKey: f.fieldKey, value, rationale: 'Поддельная модель: предложение разделяет слова с подписью поля', citations: [{ evidence: fr.label, quote }] }];
    }
    return [];
  });
  return JSON.stringify({ fields });
};

export class FakeChat implements IModelGatewayChat {
  readonly providerId = 'fake' as const;
  readonly model: string;
  readonly version: string;
  readonly maxInputChars: number;
  readonly inferenceConfig: Record<string, unknown>;
  private readonly script: FakeChatScript | null;
  calls = 0;

  constructor(o: { model?: string; revision?: string; maxInputChars?: number; script?: FakeChatScript | null } = {}) {
    this.model = o.model ?? 'fake-chat';
    this.version = o.revision ?? 'fake-heuristic-v1';
    this.maxInputChars = o.maxInputChars ?? 4000;
    this.inferenceConfig = { temperature: 0, mode: 'fake-heuristic-v1', maxInputChars: this.maxInputChars };
    this.script = o.script ?? null;
  }

  async complete(input: IChatCompleteInput): Promise<ChatModelResult<IChatCompletion>> {
    this.calls += 1;
    const startedAt = new Date();
    if (input.signal?.aborted) return chatError('UNAVAILABLE', 'запрос отменён', true);
    const scripted = this.script?.(input, this.calls) ?? null;
    if (scripted) return scripted.ok ? { ok: true, value: this.done(scripted.value, startedAt) } : scripted;
    if (input.task === 'review_hypotheses') {
      try {
        return { ok: true, value: this.done(fakeHypotheses(input.user), startedAt) };
      } catch {
        return chatError('CONTRACT_MISMATCH', 'поддельная модель ждёт вход проверки', false);
      }
    }
    if (input.task === 'form_suggestions') {
      try {
        return { ok: true, value: this.done(fakeFormSuggestions(input.user), startedAt) };
      } catch {
        return chatError('CONTRACT_MISMATCH', 'поддельная модель ждёт вход полей приложения', false);
      }
    }
    if (input.task === 'change_reasons') {
      try {
        return { ok: true, value: this.done(fakeReasons(input.user), startedAt) };
      } catch {
        return chatError('CONTRACT_MISMATCH', 'поддельная модель ждёт вход причин изменений', false);
      }
    }
    if (input.task === 'answer_draft' || input.task === 'answer_verify') {
      try {
        return { ok: true, value: this.done(input.task === 'answer_draft' ? fakeDraft(input.user) : fakeVerdict(input.user), startedAt) };
      } catch {
        return chatError('CONTRACT_MISMATCH', 'поддельная модель ждёт вход ответного ядра', false);
      }
    }
    let fragments: IFragmentIn[];
    try {
      fragments = (JSON.parse(input.user) as { fragments: IFragmentIn[] }).fragments;
    } catch {
      return chatError('CONTRACT_MISMATCH', 'поддельная модель ждёт вход портала', false);
    }
    if (input.task === 'requirement_extraction') {
      const candidates = fragments.flatMap((f) => {
        const statement = sentenceWith(f.text, REQUIREMENT_RE);
        return statement
          ? [{ statement, parameters: [], objectScope: {}, rationale: 'Поддельная модель: модальная конструкция в тексте', confidence: 0.6, evidence: [{ fragmentId: f.fragmentId, role: 'supports' }] }]
          : [];
      });
      return { ok: true, value: this.done(JSON.stringify({ candidates }), startedAt) };
    }
    const kinds = new Set((/видов: ([a-z_, ]+)\./u.exec(input.system)?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean));
    return { ok: true, value: this.done(JSON.stringify({ facts: fragments.flatMap((f) => factsOf(f, kinds)) }), startedAt) };
  }

  private done(content: string, startedAt: Date): IChatCompletion {
    return { content, startedAt, finishedAt: new Date(), promptTokens: null, completionTokens: null };
  }
}
