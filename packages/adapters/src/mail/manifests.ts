// Файловые manifest вопросов–ответов и переговоров (этап 07, D-025: OD-07-6, Q-06). Формат портала,
// версионирован: kontur.qa.v1 и kontur.negotiation.v1. Сервис переговоров не подключён (Q-06 —
// BLOCKED_EXTERNAL), поэтому manifest — штатный путь; неизвестная версия формата — отказ.
import { z } from 'zod';

const iso = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

export const QA_FORMAT = 'kontur.qa.v1';
export const NEGOTIATION_FORMAT = 'kontur.negotiation.v1';

const QaItemSchema = z
  .object({
    no: text(50),
    question: text(100_000),
    answer: z.string().trim().min(1).max(100_000).nullable().default(null),
    status: z.enum(['open', 'answered', 'withdrawn']),
    askedAt: iso.nullable().default(null),
    answeredAt: iso.nullable().default(null),
    externalRef: text(200).nullable().default(null),
  })
  .strict()
  .refine((i) => (i.status === 'answered') === (i.answer !== null), { message: 'ответ есть ровно у вопроса со статусом answered' })
  .refine((i) => i.answeredAt === null || i.status === 'answered', { message: 'дата ответа — только у отвеченного вопроса' });

const QaThreadSchema = z
  .object({
    externalRef: text(200),
    title: text(500).nullable().default(null),
    items: z.array(QaItemSchema).min(1).max(5000),
  })
  .strict()
  .refine((t) => new Set(t.items.map((i) => i.no)).size === t.items.length, { message: 'номера вопросов в треде повторяются' });

export const QaManifestSchema = z
  .object({
    format: z.literal(QA_FORMAT),
    threads: z.array(QaThreadSchema).min(1).max(200),
  })
  .strict()
  .refine((m) => new Set(m.threads.map((t) => t.externalRef)).size === m.threads.length, { message: 'внешние ссылки тредов повторяются' });

export type IQaManifest = z.infer<typeof QaManifestSchema>;

const SegmentSchema = z
  .object({
    no: z.number().int().min(1),
    speakerLabel: text(100),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    kind: z.enum(['speech', 'hint']),
    text: text(100_000),
  })
  .strict()
  .refine((s) => s.endMs >= s.startMs, { message: 'конец сегмента раньше начала' });

export const NegotiationManifestSchema = z
  .object({
    format: z.literal(NEGOTIATION_FORMAT),
    session: z
      .object({
        externalId: text(200),
        title: text(500).nullable().default(null),
        startedAt: iso,
        audio: z
          .object({ ref: text(2000), sha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable().default(null) })
          .strict()
          .nullable()
          .default(null),
      })
      .strict(),
    participants: z
      .array(z.object({ speakerLabel: text(100), name: text(200).nullable().default(null), side: z.enum(['customer', 'contractor', 'unknown']) }).strict())
      .max(200),
    transcript: z
      .object({
        revision: text(50),
        segments: z.array(SegmentSchema).min(1).max(50_000),
      })
      .strict(),
  })
  .strict()
  .refine((m) => new Set(m.participants.map((p) => p.speakerLabel)).size === m.participants.length, { message: 'метки говорящих повторяются' })
  .refine((m) => new Set(m.transcript.segments.map((s) => s.no)).size === m.transcript.segments.length, { message: 'номера сегментов повторяются' })
  .refine((m) => m.transcript.segments.every((s) => m.participants.some((p) => p.speakerLabel === s.speakerLabel)), {
    message: 'у сегмента неизвестный говорящий',
  });

export type INegotiationManifest = z.infer<typeof NegotiationManifestSchema>;

export class ManifestError extends Error {
  readonly code: 'manifest_invalid' | 'format_unsupported';
  constructor(code: 'manifest_invalid' | 'format_unsupported', message: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

const parseJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch (err) {
    throw new ManifestError('manifest_invalid', `manifest не JSON: ${(err as Error).message.slice(0, 200)}`);
  }
};

const formatOf = (value: unknown): string | null =>
  value && typeof value === 'object' && typeof (value as { format?: unknown }).format === 'string' ? (value as { format: string }).format : null;

const issues = (err: z.ZodError): string =>
  err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '—'}: ${i.message}`)
    .join('; ');

export const parseQaManifest = (bytes: Buffer): IQaManifest => {
  const value = parseJson(bytes);
  if (formatOf(value) !== QA_FORMAT) throw new ManifestError('format_unsupported', `ожидается формат ${QA_FORMAT}`);
  const r = QaManifestSchema.safeParse(value);
  if (!r.success) throw new ManifestError('manifest_invalid', issues(r.error));
  return r.data;
};

export const parseNegotiationManifest = (bytes: Buffer): INegotiationManifest => {
  const value = parseJson(bytes);
  if (formatOf(value) !== NEGOTIATION_FORMAT) throw new ManifestError('format_unsupported', `ожидается формат ${NEGOTIATION_FORMAT}`);
  const r = NegotiationManifestSchema.safeParse(value);
  if (!r.success) throw new ManifestError('manifest_invalid', issues(r.error));
  return r.data;
};
