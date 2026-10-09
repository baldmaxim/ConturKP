import { useState, type FC } from 'react';
import { listDestinations, patchDestination, probeDestination } from '../../api/deliveryEndpoints';
import type { IDestinationView } from '../../api/deliveryTypes';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { DELIVERY_ERROR, DELIVERY_KIND } from '../../utils/deliveryLabels';
import { MODE_LABEL } from '../../utils/releaseLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import { DestinationDialog } from './DestinationDialog';
import styles from './Delivery.module.css';

const ProbeLine: FC<{ d: IDestinationView }> = ({ d }) => {
  if (d.probePending) return <Badge label="Проверка выполняется" icon="loader-circle" tone="info" />;
  const p = d.lastProbe;
  if (!p) return <Badge label="Доступ не проверялся" icon="info" tone="neutral" dashed />;
  const stale = p.current ? '' : ` (версия ${p.version}, не текущая)`;
  return p.outcome === 'ok' ? (
    <Badge label={`Доступ проверен${stale}`} icon="shield-check" tone={p.current ? 'success' : 'warning'} />
  ) : (
    <Badge label={`Проверка: ${DELIVERY_ERROR[p.errorCode ?? ''] ?? p.errorCode}${stale}`} icon="circle-x" tone="danger" />
  );
};

/**
 * Назначения размещения (D-034, В-14-5): только администратор. Новая версия путей не меняет существующие доставки;
 * «Проверить назначение» выполняет worker под учётной записью службы — запись, перенос и удаление пробной папки.
 */
export const DestinationsPanel: FC = () => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const res = useApiResource((signal) => listDestinations(signal), 'delivery-destinations');
  const [dialog, setDialog] = useState<{ current?: IDestinationView } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = res.data?.items ?? [];
  usePolling(items.some((d) => d.probePending), res.reload);

  const act = async (d: IDestinationView, what: 'probe' | 'toggle'): Promise<void> => {
    setBusy(`${d.id}:${what}`);
    try {
      if (what === 'probe') await probeDestination(d, idem.keyFor({ id: d.id, probe: d.current.id }));
      else await patchDestination(d, { active: !d.active });
      idem.reset();
      toast.push({ kind: 'success', text: what === 'probe' ? 'Проверка назначения поставлена в очередь worker.' : d.active ? 'Назначение выключено.' : 'Назначение включено.' });
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(null);
      res.reload();
    }
  };

  if (res.loading && !res.data) return <LoadingState />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;

  return (
    <div className={form.stack}>
      <div className={styles.toolbar}>
        <p className={list.muted}>
          Яндекс Диск — через локальную папку синхронизации: портал проверяет файлы в ней, доставку в облако подтверждает человек. Сетевая папка — по UNC-пути. Пароли и токены не хранятся: доступ — у учётной записи службы worker.
        </p>
        <Button variant="primary" icon="plus" onClick={() => setDialog({})}>
          Новое назначение
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState icon="folder" title="Назначений нет" text="Без назначений выпуски не размещаются. Создайте тестовое назначение и проверьте доступ." />
      ) : (
        <ul className={styles.cards}>
          {items.map((d) => (
            <li key={d.id} className={list.card} data-active={d.active ? 'true' : 'false'}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{d.title}</span>
                <span className={styles.badges}>
                  <Badge label={DELIVERY_KIND[d.kind] ?? d.kind} icon={d.kind === 'yandex_disk' ? 'cloud' : 'folder'} tone="neutral" />
                  <Badge label={MODE_LABEL[d.environment] ?? d.environment} icon="layers" tone={d.environment === 'production' ? 'accent' : 'info'} />
                  {d.active ? null : <Badge label="Выключено" icon="power-off" tone="muted" dashed />}
                </span>
              </div>
              <dl className={list.meta}>
                <dt>Корень</dt>
                <dd className={list.mono}>{d.current.rootPath}</dd>
                <dt>Служебная папка</dt>
                <dd className={list.mono}>{d.current.stagingPath}</dd>
                <dt>Состав</dt>
                <dd>{d.current.includeInternal ? 'Все файлы с манифестами' : 'Файлы для заказчика'}</dd>
                <dt>Версия</dt>
                <dd>{`№ ${d.current.version} · ${d.current.createdBy.name}, ${formatDateTime(d.current.createdAt)} · ${d.current.reason}`}</dd>
              </dl>
              <span className={styles.badges}>
                <ProbeLine d={d} />
              </span>
              {d.lastProbe && d.lastProbe.outcome === 'failed' && d.lastProbe.detail ? <p className={styles.error}>{d.lastProbe.detail}</p> : null}
              {d.lastProbe ? <p className={list.muted}>{`Проверял ${d.lastProbe.requestedBy}, ${formatDateTime(d.lastProbe.checkedAt)}`}</p> : null}
              <div className={styles.actions}>
                <Button icon="scan-search" loading={busy === `${d.id}:probe`} disabled={d.probePending} onClick={() => void act(d, 'probe')}>
                  Проверить назначение
                </Button>
                <Button icon="pencil" onClick={() => setDialog({ current: d })}>
                  Новая версия путей…
                </Button>
                <Button variant="ghost" icon="power-off" loading={busy === `${d.id}:toggle`} onClick={() => void act(d, 'toggle')}>
                  {d.active ? 'Выключить' : 'Включить'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog ? (
        <DestinationDialog
          {...(dialog.current ? { current: dialog.current } : {})}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.push({ kind: 'success', text: dialog.current ? 'Новая версия путей сохранена. Проверьте назначение.' : 'Назначение создано. Проверьте доступ.' });
            res.reload();
          }}
        />
      ) : null}
    </div>
  );
};
