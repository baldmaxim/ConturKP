// Схемы запросов этапа 11 (D-031; docs/contracts/portal-api.md §2.8 в редакции этапа 11): шаблоны и ревизии,
// формулировки, приложения этапа, действия с полями, перенос, предложения модели. Схему полей проверяет ядро
// (validateSchema), значения — по схеме ревизии; права и область — сервер и вторая линия БД.
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const tags = z.array(z.string().trim().min(1).max(60)).max(20).default([]);

export const CreateTemplateRequest = z
  .object({
    ownerKind: z.enum(['company', 'customer']),
    tenderId: z.uuid().nullable().optional(),
    name: text(300),
    isDemo: z.boolean().default(false),
  })
  .strict()
  .refine((v) => (v.ownerKind === 'customer') === Boolean(v.tenderId), { message: 'шаблон заказчика — с тендером, шаблон компании — без тендера' });

export const CreateTemplateRevisionRequest = z
  .object({
    schema: z.unknown(),
    sample: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/u), name: text(300) }).strict().nullable().optional(),
    // Этап 12 (D-032 В-12-3): размеченная копия образца и аудитория файла; оригинал — `sample`.
    markedSample: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/u), name: text(300) }).strict().nullable().optional(),
    audience: z.enum(['customer', 'internal']).optional(),
  })
  .strict();

export const MarkupCheckRequest = z
  .object({
    schema: z.unknown(),
    markedSample: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
    tenderId: z.uuid().nullable().optional(),
  })
  .strict();

export const ApproveTemplateRevisionRequest = z
  .object({
    basisFragmentIds: z.array(z.uuid()).max(20).default([]),
    basisDecisionId: z.uuid().nullable().optional(),
    basisNote: text(2000).nullable().optional(),
  })
  .strict();

export const CreateWordingRequest = z
  .object({
    scopeTenderId: z.uuid().nullable().optional(),
    title: text(300),
    text: z.string().min(1).max(100_000),
    tags,
  })
  .strict();

export const AddWordingVersionRequest = z.object({ text: z.string().min(1).max(100_000), tags }).strict();

export const DecideWordingRequest = z.object({ status: z.enum(['approved', 'retired']) }).strict();

export const WordingsQuery = z.object({
  tenderId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(60).optional(),
  status: z.enum(['proposed', 'approved', 'retired']).optional(),
});

export const CreateDraftRequest = z.object({ templateRevisionId: z.uuid(), title: text(300).optional() }).strict();

const basis = z.object({ type: z.enum(['fragment', 'decision', 'requirement_revision']), id: z.uuid() }).strict();

// Действие с полем (D-031 В-11-4…В-11-6): ввод, выбор формулировки, принятие предложения системы из факта,
// повторное подтверждение (устаревшее, перенесённое), обсуждение, очистка. Предложение модели — отдельным маршрутом.
export const FieldActionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), value: z.unknown(), bases: z.array(basis).max(20).default([]) }).strict(),
  z.object({ action: z.literal('choose_wording'), wordingVersionId: z.uuid() }).strict(),
  z.object({ action: z.literal('accept_fact'), evidenceFactId: z.uuid() }).strict(),
  z.object({ action: z.literal('confirm') }).strict(),
  z
    .object({
      action: z.literal('discuss'),
      comment: text(4000),
      responsibleUserId: z.uuid().nullable().optional(),
      createQuestion: z.boolean().default(false),
      questionText: text(4000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('clear') }).strict(),
]);

export const MigrateDraftRequest = z.object({ templateRevisionId: z.uuid().optional() }).strict();

export const StartFieldSuggestionRunRequest = z.object({ fieldKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(200).nullable().optional() }).strict();

export const DecideFieldSuggestionRequest = z.object({ reason: text(2000).optional() }).strict();
