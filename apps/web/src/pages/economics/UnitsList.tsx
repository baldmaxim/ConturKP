import { useState, type FC } from 'react';
import { decideSuggestion, getComparisonUnits } from '../../api/economicsEndpoints';
import type { IComparisonUnit, IReasonSuggestion } from '../../api/economicsTypes';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { formatDecimal } from '../../utils/calculationLabels';
import { COMPONENT_LABEL, notDecomposedText, REASON_KIND_LABEL, REASON_STATUS_LABEL, signed, UNIT_KIND_LABEL } from '../../utils/economicsLabels';
import form from '../../styles/form.module.css';
import { ReasonDialog } from './ReasonDialog';
import styles from './Economics.module.css';

interface IUnitsListProps {
  comparisonId: string;
  canConfirm: boolean;
  refreshToken: number;
}

const Measure: FC<{ label: string; m: IComparisonUnit['cost'] }> = ({ label, m }) => (
  <span>
    {`${label}: ${formatDecimal(m.left)} → ${formatDecimal(m.right)} ₽`}
    {m.comparable ? <strong>{` (${signed(m.delta)})`}</strong> : <span className={styles.muted}>{` — несопоставимо: ${m.reason ?? ''}`}</span>}
  </span>
);

const Suggestion: FC<{ s: IReasonSuggestion; canConfirm: boolean; onDecided: () => void }> = ({ s, canConfirm, onDecided }) => {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = (d: 'accept' | 'reject') => {
    setBusy(true);
    decideSuggestion(s, d).then(
      () => {
        setBusy(false);
        toast.push({ kind: 'success', text: d === 'accept' ? 'Гипотеза принята: причина подтверждена.' : 'Гипотеза отклонена.' });
        onDecided();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: `Не записано: ${describeError(e)}` });
        onDecided();
      },
    );
  };
  return (
    <div className={styles.reason}>
      <div className={styles.row}>
        <Badge label={`Гипотеза модели: ${REASON_KIND_LABEL[s.reasonKind]}`} icon="scan-search" tone={s.status === 'expired' ? 'muted' : 'info'} dashed />
        {s.status === 'expired' ? <span className={styles.muted}>основание изменилось — гипотеза погашена</span> : null}
      </div>
      {s.restricted ? <p className={styles.muted}>Среди оснований есть то, что вы не можете читать: текст скрыт.</p> : <p className={styles.quote}>{s.rationale}</p>}
      {!s.restricted ? s.evidence.map((f) => <p key={f.fragmentId} className={styles.quote}>{f.text}</p>) : null}
      {canConfirm && s.status === 'open' && !s.restricted ? (
        <div className={styles.row}>
          <Button variant="primary" icon="check" loading={busy} onClick={() => act('accept')}>
            Подтвердить
          </Button>
          <Button variant="ghost" icon="x" disabled={busy} onClick={() => act('reject')}>
            Отклонить
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/** Единицы сравнения: дельты по мерам, вклады в порядке метода, причина со статусом и гипотезы модели отдельно. */
export const UnitsList: FC<IUnitsListProps> = ({ comparisonId, canConfirm, refreshToken }) => {
  const [changedOnly, setChangedOnly] = useState(true);
  const [after, setAfter] = useState(0);
  const [editing, setEditing] = useState<IComparisonUnit | null>(null);
  const page = useApiResource((signal) => getComparisonUnits(comparisonId, changedOnly, after, signal), `${comparisonId}:${changedOnly}:${after}:${refreshToken}`);
  if (page.loading && !page.data) return <LoadingState />;
  if (page.error && !page.data) return <ErrorState error={page.error} onRetry={page.reload} />;
  const items = page.data?.items ?? [];
  return (
    <section className={form.section} aria-labelledby="econ-units-title">
      <div className={form.sectionHead}>
        <h3 id="econ-units-title" className={form.sectionTitle}>
          Единицы сравнения
        </h3>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(ev) => {
              setChangedOnly(ev.target.checked);
              setAfter(0);
            }}
          />
          только изменившиеся
        </label>
      </div>
      <ul className={styles.list}>
        {items.map((u) => (
          <li key={u.id} className={styles.unit}>
            <div className={styles.unitHead}>
              <span className={styles.unitNo}>{`№ ${u.unitNo}`}</span>
              <span className={styles.unitTitle}>{u.title}</span>
              <Badge label={UNIT_KIND_LABEL[u.kind] ?? u.kind} icon={u.kind === 'matched' ? 'link' : 'layers'} tone={u.kind === 'matched' ? 'neutral' : 'warning'} />
            </div>
            <p className={styles.amounts}>
              <Measure label="Себестоимость" m={u.cost} />
              <Measure label="Коммерческая" m={u.commercial} />
            </p>
            {u.columns.shift ? <p className={styles.muted}>Сумма колонок КП не изменилась, но изменилась раскладка между «Материалами» и «Работами».</p> : null}
            {u.effects.length > 0 ? (
              <ul className={styles.effects} aria-label="Вклады">
                {u.effects.map((e) => {
                  const why = notDecomposedText(e.lineRefs?.notes);
                  return (
                    <li key={`${e.measure}:${e.component}`} className={styles.effect}>
                      <span>{`${e.measure === 'cost' ? 'себест.' : 'коммерч.'} · ${COMPONENT_LABEL[e.component] ?? e.component}${why ? `: ${why}` : ''}`}</span>
                      <span className={styles.effectAmount}>{signed(e.amount)}</span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div className={styles.reason}>
              <div className={styles.row}>
                <Badge
                  label={`Причина: ${u.explanation ? `${REASON_KIND_LABEL[u.explanation.reasonKind]}, ${REASON_STATUS_LABEL[u.explanation.reasonStatus]}` : 'не установлена'}`}
                  icon={u.explanation?.reasonStatus === 'confirmed' ? 'check' : 'info'}
                  tone={u.explanation?.reasonStatus === 'confirmed' ? 'success' : 'muted'}
                  dashed={u.explanation?.reasonStatus !== 'confirmed'}
                />
                {u.explanation?.basisChanged ? <Badge label="основание изменилось" icon="repeat" tone="warning" /> : null}
                {canConfirm ? (
                  <Button variant="secondary" icon="pencil" onClick={() => setEditing(u)}>
                    Указать причину
                  </Button>
                ) : null}
              </div>
              {u.explanation && !u.explanation.restricted && u.explanation.rationale ? <p className={styles.quote}>{u.explanation.rationale}</p> : null}
              {u.explanation?.restricted ? <p className={styles.muted}>Среди оснований причины есть то, что вы не можете читать: текст скрыт.</p> : null}
            </div>
            {u.suggestions.map((s) => (
              <Suggestion key={s.id} s={s} canConfirm={canConfirm} onDecided={page.reload} />
            ))}
          </li>
        ))}
      </ul>
      {items.length === 0 ? <p className={styles.muted}>Изменившихся единиц нет.</p> : null}
      <div className={styles.row}>
        {after > 0 ? (
          <Button variant="ghost" onClick={() => setAfter(0)}>
            К началу
          </Button>
        ) : null}
        {page.data?.hasMore && page.data.nextAfter !== null ? (
          <Button variant="secondary" icon="chevron-right" onClick={() => setAfter(page.data!.nextAfter!)}>
            Дальше
          </Button>
        ) : null}
      </div>
      {editing ? (
        <ReasonDialog
          unit={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            page.reload();
          }}
        />
      ) : null}
    </section>
  );
};
