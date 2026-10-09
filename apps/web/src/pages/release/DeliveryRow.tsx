import { useState, type FC } from 'react';
import { deliveryAction, type TDeliveryAction } from '../../api/deliveryEndpoints';
import type { IDeliveryView } from '../../api/deliveryTypes';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import type { TIconName } from '../../components/Icon';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { ATTEMPT_OUTCOME, CLOUD_STATE, DELIVERY_ERROR, DELIVERY_EVENT, DELIVERY_KIND, REMOTE_STATE, statusMeta } from '../../utils/deliveryLabels';
import { formatBytes } from '../../utils/releaseLabels';
import { ReasonDialog } from './ReasonDialog';
import styles from './Release.module.css';

interface IActionMeta {
  button: string;
  icon: TIconName;
  title: string;
  label: string;
  confirm: string;
  explain: string;
  ok: string;
}

const ACTIONS: Record<TDeliveryAction, IActionMeta> = {
  retry: {
    button: 'Повторить…',
    icon: 'refresh-cw',
    title: 'Повторить размещение',
    label: 'Причина повтора',
    confirm: 'Повторить',
    explain: 'Повтор идёт в ту же закреплённую версию назначения. Уже записанное сверяется, дублей не будет.',
    ok: 'Размещение поставлено в очередь.',
  },
  'resolve-conflict': {
    button: 'Повторить после проверки…',
    icon: 'scan-search',
    title: 'Повторить после проверки папки',
    label: 'Что проверено и сделано',
    confirm: 'Повторить',
    explain: 'Портал не перезаписывает и не дописывает папку выпуска. Уберите её или посторонние файлы вручную — портал снова сверит.',
    ok: 'Повтор после проверки поставлен в очередь.',
  },
  redirect: {
    button: 'Перенаправить…',
    icon: 'repeat',
    title: 'Перенаправить на новую версию путей',
    label: 'Причина перенаправления',
    confirm: 'Перенаправить',
    explain: 'Эта доставка будет заменена новой — в текущую версию путей назначения. Прежняя и её попытки сохранятся.',
    ok: 'Создана новая доставка.',
  },
  'confirm-cloud': {
    button: 'Подтвердить облако…',
    icon: 'cloud',
    title: 'Подтвердить доставку в облако',
    label: 'Как проверено',
    confirm: 'Подтвердить',
    explain:
      'Портал видит только локальную папку синхронизации. Подтвердите, если папка выпуска появилась в облаке и её содержимое совпало: например, скачана из веб-интерфейса Диска и сверена командой delivery:compare. Отменить подтверждение нельзя.',
    ok: 'Доставка в облако подтверждена.',
  },
};

const errorText = (e: IDeliveryView['lastError']): string | null => (e ? `${DELIVERY_ERROR[e.code] ?? e.code}${e.detail ? `: ${e.detail}` : ''}` : null);

