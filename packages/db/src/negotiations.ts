// Переговоры (этап 07, D-025, Q-06 — файловый импорт): сессия тендера → участники → неизменяемые редакции
// транскрипции → сегменты. Речь и подсказка участнику — разные виды (I06, A03): фрагменты
// negotiation_speech индексируются, negotiation_hint — нет (ADR-012 п. 21–22). Исправление транскрипции —
// новая редакция; повтор того же содержания подряд новой редакции не даёт. Новая редакция — событие
// барьера transcript_revision_added. Аудио — ссылка и хэш, запись портал не хранит.
import { sha256Hex } from '@kontur/core';
import type { Queryable } from './pool.ts';
import { emitStageEvents } from './stageEvents.ts';

export interface INegotiationManifestInput {
  format: string;
  session: { externalId: string; title: string | null; startedAt: string; audio: { ref: string; sha256: string | null } | null };
  participants: { speakerLabel: string; name: string | null; side: 'customer' | 'contractor' | 'unknown' }[];
  transcript: {
    revision: string;
    segments: { no: number; speakerLabel: string; startMs: number; endMs: number; kind: 'speech' | 'hint'; text: string }[];
  };
}

export interface INegotiationImportResult {
  importId: string;
  reused: boolean;
  sessionId: string | null;
  revisionId: string | null;
  createdRevision: boolean;
}

const transcriptHash = (m: INegotiationManifestInput): string =>
  sha256Hex(
    JSON.stringify(
      [...m.transcript.segments]
        .sort((a, b) => a.no - b.no)
        .map((s) => [s.no, s.speakerLabel, s.startMs, s.endMs, s.kind, s.text]),
    ),
  );

export const importNegotiationManifest = async (
  db: Queryable,
  n: { tenderId: string; stageId: string | null; manifestSha256: string; manifest: INegotiationManifestInput; userId: string },
): Promise<INegotiationImportResult> => {
  // Номер импорта и сравнение с последним — под блокировкой тендера для импортов этого вида.
  await db.query("SELECT pg_advisory_xact_lock(hashtext('negotiation_import'), hashtext($1::text))", [n.tenderId]);
  const lastImport = await db.query<{ id: string; seq: number; manifest_blob_sha256: string }>(
    'SELECT id, seq, manifest_blob_sha256 FROM negotiation_import WHERE tender_id = $1 ORDER BY seq DESC LIMIT 1',
    [n.tenderId],
  );
  if (lastImport.rows[0]?.manifest_blob_sha256 === n.manifestSha256) {
    return { importId: lastImport.rows[0].id, reused: true, sessionId: null, revisionId: null, createdRevision: false };
  }
  const ins = await db.query<{ id: string }>(
    `INSERT INTO negotiation_import (tender_id, seq, manifest_blob_sha256, format_version, imported_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [n.tenderId, (lastImport.rows[0]?.seq ?? 0) + 1, n.manifestSha256, n.manifest.format, n.userId],
  );
  const importId = ins.rows[0]!.id;
  const s = n.manifest.session;
  await db.query(
    `INSERT INTO negotiation_session (tender_id, stage_id, external_session_id, title, started_at, audio_ref, audio_sha256, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'manifest_import', $8)
     ON CONFLICT (tender_id, external_session_id) DO NOTHING`,
    [n.tenderId, n.stageId, s.externalId, s.title, s.startedAt, s.audio?.ref ?? null, s.audio?.sha256 ?? null, n.userId],
  );
  const session = await db.query<{ id: string }>('SELECT id FROM negotiation_session WHERE tender_id = $1 AND external_session_id = $2', [
    n.tenderId,
    s.externalId,
  ]);
  const sessionId = session.rows[0]!.id;
  // История редакций сессии сериализуется той же advisory-блокировкой, что берёт охранник редакции (0017).
  await db.query("SELECT pg_advisory_xact_lock(hashtext('transcript_revision'), hashtext($1::text))", [sessionId]);
  for (const p of n.manifest.participants) {
    await db.query(
      `INSERT INTO negotiation_participant (session_id, tender_id, speaker_label, name, side) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, speaker_label) DO NOTHING`,
      [sessionId, n.tenderId, p.speakerLabel, p.name, p.side],
    );
  }
  const hash = transcriptHash(n.manifest);
  const last = await db.query<{ id: string; seq: number; content_sha256: string }>(
    'SELECT id, seq, content_sha256 FROM transcript_revision WHERE session_id = $1 ORDER BY seq DESC LIMIT 1',
    [sessionId],
  );
  if (last.rows[0]?.content_sha256 === hash) {
    return { importId, reused: false, sessionId, revisionId: last.rows[0].id, createdRevision: false };
  }
  const rev = await db.query<{ id: string }>(
    `INSERT INTO transcript_revision (session_id, tender_id, seq, source_revision, content_sha256, import_id, supersedes_revision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [sessionId, n.tenderId, (last.rows[0]?.seq ?? 0) + 1, n.manifest.transcript.revision, hash, importId, last.rows[0]?.id ?? null],
  );
  const revisionId = rev.rows[0]!.id;
  const segs = [...n.manifest.transcript.segments].sort((a, b) => a.no - b.no);
  const segRows = await db.query<{ id: string; segment_no: number }>(
    `INSERT INTO transcript_segment (revision_id, tender_id, segment_no, speaker_label, t_start_ms, t_end_ms, segment_kind, text)
     SELECT $1, $2, x.no, x.speaker, x.start_ms, x.end_ms, x.kind, x.text
       FROM unnest($3::int[], $4::text[], $5::int[], $6::int[], $7::text[], $8::text[]) AS x(no, speaker, start_ms, end_ms, kind, text)
     RETURNING id, segment_no`,
    [
      revisionId,
      n.tenderId,
      segs.map((x) => x.no),
      segs.map((x) => x.speakerLabel),
      segs.map((x) => x.startMs),
      segs.map((x) => x.endMs),
      segs.map((x) => x.kind),
      segs.map((x) => x.text),
    ],
  );
  const idOf = new Map(segRows.rows.map((x) => [x.segment_no, x.id]));
  // Фрагмент на сегмент: речь — доказательство, подсказка — отдельный вид без индексации (I06). Владелец —
  // тендер редакции (ветка тендера, И-07-7; составной FK сверяет его).
  await db.query(
    `INSERT INTO evidence_fragment (source_unit_type, source_unit_id, transcript_revision_id, transcript_segment_id, tender_id, origin, fragment_kind,
                                    fragment_key, ordinal, text, text_sha256, part_index, part_total, locator)
     SELECT 'transcript_revision', $1, $1, x.segment_id, $9, x.origin, 'text_block', 's' || x.no, x.no, x.text, x.text_sha256, 0, 1,
            jsonb_build_object('kind', 'transcript_segment', 'segment', x.no, 'startMs', x.start_ms, 'endMs', x.end_ms)
       FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[])
            AS x(segment_id, no, origin, text, text_sha256, start_ms, end_ms)`,
    [
      revisionId,
      segs.map((x) => idOf.get(x.no)!),
      segs.map((x) => x.no),
      segs.map((x) => (x.kind === 'speech' ? 'negotiation_speech' : 'negotiation_hint')),
      segs.map((x) => x.text),
      segs.map((x) => sha256Hex(x.text)),
      segs.map((x) => x.startMs),
      segs.map((x) => x.endMs),
      n.tenderId,
    ],
  );
  await emitStageEvents(db, {
    tenderId: n.tenderId,
    stageIds: n.stageId ? [n.stageId] : null,
    eventType: 'transcript_revision_added',
    refType: 'transcript_revision',
    refId: revisionId,
    actorUserId: n.userId,
  });
  return { importId, reused: false, sessionId, revisionId, createdRevision: true };
};

