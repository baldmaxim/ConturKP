import { useState, type FC } from 'react';
import { listReleaseDeliveries, placeRelease } from '../../api/deliveryEndpoints';
import { describeError } from '../../api/errors';
import { Button } from '../../components/Button';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { WORKING_STATUSES } from '../../utils/deliveryLabels';
import { DeliveryRow } from './DeliveryRow';
import styles from './Release.module.css';

/**
 * Размещение выпуска (этап 14; D-034): по строке на назначение, у каждого свой статус и свои действия (A28). «Размещено»
 * не означает «отправлено заказчику» (A31); у Яндекс Диска «проверено в локальной папке» и «доставлено в облако» —
 * разные отметки. Пока идёт размещение — опрос раз в 3 секунды.
 */
export const DeliveriesPanel: FC<{ releaseId: string }> = ({ releaseId }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const res = useApiResource((signal) => listReleaseDeliveries(releaseId, signal), `deliveries:${releaseId}`);
  const data = res.data;
  const items = data?.items ?? [];
  const working = items.some((d) => WORKING_STATUSES.has(d.status));
  usePolling(working, res.reload);
  if (!data) return null;
  const s = data.summary;
  const place = (): void => {
    setBusy(true);
    placeRelease(releaseId, idem.keyFor({ releaseId, missing: s.missing })).then(
      (r) => {
        idem.reset();
        setBusy(false);
        toast.push({ kind: 'success', text: r.created.length > 0 ? `Размещение запрошено: ${r.created.length}.` : 'Новых назначений нет.' });
        res.reload();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        res.reload();
      },
    );
  };
  const visible = items.filter((d) => d.status !== 'superseded');
  const replaced = items.filter((d) => d.status === 'superseded');
  return (
    <div className={styles.deliveries} aria-label="Размещение">
      <div className={styles.head}>
        <span className={styles.subTitle}>
          {s.total > 0 ? `Размещение: ${s.delivered} из ${s.total}${s.cloudTotal > 0 ? ` · облако подтверждено ${s.cloudConfirmed} из ${s.cloudTotal}` : ''}` : 'Размещение: активных назначений нет'}
        </span>
        {data.canPlace ? (
          <Button icon="upload" loading={busy} onClick={place}>
            {`Разместить в новые назначения (${s.missing})`}
          </Button>
        ) : null}
      </div>
      <p className={styles.muted}>«Размещено» не означает «отправлено заказчику»: отправка регистрируется отдельно.</p>
      {visible.length > 0 ? (
        <ul className={styles.list}>
          {visible.map((d) => (
            <DeliveryRow key={d.id} d={d} onChanged={res.reload} />
          ))}
        </ul>
      ) : null}
      {replaced.length > 0 ? (
        <details className={styles.details}>
          <summary>{`Заменённые доставки (${replaced.length})`}</summary>
          <ul className={styles.list}>
            {replaced.map((d) => (
              <DeliveryRow key={d.id} d={d} onChanged={res.reload} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
};
