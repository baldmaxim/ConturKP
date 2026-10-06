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
