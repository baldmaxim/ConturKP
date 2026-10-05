// Программные проверки C01–C11 этапа 09 (docs/architecture/09-review-checks-design.md §4): детерминированные функции
// закреплённого входа прогона. Проверка не даёт «пройдено» из пустого входа: нет данных — «не применимо» с причиной или
// «неполно» с причиной (I07, I18). Модель (C12) здесь не участвует — только правила. Проверки по расчёту — checksCalc.ts.
import { FACT_TYPE_META } from '../facts/types.ts';
import { basisEvidence, draft, list, outcomeOf, requirementContext } from './checkHelpers.ts';
import { checkCoverage, checkObligations, checkParameters, checkQuantities, checkUnits } from './checksCalc.ts';
import type { ICheckResult, IEvidenceDraft, IFindingDraft, IReviewFact, IReviewInput, IReviewRequirement } from './input.ts';
import { findingKey, hasPdUncertainty, normalizeMatchText } from './matching.ts';
import { suggestedSide, type CheckOutcome } from './types.ts';

// ---------------------------------------------------------------- C01 Полнота обработки

const checkProcessing = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const gaps: string[] = [];
  let pagesMissing = 0;
  for (const u of input.units) {
    if (u.unitType !== 'document_recognition') continue;
    if (u.technicalStatus === 'not_recognized') gaps.push(`не распознано: ${u.label}`);
    else if (u.pagesTotal !== null && u.pagesRecognized !== null && u.pagesRecognized < u.pagesTotal) {
      pagesMissing += u.pagesTotal - u.pagesRecognized;
      gaps.push(`распознано ${u.pagesRecognized} из ${u.pagesTotal} страниц: ${u.label}`);
    } else if (u.runStatus !== null && u.runStatus !== 'complete') gaps.push(`распознавание «${u.runStatus}»: ${u.label}`);
    else if (u.pagesFailed > 0) {
      pagesMissing += u.pagesFailed;
      gaps.push(`страниц с ошибкой распознавания — ${u.pagesFailed}: ${u.label}`);
    } else if (u.technicalStatus === 'no_fragments') gaps.push(`нет текста: ${u.label}`);
  }
  if (input.importsPending > 0) gaps.push(`элементы импорта без исхода — ${input.importsPending}`);
  const documents = input.units.filter((u) => u.unitType === 'document_recognition').length;
  const counts = { units: input.units.length, documents, gaps: gaps.length, pagesMissing, importsPending: input.importsPending };
  if (input.units.length === 0) return { result: { check: 'processing', outcome: 'incomplete', reason: 'снимок области пуст: проверять нечего', counts }, findings: [] };
  return {
    result: { check: 'processing', outcome: gaps.length > 0 ? 'incomplete' : 'passed', reason: gaps.length > 0 ? list(gaps) : null, counts },
    findings: [],
  };
};

// ---------------------------------------------------------------- C02 Полнота реестра

const checkRegistry = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const reg = input.registry;
  if (!reg) return { result: { check: 'registry', outcome: 'incomplete', reason: 'нет реестра требований на снимке проверки', counts: {} }, findings: [] };
  const counts = { requirements: input.requirements.length, fragments: reg.total, unreviewed: reg.unreviewed, passCompleted: reg.passCompleted ? 1 : 0 };
  if (reg.passCompleted && reg.unreviewed === 0) return { result: { check: 'registry', outcome: 'passed', reason: null, counts }, findings: [] };
  // A44: нет требований или проход не завершён — не «полное покрытие», а явная неполнота и замечание человеку.
  const reason = reg.unreviewed > 0 ? `не просмотрено фрагментов — ${reg.unreviewed} из ${reg.total}` : 'проход полноты реестра не завершён';
  const findings = [
    draft({
      key: findingKey('registry_incomplete', reg.id),
      kind: 'registry_incomplete',
      title: `Реестр требований не пройден: ${reason}`,
      detail: input.requirements.length === 0 ? 'В реестре нет ни одного требования: отсутствие требований не означает полного покрытия.' : null,
      confidence: 'high',
      action: 'Завершить проход полноты реестра: просмотреть фрагменты или отметить «не требование»',
      suggestedSide: null,
      evidence: [],
    }),
  ];
  return { result: { check: 'registry', outcome: 'incomplete', reason, counts }, findings };
};

