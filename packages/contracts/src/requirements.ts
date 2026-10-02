// Схемы запросов этапа 08 (D-026; docs/contracts/portal-api.md §2.7 в редакции этапа 08): реестр, прогоны
// анализа, кандидаты требований и фактов, подтверждение, замена, покрытие, решения, допущения, вопросы
// заказчику, пометки этапа и отметки полноты. Права и область проверяет сервер и вторая линия БД.
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const ISO_UTC = z.iso.datetime({ offset: true });

export const EVIDENCE_ROLE = z.enum(['supports', 'contradicts', 'clarifies', 'supersedes_context']);
export const EvidenceRefSchema = z.object({ fragmentId: z.uuid(), role: EVIDENCE_ROLE }).strict();
// Хотя бы одно содержательное основание (supports): без него кандидат не создаётся.
const EvidenceWithSupports = z
  .array(EvidenceRefSchema)
  .min(1)
  .max(50)
  .refine((a) => a.some((e) => e.role === 'supports'), 'нужно хотя бы одно основание supports');

export const ParameterSchema = z.object({ name: text(200), value: text(500), unit: nullableText(40) }).strict();
export const ObjectScopeSchema = z
  .object({ object: nullableText(200), section: nullableText(200), floor: nullableText(200), room: nullableText(200) })
  .strict();

export const CreateRequirementRegistryRequest = z.object({ evidenceScopeId: z.uuid(), reason: text(1000) }).strict();
// `method`: `model` — генеративная модель (этап 08); `rules` — кандидаты требований из фактов графа D-018 (D-028, этап 08a).
export const StartAnalysisRunRequest = z
  .object({ task: z.enum(['requirement_extraction', 'fact_extraction']), method: z.enum(['model', 'rules']).optional() })
  .strict()
  .refine((b) => b.method !== 'rules' || b.task === 'requirement_extraction', { message: 'правила дают только кандидатов требований' });

export const CreateRequirementCandidateRequest = z
  .object({
    statement: text(4000),
    parameters: z.array(ParameterSchema).max(20).default([]),
    objectScope: ObjectScopeSchema.default({}),
    rationale: nullableText(4000),
    evidence: EvidenceWithSupports,
    targetRequirementId: z.uuid().nullable().optional(),
    derivedFromCandidateId: z.uuid().nullable().optional(),
  })
  .strict();

export const ConfirmRequirementCandidateRequest = z
  .object({
    statement: text(4000).optional(),
    parameters: z.array(ParameterSchema).max(20).optional(),
    objectScope: ObjectScopeSchema.optional(),
    // R08-01: пояснение при конфликте с действующим требованием или противоречащем основании.
    conflictNote: nullableText(1000),
  })
  .strict();

export const RejectCandidateRequest = z.object({ reason: text(1000) }).strict();

export const CreateFactCandidateRequest = z
  .object({
    factKind: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/u),
    displayValue: text(1000),
    normalizedValue: z.record(z.string(), z.unknown()),
    unit: nullableText(40),
    rationale: nullableText(4000),
    evidence: EvidenceWithSupports,
    targetFactId: z.uuid().nullable().optional(),
    derivedFromCandidateId: z.uuid().nullable().optional(),
  })
  .strict();

export const ConfirmFactCandidateRequest = z
  .object({ displayValue: text(1000).optional(), normalizedValue: z.record(z.string(), z.unknown()).optional(), unit: nullableText(40) })
  .strict();

export const SupersedeRequest = z.object({ replacementId: z.uuid(), reason: text(1000) }).strict();

const CoverageObject = z.discriminatedUnion('type', [
  z.object({ type: z.literal('evidence_fragment'), fragmentId: z.uuid() }).strict(),
  z
    .object({
      type: z.literal('calculation_revision'),
      calculationRevisionId: z.uuid(),
      externalPositionId: z.uuid().nullable().optional(),
      externalItemId: z.uuid().nullable().optional(),
      match: z.enum(['explicit_line', 'complex_rate']).nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal('decision'), decisionId: z.uuid() }).strict(),
  z.object({ type: z.literal('manual_confirmation'), note: text(2000) }).strict(),
]);

export const RecordCoverageRequest = z
  .object({
    state: z.enum(['uncovered', 'partial', 'covered', 'not_applicable', 'needs_review']),
    reason: nullableText(2000),
    // R08-01: пояснение к несовпадению единиц требования и строки расчёта.
    unitMismatchReason: nullableText(1000),
    objects: z.array(CoverageObject).max(50).default([]),
  })
  .strict();

export const RecordDecisionRequest = z
  .object({
    statement: text(4000),
    rationale: text(4000),
    supersedesDecisionId: z.uuid().nullable().optional(),
    evidence: z.array(EvidenceRefSchema).max(50).default([]),
  })
  .strict();

export const CreateAssumptionRequest = z
  .object({ statement: text(4000), requirementId: z.uuid().nullable().optional(), evidence: z.array(EvidenceRefSchema).max(50).default([]) })
  .strict();

export const ReviseAssumptionRequest = z
  .object({
    statement: text(4000).optional(),
    status: z.enum(['open', 'confirmed', 'rejected', 'superseded']),
    reason: nullableText(1000),
    supersededByAssumptionId: z.uuid().nullable().optional(),
  })
  .strict();

export const CreateCustomerQuestionRequest = z
  .object({ text: text(4000), requirementId: z.uuid().nullable().optional(), responsibleUserId: z.uuid().nullable().optional() })
  .strict();

export const UpdateCustomerQuestionRequest = z
  .object({
    text: text(4000).optional(),
    requirementId: z.uuid().nullable().optional(),
    status: z.enum(['draft', 'sent', 'answered', 'closed']).optional(),
    askedAt: ISO_UTC.nullable().optional(),
    answeredAt: ISO_UTC.nullable().optional(),
    answerQaItemRevisionId: z.uuid().nullable().optional(),
    answerNote: nullableText(4000),
    responsibleUserId: z.uuid().nullable().optional(),
  })
  .strict();

export const CreateStageNoteRequest = z.object({ text: text(4000), supersedesNoteId: z.uuid().nullable().optional() }).strict();

const MarkSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fragments'), fragmentIds: z.array(z.uuid()).min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('page'), documentRevisionId: z.uuid(), pageIndex: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('document_revision'), documentRevisionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('mail_message_revision'), mailMessageRevisionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('qa_item_revision'), qaItemRevisionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('transcript_revision'), transcriptRevisionId: z.uuid() }).strict(),
]);

export const MarkFragmentsRequest = z
  .object({ mark: z.enum(['not_requirement', 'cleared']), reason: nullableText(1000), selector: MarkSelector })
  .strict()
  .refine((b) => b.mark !== 'not_requirement' || !!b.reason, { message: '«не требование» — с причиной', path: ['reason'] });
