import { useState, type FC } from 'react';
import { Button } from '../../../components/Button';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingState } from '../../../components/LoadingState';
import { Notice } from '../../../components/Notice';
import { cx } from '../../../utils/cx';
import { OfficeDesk } from './OfficeDesk';
import { OfficeLounge } from './OfficeLounge';
import { OfficeScene } from './OfficeScene';
import { OFFICE_ROLES, ROLE_TITLE, type TOfficeRole } from './officeModel';
import { shirtClassOf } from './shirtClass';
import { useOffice } from './useOffice';
import { VoxelAgent } from './VoxelAgent';
import styles from './Office.module.css';

/** Общая сцена и доступный список используют один снимок очереди вместе с кнопкой в шапке. */
export const OfficePanel: FC = () => {
  const { office, loading, error, reload, stale } = useOffice();
  const [view, setView] = useState<'scene' | 'list'>('scene');
  const [selection, setSelection] = useState<TOfficeRole | null>(null);

  if (loading && !office) return <LoadingState />;
  if (!office) return <ErrorState error={error} onRetry={reload} />;

  const { totals } = office;
  const frozen = stale || totals.workersAlive === 0;
  const roles = OFFICE_ROLES.filter((role) => office.desks.some((desk) => desk.role === role) || office.lounge.some((resident) => resident.role === role));
  const selectedRole = selection && roles.includes(selection) ? selection : office.desks[0]?.role ?? roles[0] ?? 'intake';
  const selectedDesk = office.desks.find((desk) => desk.role === selectedRole);
  const selectedResident = office.lounge.find((resident) => resident.role === selectedRole);
  return (
    <section className={cx(styles.office, frozen && styles.frozen)} aria-label="Офис: фоновые задания">
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
        <Button icon="refresh-cw" variant="ghost" onClick={reload} disabled={loading}>
          Обновить
        </Button>
      </div>
      {stale ? <Notice tone="warning">Данные устарели: офис не обновляется, показано последнее известное состояние.</Notice> : null}
      {totals.workersAlive === 0 ? <Notice tone="danger">{office.workerDown ? 'Worker не работает: задания стоят в очереди и никто их не берёт.' : 'Нет работающих worker’ов.'}</Notice> : null}
      <div className={styles.viewControls} role="group" aria-label="Вид офиса">
        <Button variant={view === 'scene' ? 'primary' : 'ghost'} aria-pressed={view === 'scene'} onClick={() => setView('scene')}>Офис</Button>
        <Button variant={view === 'list' ? 'primary' : 'ghost'} aria-pressed={view === 'list'} onClick={() => setView('list')}>Список</Button>
      </div>
      {view === 'scene' ? (
        <div className={styles.workspace}>
          <div className={styles.scenePanel}>
            <div className={styles.sceneHeading}><h2>Рабочие места</h2><span>{stale ? 'Данные устарели' : loading ? 'Обновление…' : 'Обновляется каждые 5 с'}</span></div>
            <OfficeScene office={office} selectedRole={selectedRole} frozen={frozen} onSelect={setSelection} />
            <div className={styles.rolePicker} role="group" aria-label="Выбрать сотрудника">
              {roles.map((role) => {
                const desk = office.desks.find((item) => item.role === role);
                const word = desk ? desk.mood === 'working' ? 'Работает' : desk.mood === 'alarm' ? 'Нужна помощь' : 'Ожидает' : 'Отдыхает';
                return <button key={role} type="button" className={cx(styles.roleButton, shirtClassOf(role))} aria-pressed={selectedRole === role} aria-label={`${ROLE_TITLE[role]}: ${word}`} onClick={() => setSelection(role)}><span className={styles.roleDot} data-mood={desk?.mood ?? 'idle'} /><span>{ROLE_TITLE[role]}</span><span className={styles.roleWord}>{word}</span></button>;
              })}
            </div>
          </div>
          <aside className={styles.inspector} aria-label="Выбранный сотрудник">
            {selectedDesk ? <ul className={styles.selectedDesk}><OfficeDesk desk={selectedDesk} frozen={frozen} /></ul> : selectedResident ? (
              <div className={cx(styles.selectedResident, shirtClassOf(selectedResident.role))}>
                <VoxelAgent status="idle" frozen={frozen} />
                <h3>{selectedResident.title}</h3><p>{selectedResident.status}</p>
                <p className={styles.status}>Нет активных заданий</p>
                {selectedResident.failed > 0 ? <p className={styles.summaryDanger}>Ошибок за 24 ч: {selectedResident.failed}{selectedResident.lastErrorCode ? ` · ${selectedResident.lastErrorCode}` : ''}</p> : null}
              </div>
            ) : null}
          </aside>
        </div>
      ) : <div className={styles.floor}>
        {office.desks.length > 0 ? (
          <ul className={styles.desks}>
            {office.desks.map((desk) => (
              <OfficeDesk key={desk.role} desk={desk} frozen={frozen} />
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>За столами никого: заданий нет.</p>
        )}
        <OfficeLounge residents={office.lounge} frozen={frozen} />
      </div>}
    </section>
  );
};
