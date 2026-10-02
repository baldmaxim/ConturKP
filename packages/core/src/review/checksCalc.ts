// Программные проверки по расчёту этапа 09 (§4): покрытие C03, параметры C04, единицы C05, количества и дубли C06
// (D-029 В-09-6), договорные обязательства C07 (A02). Комплексная расценка не доказывает расхождения (A05).
import { basisEvidence, calcEvidence, calcObjects, confirmedCoverage, draft, outcomeOf, requirementContext, sameNumber } from './checkHelpers.ts';
import type { ICheckResult, IFindingDraft, IReviewInput, IReviewPosition } from './input.ts';
import { calcObjectKey, findingKey, normalizeMatchText, normalizeUnit, quantityOf, valueFoundIn } from './matching.ts';

// ---------------------------------------------------------------- C03 Покрытие

export const checkCoverage = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  let unassessed = 0;
  let needsReview = 0;
  let complexRate = 0;
  for (const r of input.requirements) {
    const c = r.coverage;
    if (!c) unassessed += 1;
    else if (c.state === 'needs_review') needsReview += 1;
    else if ((c.state === 'uncovered' || c.state === 'partial') && !r.fromContract) {
      findings.push(
        draft({
          key: findingKey('coverage_gap', r.requirementId),
          kind: 'coverage_gap',
          title: `${r.code}: требование ${c.state === 'partial' ? 'покрыто расчётом частично' : 'не покрыто расчётом'}`,
          detail: c.reason,
          confidence: 'high',
          action: 'Учесть в расчёте или записать решение',
          suggestedSide: null,
          evidence: [...basisEvidence('left', r.supports), ...calcObjects(r).map((o) => calcEvidence('right', o)), requirementContext(r)],
        }),
      );
    }
    if (c && c.state === 'covered' && c.objects.some((o) => o.match === 'complex_rate')) complexRate += 1;
  }
  const counts = { requirements: input.requirements.length, findings: findings.length, unassessed, needsReview, complexRate };
  if (input.requirements.length === 0) return { result: { check: 'coverage', outcome: 'not_applicable', reason: 'в реестре нет подтверждённых требований', counts }, findings };
  if (!input.calculationRevisionId) return { result: { check: 'coverage', outcome: 'incomplete', reason: 'у этапа нет ревизии расчёта', counts }, findings };
  const gaps = unassessed + needsReview;
  const reason = gaps > 0 ? [unassessed ? `без оценки покрытия — ${unassessed}` : '', needsReview ? `требует пересмотра — ${needsReview}` : ''].filter(Boolean).join('; ') : null;
  return { result: { check: 'coverage', outcome: outcomeOf(findings.length, gaps, input.requirements.length), reason, counts }, findings };
};

// ---------------------------------------------------------------- C04 Параметры и C06 количества

export const checkParameters = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  let checked = 0;
  let complexRate = 0;
  let missingObjects = 0;
  for (const r of input.requirements) {
    if (!confirmedCoverage(r)) continue;
    const textual = r.parameters.filter((p) => !quantityOf(p));
    if (textual.length === 0) continue;
    for (const o of calcObjects(r)) {
      if (o.match === 'complex_rate') {
        // A05: комплексная расценка не обязана называть параметры — отсутствие слова не доказывает расхождения.
        complexRate += 1;
        continue;
      }
      const obj = input.calcObjects.get(calcObjectKey(o.calculationRevisionId!, o.externalPositionId!, o.externalItemId));
      if (!obj) {
        missingObjects += 1;
        continue;
      }
      for (const p of textual) {
        checked += 1;
        if (valueFoundIn(p.value, obj.texts)) continue;
        findings.push(
          draft({
            key: findingKey('parameter_mismatch', r.requirementId, normalizeMatchText(p.name), o.externalPositionId!, o.externalItemId ?? ''),
            kind: 'parameter_mismatch',
            title: `${r.code}: «${p.name}: ${p.value}» не найдено в строке расчёта`,
            detail: `Строка расчёта: ${obj.texts.filter(Boolean)[0] ?? '—'}`.slice(0, 4000),
            confidence: 'medium',
            action: 'Сверить параметр требования и строку расчёта; при отличии — разногласие с основанием',
            suggestedSide: null,
            evidence: [...basisEvidence('left', r.supports), calcEvidence('right', o), requirementContext(r)],
          }),
        );
      }
    }
  }
  const counts = { checked, findings: findings.length, complexRate, missingObjects };
  if (missingObjects > 0) return { result: { check: 'parameters', outcome: 'incomplete', reason: `объекты покрытия не найдены в содержимом расчёта — ${missingObjects}`, counts }, findings };
  const reason = checked === 0 ? 'нет покрытых требований с текстовыми параметрами и явной строкой расчёта' : null;
  return { result: { check: 'parameters', outcome: outcomeOf(findings.length, 0, checked), reason, counts }, findings };
};

