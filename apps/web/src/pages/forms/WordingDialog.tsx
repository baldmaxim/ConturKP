import { useState, type FC } from 'react';
import { listWordings } from '../../api/formsEndpoints';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import styles from './Forms.module.css';

interface IWordingDialogProps {
  tenderId: string;
  busy: boolean;
  onChoose: (wordingVersionId: string) => void;
  onClose: () => void;
}

/** «Выбрать»: утверждённая формулировка библиотеки компании или этого тендера; версия закрепляется в значении. */
export const WordingDialog: FC<IWordingDialogProps> = ({ tenderId, busy, onChoose, onClose }) => {
  const [query, setQuery] = useState('');
  const list = useApiResource((signal) => listWordings({ tenderId, query: query.trim() || undefined, status: 'approved' }, signal), `${tenderId}:${query}`);
  return (
    <Dialog title="Утверждённые формулировки" onClose={onClose} busy={busy}>
      <div className={styles.fields}>
        <TextField label="Поиск по названию и тексту" value={query} onValueChange={setQuery} />
        {list.loading && !list.data ? <LoadingState /> : null}
        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data && list.data.items.length === 0 ? <EmptyState icon="scroll-text" title="Нет утверждённых формулировок" text="Предложите формулировку на странице «Шаблоны и формулировки»." /> : null}
        <ul className={styles.list}>
          {(list.data?.items ?? []).map((w) => (
            <li key={w.versionId} className={styles.card}>
              <p className={styles.label}>{`${w.title} · версия ${w.version}`}</p>
              <p className={styles.value}>{w.text}</p>
              <div className={styles.actions}>
                <Button variant="primary" icon="check" loading={busy} onClick={() => onChoose(w.versionId)}>
                  Выбрать
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
};
