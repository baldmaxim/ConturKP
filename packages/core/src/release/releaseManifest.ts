// Манифест выпуска (этап 13; D-033 В-13-7; spec §9: «выпуск включает manifest: файлы, размеры, hashes, версии и
// согласование»). Каноническая запись, как у манифеста кандидата: ключи по алфавиту, без пробелов, UTF-8. Файлы —
// точные байты кандидата (I02): этап 14 размещает именно их и этот манифест. В манифесте — кто, когда и на каком
// основании согласовал и выпустил, с какими принятыми рисками и решениями по удержаниям (журнал основания).
import { canonicalJson } from '../requirements.ts';
import { sha256Hex } from '../search.ts';
import type { Audience, CandidateMode, FileRole } from './manifest.ts';

export const RELEASE_MANIFEST_SCHEMA = 'kontur-release/1' as const;

export interface IActorRef {
  id: string;
  name: string;
}

export interface IReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  release: { id: string; mode: CandidateMode; tenderId: string; stageId: string; inputVersion: number; releasedBy: IActorRef; releasedAt: string };
  // `contentHash` — SHA-256 манифеста кандидата (`kontur-manifest/1`), который согласован.
  candidate: { id: string; seq: number; contentHash: string; marks: string[] };
  approval: { id: string; approvedBy: IActorRef; approvedAt: string; comment: string | null; inputVersion: number; contentHash: string };
  acceptedRisks: {
    id: string;
    code: string;
    subjectType: string;
    subjectId: string;
    subjectKey: string;
    subjectVersion: number | null;
    title: string;
    reason: string;
    acceptedBy: IActorRef;
    acceptedAt: string;
  }[];
  // Риски, принятые в этапе 09 по замечаниям и действующие на момент выпуска (D-029 В-09-3, D-033 ут. 3).
  reviewRisks: { findingId: string; kind: string; severity: string; title: string; reason: string; acceptedBy: IActorRef | null; acceptedAt: string | null }[];
  // Решения руководителя по событиям входов этого кандидата (I04): событие, решение, причина, кто и когда.
  holds: { eventSeq: number; eventType: string; decision: string; reason: string; decidedBy: IActorRef; decidedAt: string }[];
  files: { path: string; role: FileRole; audience: Audience; mediaType: string; sha256: string; size: number }[];
}

export const releaseManifestBytes = (m: IReleaseManifest): Buffer => Buffer.from(canonicalJson(m), 'utf8');
export const releaseManifestSha256 = (m: IReleaseManifest): string => sha256Hex(canonicalJson(m));
