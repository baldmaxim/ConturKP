// Область поиска (ADR-008 §2–6, state-machines §5.1): снимок области доказательств и развёртывание
// области прогона поиска. Клиент не передаёт ID единиц сам — их выводит сервер из этапа или снимка.
// Этап 07 (D-025, AD-07-1a): в область тендера входят письма с действующей связью (последней ревизией),
// документы вложений из набора этапа и редакции транскрипций переговоров тендера.
import { evidenceScopeContentHash, sourceSetContentHash, type IScopeUnit } from '@kontur/core';
import { contentTenderIds, readableContractIds, readableMailboxIds, type IAccessContext } from './access.ts';
import { inTransaction, type Queryable } from './pool.ts';

export interface IScopeRevisionItem {
  document_revision_id: string;
  blob_sha256: string;
  inclusion: 'included' | 'excluded_not_applicable' | 'inherited';
  // Владелец редакции-договора (D-023); у редакции тендера — null.
  contract_id: string | null;
  // Письмо и ящик документа вложения (D-025: документ → вложение → ревизия → письмо); иначе null.
  mail_message_id: string | null;
  mailbox_id: string | null;
  // Предпочтительный прогон редакции (recognition_preferred_run, AD-05a-3): RDWeb выше локального,
  // внутри класса — глубже по истории. Для истории только из RDWeb это прежний хвост цепочки.
  run_id: string | null;
}

const MAIL_OF_REVISION = `
  LEFT JOIN document d ON d.id = dr.document_id
  LEFT JOIN mail_attachment a ON a.id = d.mail_attachment_id
  LEFT JOIN mail_message_revision amr ON amr.id = a.revision_id
  LEFT JOIN mail_message am ON am.id = amr.message_id`;

// Элементы ревизии набора и выбранный для каждой редакции прогон «на момент чтения»
// (state-machines §5.1): предпочтительный прогон — правило БД, не время создания (AD-05a-3).
export const setRevisionItemsWithRuns = async (db: Queryable, setRevisionId: string): Promise<IScopeRevisionItem[]> => {
  const r = await db.query<IScopeRevisionItem>(
    `SELECT i.document_revision_id, dr.blob_sha256, i.inclusion, dr.contract_id, am.id AS mail_message_id, am.mailbox_id,
            recognition_preferred_run(i.document_revision_id) AS run_id
       FROM source_set_item i
       JOIN document_revision dr ON dr.id = i.document_revision_id
       ${MAIL_OF_REVISION}
      WHERE i.source_set_revision_id = $1
      ORDER BY i.document_revision_id`,
    [setRevisionId],
  );
  return r.rows;
};

export interface IWorkingSetRevision {
  id: string;
  status: 'draft' | 'frozen';
  content_hash: string | null;
}

// Последняя ревизия рабочего набора этапа — черновая или замороженная (режим working).
export const latestWorkingRevision = async (db: Queryable, stageId: string): Promise<IWorkingSetRevision | null> => {
  const r = await db.query<IWorkingSetRevision>(
    `SELECT r.id, r.status, r.content_hash FROM source_set_revision r JOIN source_set s ON s.id = r.source_set_id
      WHERE s.stage_id = $1 AND s.purpose = 'working'
      ORDER BY r.seq DESC LIMIT 1`,
    [stageId],
  );
  return r.rows[0] ?? null;
};

export const latestFrozenRevision = async (db: Queryable, stageId: string): Promise<IWorkingSetRevision | null> => {
  const r = await db.query<IWorkingSetRevision>(
    `SELECT r.id, r.status, r.content_hash FROM source_set_revision r JOIN source_set s ON s.id = r.source_set_id
      WHERE s.stage_id = $1 AND s.purpose = 'working' AND r.status = 'frozen'
      ORDER BY r.seq DESC LIMIT 1`,
    [stageId],
  );
  return r.rows[0] ?? null;
};

