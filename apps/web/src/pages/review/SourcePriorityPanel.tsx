import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { getSourcePriority, setSourcePriority } from '../../api/reviewEndpoints';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import styles from './Review.module.css';

/**
 * Приоритет источников тендера (D-029 В-09-1): упорядоченные виды источника. Приоритет подсказывает предлагаемую сторону
 * конфликта, но конфликт не разрешает и граф фактов не меняет; дата приоритетом не является. Меняет руководитель с причиной.
 */
export const SourcePriorityPanel: FC<{ tenderId: string }> = ({ tenderId }) => {
  const res = useApiResource((signal) => getSourcePriority(tenderId, signal), tenderId);
  const [draft, setDraft] = useState<{ kind: string; title: string }[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const toast = useToast();

  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const v = res.data;
  const order = draft ?? v.kinds;
  const move = (i: number, d: -1 | 1): void => {
    const next = [...order];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setDraft(next);
  };
  const save = async (): Promise<void> => {
    if (!reason.trim()) {
      setError('Укажите причину изменения');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await setSourcePriority(tenderId, { kinds: order.map((k) => k.kind), reason: reason.trim() }, idem.keyFor({ order, reason }));
      res.setData(next);
      setDraft(null);
      setReason('');
      idem.reset();
      toast.push({ kind: 'success', text: 'Приоритет источников сохранён' });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.block} aria-label="Приоритет источников">
      <h3 className={styles.blockTitle}>Приоритет источников</h3>
      <Notice tone="info">{v.note}</Notice>
      <p className={styles.muted}>{v.isDefault ? 'Действует порядок по умолчанию.' : `Ревизия № ${v.revisions[0]!.seq}: ${v.revisions[0]!.createdBy}, ${formatDateTime(v.revisions[0]!.createdAt)} — ${v.revisions[0]!.reason}`}</p>
      <ol className={styles.list}>
        {order.map((k, i) => (
          <li key={k.kind} className={styles.check}>
            <div className={styles.headLine}>
              <span className={styles.title}>{`${i + 1}. ${k.title}`}</span>
              {v.canManage ? (
                <span className={styles.push}>
                  <Button variant="ghost" iconOnly icon="chevron-down" aria-label={`Понизить «${k.title}»`} disabled={i === order.length - 1} onClick={() => move(i, 1)} />
                  <Button variant="ghost" iconOnly icon="arrow-left" aria-label={`Повысить «${k.title}»`} disabled={i === 0} onClick={() => move(i, -1)} />
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {v.canManage && draft ? (
        <>
          <TextAreaField label="Причина изменения" value={reason} onValueChange={setReason} rows={2} maxLength={1000} required />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className={styles.toolbar}>
            <Button variant="primary" icon="check" loading={busy} onClick={() => void save()}>
              Сохранить порядок
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
              Отменить
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
};
