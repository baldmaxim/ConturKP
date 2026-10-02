// Отрисовка ответа (этап 08a): перенос Locus `answer-renderer.js`. Пользователь получает только подтверждённые
// утверждения, явно показанное расхождение оснований или честное «не удалось подтвердить». Всё показанное
// детерминировано: тексты утверждений, прошедших проверки, номера цитат и служебные фразы; ни сводки модели, ни
// пояснений, ни уверенности. Расхождение показывается номерами цитат и не разрешается (AD-08a-8).
import { extractQuantities } from './claimNumbers.ts';
import type { IClaimCheck, IDraftClaim, IPacketItem } from './claimChecks.ts';
import type { IAnswerPlan } from './planner.ts';
import type { IClaimVerdict } from './verifier.ts';

export const INSUFFICIENT_ANSWER = 'Не удалось подтвердить ответ по имеющимся документам.';

export type VerificationLevel = 'hard_checks' | 'model';
export type FinalClaimStatus = 'supported' | 'unsupported' | 'contradicted' | 'ambiguous';

// Итог утверждения: провал детерминированной проверки всегда сильнее; затем вердикт проверяющего; без
// проверяющего (уровень «правила») утверждение, прошедшее проверки, остаётся.
export const finalClaimStatus = (check: IClaimCheck, verdict: IClaimVerdict | undefined, level: VerificationLevel): FinalClaimStatus => {
  if (!check.passed) return check.status === 'passed' ? 'unsupported' : check.status;
  if (level === 'model') return verdict?.status ?? 'ambiguous';
  return 'supported';
};

const citationList = (numbers: readonly number[]): string => numbers.map((n) => `[${n}]`).join('');

export interface IRenderedClaim {
  claimId: string;
  kind: string;
  text: string;
  labels: string[];
  checkStatus: IClaimCheck['status'];
  issues: string[];
  verifierStatus: IClaimVerdict['status'] | null;
  status: FinalClaimStatus;
  shown: boolean;
  citations: number[];
}

export interface IRendered {
  answer: string;
  outcome: 'confirmed' | 'conflict' | 'insufficient';
  sources: IPacketItem[];
  claims: IRenderedClaim[];
  conflictCitations: number[];
}

const VALUE_KINDS = new Set(['amount', 'percentage', 'date', 'period']);

// AD-08a-8 (в): вопрос об одном значении, а показанные утверждения одного вида называют разные величины из разных
// документов — это расхождение оснований. Обзор и сравнение не проверяются: там разные значения ожидаемы.
const valueConflictLabels = (kept: readonly { claim: IDraftClaim }[], plan: IAnswerPlan | null, byLabel: ReadonlyMap<string, IPacketItem>): string[] => {
  if (!plan || plan.intent === 'overview' || plan.intent === 'compare' || plan.entities.length > 1) return [];
  const groups = new Map<string, { value: string; documents: Set<string>; labels: string[] }[]>();
  for (const { claim } of kept) {
    if (!VALUE_KINDS.has(claim.kind)) continue;
    const quantities = extractQuantities(claim.text);
    if (quantities.length !== 1) continue;
    const q = quantities[0]!;
    const documents = new Set(claim.evidenceIds.map((label) => byLabel.get(label)?.documentKey).filter((d): d is string => Boolean(d)));
    const list = groups.get(claim.kind) ?? [];
    list.push({ value: `${q.unit}:${q.value}`, documents, labels: claim.evidenceIds });
    groups.set(claim.kind, list);
  }
  const labels = new Set<string>();
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        const sameDocument = [...a.documents].some((d) => b.documents.has(d));
        if (a.value !== b.value && !sameDocument) [...a.labels, ...b.labels].forEach((l) => labels.add(l));
      }
    }
  }
  return [...labels];
};

