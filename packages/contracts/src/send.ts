// Контракты этапа 15 (D-035; portal-api §2.10): регистрация отправки и нарушения, принятие лишних вложений, сравнение
// выпусков и причины выводов.
import { z } from 'zod';

const ISO_UTC = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(3).max(2000);

export const SEND_CHANNEL = z.enum(['email', 'customer_portal', 'paper', 'other']);

const SendEvidence = z.discriminatedUnion('kind', [
  // Письмо из почты портала: канал — почта, время и адресаты — из письма.
  z.object({ kind: z.literal('mail_message'), mailMessageRevisionId: z.uuid() }).strict(),
  // Собственная загрузка файла-основания для этого выпуска.
  z.object({ kind: z.literal('uploaded_file'), uploadId: z.uuid() }).strict(),
  z.object({ kind: z.literal('manual_note') }).strict(),
]);

export const RegisterSendRequest = z
  .object({
    evidence: SendEvidence,
    channel: SEND_CHANNEL.optional(),
    sentAt: ISO_UTC.optional(),
    recipients: z.array(z.string().trim().min(1).max(320)).max(50).default([]),
    note: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.evidence.kind === 'mail_message' || (v.channel !== undefined && v.sentAt !== undefined), { message: 'ручная регистрация: укажите канал и время отправки' })
  .refine((v) => v.evidence.kind !== 'mail_message' || (v.sentAt === undefined && v.recipients.length === 0 && !v.note && (v.channel ?? 'email') === 'email'), {
    message: 'у письма-основания канал, время и адресаты берутся из письма; пояснение не принимается',
  })
  .refine((v) => v.evidence.kind !== 'manual_note' || (v.note ?? '').length >= 10, { message: 'пояснение — не короче 10 знаков' });

export const AcceptSendExtrasRequest = z.object({ reason }).strict();

export const RegisterIncidentRequest = z
  .object({
    kind: z.enum(['test_release_sent_externally', 'sent_despite_blocker', 'other']),
    occurredAt: ISO_UTC,
    description: z.string().trim().min(10).max(4000),
    mailMessageRevisionId: z.uuid().nullable().optional(),
    uploadId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.mailMessageRevisionId && v.uploadId), { message: 'основание — письмо или файл, не оба' });

export const CreateReleaseComparisonRequest = z
  .object({
    leftReleaseId: z.uuid(),
    rightReleaseId: z.uuid(),
  })
  .strict()
  .refine((v) => v.leftReleaseId.toLowerCase() !== v.rightReleaseId.toLowerCase(), { message: 'сравниваются два разных выпуска' });

export const COMPARE_SECTION = z.enum(['sources', 'requirements', 'questions', 'terms', 'decisions', 'applications', 'received']);

export const ReleaseComparisonItemsQuery = z
  .object({
    section: COMPARE_SECTION.optional(),
    after: z.coerce.number().int().min(0).max(10_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const ReleaseReasonRequest = z
  .object({
    reasonKind: z.enum(['document', 'answer', 'supplier', 'internal_decision', 'unknown']),
    reasonStatus: z.enum(['unknown', 'hypothesis', 'confirmed']),
    rationale: z.string().trim().min(1).max(4000).nullable().optional(),
    fragmentIds: z.array(z.uuid()).max(20).default([]),
    decisionIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict()
  .refine((v) => (v.reasonKind === 'unknown') === (v.reasonStatus === 'unknown'), { message: '«не установлена» — и вид, и статус' })
  .refine((v) => v.reasonStatus === 'unknown' || !!v.rationale, { message: 'у причины нужно пояснение' })
  .refine((v) => v.reasonStatus !== 'unknown' || (v.fragmentIds.length === 0 && v.decisionIds.length === 0), { message: 'у «не установлена» оснований нет' })
  .refine((v) => v.reasonStatus !== 'confirmed' || v.fragmentIds.length + v.decisionIds.length > 0, { message: 'подтверждённая причина — с основанием' });
