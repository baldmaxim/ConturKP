import type { FC } from 'react';
import type { IMailMessage } from '../../api/mailTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { formatDateTime } from '../../utils/datetime';
import { DIRECTION_LABELS } from '../../utils/mailLabels';
import list from '../../styles/list.module.css';

interface IMailMessagesListProps {
  items: IMailMessage[];
  emptyTitle: string;
  emptyText: string;
  /** Показывать ящик письма (в переписке тендера письма бывают из разных ящиков). */
  showMailbox?: boolean;
}

const subjectOf = (m: IMailMessage): string => m.subject ?? 'Без темы';

/** Список писем: таблица от 768 px, карточки на смартфоне. Письмо открывается карточкой с ревизиями. */
export const MailMessagesList: FC<IMailMessagesListProps> = ({ items, emptyTitle, emptyText, showMailbox = false }) => {
  if (items.length === 0) return <EmptyState icon="mail" title={emptyTitle} text={emptyText} />;
  return (
    <>
      <div className={list.tableWrap}>
        <table className={list.table}>
          <thead>
            <tr>
              <th scope="col">Тема</th>
              <th scope="col">Отправитель</th>
              <th scope="col">Отправлено, МСК</th>
              {showMailbox ? <th scope="col">Ящик</th> : null}
              <th scope="col">Вложения</th>
              <th scope="col">Ревизии</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>
                  <AppLink className={list.rowLink} to={`/mail-messages/${m.id}`}>
                    {subjectOf(m)}
                  </AppLink>
                  {m.direction === 'outbound' ? <Badge tone="info" icon="upload" label={DIRECTION_LABELS.outbound} /> : null}
                </td>
                <td className={list.mono}>{m.from ?? '—'}</td>
                <td className={list.num}>{m.sentAt ? formatDateTime(m.sentAt) : '—'}</td>
                {showMailbox ? <td>{m.mailboxName}</td> : null}
                <td className={list.num}>{m.attachments}</td>
                <td className={list.num}>{m.revisions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={list.cards}>
        {items.map((m) => (
          <li key={m.id} className={list.card}>
            <div className={list.cardHead}>
              <AppLink className={list.rowLink} to={`/mail-messages/${m.id}`}>
                {subjectOf(m)}
              </AppLink>
            </div>
            <dl className={list.meta}>
              <dt>Отправитель</dt>
              <dd className={list.mono}>{m.from ?? '—'}</dd>
              <dt>Отправлено</dt>
              <dd className={list.num}>{m.sentAt ? `${formatDateTime(m.sentAt)} МСК` : '—'}</dd>
              {showMailbox ? (
                <>
                  <dt>Ящик</dt>
                  <dd>{m.mailboxName}</dd>
                </>
              ) : null}
              <dt>Направление</dt>
              <dd>{DIRECTION_LABELS[m.direction]}</dd>
              <dt>Вложения · ревизии</dt>
              <dd className={list.num}>{`${m.attachments} · ${m.revisions}`}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
};