const includedUnits = (items: IScopeRevisionItem[]): IScopeUnit[] =>
  items
    .filter((i) => i.inclusion !== 'excluded_not_applicable')
    .map((i) => ({
      unitType: 'document_recognition' as const,
      documentRevisionId: i.document_revision_id,
      recognitionRunId: i.run_id,
      mailMessageId: i.mail_message_id,
    }));

// ---------------------------------------------------------------- Письма и транскрипции тендера

export interface IMailUnit {
  revisionId: string;
  messageId: string;
  mailboxId: string;
}

export interface ICommunicationUnits {
  mail: IMailUnit[];
  transcripts: string[];
}

// Текущий выбор коммуникаций этапа (state-machines §5.1, D-025): каждое письмо с действующей связью с
// тендером (связь без этапа или с этим этапом) — последней ревизией; каждая сессия переговоров
// тендера — последней редакцией транскрипции. Тот же состав сверяет evidence_scope_verify.
export const communicationUnits = async (db: Queryable, tenderId: string, stageId: string): Promise<ICommunicationUnits> => {
  const mail = await db.query<{ revision_id: string; message_id: string; mailbox_id: string }>(
    `SELECT mail_message_latest_revision(l.message_id) AS revision_id, l.message_id, m.mailbox_id
       FROM mail_message_tender l JOIN mail_message m ON m.id = l.message_id
      WHERE l.tender_id = $1 AND l.status = 'linked' AND (l.stage_id IS NULL OR l.stage_id = $2)
      ORDER BY l.message_id`,
    [tenderId, stageId],
  );
  const tr = await db.query<{ id: string }>(
    `SELECT x.id FROM negotiation_session s CROSS JOIN LATERAL (SELECT transcript_latest_revision(s.id) AS id) x
      WHERE s.tender_id = $1 AND x.id IS NOT NULL ORDER BY x.id`,
    [tenderId],
  );
  return {
    mail: mail.rows.map((m) => ({ revisionId: m.revision_id, messageId: m.message_id, mailboxId: m.mailbox_id })),
    transcripts: tr.rows.map((t) => t.id),
  };
};

const communicationScopeUnits = (c: ICommunicationUnits): IScopeUnit[] => [
  ...c.mail.map((m) => ({ unitType: 'mail_message' as const, mailMessageRevisionId: m.revisionId, mailMessageId: m.messageId })),
  ...c.transcripts.map((t) => ({ unitType: 'transcript_revision' as const, transcriptRevisionId: t })),
];

// ---------------------------------------------------------------- Развёрнутая область

export interface IMailOwner {
  messageId: string;
  mailboxId: string;
}

export interface IResolvedScope {
  // Хэш снимка: сохранённого (review) или временного (working).
  snapshotHash: string;
  // Единицы источника до фильтра прав: прогоны, ревизии писем, редакции транскрипций.
  unitIds: string[];
  // Единицы договора → договор (D-022 OD-3): их пропускает только фильтр прав contract.read.
  contractOf: ReadonlyMap<string, string>;
  // Единицы почтовой ветки → письмо (ревизия письма и прогон документа вложения): их пропускает
  // только mail.read на ящик письма и действующая связь письма с тендером (AD-07-1a).
  mailOf: ReadonlyMap<string, IMailOwner>;
  // Включённые редакции без прогона — входят в охват как «только оригинал».
  revisionsWithoutRun: number;
}

const contractUnits = (items: { run_id: string | null; contract_id: string | null }[]): Map<string, string> =>
  new Map(items.flatMap((i) => (i.run_id && i.contract_id ? [[i.run_id, i.contract_id] as const] : [])));

const mailUnits = (
  docs: { run_id: string | null; mail_message_id: string | null; mailbox_id: string | null }[],
  mail: IMailUnit[],
): Map<string, IMailOwner> =>
  new Map([
    ...docs.flatMap((i) => (i.run_id && i.mail_message_id ? [[i.run_id, { messageId: i.mail_message_id, mailboxId: i.mailbox_id! }] as const] : [])),
    ...mail.map((m) => [m.revisionId, { messageId: m.messageId, mailboxId: m.mailboxId }] as const),
  ]);

