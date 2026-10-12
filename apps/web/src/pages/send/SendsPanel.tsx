import { useState, type FC } from 'react';
import { incidentEvidenceUrl, listReleaseSends } from '../../api/sendEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { INCIDENT_KIND, SEND_BLOCKED, SEND_STATE, SEND_WARNING } from '../../utils/sendLabels';
import styles from '../release/Release.module.css';
import { IncidentDialog } from './IncidentDialog';
import { RegisterSendDialog } from './RegisterSendDialog';
import own from './Send.module.css';
import { SendRow } from './SendRow';

/**
 * Отправка выпуска (этап 15; D-035): отдельное от размещения событие (I01). «Не зарегистрирована» — данных об отправке
 * нет; это не «не отправлено» (A33). Запись фиксирует отправку и не подтверждает получение или согласие заказчика
 * (A46). Тестовый выпуск не отправляется — у него регистрируется только нарушение (RT-05).
 */
export const SendsPanel: FC<{ releaseId: string }> = ({ releaseId }) => {
  const [dialog, setDialog] = useState<'send' | 'incident' | null>(null);
  const res = useApiResource((signal) => listReleaseSends(releaseId, signal), `sends:${releaseId}`);
  const data = res.data;
  if (!data) return null;
  const s = data.summary;
  const state = SEND_STATE[s.state]!;
  const done = (): void => {
    setDialog(null);
    res.reload();
  };
  return (
    <div className={own.sends} aria-label="Отправка">
      <div className={styles.head}>
        <span className={styles.subTitle}>{s.events > 0 ? `Отправка: записей ${s.events}, засчитано ${s.counted}` : 'Отправка'}</span>
        <span className={own.badges}>
          {s.testRelease ? <Badge label="Тестовый — не отправляется" icon="ban" tone="warning" /> : <Badge label={state.label} icon={state.icon} tone={state.tone} dashed={state.dashed} />}
          {s.incidents > 0 ? <Badge label={`Нарушений: ${s.incidents}`} icon="shield-x" tone="danger" /> : null}
        </span>
      </div>
      <p className={styles.muted}>Отправка регистрируется отдельно от размещения и не означает, что заказчик получил или принял комплект.</p>
      {s.testRelease ? <p className={styles.muted}>Тестовый выпуск не отправляется заказчику. Если комплект всё же ушёл — зарегистрируйте нарушение.</p> : null}
      {!s.testRelease && s.state === 'registered_unchecked' ? <p className={styles.muted}>Отправка зарегистрирована по файлу или пояснению: состав не сверялся.</p> : null}
      {!s.testRelease && s.state === 'not_registered' ? <p className={styles.muted}>Сведений об отправке нет. Это не значит, что комплект не отправлен.</p> : null}
      {!s.testRelease && data.can.registerBlockedBy ? <Notice tone="warning">{SEND_BLOCKED[data.can.registerBlockedBy] ?? data.can.registerBlockedBy}</Notice> : null}
      {!s.testRelease && s.counted > 0 && s.readiness.state === 'held' ? <p className={styles.muted}>После отправки появились новые события этапа: повторная отправка — после решения руководителя.</p> : null}
      {!s.testRelease ? data.warnings.map((w) => <p key={w} className={styles.muted}>{`${SEND_WARNING[w] ?? w}.`}</p>) : null}
      {data.items.length > 0 ? (
        <ul className={styles.list}>
          {data.items.map((x) => (
            <SendRow key={x.id} s={x} onChanged={res.reload} />
          ))}
        </ul>
      ) : null}
      {data.incidents.length > 0 ? (
        <ul className={styles.list}>
          {data.incidents.map((i) => (
            <li key={i.id} className={own.send} data-status="incident">
              <span className={styles.label}>{`Нарушение: ${INCIDENT_KIND[i.kind] ?? i.kind} · ${formatDateTime(i.occurredAt)}`}</span>
              <span className={styles.muted}>{i.restricted ? 'Описание закрыто: письмо-основание недоступно вам.' : i.description}</span>
              {i.evidence.file ? (
                <span className={styles.actions}>
                  <a className={styles.download} href={incidentEvidenceUrl(i.id)} download>
                    {`Основание: ${i.evidence.file.fileName}`}
                  </a>
                </span>
              ) : null}
              <span className={styles.muted}>{`Зарегистрировал ${i.registeredBy.name}, ${formatDateTime(i.registeredAt)}. Отправкой не является.`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.can.register || data.can.registerIncident ? (
        <span className={styles.actions}>
          {data.can.register ? (
            <Button icon="send" className={own.wrapButton} onClick={() => setDialog('send')}>
              Зарегистрировать отправку…
            </Button>
          ) : null}
          {data.can.registerIncident ? (
            <Button icon="shield-x" className={own.wrapButton} onClick={() => setDialog('incident')}>
              Зарегистрировать нарушение…
            </Button>
          ) : null}
        </span>
      ) : null}
      {data.mailhub.status !== 'VERIFIED_LIVE' ? <p className={styles.muted}>{`MailHub: ${data.mailhub.note}.`}</p> : null}
      {dialog === 'send' ? <RegisterSendDialog releaseId={releaseId} warnings={data.warnings} onDone={done} onClose={() => setDialog(null)} /> : null}
      {dialog === 'incident' ? <IncidentDialog releaseId={releaseId} testRelease={s.testRelease} onDone={done} onClose={() => setDialog(null)} /> : null}
    </div>
  );
};
