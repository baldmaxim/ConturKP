import { z } from 'zod';
const iso = z.iso.datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(1000).refine((p) =>
  !/^[\\/]|^[a-z]:|[:\x00-\x1f]/i.test(p) && !p.replaceAll('\\','/').split('/').includes('..'), 'недопустимый путь');
export const HistoryImportRequest = z.object({
  confirmBinding: z.literal(true),
  manifest: z.object({
    schema: z.literal('tender-history/1'), externalFolderId: z.string().min(1).max(200),
    folderName: relative, observedAt: iso, observationStartedAt: iso,
    complete: z.boolean(), sourceSha256: sha,
    records: z.array(z.object({
      key: z.string().min(1).max(1000), kind: z.string().min(1).max(64),
      title: z.string().max(2000), detail: z.string().max(100_000), occurredAt: iso.nullable(),
      sourcePath: relative.nullable(), sourceLabel: z.string().max(200),
      payloadSha256: sha, restricted: z.boolean(), technical: z.boolean(),
    }).strict()).max(20_000),
    files: z.array(z.object({
      path: relative, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sha256: sha.nullable(), modifiedAt: iso.nullable(), verifiedAt: iso.nullable(),
      status: z.string().min(1).max(64), technical: z.boolean(),
    }).strict()).max(50_000),
  }).strict().refine((m) => m.observationStartedAt <= m.observedAt, 'некорректный интервал'),
}).strict();
export const HistoryQuery = z.object({
  scope:z.enum(['all','common','tenders']).default('all'),
  cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(40),
  q: z.string().max(200).default(''), kind: z.string().max(64).default(''),
  technical: z.enum(['true','false']).default('false'),
  fileFacts: z.enum(['true','false']).default('true'),
});
export const HistoryTaskRequest = z.object({
  title: z.string().trim().min(1).max(2000), recordId: z.uuid().nullable().default(null),
  fileId: z.uuid().nullable().default(null), ownerUserId: z.uuid().nullable().default(null),
  dueAt: iso.nullable().default(null),
}).strict();
export const HistoryTaskPatch = z.object({
  status: z.enum(['open','in_progress','resolved']), ownerUserId: z.uuid().nullable(),
  dueAt: iso.nullable(), resolution: z.string().trim().max(10000).nullable(),
}).strict().refine((v) => v.status !== 'resolved' || !!v.resolution, 'укажите результат разбора');
