// Схемы запросов этапа 10 (D-030; docs/contracts/portal-api.md §2.5, §2.10 в редакции этапа 10): сравнение ревизий,
// решения по парам позиций, причины изменений и гипотезы модели. Права и область проверяет сервер и вторая линия БД.
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const CreateComparisonRequest = z
  .object({
    leftRevisionId: z.uuid(),
    rightRevisionId: z.uuid(),
  })
  .strict()
  .refine((v) => v.leftRevisionId.toLowerCase() !== v.rightRevisionId.toLowerCase(), { message: 'сравниваются две разные ревизии' });

export const ComparisonUnitsQuery = z.object({
  kind: z.enum(['matched', 'added', 'removed', 'split_merge']).optional(),
  changed: z.enum(['true', 'false']).optional(),
  after: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const DeviationLinesQuery = z.object({
  flag: z
    .enum(['quantity_nonpositive', 'negative_amount', 'unknown_item_type', 'missing_commercial', 'missing_fx_rate', 'bound_quantity_mismatch', 'recompute_outside_tolerance'])
    .optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Решения инженера по парам: подтверждение предложений (в том числе пакетом), ручная пара, отклонение.
export const LineageDecisionsRequest = z
  .object({
    decisions: z
      .array(z.object({ fromPositionId: z.uuid(), toPositionId: z.uuid(), status: z.enum(['confirmed', 'rejected']) }).strict())
      .min(1)
      .max(2000),
  })
  .strict();

export const ExplanationRequest = z
  .object({
    reasonKind: z.enum(['document', 'answer', 'supplier', 'internal_decision', 'unknown']),
    reasonStatus: z.enum(['unknown', 'hypothesis', 'confirmed']),
    rationale: text(4000).nullable().optional(),
    fragmentIds: z.array(z.uuid()).max(20).default([]),
    decisionIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict()
  .refine((v) => (v.reasonKind === 'unknown') === (v.reasonStatus === 'unknown'), { message: '«неизвестно» — и вид, и статус' })
  .refine((v) => v.reasonStatus === 'unknown' || !!v.rationale, { message: 'у причины нужно обоснование' })
  .refine((v) => v.reasonStatus !== 'unknown' || (v.fragmentIds.length === 0 && v.decisionIds.length === 0), { message: 'у «неизвестно» оснований нет' });

export const StartReasonRunRequest = z
  .object({
    unitIds: z.array(z.uuid()).min(1).max(50).optional(),
  })
  .strict();

export const DecideReasonSuggestionRequest = z
  .object({
    reason: text(2000).nullable().optional(),
  })
  .strict();