export const checkQuantities = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  let checked = 0;
  for (const r of input.requirements) {
    if (!confirmedCoverage(r)) continue;
    const quantities = r.parameters.map((p) => ({ p, q: quantityOf(p) })).filter((x) => x.q !== null);
    if (quantities.length === 0) continue;
    for (const o of calcObjects(r)) {
      const obj = input.calcObjects.get(calcObjectKey(o.calculationRevisionId!, o.externalPositionId!, o.externalItemId));
      for (const { p, q } of quantities) {
        checked += 1;
        const unit = normalizeUnit(obj?.unit ?? null);
        const base: Pick<IFindingDraft, 'evidence' | 'suggestedSide'> = { evidence: [...basisEvidence('left', r.supports), calcEvidence('right', o), requirementContext(r)], suggestedSide: null };
        const keyParts = [r.requirementId, normalizeMatchText(p.name), o.externalPositionId!, o.externalItemId ?? ''];
        if (!obj || obj.quantity === null || !unit || unit !== q!.unit) {
          // D-029 В-09-6: несопоставимость — неопределённость, а не «пройдено» и не уверенное расхождение.
          findings.push(
            draft({
              ...base,
              key: findingKey('quantity_uncertain', ...keyParts),
              kind: 'quantity_uncertain',
              title: `${r.code}: «${p.name}: ${p.value} ${p.unit ?? ''}» не сопоставляется с расчётом`.replace(/\s+»/u, '»'),
              detail: obj ? `В расчёте: ${obj.quantity ?? '—'} ${obj.unit ?? 'без единицы'}` : 'Объект покрытия не найден в содержимом расчёта',
              confidence: 'low',
              action: 'Сопоставить величины вручную',
            }),
          );
          continue;
        }
        if (sameNumber(obj.quantity, q!.value)) continue;
        findings.push(
          draft({
            ...base,
            key: findingKey('quantity_mismatch', ...keyParts),
            kind: 'quantity_mismatch',
            title: `${r.code}: «${p.name}» ${p.value} ${unit}, в расчёте ${obj.quantity} ${unit}`,
            detail: null,
            confidence: 'high',
            action: 'Сверить количество требования и объём расчёта',
          }),
        );
      }
    }
  }
  // Дубли позиций и нулевые объёмы — по закреплённой ревизии расчёта.
  const groups = new Map<string, IReviewPosition[]>();
  for (const p of input.positions) {
    if (p.isSection || !p.name.trim()) continue;
    const key = [normalizeMatchText(p.name), normalizeUnit(p.unit) ?? '', normalizeMatchText(p.section ?? '')].join('|');
    groups.set(key, [...(groups.get(key) ?? []), p]);
    if (p.volume !== null && p.volume <= 0 && (p.total ?? 0) > 0) {
      findings.push(
        draft({
          key: findingKey('quantity_mismatch', 'volume', p.externalPositionId),
          kind: 'quantity_mismatch',
          title: `Позиция «${p.name}»: объём ${p.volume} при ненулевой сумме`,
          detail: null,
          confidence: 'high',
          action: 'Проверить объём позиции',
          suggestedSide: null,
          evidence: [{ side: 'right', objectType: 'calculation_object', calculationRevisionId: input.calculationRevisionId!, externalPositionId: p.externalPositionId, externalItemId: null }],
        }),
      );
    }
  }
  let duplicates = 0;
  for (const [key, ps] of groups) {
    if (ps.length < 2) continue;
    duplicates += 1;
    findings.push(
      draft({
        key: findingKey('duplicate_position', key),
        kind: 'duplicate_position',
        title: `Позиция «${ps[0]!.name}» повторяется ${ps.length} раза в одном разделе`,
        detail: null,
        confidence: 'high',
        action: 'Проверить, не учтена ли работа дважды',
        suggestedSide: null,
        evidence: ps.map((p) => ({ side: 'right' as const, objectType: 'calculation_object' as const, calculationRevisionId: input.calculationRevisionId!, externalPositionId: p.externalPositionId, externalItemId: null })),
      }),
    );
  }
  const counts = { checked, positions: input.positions.length, duplicates, findings: findings.length };
  if (!input.calculationRevisionId && checked === 0) return { result: { check: 'quantities', outcome: 'not_applicable', reason: 'нет ревизии расчёта и количественных параметров', counts }, findings };
  const total = checked + input.positions.length;
  return { result: { check: 'quantities', outcome: outcomeOf(findings.length, 0, total), reason: total === 0 ? 'нет количественных параметров и позиций расчёта' : null, counts }, findings };
};

