// Проекции этапа 08 (Р-08-5, OD-08-4, R08-02): формулировка, параметры, обоснование, значение, пояснения и
// сведения о конфликте показываются целиком, только если объект видим по замыканию закрытости
// (requirementTaint.ts: все основания любой роли с наследованием читаются); иначе — безопасная оболочка: ID, код,
// статус, служебные данные, число оснований по ролям и признаки закрытого основания, конфликта и несовпадения
// единиц. Текст закрытого основания не выдаётся никогда; цитата — только по правам источника (GET /evidence/{id}).
import type {
  IAnalysisRunRow,
  IAssumptionRow,
  ICoverageRow,
  ICustomerQuestionRow,
  IEvidenceLinkRow,
  IFactCandidateRow,
  IFactRow,
  IRequirementCandidateRow,
  IRequirementDecisionRow,
  IRequirementRegistryRow,
  IRequirementRevisionRow,
  IRequirementRow,
  IStageNoteRow,
} from '@kontur/db';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const toEvidenceLinks = (links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>) =>
  links.map((l) => {
    const open = readable.has(l.fragment_id);
    return {
      fragmentId: l.fragment_id,
      role: l.role,
      sourceKind: l.source_unit_type,
      restricted: !open,
      origin: open ? l.origin : null,
      pageIndex: open ? l.page_index : null,
      text: open ? l.text : null,
    };
  });

const roleCounts = (links: readonly IEvidenceLinkRow[]): Record<string, number> =>
  links.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.role]: (acc[l.role] ?? 0) + 1 }), {});

// Конфликт параметров (R08-01): коды требований — служебные данные; имя параметра — производный текст обоих
// требований, поэтому только если видимы оба.
export const toConflicts = (
  conflicts: readonly { requirementId: string; code: string; parameter: string }[],
  visible: boolean,
  isVisible: (requirementId: string) => boolean,
) => conflicts.map((c) => ({ requirementId: c.requirementId, code: c.code, parameter: visible && isVisible(c.requirementId) ? c.parameter : null }));

type ConflictView = ReturnType<typeof toConflicts>;

export const toRegistry = (r: IRequirementRegistryRow) => ({
  id: r.id,
  stageId: r.stage_id,
  tenderId: r.tender_id,
  seq: r.seq,
  evidenceScopeId: r.evidence_scope_id,
  scopeHash: r.scope_hash,
  scopeCreatedAt: iso(r.scope_created_at),
  previousRegistryId: r.previous_registry_id,
  reason: r.reason,
  active: r.active,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});

export const toAnalysisRun = (r: IAnalysisRunRow, resultVisible: boolean) => ({
  id: r.id,
  registryId: r.registry_id,
  evidenceScopeId: r.evidence_scope_id,
  task: r.task,
  status: r.status,
  failureCode: r.failure_code,
  providerId: r.provider_id,
  modelId: r.model_id,
  modelVersion: r.model_version,
  promptVersion: r.prompt_version,
  promptSha256: r.prompt_sha256,
  inferenceConfig: r.inference_config,
  configSha256: r.config_sha256,
  outputSchemaVersion: r.output_schema_version,
  inputSha256: r.input_sha256,
  inputCount: r.input_count,
  attempt: r.attempt,
  coverage: r.coverage,
  // Сырой ответ модели — производный текст входа: только если все фрагменты входа читаются (Р-08-5).
  resultVisible,
  result: resultVisible ? r.result : null,
  requestedBy: r.requested_by,
  createdAt: iso(r.created_at),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
});

export const toRequirementCandidate = (c: IRequirementCandidateRow, links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>, visible: boolean, conflicts: ConflictView) => {
  const v = { full: visible };
  return {
    id: c.id,
    kind: 'requirement' as const,
    registryId: c.registry_id,
    registryActive: c.registry_active,
    origin: c.origin,
    analysisRunId: c.analysis_run_id,
    targetRequirementId: c.target_requirement_id,
    targetCode: c.target_code,
    rebasedFromCandidateId: c.rebased_from_candidate_id,
    carriedFromRevisionId: c.carried_from_revision_id,
    derivedFromCandidateId: c.derived_from_candidate_id,
    status: c.status,
    statusReason: v.full ? c.status_reason : null,
    decidedBy: c.decided_by,
    decidedAt: iso(c.decided_at),
    createdBy: c.created_by,
    createdAt: iso(c.created_at),
    rowVersion: c.row_version,
    requirementId: c.requirement_id,
    visible: v.full,
    restricted: !v.full,
    evidenceCounts: roleCounts(links),
    contradicted: c.contradicted,
    conflicts,
    statement: v.full ? c.statement : null,
    parameters: v.full ? c.parameters : null,
    objectScope: v.full ? c.object_scope : null,
    rationale: v.full ? c.rationale : null,
    confidence: v.full && c.confidence !== null ? Number(c.confidence) : null,
    evidence: toEvidenceLinks(links, readable),
  };
};

