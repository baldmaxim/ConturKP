// Схема _blocks.json (docs/discovery.md §7.1). Формат подтверждён ОДНИМ образцом (R-05),
// поэтому объекты loose: неизвестное поле не валит импорт. Отказ допустим только там, где
// непонимание схемы сделало бы доказательство ложным: чужая версия схемы и чужое
// пространство координат. Всё остальное — предупреждение.
import { z } from 'zod';

export const SUPPORTED_SCHEMA_VERSION = 1;
export const SUPPORTED_COORDINATE_SPACE = 'normalized_page_top_left';

const num = z.number().finite();

export const RdwebPageSchema = z
  .object({
    page_index: z.number().int().min(0),
    page_label: z.union([z.string().max(60), z.number().int()]).nullish(),
    width_px: z.number().int().positive().nullish(),
    height_px: z.number().int().positive().nullish(),
    rotation: z.number().int().nullish(),
  })
  .loose();

export const RdwebBlockSchema = z
  .object({
    block_id: z.string().min(1).max(200),
    ordinal: z.number().int().nullish(),
    page_index: z.number().int().min(0),
    page_label: z.union([z.string().max(60), z.number().int()]).nullish(),
    block_type: z.string().min(1).max(64),
    shape_type: z.string().max(40).nullish(),
    // Может приходить парами [x, y] или плоским списком — приводится в import.ts.
    polygon_points: z.array(z.union([z.array(num), num])).max(4000).nullish(),
    status: z.string().max(40).nullish(),
    export_status: z.string().max(40).nullish(),
    coords_norm: z.array(num).nullish(),
    crop_url: z.string().max(2000).nullish(),
  })
  .loose();

export const RdwebBlocksSchema = z
  .object({
    schema_version: z.number().int(),
    document_id: z.string().max(200).nullish(),
    document_name: z.string().max(500).nullish(),
    document_path: z.string().max(2000).nullish(),
    generated_at: z.string().max(60).nullish(),
    coordinate_space: z.string().max(60),
    pages: z.array(RdwebPageSchema),
    blocks: z.array(RdwebBlockSchema),
  })
  .loose();

export type RdwebBlocks = z.infer<typeof RdwebBlocksSchema>;
export type RdwebBlock = z.infer<typeof RdwebBlockSchema>;
export type RdwebPageMeta = z.infer<typeof RdwebPageSchema>;

// Типы блоков образца. Незнакомый тип не отбрасывается: он импортируется с пометкой,
// иначе часть документа молча выпала бы из доказательств.
export const KNOWN_BLOCK_TYPES = ['text', 'image', 'stamp'] as const;
