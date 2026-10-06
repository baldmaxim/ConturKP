// Манифест кандидата выпуска (этап 12; data-model §5; D-032). Каноническая запись: JSON с ключами по алфавиту, без
// пробелов, UTF-8; числа и деньги — строками. SHA-256 байтов манифеста — `content_hash` кандидата. В манифесте —
// режим, закреплённые входы с их хэшами, базы актуальности, конвертер, файлы (путь, роль, аудитория, тип, SHA-256,
// размер; у превью — SHA-256 исходного файла и шрифты PDF) и итоги проверок сборки.
import { canonicalJson } from '../requirements.ts';
import { sha256Hex } from '../search.ts';

export const MANIFEST_SCHEMA = 'kontur-manifest/1' as const;

export type CandidateMode = 'test' | 'production';
export type FileRole = 'document' | 'attachment' | 'preview';
export type Audience = 'customer' | 'internal';

export interface IManifestFile {
  path: string;
  role: FileRole;
  audience: Audience;
  mediaType: string;
  sha256: string;
  size: number;
  sourceSha256?: string;
  fonts?: string[];
  pages?: number;
}

export interface IManifestCheck {
  code: string;
  outcome: 'passed' | 'failed' | 'unverified' | 'not_applicable';
  path?: string;
  detail?: string;
}

export interface IManifest {
  schema: typeof MANIFEST_SCHEMA;
  candidate: { id: string; seq: number; mode: CandidateMode; tenderId: string; stageId: string; createdAt: string; marks: string[] };
  inputs: {
    calculationRevision: { id: string; kind: string; contentId: string; contentHash: string };
    evidenceScope: { id: string; contentHash: string; sourceSetRevisionId: string | null };
    reviewRuns: { id: string; status: string; inputSha256: string | null }[];
    decisions: { id: string; type: string }[];
    templates: { revisionId: string; templateId: string; seq: number; isDemo: boolean; schemaSha256: string; markedSampleSha256: string; outputFormat: string; audience: Audience }[];
    drafts: { id: string; title: string; templateRevisionId: string; fieldVersions: { key: string; versionId: string; version: number }[] }[];
    attachments: { revisionId: string; attachmentId: string; sha256: string; mediaType: string; audience: Audience }[];
    baselines: { calculation: number; content: number };
    inputsSha256: string;
  };
  converter: { name: 'libreoffice'; version: string };
  files: IManifestFile[];
  checks: IManifestCheck[];
  // Сведения для этапа 13 (не разрешение на выпуск): известные блокеры production и отметки (D-032 В-12-6, В-12-8).
  notes: string[];
}

export const manifestBytes = (m: IManifest): Buffer => Buffer.from(canonicalJson(m), 'utf8');
export const manifestSha256 = (m: IManifest): string => sha256Hex(canonicalJson(m));

// Хэш закреплённых входов (без файлов): одинаковые входы — одинаковый хэш.
export const inputsSha256 = (inputs: Omit<IManifest['inputs'], 'inputsSha256'>): string => sha256Hex(`kontur.candidate_inputs.v1\n${canonicalJson(inputs)}`);
