import type { FC } from 'react';
import { revisionContentUrl } from '../../api/sourceEndpoints';
import type { IRevision } from '../../api/types';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { formatDateTime } from '../../utils/datetime';
import { RecognitionPanel } from './RecognitionPanel';
import { formatBytes, occurrenceKindLabel, shortSha } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './RevisionList.module.css';

interface IRevisionListProps {
  revisions: IRevision[];
  latestRevisionId: string | null;
  canWrite: boolean;
}

/** Редакции документа (новые сверху) и происхождения каждой редакции. */
export const RevisionList: FC<IRevisionListProps> = ({ revisions, latestRevisionId, canWrite }) => {
  if (revisions.length === 0) {
    return <EmptyState icon="file-question-mark" title="Редакций нет" text="У документа пока нет зарегистрированных редакций." />;
  }
  const sorted = [...revisions].sort((a, b) => b.revisionSeq - a.revisionSeq);

  return (
    <ul className={styles.cards}>
      {sorted.map((rev) => (
        <li key={rev.id} className={list.card}>
          <div className={list.cardHead}>
            <h3 className={list.cardTitle}>{`Ред. ${rev.revisionSeq}`}</h3>
            {rev.id === latestRevisionId ? (
              <Badge tone="neutral" icon="check" label="Последняя редакция" />
            ) : (
              <Badge tone="warning" icon="clock-alert" dashed label="Не последняя редакция" />
            )}
          </div>
          <dl className={list.meta}>
            <dt>Получена</dt>
            <dd className={list.num}>{formatDateTime(rev.receivedAt)} МСК</dd>
            <dt>Размер</dt>
            <dd className={list.num}>{formatBytes(rev.sizeBytes)}</dd>
            <dt>Тип файла</dt>
            <dd className={list.mono}>{rev.mediaType}</dd>
            <dt>SHA-256</dt>
            <dd className={list.mono} title={rev.sha256}>
              {`${shortSha(rev.sha256)}…`}
            </dd>
          </dl>
          <div>
            <a className={styles.open} href={revisionContentUrl(rev.id)} target="_blank" rel="noopener">
              <Icon name="external-link" size={16} />
              <span>Открыть или скачать оригинал</span>
            </a>
          </div>
          <details className={styles.occurrences}>
            <summary className={styles.summary}>
              <Icon name="chevron-down" size={16} className={styles.chevron} />
              <span>{`Происхождение: ${rev.occurrences.length}`}</span>
            </summary>
            {rev.occurrences.length === 0 ? (
              <p className={list.muted}>Нет данных о происхождении.</p>
            ) : (
              <ul className={styles.occList}>
                {rev.occurrences.map((occ) => (
                  <li key={occ.id} className={styles.occ}>
                    <div className={styles.occHead}>
                      <span className={styles.kind}>{occurrenceKindLabel(occ.sourceKind)}</span>
                      <span className={list.num}>{`${formatDateTime(occ.observedAt)} МСК`}</span>
                    </div>
                    <span className={styles.name}>{occ.observedName}</span>
                    <span className={styles.locator}>{occ.sourceLocator}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
          <RecognitionPanel revisionId={rev.id} canWrite={canWrite} />
        </li>
      ))}
    </ul>
  );
};