// ---------------------------------------------------------------- C08 Неопределённость ПД

const checkPdUncertainty = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  let matched = 0;
  const covered = new Set(input.requirements.filter((r) => r.hasAssumptionOrQuestion).flatMap((r) => r.supports.map((s) => s.fragmentId)));
  for (const f of input.fragments) {
    if (!['document_text', 'recognized_text'].includes(f.origin) || !hasPdUncertainty(f.text)) continue;
    matched += 1;
    if (f.hasAssumption || covered.has(f.fragmentId)) continue;
    findings.push(
      draft({
        key: findingKey('pd_uncertainty', f.fragmentId),
        kind: 'pd_uncertainty',
        title: 'Величина уточняется позже: нужна явная оговорка',
        detail: f.text.slice(0, 300),
        confidence: 'medium',
        action: 'Записать допущение или вопрос заказчику и связать с условием КП',
        suggestedSide: null,
        evidence: [{ side: 'left', objectType: 'fragment', fragmentId: f.fragmentId }],
      }),
    );
  }
  const counts = { fragments: input.fragmentsTotal, matched, findings: findings.length };
  return { result: { check: 'pd_uncertainty', outcome: outcomeOf(findings.length, 0, input.fragmentsTotal), reason: input.fragmentsTotal === 0 ? 'в снимке нет текста документов' : null, counts }, findings };
};

// ---------------------------------------------------------------- C09 Конфликты источников

