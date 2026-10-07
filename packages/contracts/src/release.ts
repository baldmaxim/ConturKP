// Контракты этапа 12 (D-032; portal-api §2.9): сборка кандидата выпуска и библиотека стандартных вложений.
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const CreateCandidateRequest = z
  .object({
    mode: z.enum(['test', 'production']),
    draftIds: z.array(z.uuid()).max(50).default([]),
    attachmentRevisionIds: z.array(z.uuid()).max(50).default([]),
  })
  .strict();

export const CreateStandardAttachmentRequest = z
  .object({
    title: text(300),
    scopeTenderId: z.uuid().nullable().optional(),
  })
  .strict();

export const CreateStandardAttachmentRevisionRequest = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    fileName: text(300),
    audience: z.enum(['customer', 'internal']).default('customer'),
  })
  .strict();

export const CandidateArchiveQuery = z
  .object({
    set: z.enum(['customer', 'all']).default('customer'),
  })
  .strict();

// ---------------------------------------------------------------- Этап 13: согласование и выпуск (D-033; portal-api §2.9.2)

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const reason = z.string().trim().min(1).max(2000);

export const ApproveCandidateRequest = z
  .object({
    // Хэш содержимого, показанного руководителю (В-13-8): согласуется только оно.
    contentHash: sha256,
    comment: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict();

export const ReturnCandidateRequest = z.object({ reason }).strict();

export const RevokeApprovalRequest = z.object({ reason }).strict();

export const ReleaseCandidateRequest = z
  .object({
    approvalId: z.uuid(),
    contentHash: sha256,
  })
  .strict();

export const RiskAcceptanceRequest = z
  .object({
    // Любой код матрицы: неснимаемый — 409 risk_not_acceptable (не ошибка формы запроса).
    blockerCode: z.string().regex(/^[A-Z_]{3,40}$/u),
    subjectType: z.string().regex(/^[a-z_]{3,40}$/u),
    subjectId: z.uuid(),
    subjectKey: z.string().max(200).default(''),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();

export const ResolveHoldRequest = z
  .object({
    resolution: z.enum(['not_applicable', 'requires_new_candidate']),
    reason,
  })
  .strict();

export const ResolveHoldsRequest = z
  .object({
    holdIds: z.array(z.uuid()).min(1).max(200),
    resolution: z.enum(['not_applicable', 'requires_new_candidate']),
    reason,
  })
  .strict();

export const HoldsQuery = z
  .object({
    candidateId: z.uuid().optional(),
    status: z.enum(['open', 'resolved_not_applicable', 'resolved_requires_new_candidate']).optional(),
  })
  .strict();

export const ReleaseArchiveQuery = z
  .object({
    set: z.enum(['customer', 'all']).default('customer'),
  })
  .strict();