/** Строка доставки: своё назначение, свой статус, свои действия (A28). Полных путей нет — только папка выпуска. */
export const DeliveryRow: FC<{ d: IDeliveryView; onChanged: () => void }> = ({ d, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [dialog, setDialog] = useState<TDeliveryAction | null>(null);
  const [busy, setBusy] = useState(false);
  const status = statusMeta(d.destination.kind, d.status);
  const cloud = d.cloud ? CLOUD_STATE[d.cloud.state] : null;
  const available = (Object.keys(ACTIONS) as TDeliveryAction[]).filter(
    (a) => (a === 'retry' && d.actions.retry) || (a === 'resolve-conflict' && d.actions.resolveConflict) || (a === 'redirect' && d.actions.redirect) || (a === 'confirm-cloud' && d.actions.confirmCloud),
  );
  const run = (action: TDeliveryAction, text: string): void => {
    setBusy(true);
    deliveryAction(d, action, text, idem.keyFor({ id: d.id, action, text })).then(
      () => {
        idem.reset();
        setBusy(false);
        setDialog(null);
        toast.push({ kind: 'success', text: ACTIONS[action].ok });
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        onChanged();
      },
    );
  };
  const err = errorText(d.lastError);
  const meta = dialog ? ACTIONS[dialog] : null;
  return (
    <li className={styles.delivery} data-status={d.status}>
      <div className={styles.head}>
        <span className={styles.label}>{`${d.destination.title} · ${DELIVERY_KIND[d.destination.kind] ?? d.destination.kind}`}</span>
        <span className={styles.badges}>
          <Badge label={status.label} icon={status.icon} tone={status.tone} dashed={status.dashed} />
          {cloud ? <Badge label={cloud.label} icon={cloud.icon} tone={cloud.tone} dashed={cloud.dashed} /> : null}
        </span>
      </div>
      <span className={styles.mono}>{d.targetFolder}</span>
      <span className={styles.muted}>
        {`${d.fileSet === 'all' ? 'Все файлы (с внутренними)' : 'Файлы для заказчика'} · версия путей ${d.destination.version} · попыток ${d.attemptCount}${d.deliveredAt ? ` · ${formatDateTime(d.deliveredAt)}` : ''}`}
      </span>
      {d.cloud?.state === 'confirmed' ? <span className={styles.muted}>{`Облако подтвердил ${d.cloud.confirmedBy ?? '—'}, ${formatDateTime(d.cloud.confirmedAt)}: ${d.cloud.note ?? ''}`}</span> : null}
      {d.status !== 'delivered' && d.status !== 'superseded' && err ? <span className={styles.error}>{err}</span> : null}
      <details className={styles.details}>
        <summary>{`Файлы (${d.files.length}) и журнал`}</summary>
        <ul className={styles.checks}>
          {d.files.map((f) => (
            <li key={f.path} className={styles.check}>
              <span>{f.kind === 'marker' ? `${f.path} — признак готовности` : f.path}</span>
              <span className={styles.mono}>{`${formatBytes(f.size)} · ${f.sha256.slice(0, 12)}… · ${REMOTE_STATE[f.remoteState] ?? f.remoteState}`}</span>
            </li>
          ))}
        </ul>
        <h5 className={styles.subTitle}>События и попытки</h5>
        <ul className={styles.checks}>
          {d.events.map((e, n) => (
            <li key={`e${n}`} className={styles.check}>
              <span>{`${formatDateTime(e.createdAt)} · ${DELIVERY_EVENT[e.action] ?? e.action}${e.actor ? ` · ${e.actor}` : ''}`}</span>
              {e.reason ? <span className={styles.muted}>{e.reason}</span> : null}
            </li>
          ))}
          {d.attempts.map((a) => (
            <li key={`a${a.seq}`} className={styles.check}>
              <span>{`Попытка ${a.seq} · ${formatDateTime(a.finishedAt)} · ${ATTEMPT_OUTCOME[a.outcome] ?? a.outcome}`}</span>
              {a.errorCode ? <span className={styles.muted}>{errorText({ code: a.errorCode, detail: a.detail })}</span> : null}
            </li>
          ))}
        </ul>
      </details>
      {available.length > 0 ? (
        <span className={styles.actions}>
          {available.map((a) => (
            <Button key={a} icon={ACTIONS[a].icon} onClick={() => setDialog(a)}>
              {ACTIONS[a].button}
            </Button>
          ))}
        </span>
      ) : null}
      {dialog && meta ? (
        <ReasonDialog title={meta.title} label={meta.label} confirmLabel={meta.confirm} confirmIcon={meta.icon} minLength={3} busy={busy} onConfirm={(text) => run(dialog, text)} onClose={() => setDialog(null)}>
          <p className={styles.muted}>{`${d.destination.title}: ${d.targetFolder}`}</p>
          <p className={styles.muted}>{meta.explain}</p>
        </ReasonDialog>
      ) : null}
    </li>
  );
};
