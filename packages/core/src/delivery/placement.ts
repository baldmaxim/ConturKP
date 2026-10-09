// Набор файлов размещения и признак готовности `kontur-placement/1` (этап 14; D-034 В-14-3; проект §5.2). Признак — последний
// файл папки выпуска: выпуск, режим, хэш содержимого, SHA-256 манифеста выпуска, набор и файлы набора с путём, размером и
// SHA-256. Причин решений и текстов нет. Каноническая запись (ключи по алфавиту, UTF-8): содержимое детерминировано, его
// SHA-256 вычисляется при создании доставки и сверяется после записи.
import { canonicalJson } from '../requirements.ts';
import { sha256Hex } from '../search.ts';
import type { Audience, CandidateMode, FileRole } from '../release/manifest.ts';

export const PLACEMENT_SCHEMA = 'kontur-placement/1' as const;
export const PLACEMENT_MARKER = 'kontur-placement.json';
export const CANDIDATE_MANIFEST_NAME = 'manifest.json';
export const RELEASE_MANIFEST_NAME = 'release-manifest.json';

export type DeliveryFileSet = 'customer' | 'all';
export type DeliveryFileKind = 'file' | 'manifest' | 'marker';

export interface IPlacementFile {
  path: string;
  size: number;
  sha256: string;
}

export interface IPlacementManifest {
  schema: typeof PLACEMENT_SCHEMA;
  release: { id: string; mode: CandidateMode; contentHash: string; releaseManifestSha256: string };
  fileSet: DeliveryFileSet;
  files: IPlacementFile[];
}

export const placementBytes = (m: IPlacementManifest): Buffer => Buffer.from(canonicalJson(m), 'utf8');
export const placementSha256 = (m: IPlacementManifest): string => sha256Hex(canonicalJson(m));

export interface IReleaseFileRef {
  path: string;
  role: FileRole;
  audience: Audience;
  sha256: string;
  size: number;
}

export interface IDeliveryFilePlan {
  path: string;
  kind: DeliveryFileKind;
  sha256: string;
  size: number;
}

// Файлы набора (без признака): «для заказчика» — аудитория customer без превью (как ZIP для заказчика); «все файлы» —
// все файлы кандидата и оба манифеста (кандидата и выпуска; в манифесте выпуска — причины решений, R13-02).
export const deliveryFilePlan = (
  set: DeliveryFileSet,
  files: readonly IReleaseFileRef[],
  manifests: { candidate: { sha256: string; size: number }; release: { sha256: string; size: number } },
): IDeliveryFilePlan[] => {
  const chosen = files.filter((f) => set === 'all' || (f.audience === 'customer' && f.role !== 'preview'));
  const out: IDeliveryFilePlan[] = chosen.map((f) => ({ path: f.path, kind: 'file', sha256: f.sha256, size: f.size }));
  if (set === 'all') {
    out.push({ path: CANDIDATE_MANIFEST_NAME, kind: 'manifest', sha256: manifests.candidate.sha256, size: manifests.candidate.size });
    out.push({ path: RELEASE_MANIFEST_NAME, kind: 'manifest', sha256: manifests.release.sha256, size: manifests.release.size });
  }
  return out;
};

export const placementManifestOf = (
  release: IPlacementManifest['release'],
  set: DeliveryFileSet,
  plan: readonly IDeliveryFilePlan[],
): IPlacementManifest => ({
  schema: PLACEMENT_SCHEMA,
  release,
  fileSet: set,
  files: plan.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
});