const checkConflicts = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  const facts = new Map(input.facts.map((f) => [f.factId, f]));
  // (а) Конфликт значений графа D-018: обе стороны — факты и их фрагменты.
  for (const c of input.factConflicts) {
    const group = c.factIds.map((id) => facts.get(id)).filter((f): f is IReviewFact => !!f);
    const distinct = group.filter((f, i) => group.findIndex((g) => g.rawValue === f.rawValue) === i);
    if (distinct.length < 2) continue;
    const [left, right] = distinct as [IReviewFact, IReviewFact];
    const sideOf = (side: IEvidenceDraft['side'], f: IReviewFact): IEvidenceDraft[] => [
      { side, objectType: 'evidence_fact', evidenceFactId: f.factId },
      ...f.fragmentIds.map((fragmentId) => ({ side, objectType: 'fragment' as const, fragmentId })),
    ];
    findings.push(
      draft({
        key: findingKey('source_conflict', 'facts', ...[...c.factIds].sort()),
        kind: 'source_conflict',
        title: `${FACT_TYPE_META[left.factType].title}: «${left.rawValue}» и «${right.rawValue}»`,
        detail: distinct.length > 2 ? `Других значений — ${distinct.length - 2}` : null,
        confidence: 'high',
        action: 'Решить, какое значение действует; поздняя дата сама конфликт не закрывает',
        suggestedSide: suggestedSide(input.priority, left.sourceKind, right.sourceKind),
        evidence: [...sideOf('left', left), ...sideOf('right', right), ...distinct.slice(2).flatMap((f) => sideOf('context', f))],
      }),
    );
  }
  // (б) Требования реестра с разными значениями параметра того же имени (R08-01) и (в) противоречащее основание.
  const byId = new Map(input.requirements.map((r) => [r.requirementId, r]));
  const seen = new Set<string>();
  for (const r of input.requirements) {
    for (const c of r.conflicts) {
      const other = byId.get(c.requirementId);
      if (!other) continue;
      const pair = [r.requirementId, other.requirementId].sort();
      const key = `${pair.join('|')}|${normalizeMatchText(c.parameter)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Левая сторона — требование с меньшим кодом (раньше записанное в реестр): порядок устойчив между прогонами.
      const [a, b] = r.code <= other.code ? [r, other] : [other, r];
      const value = (q: IReviewRequirement) => q.parameters.find((p) => normalizeMatchText(p.name) === normalizeMatchText(c.parameter))?.value ?? '—';
      findings.push(
        draft({
          key: findingKey('source_conflict', 'requirements', key),
          kind: 'source_conflict',
          title: `${a.code} и ${b.code}: «${c.parameter}» — «${value(a)}» и «${value(b)}»`,
          detail: [a.conflictNote, b.conflictNote].filter(Boolean).join(' / ') || null,
          confidence: 'medium',
          action: 'Решить, какое значение действует; поздняя дата сама конфликт не закрывает',
          suggestedSide: suggestedSide(input.priority, a.supports[0]?.sourceKind ?? null, b.supports[0]?.sourceKind ?? null),
          evidence: [
            ...basisEvidence('left', a.supports),
            { side: 'left', objectType: 'requirement_revision', requirementRevisionId: a.revisionId },
            ...basisEvidence('right', b.supports),
            { side: 'right', objectType: 'requirement_revision', requirementRevisionId: b.revisionId },
          ],
        }),
      );
    }
    if (r.contradicts.length > 0 && r.supports.length > 0) {
      findings.push(
        draft({
          key: findingKey('source_conflict', 'contradicts', r.requirementId),
          kind: 'source_conflict',
          title: `${r.code}: у требования есть противоречащее основание`,
          detail: r.conflictNote,
          confidence: 'medium',
          action: 'Решить, какое основание действует',
          suggestedSide: suggestedSide(input.priority, r.supports[0]?.sourceKind ?? null, r.contradicts[0]?.sourceKind ?? null),
          evidence: [...basisEvidence('left', r.supports), ...basisEvidence('right', r.contradicts), requirementContext(r)],
        }),
      );
    }
  }
  const counts = { factConflicts: input.factConflicts.length, findings: findings.length, facts: input.facts.length, factsPendingUnits: input.factsPendingUnits };
  const checked = input.facts.length + input.requirements.length;
  if (input.factsPendingUnits > 0) return { result: { check: 'source_conflicts', outcome: 'incomplete', reason: `факты не извлечены по единицам снимка — ${input.factsPendingUnits}`, counts }, findings };
  return { result: { check: 'source_conflicts', outcome: outcomeOf(findings.length, 0, checked), reason: checked === 0 ? 'нет фактов и требований для сравнения' : null, counts }, findings };
};

// ---------------------------------------------------------------- C10 Молчание заказчика

const checkSilence = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  // D-029 В-09-4: отправленный вопрос без ответа — замечание; молчание не согласие, ось позиции заказчика не меняется.
  const findings = input.questions.map((q) =>
    draft({
      key: findingKey('customer_silence', q.kind, q.id),
      kind: 'customer_silence',
      title: q.kind === 'customer_question' ? 'Вопрос заказчику отправлен, ответа нет' : 'Вопрос в форме вопросов–ответов без ответа',
      detail: q.askedAt ? `Отправлен: ${q.askedAt}` : null,
      confidence: 'high',
      action: 'Получить ответ заказчика или решить без ответа; молчание не считается согласием',
      suggestedSide: null,
      evidence: [
        q.kind === 'customer_question'
          ? { side: 'left' as const, objectType: 'customer_question' as const, customerQuestionId: q.id }
          : { side: 'left' as const, objectType: 'qa_item_revision' as const, qaItemRevisionId: q.revisionId! },
        ...q.fragmentIds.map((fragmentId) => ({ side: 'context' as const, objectType: 'fragment' as const, fragmentId })),
      ],
    }),
  );
  return { result: { check: 'customer_silence', outcome: findings.length > 0 ? 'failed' : 'passed', reason: null, counts: { unanswered: findings.length } }, findings };
};

// ---------------------------------------------------------------- C11 Устаревшие основания

const checkStaleBasis = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  const factsByFragment = new Map<string, IReviewFact[]>();
  for (const f of input.facts) for (const id of f.fragmentIds) factsByFragment.set(id, [...(factsByFragment.get(id) ?? []), f]);
  const facts = new Map(input.facts.map((f) => [f.factId, f]));
  for (const r of input.requirements) {
    for (const b of r.supports) {
      const newer = b.documentRevisionId ? input.newerRevisions.get(b.documentRevisionId) : undefined;
      if (newer) {
        findings.push(
          draft({
            key: findingKey('stale_basis', r.requirementId, 'revision', b.documentRevisionId!),
            kind: 'stale_basis',
            title: `${r.code}: основание из прежней редакции документа`,
            detail: null,
            confidence: 'high',
            action: 'Пересмотреть требование по новой редакции',
            suggestedSide: null,
            evidence: [
              { side: 'left', objectType: 'fragment', fragmentId: b.fragmentId },
              { side: 'right', objectType: 'document_revision', documentRevisionId: newer },
              requirementContext(r),
            ],
          }),
        );
      }
      const here = factsByFragment.get(b.fragmentId) ?? [];
      for (const f of here) {
        if (f.status !== 'superseded') continue;
        // Тот же тип действует в том же фрагменте — основание не устарело целиком (R08a-01).
        if (here.some((g) => g.factType === f.factType && g.status !== 'superseded')) continue;
        const by = f.supersededByFactId ? facts.get(f.supersededByFactId) : undefined;
        findings.push(
          draft({
            key: findingKey('stale_basis', r.requirementId, 'fact', f.factId),
            kind: 'stale_basis',
            title: `${r.code}: «${FACT_TYPE_META[f.factType].title}: ${f.rawValue}» перекрыто${by ? ` значением «${by.rawValue}»` : ''}`,
            detail: null,
            confidence: 'high',
            action: 'Пересмотреть требование по действующему значению',
            suggestedSide: null,
            evidence: [
              { side: 'left', objectType: 'evidence_fact', evidenceFactId: f.factId },
              { side: 'left', objectType: 'fragment', fragmentId: b.fragmentId },
              ...(by ? [{ side: 'right' as const, objectType: 'evidence_fact' as const, evidenceFactId: by.factId }, ...by.fragmentIds.map((fragmentId) => ({ side: 'right' as const, objectType: 'fragment' as const, fragmentId }))] : []),
              requirementContext(r),
            ],
          }),
        );
      }
    }
  }
  const counts = { requirements: input.requirements.length, findings: findings.length, factsPendingUnits: input.factsPendingUnits };
  if (input.factsPendingUnits > 0 && input.requirements.length > 0) {
    return { result: { check: 'stale_basis', outcome: 'incomplete', reason: `факты не извлечены по единицам снимка — ${input.factsPendingUnits}`, counts }, findings };
  }
  return { result: { check: 'stale_basis', outcome: outcomeOf(findings.length, 0, input.requirements.length), reason: input.requirements.length === 0 ? 'нет требований с основаниями' : null, counts }, findings };
};

// ---------------------------------------------------------------- Сборка

const dedupe = (findings: IFindingDraft[]): IFindingDraft[] => {
  const out = new Map<string, IFindingDraft>();
  for (const f of findings) if (!out.has(f.key)) out.set(f.key, f);
  return [...out.values()];
};

export const runRuleChecks = (input: IReviewInput): { results: ICheckResult[]; findings: IFindingDraft[] } => {
  const parts = [
    checkProcessing(input),
    checkRegistry(input),
    checkCoverage(input),
    checkParameters(input),
    checkUnits(input),
    checkQuantities(input),
    checkObligations(input),
    checkPdUncertainty(input),
    checkConflicts(input),
    checkSilence(input),
    checkStaleBasis(input),
  ];
  return { results: parts.map((p) => p.result), findings: dedupe(parts.flatMap((p) => p.findings)) };
};

// Итог прогона по исходам (I07, I18): без неполных и ошибочных проверок — «завершён», иначе — «с пробелами».
export const runStatusOf = (outcomes: readonly CheckOutcome[]): 'completed' | 'completed_with_gaps' =>
  outcomes.some((o) => o === 'incomplete' || o === 'error') ? 'completed_with_gaps' : 'completed';
