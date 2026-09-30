// Связь письма с тендером (этап 07, D-025: OD-07-7). Связь создаёт и снимает только пользователь
// с mail.link (и доступом к тендеру); система лишь предлагает кандидатов по точным признакам.
// Подтверждённая связь — событие барьера communication_linked (state-machines §1.1); снятие связи
// письмо, ревизии и исторические снимки не трогает.
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';
import { emitStageEvents } from './stageEvents.ts';

export interface IMailLinkRow {
  id: string;
  message_id: string;
  tender_id: string;
  tender_code: string;
  tender_title: string;
  stage_id: string | null;
  status: 'linked' | 'unlinked';
  linked_by: string;
  linked_at: Date;
  updated_at: Date;
  row_version: number;
}

// Связи письма с тендерами, которые пользователь видит (чужие тендеры не называются).
export const listMessageLinks = async (db: Queryable, ctx: IAccessContext, messageId: string): Promise<IMailLinkRow[]> => {
  const r = await db.query<IMailLinkRow>(
    `SELECT l.id, l.message_id, l.tender_id, t.code AS tender_code, t.title AS tender_title, l.stage_id, l.status, l.linked_by, l.linked_at,
            l.updated_at, l.row_version
       FROM mail_message_tender l JOIN tender t ON t.id = l.tender_id
      WHERE l.message_id = $1 AND l.tender_id = ANY($2::uuid[])
      ORDER BY t.code, l.id`,
    [messageId, contentTenderIds(ctx)],
  );
  return r.rows;
};

export const getMessageLink = async (db: Queryable, messageId: string, tenderId: string, lock = false): Promise<IMailLinkRow | null> => {
  const r = await db.query<IMailLinkRow>(
    `SELECT l.id, l.message_id, l.tender_id, t.code AS tender_code, t.title AS tender_title, l.stage_id, l.status, l.linked_by, l.linked_at,
            l.updated_at, l.row_version
       FROM mail_message_tender l JOIN tender t ON t.id = l.tender_id
      WHERE l.message_id = $1 AND l.tender_id = $2${lock ? ' FOR UPDATE OF l' : ''}`,
    [messageId, tenderId],
  );
  return r.rows[0] ?? null;
};

export type LinkOutcome = 'linked' | 'relinked' | 'already_linked' | 'stage_changed';

// Связать письмо с тендером (и, при необходимости, этапом). Пара одна на всю историю: повторная связь
// после снятия — тот же ряд со статусом linked. Событие барьера — этапу связи или всем активным этапам.
export const linkMessage = async (
  db: Queryable,
  l: { messageId: string; tenderId: string; stageId: string | null; userId: string },
): Promise<{ outcome: LinkOutcome; link: IMailLinkRow }> => {
  const prev = await getMessageLink(db, l.messageId, l.tenderId, true);
  let outcome: LinkOutcome;
  if (!prev) {
    await db.query(
      `INSERT INTO mail_message_tender (message_id, tender_id, stage_id, linked_by, updated_by) VALUES ($1, $2, $3, $4, $4)`,
      [l.messageId, l.tenderId, l.stageId, l.userId],
    );
    outcome = 'linked';
  } else if (prev.status === 'linked' && prev.stage_id === l.stageId) {
    return { outcome: 'already_linked', link: prev };
  } else {
    await db.query(
      `UPDATE mail_message_tender SET status = 'linked', stage_id = $3, updated_by = $4, updated_at = now(), row_version = row_version + 1
        WHERE message_id = $1 AND tender_id = $2`,
      [l.messageId, l.tenderId, l.stageId, l.userId],
    );
    outcome = prev.status === 'linked' ? 'stage_changed' : 'relinked';
  }
  const link = (await getMessageLink(db, l.messageId, l.tenderId))!;
  await emitStageEvents(db, {
    tenderId: l.tenderId,
    stageIds: l.stageId ? [l.stageId] : null,
    eventType: 'communication_linked',
    refType: 'mail_message',
    refId: l.messageId,
    actorUserId: l.userId,
  });
  return { outcome, link };
};

export const unlinkMessage = async (db: Queryable, l: { messageId: string; tenderId: string; userId: string }): Promise<boolean> => {
  const r = await db.query(
    `UPDATE mail_message_tender SET status = 'unlinked', updated_by = $3, updated_at = now(), row_version = row_version + 1
      WHERE message_id = $1 AND tender_id = $2 AND status = 'linked'`,
    [l.messageId, l.tenderId, l.userId],
  );
  return (r.rowCount ?? 0) > 0;
};

// ---------------------------------------------------------------- Кандидаты связи (OD-07-7)

export interface ILinkCandidate {
  tenderId: string;
  tenderCode: string;
  tenderTitle: string;
  reasons: ('tender_code_in_subject' | 'tender_code_in_body' | 'tenderhub_number_in_subject' | 'tenderhub_number_in_body')[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Точное вхождение идентификатора как отдельного токена: соседние символы — не буквы и не цифры.
const hasToken = (text: string, token: string): boolean =>
  token.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(token)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

// Только детерминированные признаки: точный код тендера портала и точный номер тендера TenderHub
// (external_ref) в теме или тексте письма. Нечёткого и смыслового сопоставления нет; кандидат —
// рекомендация, связью он не становится. Предлагаются только тендеры, доступные пользователю, и только
// те, с которыми письмо ещё не связано.
export const linkCandidates = async (
  db: Queryable,
  ctx: IAccessContext,
  m: { messageId: string; subject: string | null; bodyText: string },
): Promise<ILinkCandidate[]> => {
  const tenders = await db.query<{ id: string; code: string; title: string; numbers: string[] }>(
    `SELECT t.id, t.code, t.title,
            coalesce(array_agg(e.external_id) FILTER (WHERE e.external_id IS NOT NULL), '{}') AS numbers
       FROM tender t
       LEFT JOIN external_ref e ON e.tender_id = t.id AND e.entity_type = 'tender' AND e.system = 'tenderhub'
      WHERE t.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM mail_message_tender l WHERE l.message_id = $2 AND l.tender_id = t.id AND l.status = 'linked')
      GROUP BY t.id, t.code, t.title`,
    [contentTenderIds(ctx), m.messageId],
  );
  const subject = m.subject ?? '';
  const out: ILinkCandidate[] = [];
  for (const t of tenders.rows) {
    const reasons: ILinkCandidate['reasons'] = [];
    if (hasToken(subject, t.code)) reasons.push('tender_code_in_subject');
    else if (hasToken(m.bodyText, t.code)) reasons.push('tender_code_in_body');
    for (const n of t.numbers) {
      if (hasToken(subject, n)) reasons.push('tenderhub_number_in_subject');
      else if (hasToken(m.bodyText, n)) reasons.push('tenderhub_number_in_body');
    }
    if (reasons.length > 0) out.push({ tenderId: t.id, tenderCode: t.code, tenderTitle: t.title, reasons: [...new Set(reasons)] });
  }
  return out.sort((a, b) => a.tenderCode.localeCompare(b.tenderCode));
};
