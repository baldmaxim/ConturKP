// Контракты этапа 14 (D-034; portal-api §2.10): назначения размещения и доставки выпуска.
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(3).max(2000);
// Абсолютный путь проверяет сервер (проект §6): UNC, буква диска или /…
const rootPath = z.string().trim().min(2).max(400);

export const DELIVERY_KIND = z.enum(['yandex_disk', 'smb']);

export const CreateDestinationRequest = z
  .object({
    title: text(200),
    kind: DELIVERY_KIND,
    environment: z.enum(['test', 'production']),
    rootPath,
    // Яндекс Диск — обязательна и вне папки синхронизации; сетевая папка — по умолчанию <корень>/.kontur-staging.
    stagingPath: rootPath.nullable().optional(),
    includeInternal: z.boolean().default(false),
    reason,
  })
  .strict();

export const NewDestinationVersionRequest = z
  .object({
    rootPath,
    stagingPath: rootPath.nullable().optional(),
    includeInternal: z.boolean(),
    reason,
  })
  .strict();

export const PatchDestinationRequest = z
  .object({
    title: text(200).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.active !== undefined, { message: 'нужно title или active' });

export const PlaceDeliveriesRequest = z.object({ reason: reason.nullable().optional() }).strict();

export const DeliveryReasonRequest = z.object({ reason }).strict();

export const ConfirmCloudRequest = z.object({ note: reason }).strict();
