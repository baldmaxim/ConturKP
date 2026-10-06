import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { decideWording, listWordings, proposeWording } from '../../api/formsEndpoints';
import type { IWording } from '../../api/formsTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import form from '../../styles/form.module.css';
import styles from './Forms.module.css';

const STATUS: Record<IWording['status'], { label: string; tone: 'success' | 'warning' | 'muted' }> = {
  proposed: { label: 'Предложена', tone: 'warning' },
  approved: { label: 'Утверждена', tone: 'success' },
  retired: { label: 'Выведена', tone: 'muted' },
};

/** Библиотека утверждённых формулировок: предлагает участник, утверждает руководитель (D-031 В-11-3). */
export const WordingsPanel: FC = () => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [query, setQuery] = useState('');
  const list = useApiResource((signal) => listWordings({ query: query.trim() || undefined }, signal), `wordings:${query}`);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>, done: string): void => {
    setBusy(true);
    fn().then(
      () => {
        setBusy(false);
        toast.push({ kind: 'success', text: done });
        list.reload();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };
  return (
    <section className={form.section} aria-labelledby="wordings-title">
      <h2 id="wordings-title" className={form.sectionTitle}>
        Утверждённые формулировки
      </h2>
      <form
        className={styles.fields}
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () =>
              proposeWording({ title: title.trim(), text, tags: [] }, idem.keyFor({ title, text })).then(() => {
                idem.reset();
                setTitle('');
                setText('');
              }),
            'Формулировка предложена на утверждение',
          );
        }}
      >
        <TextField label="Название формулировки" value={title} onValueChange={setTitle} maxLength={300} />
        <TextAreaField label="Текст" value={text} onValueChange={setText} rows={4} maxLength={100000} />
        <div className={styles.actions}>
          <Button type="submit" icon="plus" loading={busy} disabled={!title.trim() || !text.trim()}>
            Предложить
          </Button>
        </div>
      </form>
      <TextField label="Поиск" value={query} onValueChange={setQuery} />
      {list.loading && !list.data ? <LoadingState /> : null}
      {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.data && list.data.items.length === 0 ? <EmptyState icon="scroll-text" title="Формулировок нет" /> : null}
      <ul className={styles.list}>
        {(list.data?.items ?? []).map((w) => (
          <li key={w.versionId} className={styles.card}>
            <div className={styles.cardHead}>
              <p className={styles.label}>{`${w.title} · версия ${w.version}`}</p>
              <Badge label={STATUS[w.status].label} icon={w.status === 'approved' ? 'check' : 'circle-dot'} tone={STATUS[w.status].tone} />
            </div>
            <p className={styles.value}>{w.text}</p>
            <p className={styles.muted}>{`Предложил: ${w.proposedBy.name}`}</p>
            {list.data?.canApproveCompany && w.scopeTenderId === null && w.status !== 'retired' ? (
              <div className={styles.actions}>
                {w.status === 'proposed' ? (
                  <Button variant="primary" icon="check" loading={busy} onClick={() => run(() => decideWording(w, 'approved'), 'Формулировка утверждена')}>
                    Утвердить
                  </Button>
                ) : null}
                <Button variant="ghost" icon="archive" disabled={busy} onClick={() => run(() => decideWording(w, 'retired'), 'Формулировка выведена')}>
                  Вывести
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
};
