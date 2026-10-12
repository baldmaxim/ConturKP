import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { createReleaseComparison, listReleaseComparisons, listTenderReleases } from '../../api/sendEndpoints';
import type { ITenderRelease } from '../../api/sendTypes';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { MODE_LABEL } from '../../utils/releaseLabels';
import { ComparisonResult, sideTitle } from './ComparisonResult';
import styles from './Comparison.module.css';

const releaseLabel = (r: ITenderRelease): string =>
  `Этап ${r.stage.seq} · комплект № ${r.candidateSeq} · ${MODE_LABEL[r.mode] ?? r.mode} · ${formatDateTime(r.releasedAt)}${r.send.counted > 0 ? ` · отправок: ${r.send.counted}` : ''}${r.restricted ? ' · входы закрыты для вас' : ''}`;

/**
 * Сравнение двух любых выпусков тендера (этап 15): любого этапа и режима. Стороны упорядочивает сервер — левая
 * выпущена раньше. Каждое сравнение — неизменяемая запись; повторный запуск создаёт новую.
 */
export const ReleaseComparisonPanel: FC<{ tenderId: string }> = ({ tenderId }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [version, setVersion] = useState(0);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const releases = useApiResource((signal) => listTenderReleases(tenderId, signal), `tender-releases:${tenderId}`);
  const comparisons = useApiResource((signal) => listReleaseComparisons(tenderId, signal), `release-comparisons:${tenderId}:${version}`);

  if (releases.error && !releases.data) return <ErrorState error={releases.error} onRetry={releases.reload} />;
  if (!releases.data) return <LoadingState />;
  const list = releases.data.items;
  if (list.length < 2) {
    return <EmptyState icon="layers" title="Сравнивать пока нечего" text="Сравнение строится между двумя выпусками тендера. Выпусков меньше двух." />;
  }
  const options = list.map((r) => ({ value: r.id, label: releaseLabel(r), disabled: r.restricted }));
  const run = (): void => {
    setBusy(true);
    createReleaseComparison(tenderId, left, right, idem.keyFor({ left, right, n: comparisons.data?.items.length ?? 0 })).then(
      (c) => {
        idem.reset();
        setBusy(false);
        setSelected(c.id);
        setVersion((v) => v + 1);
        toast.push({ kind: c.status === 'ready' ? 'success' : 'error', text: c.status === 'ready' ? 'Сравнение построено.' : `Сравнение не построено: ${c.failureReason ?? ''}` });
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };
  const items = comparisons.data?.items ?? [];
  const active = selected ?? items[0]?.id ?? null;
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>Сравниваются два выпуска: источники, требования, расчёт, вопросы, условия, решения и приложения — по записям, закреплённым в каждом выпуске.</p>
      {releases.data.canCompare ? (
        <div className={styles.selectors}>
          <SelectField label="Первый выпуск" value={left} onValueChange={setLeft} options={options} placeholder="Выберите выпуск" />
          <SelectField label="Второй выпуск" value={right} onValueChange={setRight} options={options} placeholder="Выберите выпуск" />
          <Button variant="primary" icon="layers" loading={busy} disabled={left === '' || right === '' || left === right} onClick={run}>
            Сравнить
          </Button>
        </div>
      ) : null}
      {items.length > 0 ? (
        <>
          <h3 className={styles.title}>Сравнения</h3>
          <ul className={styles.list}>
            {items.map((c) => (
              <li key={c.id} className={styles.card} data-active={c.id === active}>
                <button type="button" className={styles.cardButton} aria-pressed={c.id === active} onClick={() => setSelected(c.id)}>
                  <span>{`${sideTitle(c.left)} → ${sideTitle(c.right)}`}</span>
                  <span className={styles.muted}>
                    {`${formatDateTime(c.createdAt)} · ${c.requestedBy.name} · ${c.status === 'ready' ? `изменений: ${c.changes ? Object.values(c.changes).reduce((a, b) => a + b, 0) : 0}` : 'не построено'}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className={styles.muted}>Сравнений ещё нет.</p>
      )}
      {active ? <ComparisonResult key={active} comparisonId={active} /> : null}
    </div>
  );
};
