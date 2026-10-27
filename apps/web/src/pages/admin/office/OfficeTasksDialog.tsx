import { useEffect, useRef, useState, type FC } from 'react';
import { ApiError } from '../../../api/client';
import { getOfficeTask, getOfficeTasks } from '../../../api/endpoints';
import { AppLink } from '../../../components/AppLink';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingState } from '../../../components/LoadingState';
import { Notice } from '../../../components/Notice';
import { OfficeTaskProgress } from './OfficeTaskProgress';
import { OFFICE_JOB_STATUS, officeJobError, officeJobProgressTask, officeJobSteps, officeJobTitle, type IOfficeJob, type IOfficeJobPage, type IOfficeJobScope, type TOfficeJobFilter } from './officeJobs';
import styles from './Office.module.css';
import { useOffice } from './useOffice';

const time = (value: string): string => new Date(value).toLocaleString('ru-RU');
const tabs: Array<[TOfficeJobFilter, string]> = [['active', 'Актуальные'], ['running', 'Выполняются'], ['queued', 'Очередь'], ['failed', 'Ошибки'], ['succeeded', 'Завершённые'], ['cancelled', 'Отменённые']];
type Payload = { type: 'list'; value: IOfficeJobPage } | { type: 'task'; value: IOfficeJob };

const JobProgress: FC<{ job: IOfficeJob; stale: boolean }> = ({ job, stale }) => job.status === 'running'
  ? <OfficeTaskProgress task={officeJobProgressTask(job)} frozen={stale} />
  : job.status === 'succeeded' ? <span className={styles.taskProgress}><span className={styles.progressTrack} role="progressbar" aria-label="Задание завершено" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}><span style={{ width: '100%' }} /></span><span className={styles.progressLabel}>100% · завершено</span></span>
    : <span className={styles.taskTarget}>{job.status === 'queued' ? job.attempts > 0 ? 'Ожидает повторного запуска' : 'Выполнение ещё не началось' : job.status === 'failed' ? 'Выполнение остановлено с ошибкой' : 'Выполнение отменено'}</span>;

const TaskDetails: FC<{ job: IOfficeJob; stale: boolean }> = ({ job, stale }) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [job.id]);
  return <div className={styles.taskDetail}>
  <div className={styles.taskDetailHeading}><h3 ref={heading} tabIndex={-1}>{officeJobTitle(job.kind)}</h3><span className={styles.jobStatus} data-status={job.status}>{OFFICE_JOB_STATUS[job.status]}</span></div>
  <p>{job.tenderTitle ?? 'Общая задача'}</p>
  <JobProgress job={job} stale={stale} />
  <ol className={styles.taskSteps} aria-label="Этапы задачи">{officeJobSteps(job).map(step => <li key={step.title} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}><strong>{step.title}</strong><span>{step.state === 'done' ? 'Выполнено' : step.state === 'current' ? 'Сейчас выполняется' : step.state === 'failed' ? 'Ошибка' : step.state === 'cancelled' ? 'Отменено' : 'Ожидается'}</span>{step.detail ? <time dateTime={step.detail}>{time(step.detail)}</time> : null}</li>)}</ol>
  {job.status === 'running' && !job.progress ? <p className={styles.quiet}>Исполнитель ещё не передал детализацию текущего этапа и объём работы.</p> : null}
  {job.errorCode ? <Notice tone={job.status === 'failed' ? 'danger' : 'info'}>{job.status !== 'failed' ? 'Предыдущая попытка: ' : ''}{officeJobError(job.errorCode)} <code>{job.errorCode}</code></Notice> : null}
  {job.nextCheckAt ? <p>Запланированная проверка: <time dateTime={job.nextCheckAt}>{time(job.nextCheckAt)}</time></p> : null}
  {job.cancelRequested ? <Notice tone="warning">Запрошена отмена; ожидается подтверждение исполнителя.</Notice> : null}
  <details className={styles.taskTechnical}><summary>Технические данные</summary><dl><dt>Идентификатор</dt><dd>{job.id}</dd><dt>Вид задания</dt><dd>{job.kind}</dd><dt>Попытки</dt><dd>{job.attempts} из {job.maxAttempts}</dd><dt>Запись обновлена</dt><dd>{time(job.updatedAt)}</dd></dl></details>
  {job.tenderId ? <AppLink to={`/tenders/${job.tenderId}`}>Открыть тендер</AppLink> : null}
</div>;
};

