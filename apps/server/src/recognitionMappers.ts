// Ответы API распознавания (этап 04). Координаты приходят из pg строками (numeric):
// в ответ они уходят числами, но округления при разборе не происходит.
import type { IEvidenceFragmentRow, IRecognitionPageRow, IRecognitionRunRow, IScopedFragmentRow } from '@kontur/db';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const nums = (v: string[] | null): number[] | null => (v ? v.map(Number) : null);

export const contentUrlOf = (revisionId: string): string => `/api/v1/document-revisions/${revisionId}/content`;

export const toRun = (r: IRecognitionRunRow) => ({
  id: r.id,
  documentRevisionId: r.document_revision_id,
  documentId: r.document_id,
  tenderId: r.tender_id,
  engine: r.engine,
  engineSchemaVersion: r.engine_schema_version,
  sourceArtifactSha256: r.source_artifact_sha256,
  sourceArtifactName: r.source_artifact_name,
  status: r.status,
  pagesTotal: r.pages_total,
  pagesRecognized: r.pages_recognized,
  supersedesRunId: r.supersedes_run_id,
  failureCode: r.failure_code,
  failureDetail: r.failure_detail,
  createdAt: r.created_at.toISOString(),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  contentUrl: contentUrlOf(r.document_revision_id),
});

export const toPage = (p: IRecognitionPageRow) => ({
  pageIndex: p.page_index,
  pageLabel: p.page_label,
  sheetLabel: p.sheet_label,
  widthPx: p.width_px,
  heightPx: p.height_px,
  rotation: p.rotation,
  status: p.status,
});

export const toRunDetail = (r: IRecognitionRunRow, pages: IRecognitionPageRow[], supersededByRunId: string | null) => ({
  ...toRun(r),
  supersededByRunId,
  quality: r.quality,
  // Явный перечень нераспознанных страниц: неполнота должна быть видна, а не выводиться
  // вычитанием счётчиков (A16, I18).
  missingPages: pages.filter((p) => p.status !== 'recognized').map((p) => p.page_index),
  pages: pages.map(toPage),
});

export const toFragment = (f: IEvidenceFragmentRow) => ({
  id: f.id,
  runId: f.run_id,
  documentRevisionId: f.document_revision_id,
  origin: f.origin,
  fragmentKind: f.fragment_kind,
  externalBlockId: f.external_block_id,
  ordinal: f.ordinal,
  pageIndex: f.page_index,
  bboxNorm: nums(f.bbox_norm),
  bboxSpace: f.bbox_space,
  shapeType: f.shape_type,
  polygonNorm: nums(f.polygon_norm),
  rotation: f.rotation,
  text: f.text,
  textSha256: f.text_sha256,
  derivedModelRef: f.derived_model_ref,
  // Справочная ссылка экспорта: портал её не загружает (A38). Интерфейс показывает её текстом.
  externalCropUrl: f.external_crop_url,
  warnings: f.warnings,
  // Часть длинного текста блока: доказательство разбито, а не усечено (R04-06).
  partIndex: f.part_index,
  partTotal: f.part_total,
});

export const toEvidence = (f: IScopedFragmentRow) => ({
  ...toFragment(f),
  tenderId: f.tender_id,
  documentId: f.document_id,
  runStatus: f.run_status,
  pageLabel: f.page_label,
  sheetLabel: f.sheet_label,
  pageWidthPx: f.page_width_px,
  pageHeightPx: f.page_height_px,
  pageStatus: f.page_status,
  contentUrl: f.document_revision_id ? contentUrlOf(f.document_revision_id) : null,
});
