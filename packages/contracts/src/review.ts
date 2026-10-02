// Схемы запросов этапа 09 (D-029; docs/contracts/portal-api.md §2.7 в редакции этапа 09): прогон проверки, замечания,
// разногласия и оси, гипотезы модели, приоритет источников. Права и область проверяет сервер и вторая линия БД.
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const SEVERITY = z.enum(['critical', 'major', 'minor']);
export const CONFIDENCE = z.enum(['low', 'medium', 'high']);

export const StartReviewRunRequest = z.object({}).strict();

const EvidenceSide = z.enum(['left', 'right', 'context']);
export const FindingEvidenceInput = z.union([
  z.object({ side: EvidenceSide, fragmentId: z.uuid() }).strict(),
  z.object({ side: EvidenceSide, calculationRevisionId: z.uuid(), externalPositionId: z.uuid(), externalItemId: z.uuid().nullable().optional() }).strict(),
]);

export const CreateFindingRequest = z
  .object({
    title: text(500),
    detail: nullableText(4000),
    severity: SEVERITY,
    confidence: CONFIDENCE,
    action: nullableText(1000),
    evidence: z.array(FindingEvidenceInput).min(1).max(20),
  })
  .strict();

// Переход человеком (state-machines §10): «решено» и «принять риск» — с формулировкой решения и причиной; «отклонено»
// — с причиной; «в работу» — с ответственным.
export const FindingTransitionRequest = z
  .object({
    to: z.enum(['in_progress', 'resolved', 'accepted_risk', 'rejected', 'open']),
    reason: nullableText(2000),
    statement: nullableText(4000),
    ownerUserId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((b) => !['resolved', 'accepted_risk', 'rejected'].includes(b.to) || !!b.reason, { message: 'переход требует причины' })
  .refine((b) => !['resolved', 'accepted_risk'].includes(b.to) || !!b.statement, { message: 'решение требует формулировки' });

export const PatchFindingRequest = z
  .object({
    severity: SEVERITY.optional(),
    confidence: CONFIDENCE.optional(),
    ownerUserId: z.uuid().nullable().optional(),
    action: nullableText(1000),
    impact: nullableText(1000),
    reason: nullableText(2000),
  })
  .strict()
  .refine((b) => b.severity !== undefined || b.confidence !== undefined || b.ownerUserId !== undefined || b.action !== undefined || b.impact !== undefined, {
    message: 'нечего менять',
  });

export const CreateDiscrepancyRequest = z.object({ topic: text(300) }).strict();

export const AxisBasisInput = z
  .object({ type: z.enum(['fragment', 'qa_item_revision', 'mail_message_revision', 'document_revision', 'decision']), id: z.uuid() })
  .strict();

export const AxisEventRequest = z
  .object({
    axis: z.enum(['customer_position', 'calculation', 'proposal', 'documents']),
    value: text(60),
    reason: text(2000),
    bases: z.array(AxisBasisInput).max(20).default([]),
  })
  .strict();

// Решение по разногласию; если обе стороны замечания — факты D-018, решение пишет и ребро графа (D-029 В-09-2):
// `prevailingFactId` — какое значение действует, либо `distinct` — значения не конфликтуют.
export const DiscrepancyDecisionRequest = z
  .object({
    statement: text(4000),
    rationale: text(4000),
    graph: z
      .union([z.object({ kind: z.literal('prevails'), prevailingFactId: z.uuid() }).strict(), z.object({ kind: z.literal('distinct') }).strict()])
      .nullable()
      .optional(),
  })
  .strict();

export const AcceptSuggestionRequest = z.object({ severity: z.enum(['major', 'minor', 'critical']), reason: nullableText(2000) }).strict();
export const RejectSuggestionRequest = z.object({ reason: text(2000) }).strict();

export const SourcePriorityRequest = z
  .object({ kinds: z.array(z.enum(['contract', 'tz', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'])).length(8), reason: text(1000) })
  .strict()
  .refine((b) => new Set(b.kinds).size === 8, { message: 'каждый вид источника — ровно один раз' });