const unitIdOf = (u: IScopeUnit): string | null =>
  u.unitType === 'document_recognition' ? u.recognitionRunId : u.unitType === 'mail_message' ? u.mailMessageRevisionId : u.transcriptRevisionId;

const resolvedFrom = (
  snapshotHash: string,
  units: IScopeUnit[],
  docs: IScopeRevisionItem[],
  mail: IMailUnit[],
): IResolvedScope => ({
  snapshotHash,
  unitIds: units.flatMap((u) => {
    const id = unitIdOf(u);
    return id ? [id] : [];
  }),
  contractOf: contractUnits(docs),
  mailOf: mailUnits(docs, mail),
  revisionsWithoutRun: units.filter((u) => u.unitType === 'document_recognition' && u.recognitionRunId === null).length,
});

// Временный снимок режима working (ADR-008 §3): последняя ревизия рабочего набора этапа, предпочтительные
// прогоны её редакций и текущие коммуникации этапа. Хэш считается так же, как хэш сохранённого снимка,
// поэтому одинаковый состав даёт одинаковый scopeHash.
export const resolveWorkingScope = async (db: Queryable, stageId: string): Promise<IResolvedScope> => {
  const stage = await db.query<{ tender_id: string }>('SELECT tender_id FROM tender_stage WHERE id = $1', [stageId]);
  const comm = await communicationUnits(db, stage.rows[0]!.tender_id, stageId);
  const rev = await latestWorkingRevision(db, stageId);
  const all = rev ? await setRevisionItemsWithRuns(db, rev.id) : [];
  const setHash = !rev
    ? 'empty'
    : (rev.content_hash ??
      sourceSetContentHash(all.map((i) => ({ documentRevisionId: i.document_revision_id, blobSha256: i.blob_sha256, inclusion: i.inclusion }))));
  const items = all.filter((i) => i.inclusion !== 'excluded_not_applicable');
  const units = [...includedUnits(items), ...communicationScopeUnits(comm)];
  return resolvedFrom(evidenceScopeContentHash(setHash, units), units, items, comm.mail);
};

// Область контекста contract (ADR-012 §24): текущий корпус договора — последняя редакция каждого
// документа (основной договор, допсоглашения, приложения) и её предпочтительный прогон.
// Отдельного снимка договора нет (T06A-1); хэш временного снимка считается так же, как у этапа.
export const resolveContractScope = async (db: Queryable, contractId: string): Promise<IResolvedScope> => {
  const r = await db.query<IScopeRevisionItem>(
    `SELECT lr.id AS document_revision_id, lr.blob_sha256, 'included' AS inclusion, lr.contract_id, NULL AS mail_message_id, NULL AS mailbox_id,
            recognition_preferred_run(lr.id) AS run_id
       FROM document d
       JOIN LATERAL (SELECT x.id, x.blob_sha256, x.contract_id FROM document_revision x
                      WHERE x.document_id = d.id ORDER BY x.revision_seq DESC LIMIT 1) lr ON true
      WHERE d.contract_id = $1
      ORDER BY lr.id`,
    [contractId],
  );
  const units = includedUnits(r.rows);
  const setHash = sourceSetContentHash(r.rows.map((i) => ({ documentRevisionId: i.document_revision_id, blobSha256: i.blob_sha256, inclusion: i.inclusion })));
  return resolvedFrom(evidenceScopeContentHash(setHash, units), units, r.rows, []);
};

// ---------------------------------------------------------------- Снимок области (evidence_scope)

export interface IEvidenceScopeRow {
  id: string;
  stage_id: string;
  tender_id: string;
  source_set_revision_id: string;
  input_version: number;
  content_hash: string;
  created_by: string;
  created_at: Date;
}

