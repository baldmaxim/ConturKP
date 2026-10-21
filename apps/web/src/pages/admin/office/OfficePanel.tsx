import { useEffect, useMemo, useState, type FC } from 'react';
import { getAdminOffice } from '../../../api/endpoints';
import { Button } from '../../../components/Button';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingState } from '../../../components/LoadingState';
import { Notice } from '../../../components/Notice';
import { useApiResource } from '../../../hooks/useApiResource';
import { usePolling } from '../../../hooks/usePolling';
import { cx } from '../../../utils/cx';
import { OfficeDesk } from './OfficeDesk';
import { OfficeLounge } from './OfficeLounge';
import { STALE_AFTER_MS, buildOffice } from './officeModel';
import styles from './Office.module.css';

const POLL_MS = 5000;

/**
 * Вкладка «Офис»: фоновые задания worker'а как офис из пиксельных сотрудников. Данные — очередь заданий, раз в 5 с.
 * Старше 30 с или ошибка загрузки — офис застывает (анимация снята, серый) и появляется плашка «данные устарели».
 */
export const OfficePanel: FC = () => {
  const res = useApiResource((signal) => getAdminOffice(signal), 'admin-office');
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  // Часы браузера, а не сервера: возраст данных — время с момента их получения.
  useEffect(() => {
    if (res.data) {
      setReceivedAt(Date.now());
    }
  }, [res.data]);
  usePolling(true, () => {
    setNow(Date.now());
    res.reload();
  }, POLL_MS);
  const office = useMemo(() => (res.data ? buildOffice(res.data) : null), [res.data]);

  if (res.loading && !res.data) return <LoadingState />;
  if (!office) return <ErrorState error={res.error} onRetry={res.reload} />;

  const stale = Boolean(res.error) || now - receivedAt > STALE_AFTER_MS;
  const { totals } = office;
  return (
    <section className={cx(styles.office, stale && styles.frozen)} aria-label="Офис: фоновые задания">
      <div className={styles.toolbar}>
        <dl className={styles.summary} aria-label="Сводка очереди">
          <div>
            <dt>В работе</dt>
            <dd>{totals.running}</dd>
          </div>
          <div>
            <dt>В очереди</dt>
            <dd>{totals.queued}</dd>
          </div>
          <div>
            <dt>Ошибок за 24 ч</dt>
            <dd className={cx(totals.failed > 0 && styles.summaryDanger)}>{totals.failed}</dd>
          </div>
          <div>
            <dt>Worker&apos;ов живо</dt>
            <dd className={cx(totals.workersAlive === 0 && styles.summaryDanger)}>{totals.workersAlive}</dd>
          </div>
        </dl>
        <Button icon="refresh-cw" variant="ghost" onClick={res.reload}>
          Обновить
        </Button>
      </div>
      {stale ? <Notice tone="warning">Данные устарели: офис не обновляется, показано последнее известное состояние.</Notice> : null}
      {office.workerDown ? <Notice tone="danger">Worker не работает: задания стоят в очереди и никто их не берёт.</Notice> : null}
      <div className={styles.floor}>
        {office.desks.length > 0 ? (
          <ul className={styles.desks}>
            {office.desks.map((desk) => (
              <OfficeDesk key={desk.role} desk={desk} />
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>За столами никого: заданий нет.</p>
        )}
        <OfficeLounge residents={office.lounge} />
      </div>
    </section>
  );
};