export const renderVerifiedAnswer = (o: {
  claims: readonly IDraftClaim[];
  checks: ReadonlyMap<string, IClaimCheck>;
  verdicts?: ReadonlyMap<string, IClaimVerdict>;
  conflicts?: readonly { evidenceIds: string[] }[];
  items: readonly IPacketItem[];
  level: VerificationLevel;
  plan?: IAnswerPlan | null;
}): IRendered => {
  const verdicts = o.verdicts ?? new Map<string, IClaimVerdict>();
  const byLabel = new Map(o.items.map((item) => [item.label, item]));
  const numberByLabel = new Map<string, number>();
  const sources: IPacketItem[] = [];
  const cite = (label: string): number | null => {
    if (!numberByLabel.has(label)) {
      const item = byLabel.get(label);
      if (!item) return null;
      sources.push(item);
      numberByLabel.set(label, sources.length);
    }
    return numberByLabel.get(label)!;
  };

  const reviewed = o.claims.map((claim) => {
    const check = o.checks.get(claim.claimId)!;
    const verdict = verdicts.get(claim.claimId);
    return { claim, check, verdict, status: finalClaimStatus(check, verdict, o.level) };
  });
  const kept = reviewed.filter((item) => item.status === 'supported');

  const lines = kept.map(({ claim, verdict }) => {
    // Проверяющий может сузить цитату до оснований, которые действительно подтверждают утверждение.
    const narrowed = (verdict?.supportedBy ?? []).filter((label) => claim.evidenceIds.includes(label));
    const labels = narrowed.length ? narrowed : claim.evidenceIds;
    const numbers = labels.map(cite).filter((n): n is number => n !== null);
    return { claimId: claim.claimId, text: `${claim.text.replace(/[.;\s]+$/u, '')}. ${citationList(numbers)}`.trim(), numbers };
  });

  // Расхождение: основания с пометкой правила (AD-08a-1), конфликты проверяющего и расхождение величин (AD-08a-8).
  const conflictLabels = new Set<string>();
  // Стороны конфликта графа: фрагменты с фактами в конфликте тех типов, значения которых показанные утверждения
  // используют (R08a-01); без сведений о фактах — фрагменты с пометкой «расхождение».
  if (kept.some(({ check }) => check.conflict)) {
    const types = new Set(kept.flatMap(({ check }) => check.conflictFactTypes ?? []));
    o.items
      .filter((item) => (item.facts ? item.facts.some((f) => f.status === 'conflict' && types.has(f.factType)) : item.versionNote === 'conflict'))
      .forEach((item) => conflictLabels.add(item.label));
  }
  if (kept.length) {
    (o.conflicts ?? []).forEach((conflict) => conflict.evidenceIds.filter((label) => byLabel.has(label)).forEach((label) => conflictLabels.add(label)));
    valueConflictLabels(kept, o.plan ?? null, byLabel).forEach((label) => conflictLabels.add(label));
  }
  const conflictNumbers = [...conflictLabels].map(cite).filter((n): n is number => n !== null);

  const dropped = reviewed.length - kept.length;
  let answer: string;
  let outcome: IRendered['outcome'];
  if (!kept.length) {
    answer = INSUFFICIENT_ANSWER;
    outcome = 'insufficient';
  } else {
    const body = lines.length === 1 ? lines[0]!.text : lines.map((line) => `- ${line.text}`).join('\n');
    const notes: string[] = [];
    if (conflictNumbers.length >= 2) notes.push(`В документах есть расхождение по этому вопросу: сравните ${citationList(conflictNumbers)}.`);
    if (dropped) notes.push(`Не показано утверждений, не подтверждённых документами: ${dropped}.`);
    answer = [body, ...notes].join('\n\n');
    outcome = conflictNumbers.length >= 2 ? 'conflict' : 'confirmed';
  }

  return {
    answer,
    outcome,
    sources,
    conflictCitations: conflictNumbers.length >= 2 ? conflictNumbers : [],
    claims: reviewed.map(({ claim, check, verdict, status }) => ({
      claimId: claim.claimId,
      kind: claim.kind,
      text: claim.text,
      labels: claim.evidenceIds,
      checkStatus: check.status,
      issues: [...check.issues.map((issue) => issue.code), ...(check.passed && verdict && status !== 'supported' ? [`verifier:${verdict.status}`] : [])],
      verifierStatus: verdict?.status ?? null,
      status,
      shown: status === 'supported',
      citations: lines.find((line) => line.claimId === claim.claimId)?.numbers ?? [],
    })),
  };
};