export interface IEvidenceScopeItemRow {
  unit_type: 'document_recognition' | 'mail_message' | 'transcript_revision';
  document_revision_id: string | null;
  recognition_run_id: string | null;
  inclusion_reason: string;
  contract_id: string | null;
  document_id: string | null;
  document_title: string | null;
  revision_seq: number | null;
  run_status: string | null;
  pages_total: number | null;
  pages_recognized: number | null;
  // Почтовая ветка: письмо (у единицы вложения — письмо вложения), ящик, ревизия и её шапка.
  mail_message_id: string | null;
  mailbox_id: string | null;
  mail_message_revision_id: string | null;
  mail_revision_seq: number | null;
  mail_subject: string | null;
  mail_sent_at: Date | null;
  // Транскрипция: редакция, сессия и её название.
  transcript_revision_id: string | null;
  transcript_seq: number | null;
  session_id: string | null;
  session_title: string | null;
}

export interface IScopePlan {
  contentHash: string;
  units: IScopeUnit[];
  // Вложения из набора, письмо которых больше не связано с тендером (или этапом) снимка: снимок
  // с ними не соберётся (охранник единицы) — сначала их нужно исключить из набора.
  unlinkedAttachments: string[];
}

export const planEvidenceScope = async (
  db: Queryable,
  setRevision: { id: string; content_hash: string },
  stage: { tenderId: string; stageId: string },
): Promise<IScopePlan> => {
  const items = await setRevisionItemsWithRuns(db, setRevision.id);
  const comm = await communicationUnits(db, stage.tenderId, stage.stageId);
  const linked = new Set(
    (
      await db.query<{ message_id: string }>(
        `SELECT message_id FROM mail_message_tender WHERE tender_id = $1 AND status = 'linked' AND (stage_id IS NULL OR stage_id = $2)`,
        [stage.tenderId, stage.stageId],
      )
    ).rows.map((x) => x.message_id),
  );
  const included = items.filter((i) => i.inclusion !== 'excluded_not_applicable');
  const units = [...includedUnits(included), ...communicationScopeUnits(comm)];
  return {
    contentHash: evidenceScopeContentHash(setRevision.content_hash, units),
    units,
    unlinkedAttachments: included.filter((i) => i.mail_message_id && !linked.has(i.mail_message_id)).map((i) => i.document_revision_id),
  };
};