export const toFactCandidate = (c: IFactCandidateRow, links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>, visible: boolean) => {
  const v = { full: visible };
  return {
    id: c.id,
    kind: 'fact' as const,
    registryId: c.registry_id,
    registryActive: c.registry_active,
    factKind: c.fact_kind,
    factKindTitle: c.fact_kind_title,
    origin: c.origin,
    analysisRunId: c.analysis_run_id,
    targetFactId: c.target_fact_id,
    rebasedFromCandidateId: c.rebased_from_candidate_id,
    carriedFromRevisionId: c.carried_from_revision_id,
    derivedFromCandidateId: c.derived_from_candidate_id,
    status: c.status,
    statusReason: v.full ? c.status_reason : null,
    decidedBy: c.decided_by,
    decidedAt: iso(c.decided_at),
    createdBy: c.created_by,
    createdAt: iso(c.created_at),
    rowVersion: c.row_version,
    factId: c.fact_id,
    visible: v.full,
    restricted: !v.full,
    evidenceCounts: roleCounts(links),
    displayValue: v.full ? c.display_value : null,
    normalizedValue: v.full ? c.normalized_value : null,
    unit: v.full ? c.unit : null,
    rationale: v.full ? c.rationale : null,
    confidence: v.full && c.confidence !== null ? Number(c.confidence) : null,
    evidence: toEvidenceLinks(links, readable),
  };
};

export const toCoverage = (c: ICoverageRow, visible: boolean) => ({
  id: c.id,
  seq: c.seq,
  state: c.state,
  origin: c.origin,
  reason: visible ? c.reason : null,
  assessedBy: c.assessed_by,
  triggerCalculationRevisionId: c.trigger_calculation_revision_id,
  createdAt: iso(c.created_at),
  visible,
  // R08-01: несовпадение единиц — признак состояния, виден всегда; пояснение и единицы — производные поля.
  unitMismatch: c.objects.some((o) => o.unit_status === 'mismatch'),
  unitMismatchReason: visible ? c.unit_mismatch_reason : null,
  objects: visible
    ? c.objects.map((o) => ({
        id: o.id,
        type: o.object_type,
        fragmentId: o.fragment_id,
        calculationRevisionId: o.calculation_revision_id,
        calculationRevisionSeq: o.calculation_revision_seq,
        calculationRevisionKind: o.calculation_revision_kind,
        externalPositionId: o.external_position_id,
        externalItemId: o.external_item_id,
        positionName: o.position_name,
        positionNumber: o.position_number,
        match: o.match,
        decisionId: o.decision_id,
        note: o.note,
        requirementUnits: o.requirement_units,
        calculationUnit: o.calculation_unit,
        unitStatus: o.unit_status,
      }))
    : [],
  objectCount: c.objects.length,
});

export const toRequirementRevision = (r: IRequirementRevisionRow, links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>, visible: boolean) => {
  const v = { full: visible };
  return {
    id: r.id,
    seq: r.seq,
    registryId: r.registry_id,
    registrySeq: r.registry_seq,
    status: r.status,
    changeKind: r.change_kind,
    candidateId: r.candidate_id,
    carriedFromRevisionId: r.carried_from_revision_id,
    supersededByRequirementId: r.superseded_by_requirement_id,
    supersededByCode: r.superseded_by_code,
    authoredBy: r.authored_by,
    confirmedBy: r.confirmed_by,
    createdAt: iso(r.created_at),
    visible: v.full,
    restricted: !v.full,
    evidenceCounts: roleCounts(links),
    statement: v.full ? r.statement : null,
    parameters: v.full ? r.parameters : null,
    objectScope: v.full ? r.object_scope : null,
    reason: v.full ? r.reason : null,
    conflictNote: v.full ? r.conflict_note : null,
    evidence: toEvidenceLinks(links, readable),
  };
};