export interface INegotiationSessionRow {
  id: string;
  tender_id: string;
  stage_id: string | null;
  external_session_id: string;
  title: string | null;
  started_at: Date;
  audio_ref: string | null;
  audio_sha256: string | null;
  source: string;
  created_at: Date;
  revisions: number;
  latest_revision_id: string | null;
}

const SELECT_SESSION = `
  SELECT s.*, (SELECT count(*)::int FROM transcript_revision r WHERE r.session_id = s.id) AS revisions,
         transcript_latest_revision(s.id) AS latest_revision_id
    FROM negotiation_session s`;

export const listNegotiationSessions = async (db: Queryable, tenderId: string): Promise<INegotiationSessionRow[]> => {
  const r = await db.query<INegotiationSessionRow>(`${SELECT_SESSION} WHERE s.tender_id = $1 ORDER BY s.started_at DESC, s.id`, [tenderId]);
  return r.rows;
};

export const getNegotiationSession = async (db: Queryable, tenderId: string, id: string): Promise<INegotiationSessionRow | null> => {
  const r = await db.query<INegotiationSessionRow>(`${SELECT_SESSION} WHERE s.id = $1 AND s.tender_id = $2`, [id, tenderId]);
  return r.rows[0] ?? null;
};

export const getNegotiationSessionById = async (db: Queryable, id: string): Promise<INegotiationSessionRow | null> => {
  const r = await db.query<INegotiationSessionRow>(`${SELECT_SESSION} WHERE s.id = $1`, [id]);
  return r.rows[0] ?? null;
};

export interface IParticipantRow {
  speaker_label: string;
  name: string | null;
  side: 'customer' | 'contractor' | 'unknown';
}

export const listParticipants = async (db: Queryable, sessionId: string): Promise<IParticipantRow[]> => {
  const r = await db.query<IParticipantRow>(
    'SELECT speaker_label, name, side FROM negotiation_participant WHERE session_id = $1 ORDER BY speaker_label',
    [sessionId],
  );
  return r.rows;
};

export interface ITranscriptRevisionRow {
  id: string;
  seq: number;
  source_revision: string;
  created_at: Date;
  segments: number;
}

export const listTranscriptRevisions = async (db: Queryable, sessionId: string): Promise<ITranscriptRevisionRow[]> => {
  const r = await db.query<ITranscriptRevisionRow>(
    `SELECT r.id, r.seq, r.source_revision, r.created_at, (SELECT count(*)::int FROM transcript_segment s WHERE s.revision_id = r.id) AS segments
       FROM transcript_revision r WHERE r.session_id = $1 ORDER BY r.seq DESC`,
    [sessionId],
  );
  return r.rows;
};

export interface ITranscriptSegmentRow {
  id: string;
  fragment_id: string;
  segment_no: number;
  speaker_label: string;
  t_start_ms: number;
  t_end_ms: number;
  segment_kind: 'speech' | 'hint';
  text: string;
}

export const listTranscriptSegments = async (db: Queryable, revisionId: string): Promise<ITranscriptSegmentRow[]> => {
  const r = await db.query<ITranscriptSegmentRow>(
    `SELECT s.id, f.id AS fragment_id, s.segment_no, s.speaker_label, s.t_start_ms, s.t_end_ms, s.segment_kind, s.text
       FROM transcript_segment s JOIN evidence_fragment f ON f.transcript_segment_id = s.id
      WHERE s.revision_id = $1 ORDER BY s.segment_no`,
    [revisionId],
  );
  return r.rows;
};