// Одинаковый состав этапа — та же строка (data-model §4.3): повтор возвращает существующий снимок.
// Снимок и весь его состав пишутся в одной транзакции, единицы — одной командой (миграция 0010, R05-01):
// БД сверяет полноту и хэш после команды и при COMMIT, а после фиксации единицу в снимок не вставить.
// Параллельное создание того же состава ждёт на уникальности (stage_id, content_hash) и возвращает
// зафиксированный снимок; частично заполненный снимок другим транзакциям не виден.
export const createEvidenceScope = async (
  db: Queryable,
  s: { stageId: string; tenderId: string; sourceSetRevisionId: string; inputVersion: number; contentHash: string; createdBy: string; units: IScopeUnit[] },
): Promise<{ id: string; created: boolean }> =>
  inTransaction(db, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO evidence_scope (stage_id, tender_id, source_set_revision_id, input_version, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stage_id, content_hash) DO NOTHING RETURNING id`,
      [s.stageId, s.tenderId, s.sourceSetRevisionId, s.inputVersion, s.contentHash, s.createdBy],
    );
    const id = r.rows[0]?.id;
    if (!id) {
      const existing = await tx.query<{ id: string }>('SELECT id FROM evidence_scope WHERE stage_id = $1 AND content_hash = $2', [s.stageId, s.contentHash]);
      return { id: existing.rows[0]!.id, created: false };
    }
    if (s.units.length > 0) {
      const docs = s.units.filter((u) => u.unitType === 'document_recognition');
      const mail = s.units.filter((u) => u.unitType === 'mail_message');
      const tr = s.units.filter((u) => u.unitType === 'transcript_revision');
      // Владелец единицы-договора и письмо единицы-вложения выводятся из редакции, письмо ревизии — из
      // ревизии, а не передаются (AD-06a-1 §8–9); FK и охранник единицы сверяют их.
      await tx.query(
        `INSERT INTO evidence_scope_item (scope_id, tender_id, contract_id, unit_type, document_revision_id, recognition_run_id,
                                          mail_message_id, mail_message_revision_id, transcript_revision_id, inclusion_reason)
         SELECT $1::uuid, $2::uuid, dr.contract_id, 'document_recognition', u.document_revision_id, u.recognition_run_id,
                document_revision_mail_message(u.document_revision_id), NULL::uuid, NULL::uuid, 'source_set_included'
           FROM unnest($3::uuid[], $4::uuid[]) AS u(document_revision_id, recognition_run_id)
           JOIN document_revision dr ON dr.id = u.document_revision_id
         UNION ALL
         SELECT $1::uuid, $2::uuid, NULL::uuid, 'mail_message', NULL::uuid, NULL::uuid, mr.message_id, mr.id, NULL::uuid, 'mail_linked'
           FROM unnest($5::uuid[]) AS m(id) JOIN mail_message_revision mr ON mr.id = m.id
         UNION ALL
         SELECT $1::uuid, $2::uuid, NULL::uuid, 'transcript_revision', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, t.id, 'negotiation_transcript'
           FROM unnest($6::uuid[]) AS t(id)`,
        [
          id,
          s.tenderId,
          docs.map((u) => u.documentRevisionId),
          docs.map((u) => u.recognitionRunId),
          mail.map((u) => u.mailMessageRevisionId),
          tr.map((u) => u.transcriptRevisionId),
        ],
      );
    }
    return { id, created: true };
  });

export const getEvidenceScope = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IEvidenceScopeRow | null> => {
  const r = await db.query<IEvidenceScopeRow>('SELECT * FROM evidence_scope WHERE id = $1 AND tender_id = ANY($2::uuid[])', [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

export const listEvidenceScopes = async (db: Queryable, stageId: string): Promise<(IEvidenceScopeRow & { units: number })[]> => {
  const r = await db.query<IEvidenceScopeRow & { units: number }>(
    `SELECT s.*, (SELECT count(*) FROM evidence_scope_item i WHERE i.scope_id = s.id) AS units
       FROM evidence_scope s WHERE s.stage_id = $1 ORDER BY s.created_at DESC, s.id`,
    [stageId],
  );
  return r.rows;
};

// Состав снимка со всеми полями; что из них показать пользователю, решает представление по его правам
// (contract.read, mail.read) — шапка письма без mail.read наружу не выходит.
export const evidenceScopeItems = async (db: Queryable, scopeId: string): Promise<IEvidenceScopeItemRow[]> => {
  const r = await db.query<IEvidenceScopeItemRow>(
    `SELECT i.unit_type, i.document_revision_id, i.recognition_run_id, i.inclusion_reason, i.contract_id, d.id AS document_id,
            d.title AS document_title, dr.revision_seq, r.status AS run_status, r.pages_total, r.pages_recognized,
            i.mail_message_id, mm.mailbox_id, i.mail_message_revision_id, mr.seq AS mail_revision_seq, mr.subject AS mail_subject,
            mr.sent_at AS mail_sent_at, i.transcript_revision_id, tr.seq AS transcript_seq, ns.id AS session_id, ns.title AS session_title
       FROM evidence_scope_item i
       LEFT JOIN document_revision dr ON dr.id = i.document_revision_id
       LEFT JOIN document d ON d.id = dr.document_id
       LEFT JOIN recognition_run r ON r.id = i.recognition_run_id
       LEFT JOIN mail_message mm ON mm.id = i.mail_message_id
       LEFT JOIN mail_message_revision mr ON mr.id = i.mail_message_revision_id
       LEFT JOIN transcript_revision tr ON tr.id = i.transcript_revision_id
       LEFT JOIN negotiation_session ns ON ns.id = tr.session_id
      WHERE i.scope_id = $1
      ORDER BY i.unit_type, d.title, dr.revision_seq, mr.sent_at, ns.started_at, i.id`,
    [scopeId],
  );
  return r.rows;
};

// Область режима review — единицы сохранённого снимка (ADR-008 §6): поздние прогоны, ревизии писем и
// редакции транскрипций не входят.
export const resolveSnapshotScope = async (db: Queryable, scope: IEvidenceScopeRow): Promise<IResolvedScope> => {
  const items = await db.query<{
    unit_type: IEvidenceScopeItemRow['unit_type'];
    recognition_run_id: string | null;
    contract_id: string | null;
    mail_message_id: string | null;
    mail_message_revision_id: string | null;
    transcript_revision_id: string | null;
    mailbox_id: string | null;
  }>(
    `SELECT i.unit_type, i.recognition_run_id, i.contract_id, i.mail_message_id, i.mail_message_revision_id, i.transcript_revision_id, m.mailbox_id
       FROM evidence_scope_item i LEFT JOIN mail_message m ON m.id = i.mail_message_id
      WHERE i.scope_id = $1`,
    [scope.id],
  );
  const docs = items.rows.filter((i) => i.unit_type === 'document_recognition');
  const docItems = docs.map((i) => ({ run_id: i.recognition_run_id, contract_id: i.contract_id, mail_message_id: i.mail_message_id, mailbox_id: i.mailbox_id }));
  const mail = items.rows
    .filter((i) => i.unit_type === 'mail_message')
    .map((i) => ({ revisionId: i.mail_message_revision_id!, messageId: i.mail_message_id!, mailboxId: i.mailbox_id! }));
  const transcripts = items.rows.filter((i) => i.unit_type === 'transcript_revision').map((i) => i.transcript_revision_id!);
  return {
    snapshotHash: scope.content_hash,
    unitIds: [...docs.flatMap((i) => (i.recognition_run_id ? [i.recognition_run_id] : [])), ...mail.map((m) => m.revisionId), ...transcripts].sort(),
    contractOf: contractUnits(docItems),
    mailOf: mailUnits(docItems, mail),
    revisionsWithoutRun: docs.filter((i) => i.recognition_run_id === null).length,
  };
};

// Права поверх закреплённой области (ADR-008 §4): снимок не даёт вечного разрешения. Возвращает
// единицы, доступ к которым у пользователя пропал. Прогон тендера — доступ к тендеру; прогон
// договора — contract.read, даже если единица закреплена в снимке тендера (D-022 OD-3); ревизия письма
// и прогон документа вложения — mail.read на ящик письма, доступ к тендеру контекста и связь письма с
// ним (AD-07-1a): в режиме working — действующая, в review — пара из снимка (снятие связи не стирает
// историческое доказательство, обязательный тест 10 D-025); редакция транскрипции — доступ к её тендеру.
// В контексте договора почтовых единиц нет, и тендер не передаётся.
export const unitsNotPermitted = async (
  db: Queryable,
  ctx: IAccessContext,
  unitIds: string[],
  tenderId: string | null = null,
  mode: 'working' | 'review' = 'working',
): Promise<string[]> => {
  if (unitIds.length === 0) return [];
  const tenders = contentTenderIds(ctx);
  const mailTender = tenderId && tenders.includes(tenderId) ? tenderId : null;
  const r = await db.query<{ id: string }>(
    `WITH linked AS (
       SELECT l.message_id FROM mail_message_tender l
        WHERE l.tender_id = $5::uuid AND ($6 OR l.status = 'linked'))
     SELECT u.id FROM unnest($1::uuid[]) AS u(id)
      WHERE NOT EXISTS (SELECT 1 FROM recognition_run r
                         WHERE r.id = u.id AND (r.tender_id = ANY($2::uuid[]) OR r.contract_id = ANY($3::uuid[])))
        AND NOT EXISTS (SELECT 1 FROM recognition_run r JOIN mail_message m ON m.id = document_revision_mail_message(r.document_revision_id)
                         WHERE r.id = u.id AND r.tender_id IS NULL AND r.contract_id IS NULL AND m.mailbox_id = ANY($4::uuid[])
                           AND m.id IN (SELECT message_id FROM linked))
        AND NOT EXISTS (SELECT 1 FROM mail_message_revision mr JOIN mail_message m ON m.id = mr.message_id
                         WHERE mr.id = u.id AND m.mailbox_id = ANY($4::uuid[]) AND m.id IN (SELECT message_id FROM linked))
        AND NOT EXISTS (SELECT 1 FROM transcript_revision t WHERE t.id = u.id AND t.tender_id = ANY($2::uuid[]))`,
    [unitIds, tenders, readableContractIds(ctx), readableMailboxIds(ctx), mailTender, mode === 'review'],
  );
  return r.rows.map((x) => x.id);
};

// ---------------------------------------------------------------- Охват

export interface IScopeCoverage {
  units: number;
  pagesRecognized: number;
  pagesTotal: number;
  unitsNotIndexed: number;
  // A43: сколько единиц области — локальное распознавание и сколько из них требуют проверки (partial).
  localUnits: number;
  localNeedsReview: number;
  // Этап 07: единицы писем и транскрипций в области (после фильтра прав).
  mailUnits: number;
  transcriptUnits: number;
}

// Охват области (ADR-008 §11): сколько единиц и страниц распознано и сколько единиц ещё не
// проиндексировано активной версией. Честная неполнота вместо тихого «ничего нет» (I07, I18).
// Локальные единицы считаются отдельно: происхождение не подменяется основной обработкой (A43).
export const scopeCoverage = async (db: Queryable, versionId: string, unitIds: string[]): Promise<IScopeCoverage> => {
  const r = await db.query<{
    pages_recognized: number | null;
    pages_total: number | null;
    not_indexed: number;
    local_units: number;
    local_review: number;
    mail_units: number;
    transcript_units: number;
  }>(
    `SELECT (SELECT sum(r.pages_recognized)::int FROM recognition_run r WHERE r.id = ANY($2::uuid[])) AS pages_recognized,
            (SELECT sum(r.pages_total)::int FROM recognition_run r WHERE r.id = ANY($2::uuid[])) AS pages_total,
            (SELECT count(*)::int FROM unnest($2::uuid[]) AS u(id)
              WHERE NOT EXISTS (SELECT 1 FROM search_index_unit s WHERE s.index_version_id = $1 AND s.source_unit_id = u.id)) AS not_indexed,
            (SELECT count(*)::int FROM recognition_run r WHERE r.id = ANY($2::uuid[]) AND r.engine = 'local_ocr') AS local_units,
            (SELECT count(*)::int FROM recognition_run r WHERE r.id = ANY($2::uuid[]) AND r.engine = 'local_ocr' AND r.status = 'partial') AS local_review,
            (SELECT count(*)::int FROM mail_message_revision m WHERE m.id = ANY($2::uuid[])) AS mail_units,
            (SELECT count(*)::int FROM transcript_revision t WHERE t.id = ANY($2::uuid[])) AS transcript_units`,
    [versionId, unitIds],
  );
  const row = r.rows[0]!;
  return {
    units: unitIds.length,
    pagesRecognized: row.pages_recognized ?? 0,
    pagesTotal: row.pages_total ?? 0,
    unitsNotIndexed: row.not_indexed,
    localUnits: row.local_units,
    localNeedsReview: row.local_review,
    mailUnits: row.mail_units,
    transcriptUnits: row.transcript_units,
  };
};
