// Влияние распознавания на этапы (state-machines §1.1, §5): какие этапы затрагивает новый прогон редакции
// и какие включённые редакции мешают заморозить состав. Вынесено из recognition.ts (лимит размера модуля).
import type { Queryable } from './pool.ts';

// Затронутые этапы события recognition_run_completed (state-machines §1.1): активные этапы
// тендера, где редакция входит в набор источников или ещё не отнесена. Явно исключённая
// из последней ревизии набора редакция этап не затрагивает.
export const stagesAffectedByRevision = async (db: Queryable, tenderId: string, revisionId: string): Promise<string[]> => {
  const r = await db.query<{ id: string }>(
    `SELECT s.id
       FROM tender_stage s
      WHERE s.tender_id = $1 AND s.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM source_set ss
            JOIN LATERAL (
              SELECT rr.id FROM source_set_revision rr WHERE rr.source_set_id = ss.id ORDER BY rr.seq DESC LIMIT 1
            ) last ON true
            JOIN source_set_item i ON i.source_set_revision_id = last.id
           WHERE ss.stage_id = s.id AND i.document_revision_id = $2 AND i.inclusion = 'excluded_not_applicable')
      ORDER BY s.id`,
    [tenderId, revisionId],
  );
  return r.rows.map((x) => x.id);
};

// Затронутые этапы для редакции договора (D-017): загрузка и распознавание договора этапы сами по
// себе не затрагивают — событие получает только активный этап, в последнюю ревизию состава которого
// человек явно включил эту редакцию. Группы по тендеру в возрастающем порядке id — единый порядок блокировок.
export const stagesIncludingRevision = async (db: Queryable, revisionId: string): Promise<{ tenderId: string; stageIds: string[] }[]> => {
  const r = await db.query<{ tender_id: string; stage_id: string }>(
    `SELECT s.tender_id, s.id AS stage_id
       FROM tender_stage s
      WHERE s.status = 'active'
        AND EXISTS (
          SELECT 1
            FROM source_set ss
            JOIN LATERAL (
              SELECT rr.id FROM source_set_revision rr WHERE rr.source_set_id = ss.id ORDER BY rr.seq DESC LIMIT 1
            ) last ON true
            JOIN source_set_item i ON i.source_set_revision_id = last.id
           WHERE ss.stage_id = s.id AND i.document_revision_id = $1 AND i.inclusion <> 'excluded_not_applicable')
      ORDER BY s.tender_id, s.id`,
    [revisionId],
  );
  const groups: { tenderId: string; stageIds: string[] }[] = [];
  for (const row of r.rows) {
    const last = groups.at(-1);
    if (last?.tenderId === row.tender_id) last.stageIds.push(row.stage_id);
    else groups.push({ tenderId: row.tender_id, stageIds: [row.stage_id] });
  }
  return groups;
};

// Включённые редакции ревизии набора без пригодного распознавания (охранное условие заморозки).
export interface IBlockingItemRow {
  document_revision_id: string;
  document_id: string;
  document_title: string;
  revision_seq: number;
  contract_id: string | null;
  reason: 'no_recognition' | 'recognition_in_progress' | 'recognition_failed' | 'recognition_cancelled';
}

export const blockingFreezeItems = async (db: Queryable, revisionId: string): Promise<IBlockingItemRow[]> => {
  const r = await db.query<IBlockingItemRow>(
    `SELECT i.document_revision_id, d.id AS document_id, d.title AS document_title, dr.revision_seq, dr.contract_id,
            CASE
              WHEN EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = i.document_revision_id
                            AND r.status IN ('queued', 'running')) THEN 'recognition_in_progress'
              WHEN EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = i.document_revision_id
                            AND r.status = 'failed') THEN 'recognition_failed'
              WHEN EXISTS (SELECT 1 FROM recognition_run r WHERE r.document_revision_id = i.document_revision_id
                            AND r.status = 'cancelled') THEN 'recognition_cancelled'
              ELSE 'no_recognition'
            END AS reason
       FROM source_set_item i
       JOIN document_revision dr ON dr.id = i.document_revision_id
       JOIN document d ON d.id = dr.document_id
      WHERE i.source_set_revision_id = $1
        AND i.inclusion <> 'excluded_not_applicable'
        AND NOT EXISTS (SELECT 1 FROM recognition_run r
                         WHERE r.document_revision_id = i.document_revision_id AND r.status IN ('complete', 'partial'))
      ORDER BY d.title, dr.revision_seq`,
    [revisionId],
  );
  return r.rows;
};