export const toRequirement = (q: IRequirementRow, links: readonly IEvidenceLinkRow[], visible: boolean, conflicts: ConflictView) => {
  const v = { full: visible };
  return {
    id: q.id,
    code: q.code,
    stageId: q.stage_id,
    registryId: q.registry_id,
    registryActive: q.registry_active,
    currentRevisionId: q.current_revision_id,
    seq: q.seq,
    status: q.status,
    changeKind: q.change_kind,
    supersededByRequirementId: q.superseded_by_requirement_id,
    supersededByCode: q.superseded_by_code,
    coverageState: q.coverage_state,
    coverageUnitMismatch: q.coverage_unit_mismatch,
    contradicted: q.contradicted,
    conflicts,
    conflictNote: v.full ? q.conflict_note : null,
    rowVersion: q.row_version,
    createdAt: iso(q.created_at),
    revisionCreatedAt: iso(q.revision_created_at),
    authoredBy: q.authored_by,
    confirmedBy: q.confirmed_by,
    visible: v.full,
    restricted: !v.full,
    evidenceCounts: roleCounts(links),
    statement: v.full ? q.statement : null,
    parameters: v.full ? q.parameters : null,
    objectScope: v.full ? q.object_scope : null,
  };
};

export const toFact = (f: IFactRow, links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>, visible: boolean) => {
  const v = { full: visible };
  return {
    id: f.id,
    factKind: f.fact_kind,
    factKindTitle: f.fact_kind_title,
    stageId: f.stage_id,
    registryId: f.registry_id,
    registryActive: f.registry_active,
    currentRevisionId: f.current_revision_id,
    seq: f.seq,
    status: f.status,
    changeKind: f.change_kind,
    supersededByFactId: f.superseded_by_fact_id,
    rowVersion: f.row_version,
    createdAt: iso(f.created_at),
    revisionCreatedAt: iso(f.revision_created_at),
    authoredBy: f.authored_by,
    confirmedBy: f.confirmed_by,
    visible: v.full,
    restricted: !v.full,
    evidenceCounts: roleCounts(links),
    displayValue: v.full ? f.display_value : null,
    normalizedValue: v.full ? f.normalized_value : null,
    unit: v.full ? f.unit : null,
    evidence: toEvidenceLinks(links, readable),
  };
};

export const toDecision = (d: IRequirementDecisionRow, links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>, visible: boolean) => {
  const v = { full: visible };
  return {
    id: d.id,
    requirementId: d.subject_id,
    status: d.superseded_by ? ('superseded' as const) : ('active' as const),
    supersedesDecisionId: d.supersedes_decision_id,
    supersededBy: d.superseded_by,
    decidedBy: d.decided_by,
    decidedAt: iso(d.created_at),
    visible: v.full,
    restricted: !v.full,
    statement: v.full ? d.statement : null,
    rationale: v.full ? d.rationale : null,
    evidence: toEvidenceLinks(links, readable),
  };
};

export const toAssumption = (a: IAssumptionRow, links: readonly IEvidenceLinkRow[], readable: ReadonlySet<string>, visible: boolean) => {
  const v = { full: visible };
  return {
    id: a.id,
    stageId: a.stage_id,
    requirementId: a.requirement_id,
    requirementCode: a.requirement_code,
    currentRevisionId: a.current_revision_id,
    seq: a.seq,
    status: a.status,
    supersededByAssumptionId: a.superseded_by_assumption_id,
    authoredBy: a.authored_by,
    rowVersion: a.row_version,
    createdAt: iso(a.created_at),
    revisionCreatedAt: iso(a.revision_created_at),
    visible: v.full,
    restricted: !v.full,
    statement: v.full ? a.statement : null,
    reason: v.full ? a.reason : null,
    evidence: toEvidenceLinks(links, readable),
  };
};

// Вопрос, связанный с требованием, мог повторить его текст (R08-02): текст и пояснение — по видимости вопроса.
export const toCustomerQuestion = (q: ICustomerQuestionRow, visible: boolean) => ({
  id: q.id,
  stageId: q.stage_id,
  requirementId: q.requirement_id,
  requirementCode: q.requirement_code,
  visible,
  text: visible ? q.text : null,
  status: q.status,
  askedAt: iso(q.asked_at),
  answeredAt: iso(q.answered_at),
  answerQaItemRevisionId: q.answer_qa_item_revision_id,
  answerQaItemNo: q.answer_qa_item_no,
  answerNote: visible ? q.answer_note : null,
  responsibleUserId: q.responsible_user_id,
  createdBy: q.created_by,
  updatedBy: q.updated_by,
  createdAt: iso(q.created_at),
  updatedAt: iso(q.updated_at),
  rowVersion: q.row_version,
});

export const toStageNote = (n: IStageNoteRow) => ({
  id: n.id,
  stageId: n.stage_id,
  text: n.text,
  supersedesNoteId: n.supersedes_note_id,
  supersededBy: n.superseded_by,
  createdBy: n.created_by,
  createdAt: iso(n.created_at),
});
