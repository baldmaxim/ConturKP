import type { FC } from 'react';
import type { IEvidenceDetail } from '../../api/types';
import { AppLink } from '../../components/AppLink';
import { Notice } from '../../components/Notice';
import { formatDateTime } from '../../utils/datetime';
import { formatTimecode } from '../../utils/mailLabels';
import list from '../../styles/list.module.css';
import styles from './EvidenceViewer.module.css';

interface IEvidenceSourceProps {
  fragment: IEvidenceDetail;
}

/**
 * Источник доказательства вне документа (этап 07): письмо или реплика переговоров. Оригинал письма —
 * его ревизия; вложение — документ, приложенный к письму. Подсказка участнику речью заказчика не является.
 */
export const EvidenceSource: FC<IEvidenceSourceProps> = ({ fragment }) => {
  const { mail, transcript } = fragment;
  if (fragment.sourceKind === 'mail_message_revision' && mail) {
    return (
      <dl className={list.meta}>
        <dt>Письмо</dt>
        <dd>
          <AppLink to={`/mail-messages/${mail.messageId}`}>{mail.subject ?? 'Без темы'}</AppLink>
        </dd>
        <dt>Отправитель</dt>
        <dd>{mail.from ?? '—'}</dd>
        <dt>Отправлено</dt>
        <dd className={list.num}>{mail.sentAt ? `${formatDateTime(mail.sentAt)} МСК` : '—'}</dd>
        <dt>Ревизия</dt>
        <dd className={list.mono}>{mail.revisionId ?? '—'}</dd>
      </dl>
    );
  }
  if (fragment.sourceKind === 'transcript_revision' && transcript) {
    return (
      <>
        {transcript.segmentKind === 'hint' ? (
          <Notice tone="warning">Это подсказка сервиса переговоров участнику, а не слова стороны переговоров.</Notice>
        ) : null}
        <dl className={list.meta}>
          <dt>Переговоры</dt>
          <dd>
            {transcript.sessionId ? (
              <AppLink to={`/negotiation-sessions/${transcript.sessionId}?revision=${transcript.revisionId}`}>{transcript.sessionTitle ?? 'Без названия'}</AppLink>
            ) : (
              '—'
            )}
          </dd>
          <dt>Говорящий</dt>
          <dd>{transcript.speakerLabel ?? '—'}</dd>
          <dt>Время</dt>
          <dd className={list.num}>
            {transcript.startMs !== null && transcript.endMs !== null ? `${formatTimecode(transcript.startMs)}–${formatTimecode(transcript.endMs)}` : '—'}
          </dd>
        </dl>
      </>
    );
  }
  if (mail) {
    return (
      <p className={styles.crop}>
        {'Документ — вложение к письму '}
        <AppLink to={`/mail-messages/${mail.messageId}`}>{`«${mail.subject ?? 'без темы'}»`}</AppLink>
        {mail.attachmentFilename ? ` (${mail.attachmentFilename})` : ''}
      </p>
    );
  }
  return null;
};