// ---------------------------------------------------------------- C05 Единицы

export const checkUnits = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  let compared = 0;
  let explained = 0;
  for (const r of input.requirements) {
    if (!confirmedCoverage(r)) continue;
    for (const o of calcObjects(r)) {
      if (o.unitStatus === 'match' || o.unitStatus === 'mismatch') compared += 1;
      if (o.unitStatus !== 'mismatch') continue;
      if (r.coverage!.unitMismatchReason) {
        explained += 1;
        continue;
      }
      findings.push(
        draft({
          key: findingKey('unit_mismatch', r.requirementId, o.externalPositionId!, o.externalItemId ?? ''),
          kind: 'unit_mismatch',
          title: `${r.code}: единица требования не совпадает с единицей расчёта`,
          detail: null,
          confidence: 'high',
          action: 'Пояснить или исправить единицу',
          suggestedSide: null,
          evidence: [...basisEvidence('left', r.supports), calcEvidence('right', o), requirementContext(r)],
        }),
      );
    }
  }
  const counts = { compared, explained, findings: findings.length };
  return { result: { check: 'units', outcome: outcomeOf(findings.length, 0, compared), reason: compared === 0 ? 'нет сравнимых единиц в покрытии' : null, counts }, findings };
};

// ---------------------------------------------------------------- C07 Договорные обязательства

const COVERAGE_STATE_TITLES: Record<string, string> = {
  uncovered: 'не покрыто',
  partial: 'покрыто частично',
  not_applicable: 'не применимо',
  needs_review: 'требует пересмотра',
};

export const checkObligations = (input: IReviewInput): { result: ICheckResult; findings: IFindingDraft[] } => {
  const findings: IFindingDraft[] = [];
  const contract = input.requirements.filter((r) => r.fromContract);
  for (const r of contract) {
    if (r.coverage?.state === 'covered') continue;
    const state = r.coverage ? (COVERAGE_STATE_TITLES[r.coverage.state] ?? r.coverage.state) : 'не оценено';
    // A02: вопрос инженеру и руководителю со ссылками на договор и расчёт, без юридического вывода.
    findings.push(
      draft({
        key: findingKey('contract_obligation', r.requirementId),
        kind: 'contract_obligation',
        title: `${r.code}: обязательство по договору — в расчёте «${state}»`,
        detail: r.coverage?.reason ? `Оценка покрытия: ${r.coverage.reason}` : null,
        confidence: 'high',
        action: 'Вопрос инженеру и руководителю: как обязательство договора отражено в расчёте',
        suggestedSide: null,
        evidence: [...basisEvidence('left', r.supports.filter((b) => b.sourceKind === 'contract')), ...calcObjects(r).map((o) => calcEvidence('right', o)), requirementContext(r)],
      }),
    );
  }
  const counts = { contractRequirements: contract.length, findings: findings.length };
  return { result: { check: 'obligations', outcome: outcomeOf(findings.length, 0, contract.length), reason: contract.length === 0 ? 'нет подтверждённых требований с основанием из договора' : null, counts }, findings };
};