/** Список и подробности меняют содержимое одного диалога; фокус остаётся в его пределах. */
export const OfficeTasksDialog: FC<{ scope: IOfficeJobScope; onClose: () => void }> = ({ scope, onClose }) => {
  const office = useOffice();
  const frozen = office.stale || office.office?.totals.workersAlive === 0;
  const [status, setStatus] = useState<TOfficeJobFilter>(scope.status ?? 'active');
  const [offset, setOffset] = useState(0);
  const [jobId, setJobId] = useState<string | null>(scope.jobId ?? null);
  const returnToJob = useRef<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const [refresh, setRefresh] = useState(0);
  const [resource, setResource] = useState<{ key: string; payload: Payload | null; error: unknown; refreshing: boolean }>({ key: '', payload: null, error: null, refreshing: false });
  const key = JSON.stringify({ kinds: scope.kinds, tender: scope.tender, status, offset, jobId });

  useEffect(() => {
    let disposed = false, controller: AbortController | null = null;
    const load = async (): Promise<void> => {
      if (controller || document.visibilityState === 'hidden') return;
      const request = new AbortController();controller = request;
      const timeout = window.setTimeout(() => request.abort(), 12_000);
      setResource(previous => previous.key === key ? { ...previous, refreshing: true } : { key, payload: null, error: null, refreshing: true });
      try {
        const payload: Payload = jobId ? { type: 'task', value: (await getOfficeTask(jobId, request.signal)).task }
          : { type: 'list', value: await getOfficeTasks({ kinds: scope.kinds, ...(scope.tender ? { tender: scope.tender } : {}), status, offset }, request.signal) };
        if (!disposed) {
          if (payload.type === 'list' && offset > 0 && offset >= payload.value.total) setOffset(Math.max(0, Math.floor((payload.value.total - 1) / payload.value.limit) * payload.value.limit));
          setResource({ key, payload, error: null, refreshing: false });
        }
      } catch (error) {
        if (!disposed) setResource(previous => ({ key, payload: error instanceof ApiError && [401, 403, 404].includes(error.status) ? null : previous.key === key ? previous.payload : null, error, refreshing: false }));
      } finally { clearTimeout(timeout);controller = null; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    const visible = (): void => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true;clearInterval(timer);controller?.abort();document.removeEventListener('visibilitychange', visible); };
  }, [key, refresh]);

  const current = resource.key === key ? resource : null;
  const page = current?.payload?.type === 'list' ? current.payload.value : null;
  const job = current?.payload?.type === 'task' ? current.payload.value : null;
  useEffect(() => {
    if (page && returnToJob.current) {
      const button = list.current?.querySelector<HTMLButtonElement>(`[data-job-id="${returnToJob.current}"]`) ?? list.current?.querySelector<HTMLButtonElement>('button');
      button?.focus();returnToJob.current = null;
    }
  }, [page]);
  const count = (value: TOfficeJobFilter): number | undefined => page ? value === 'active' ? page.counts.running + page.counts.queued + page.counts.failed : page.counts[value] : undefined;

  return <Dialog title={jobId ? 'Подробности задачи' : `${scope.title} · задачи`} onClose={onClose} footer={<><Button variant="ghost" icon="refresh-cw" onClick={() => setRefresh(n => n + 1)} disabled={current?.refreshing}>Обновить</Button><Button onClick={onClose}>Закрыть</Button></>}>
    <div className={styles.taskDialogBody}>
      {jobId ? <Button variant="ghost" icon="arrow-left" onClick={() => setJobId(null)}>К задачам: {scope.title}</Button> : <>
        <p className={styles.quiet}>Актуальные задачи и результаты за последние 24 часа. Состояние обновляется каждые 5 секунд.</p>
        <div className={styles.filters} role="group" aria-label="Состояние задач">{tabs.map(([value, label]) => <button key={value} type="button" aria-pressed={status === value} onClick={() => { setStatus(value);setOffset(0); }}>{label}{count(value) !== undefined ? ` · ${count(value)}` : ''}</button>)}</div>
      </>}
      {current?.error && current.payload ? <Notice tone="warning">Не удалось обновить данные. Показан последний снимок.</Notice> : null}
      {frozen ? <Notice tone="warning">Офис не подтверждает текущее выполнение: данные устарели или исполнитель недоступен.</Notice> : null}
      {!current?.payload ? current?.error ? <ErrorState error={current.error} onRetry={() => setRefresh(n => n + 1)} /> : <LoadingState /> : null}
      {job ? <TaskDetails key={job.id} job={job} stale={frozen || !!current?.error} /> : null}
      {page ? <>
        {page.hidden > 0 ? <Notice tone="info">Ещё {page.hidden} заданий относятся к закрытым тендерам. Их подробности доступны только участникам с правом чтения.</Notice> : null}
        <ol ref={list} className={styles.modalTaskList} aria-label="Задачи по этапам">{page.items.map(item => <li key={item.id}><button type="button" data-job-id={item.id} onClick={() => { returnToJob.current = item.id;setJobId(item.id); }} aria-label={`Открыть задачу: ${officeJobTitle(item.kind)}`}><span className={styles.taskListHeading}><strong>{officeJobTitle(item.kind)}</strong><span className={styles.jobStatus} data-status={item.status}>{OFFICE_JOB_STATUS[item.status]}</span></span><span className={styles.taskTarget}>{item.tenderTitle ?? 'Общая задача'}</span><JobProgress job={item} stale={frozen || !!current?.error} />{item.errorCode ? <code className={styles.miniError}>{item.errorCode}</code> : null}<span className={styles.taskListFooter}>Создано: {time(item.createdAt)} · Открыть этапы →</span></button></li>)}</ol>
        {!page.items.length ? <p className={styles.quiet}>{page.hidden ? 'Подробности закрытых задач не раскрываются.' : 'В этой группе задач нет.'}</p> : null}
        {page.total > 0 && page.items.length > 0 ? <div className={styles.taskPagination}><span>{page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} из {page.total}</span><Button variant="ghost" onClick={() => setOffset(n => Math.max(0, n - page.limit))} disabled={offset === 0}>Назад</Button><Button variant="ghost" onClick={() => setOffset(n => n + page.limit)} disabled={!page.hasMore}>Далее</Button></div> : null}
        <small className={styles.taskTarget}>Снимок: {time(page.at)}</small>
      </> : null}
    </div>
  </Dialog>;
};
