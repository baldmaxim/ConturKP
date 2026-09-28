import { useEffect, useState, type FC } from 'react';
import type { ICalculationLine, ICalculationPosition } from '../../api/calculationTypes';
import { getCalculationLines, getCalculationPositions } from '../../api/calculationEndpoints';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { formatDecimal, formatMoney } from '../../utils/calculationLabels';
import styles from './Calculation.module.css';

interface ICalculationPositionsProps {
  revisionId: string;
}

const Lines: FC<{ revisionId: string; positionId: string }> = ({ revisionId, positionId }) => {
  const [lines, setLines] = useState<ICalculationLine[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    getCalculationLines(revisionId, positionId, null, controller.signal).then(
      (page) => {
        setLines(page.items);
        setCursor(page.hasMore ? page.nextCursor : null);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(e);
      },
    );
    return () => controller.abort();
  }, [revisionId, positionId]);
  // Строк у позиции может быть больше одной страницы: догружаются явно, без молчаливого усечения.
  const more = (): void => {
    setBusy(true);
    getCalculationLines(revisionId, positionId, cursor).then(
      (page) => {
        setLines((prev) => [...(prev ?? []), ...page.items]);
        setCursor(page.hasMore ? page.nextCursor : null);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e);
        setBusy(false);
      },
    );
  };
  if (error) return <Notice tone="danger">{describeError(error)}</Notice>;
  if (!lines) return <LoadingState />;
  if (lines.length === 0) return <p className={styles.muted}>У позиции нет строк сметы.</p>;
  return (
    <>
      <ul className={styles.lines} aria-label="Строки сметы позиции">
        {lines.map((l) => (
          <li key={l.externalItemId} className={styles.lineItem}>
            <div className={styles.cardHead}>
              <span className={styles.type}>{l.itemType}</span>
              <span className={styles.name}>{l.workName ?? l.materialName ?? l.description ?? '—'}</span>
            </div>
            <p className={styles.line}>
              {`${formatDecimal(l.quantity)} ${l.unitCode ?? ''} × ${formatMoney(l.unitRate)}`}
              {l.parentWorkExternalItemId ? ' · к работе' : ''}
            </p>
            {/* Коммерческая стоимость строки — две составляющие источника, каждая со своей подписью. */}
            <p className={styles.line}>
              {`Себестоимость ${formatMoney(l.totalAmount)}`}
              {l.totalCommercialMaterial ? ` · КП материалов ${formatMoney(l.totalCommercialMaterial)}` : ''}
              {l.totalCommercialWork ? ` · КП работ ${formatMoney(l.totalCommercialWork)}` : ''}
              {l.costCategory ? ` · ${l.costCategory}` : ''}
            </p>
          </li>
        ))}
      </ul>
      {cursor ? (
        <Button loading={busy} onClick={more}>
          Показать ещё строки
        </Button>
      ) : null}
    </>
  );
};

/**
 * Позиции ВОР ревизии в порядке номера: заголовок раздела показан как раздел и работой не считается;
 * пустые и дополнительные позиции видны; manual_volume — значение источника без подтверждённой семантики.
 */
export const CalculationPositions: FC<ICalculationPositionsProps> = ({ revisionId }) => {
  const [items, setItems] = useState<ICalculationPosition[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // Первая страница — при смене ревизии; ответ прежней ревизии отбрасывается.
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setOpen(null);
    setError(null);
    setBusy(true);
    getCalculationPositions(revisionId, null, controller.signal).then(
      (page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
        setDone(!page.hasMore);
        setBusy(false);
      },
      (e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e);
        setBusy(false);
      },
    );
    return () => controller.abort();
  }, [revisionId]);

  const more = (): void => {
    setBusy(true);
    getCalculationPositions(revisionId, cursor).then(
      (page) => {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setDone(!page.hasMore);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e);
        setBusy(false);
      },
    );
  };

  return (
    <div className={styles.positions}>
      {error ? <Notice tone="danger">{describeError(error)}</Notice> : null}
      <ul className={styles.list} aria-label="Позиции ВОР">
        {items.map((p) => {
          const expanded = open === p.externalPositionId;
          return (
            <li key={p.externalPositionId} className={p.isSection ? styles.section : styles.card}>
              <button
                type="button"
                className={styles.positionHead}
                aria-expanded={p.isSection ? undefined : expanded}
                disabled={p.isSection}
                onClick={() => setOpen(expanded ? null : p.externalPositionId)}
              >
                <span className={styles.number}>{p.itemNo ?? formatDecimal(p.positionNumber)}</span>
                <span className={styles.name}>{p.workName}</span>
              </button>
              {p.isSection ? (
                <p className={styles.muted}>Заголовок раздела — не работа.</p>
              ) : (
                <>
                  <div className={styles.badges}>
                    {p.isAdditional ? <Badge label="ДОП" icon="plus" tone="info" /> : null}
                    {p.lines === 0 ? <Badge label="Без строк" icon="info" tone="muted" dashed /> : null}
                  </div>
                  <p className={styles.line}>
                    {`${formatDecimal(p.volume)} ${p.unitCode ?? ''} · себестоимость ${formatMoney(p.totals.baseTotal)} · КП ${formatMoney(p.totals.commercialTotal)}`}
                  </p>
                  {p.manualVolume ? (
                    <p className={styles.muted}>{`manual_volume источника: ${formatDecimal(p.manualVolume.value)}${p.manualVolume.note ? ` (${p.manualVolume.note})` : ''} — семантика не подтверждена, объёмом не считается.`}</p>
                  ) : null}
                  {expanded ? <Lines revisionId={revisionId} positionId={p.externalPositionId} /> : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {busy && items.length === 0 ? <LoadingState /> : null}
      {!done && items.length > 0 ? (
        <Button loading={busy} onClick={more}>
          Показать ещё
        </Button>
      ) : null}
    </div>
  );
};
