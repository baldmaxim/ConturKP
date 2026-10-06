import type { FC } from 'react';
import { fieldHistory } from '../../api/formsEndpoints';
import type { IFieldDefinition } from '../../api/formsTypes';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { formatFieldValue, ORIGIN_LABEL, STATE_LABEL } from '../../utils/formsLabels';
import styles from './Forms.module.css';

interface IFieldHistoryProps {
  draftId: string;
  definition: IFieldDefinition;
  token: number;
}

/** История правок поля: каждая версия — автор, время, происхождение, состояние; ручная правка после предложения видна. */
export const FieldHistory: FC<IFieldHistoryProps> = ({ draftId, definition, token }) => {
  const h = useApiResource((signal) => fieldHistory(draftId, definition.key, signal), `${draftId}:${definition.key}:${token}`);
  if (h.loading && !h.data) return <LoadingState />;
  if (h.error && !h.data) return <ErrorState error={h.error} onRetry={h.reload} />;
  const items = h.data?.items ?? [];
  return (
    <ol className={styles.history} aria-label={`История поля «${definition.label}»`}>
      {items.map((v, i) => {
        const prev = items[i + 1];
        const afterModel = v.origin === 'manual' && v.state === 'edited' && prev?.origin === 'model_suggestion';
        return (
          <li key={v.id} className={styles.historyItem}>
            <div className={styles.badges}>
              <Badge label={`Версия ${v.version}`} icon="circle-dot" tone="neutral" />
              <Badge label={STATE_LABEL[v.state].label} icon={STATE_LABEL[v.state].icon} tone={STATE_LABEL[v.state].tone} />
              {v.stale ? <Badge label="Устарело" icon="clock-alert" tone="warning" dashed /> : null}
            </div>
            <p className={styles.muted}>{`${v.actor.name} · ${formatDateTime(v.createdAt)} · ${ORIGIN_LABEL[v.origin]}${afterModel ? ' · изменено вручную после предложения модели' : ''}`}</p>
            <p className={styles.value}>{v.restricted ? 'Значение скрыто: среди оснований есть закрытые для вас материалы.' : formatFieldValue(definition, v.value)}</p>
            {v.comment ? <p className={styles.muted}>{`Комментарий: ${v.comment}`}</p> : null}
          </li>
        );
      })}
    </ol>
  );
};
