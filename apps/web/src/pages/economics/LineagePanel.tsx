import { useMemo, useState, type FC } from 'react';
import { decideLineage, getLineage } from '../../api/economicsEndpoints';
import type { ILineageRow, IPositionBrief } from '../../api/economicsTypes';
import { describeError, hasCode } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { LINEAGE_METHOD_LABEL } from '../../utils/economicsLabels';
import form from '../../styles/form.module.css';
import styles from './Economics.module.css';

interface ILineagePanelProps {
  comparisonId: string;
  canDecide: boolean;
  onChanged: () => void;
}

const label = (p: IPositionBrief | undefined): string => (p ? `${p.positionNumber} · ${p.workName}${p.unitCode ? ` (${p.unitCode})` : ''}` : '—');

/**
 * Сопоставление позиций (D-030 В-10-5): система подтверждает только ту же позицию источника одного экземпляра, тендера
 * и версии; пары по ключам — предложения, их подтверждает инженер (в том числе пакетом по методу); неоднозначные пары и
 * разделения — вручную. Решения дописываются; новое сравнение учитывает подтверждённые пары.
 */
export const LineagePanel: FC<ILineagePanelProps> = ({ comparisonId, canDecide, onChanged }) => {
  const toast = useToast();
  const view = useApiResource((signal) => getLineage(comparisonId, signal), comparisonId);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const data = view.data;
  const leftBy = useMemo(() => new Map((data?.left ?? []).map((p) => [p.externalPositionId, p])), [data]);
  const rightBy = useMemo(() => new Map((data?.right ?? []).map((p) => [p.externalPositionId, p])), [data]);
  if (view.loading && !data) return <LoadingState />;
  if (view.error && !data) return <ErrorState error={view.error} onRetry={view.reload} />;
  if (!data) return null;

  const proposed = data.items.filter((i) => i.status === 'proposed');
  const confirmed = data.items.filter((i) => i.status === 'confirmed');
  const byMethod = new Map<string, ILineageRow[]>();
  for (const p of proposed) byMethod.set(p.method, [...(byMethod.get(p.method) ?? []), p]);

  const send = (decisions: { fromPositionId: string; toPositionId: string; status: 'confirmed' | 'rejected' }[], done: string): void => {
    setBusy(true);
    decideLineage(comparisonId, data.version, decisions).then(
      () => {
        setBusy(false);
        toast.push({ kind: 'success', text: done });
        view.reload();
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: hasCode(e, 'VERSION_CONFLICT') ? 'Решения по парам изменил другой пользователь: список обновлён.' : `Не записано: ${describeError(e)}` });
        view.reload();
      },
    );
  };

  const sources = data.left.filter((p) => !p.isSection);
  const targets = data.right.filter((p) => !p.isSection);

  return (
    <section className={form.section} aria-labelledby="econ-lineage-title">
      <div className={form.sectionHead}>
        <h3 id="econ-lineage-title" className={form.sectionTitle}>
          Сопоставление позиций
        </h3>
        <Badge label={`подтверждено ${confirmed.length} · предложено ${proposed.length}`} icon="link" tone={proposed.length > 0 ? 'warning' : 'neutral'} />
      </div>
      {data.version > data.comparisonLineageSeq ? (
        <Notice tone="warning">После этого сравнения появились новые решения по парам: запустите сравнение заново, чтобы вклады их учли.</Notice>
      ) : null}
      {[...byMethod.entries()].map(([method, rows]) => (
        <div key={method} className={styles.unit}>
          <div className={styles.row}>
            <span className={styles.unitTitle}>{`${LINEAGE_METHOD_LABEL[method] ?? method}: ${rows.length}`}</span>
            {canDecide ? (
              <Button
                variant="primary"
                icon="check"
                loading={busy}
                onClick={() => send(rows.map((r) => ({ fromPositionId: r.fromPositionId, toPositionId: r.toPositionId, status: 'confirmed' })), `Подтверждено пар: ${rows.length}`)}
              >
                Подтвердить все
              </Button>
            ) : null}
          </div>
          <p className={styles.muted}>Совпадение ключа — предложение: проверьте пары перед подтверждением.</p>
          <ul className={styles.list}>
            {rows.slice(0, 20).map((r) => (
              <li key={r.id} className={styles.row}>
                <span className={styles.muted}>{`${label(leftBy.get(r.fromPositionId))} → ${label(rightBy.get(r.toPositionId))}`}</span>
                {canDecide ? (
                  <Button variant="ghost" icon="x" disabled={busy} onClick={() => send([{ fromPositionId: r.fromPositionId, toPositionId: r.toPositionId, status: 'rejected' }], 'Предложение отклонено')}>
                    Отклонить
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {rows.length > 20 ? <p className={styles.muted}>{`Ещё ${rows.length - 20} — подтверждаются пакетом вместе с показанными.`}</p> : null}
        </div>
      ))}
      {data.ambiguous.length > 0 ? (
        <Notice tone="warning">
          {`Неоднозначных групп: ${data.ambiguous.length}. Одна работа в разных секциях или расхождение ключей — пары задаются вручную.`}
        </Notice>
      ) : null}
      {canDecide ? (
        <form
          className={styles.pairForm}
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!left || !right) return;
            send([{ fromPositionId: left, toPositionId: right, status: 'confirmed' }], 'Пара задана вручную');
            setRight('');
          }}
        >
          <SelectField label="Позиция прежней ревизии" value={left} onValueChange={setLeft} placeholder="Выберите позицию" options={sources.map((p) => ({ value: p.externalPositionId, label: label(p) }))} />
          <SelectField label="Позиция новой ревизии" value={right} onValueChange={setRight} placeholder="Выберите позицию" options={targets.map((p) => ({ value: p.externalPositionId, label: label(p) }))} />
          <div className={form.actions}>
            <Button type="submit" variant="secondary" icon="link" disabled={!left || !right} loading={busy}>
              Задать пару вручную
            </Button>
          </div>
          <p className={styles.muted}>Разделение позиции — несколько пар с одной прежней позицией; объединение — наоборот.</p>
        </form>
      ) : null}
    </section>
  );
};
