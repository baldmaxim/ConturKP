import { useEffect, useRef, useState, type FC } from 'react';
import { ApiError } from '../../../api/client';
import { getOfficeDiagnostics } from '../../../api/endpoints';
import { Button } from '../../../components/Button';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingState } from '../../../components/LoadingState';
import { Notice } from '../../../components/Notice';
import { useToast } from '../../../hooks/useToast';
import { cx } from '../../../utils/cx';
import { OfficeScene } from './OfficeScene';
import { OfficeTasksDialog } from './OfficeTasksDialog';
import { OfficeTaskProgress as OfficeProgress } from './OfficeTaskProgress';
import { officeExecution } from './officeExecution';
import { formatOfficeDiagnostics, type IOfficeDiagnostics } from './officeDiagnostics';
import { OFFICE_ROLES, ROLE_KINDS, ROLE_TITLE, foldersOf, roleOfKind, type TOfficeRole } from './officeModel';
import { officeJobTitle, type IOfficeJobScope } from './officeJobs';
import { useOffice } from './useOffice';
import styles from './Office.module.css';

type TFilter = 'all' | 'failed' | 'queued' | 'running';

/** Одна сцена и текстовая сводка по ролям используют общий снимок очереди. */
export const OfficePanel: FC = () => {
  const { data, office, loading, error, reload, stale } = useOffice();
  const toast = useToast();
  const [selection, setSelection] = useState<TOfficeRole | null>(null);
  const [filter, setFilter] = useState<TFilter>('all');
  const [copying, setCopying] = useState(false);
  const [manualLog, setManualLog] = useState('');
  const [copyFallback, setCopyFallback] = useState(false);
  const [taskScope, setTaskScope] = useState<IOfficeJobScope | null>(null);
  const copyRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true;return () => { mounted.current = false;copyRequest.current?.abort(); }; }, []);

  if (loading && !office) return <LoadingState />;
  if (!office || !data) return <ErrorState error={error} onRetry={reload} />;

  const { totals } = office;
  const frozen = stale || totals.workersAlive === 0;
  const roles = OFFICE_ROLES.flatMap((role) => {
    const person = office.desks.find((desk) => desk.role === role) ?? office.lounge.find((resident) => resident.role === role);
    return person ? [{ ...person, tasks: 'tasks' in person ? person.tasks ?? [] : [], running: 'running' in person ? person.running : 0, queued: 'queued' in person ? person.queued : 0, execution: officeExecution(person, totals.workersAlive, stale) }] : [];
  }).sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0) || Number(b.queued > 0) - Number(a.queued > 0) || b.failed - a.failed || b.queued - a.queued || b.running - a.running);
  const selectedRole = selection && roles.some((role) => role.role === selection) ? selection : roles[0]?.role ?? 'intake';
  const selected = roles.find((role) => role.role === selectedRole);
  const items = data.items.filter((item) => roleOfKind(item.kind) === selectedRole);
  const groups = [...items.reduce((map, item) => {
    const key = `${item.kind}:${item.status}`, group = map.get(key);
    map.set(key, { kind: item.kind, status: item.status, count: (group?.count ?? 0) + item.count });return map;
  }, new Map<string, { kind: string; status: typeof items[number]['status']; count: number }>()).values()];
  const folders = foldersOf(items, new Map(data.tenders.map((tender) => [tender.id, tender.title])));
  const shown = roles.filter((role) => filter === 'all' || role[filter] > 0);
  const openTasks = (role: TOfficeRole, options: Partial<Omit<IOfficeJobScope, 'role'>> = {}): void => {
    const kinds = role === 'other' ? [...new Set(data.items.filter(item => roleOfKind(item.kind) === role).map(item => item.kind))] : [...ROLE_KINDS[role]];
    setSelection(role);setTaskScope({ role, title: ROLE_TITLE[role], kinds, ...options });
  };

  const copyLog = async (role: TOfficeRole | null): Promise<void> => {
    if (copyRequest.current) return;
    const request = new AbortController();copyRequest.current = request;
    const timeout = window.setTimeout(() => request.abort(), 10_000);
    setCopying(true);setManualLog('');
    let details: IOfficeDiagnostics | null = null, problem: string | undefined;
    try {
      const kinds = role ? [...new Set(data.items.filter((item) => roleOfKind(item.kind) === role).map((item) => item.kind))] : null;
      if (kinds?.length === 0) details = { at: data.at, build: null, total: 0, hidden: 0, limit: 50, truncated: false, entries: [] };
      else details = await getOfficeDiagnostics(kinds, request.signal);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) { reload();return; }
      problem = request.signal.aborted ? 'TIMEOUT' : err instanceof ApiError ? `HTTP_${err.status}_${err.code ?? 'REQUEST_FAILED'}` : 'NETWORK_ERROR';
    } finally { clearTimeout(timeout);copyRequest.current = null;setCopying(false); }
    if (!mounted.current) return;
    const text = formatOfficeDiagnostics(data, details, stale, role, problem);
    try {
      await navigator.clipboard.writeText(text);
      setManualLog(text);setCopyFallback(false);
      toast.push({ kind: 'success', text: details ? 'Лог ошибок скопирован — можно отправить в Codex.' : 'Сводка скопирована. Подробный журнал сейчас недоступен.' });
    } catch {
      setManualLog(text);
      setCopyFallback(true);
      toast.push({ kind: 'info', text: 'Выделите и скопируйте лог из поля ниже.' });
    }
  };

  return <section className={cx(styles.office, frozen && styles.frozen)} aria-label="Офис: фоновые задания">
    <div className={styles.toolbar}>
      <dl className={styles.summary} aria-label="Сводка очереди">
        <div><dt>В работе</dt><dd>{totals.running}</dd></div>
        <div className={cx(totals.queued > 0 && styles.summaryQueue)}><dt>В очереди</dt><dd>{totals.queued}</dd></div>
        <div className={cx(totals.failed > 0 && styles.summaryError)}><dt title="Отказы за последние сутки без успешного повтора">Нерешённых ошибок</dt><dd>{totals.failed}</dd></div>
        <div><dt>Живых worker’ов</dt><dd className={cx(totals.workersAlive === 0 && styles.summaryDanger)}>{totals.workersAlive}</dd></div>
      </dl>
      <div className={styles.actions}>
        <span className={styles.logRole}>Выбрана роль: {ROLE_TITLE[selectedRole]}</span>
        <Button icon="copy" variant="secondary" loading={copying} onClick={() => { void copyLog(selectedRole); }}>Лог этой роли</Button>
        <Button icon="copy" variant="secondary" loading={copying} onClick={() => { void copyLog(null); }}>Скопировать лог ошибок</Button>
        <Button icon="refresh-cw" variant="ghost" onClick={reload} disabled={loading}>Обновить</Button>
      </div>
    </div>
    {manualLog ? <details className={styles.manualLog} open={copyFallback}><summary>Лог для Codex{copyFallback ? ' — выделите и скопируйте' : ' — посмотреть текст'}</summary><textarea aria-label="Лог ошибок для Codex" readOnly value={manualLog} onFocus={(event) => event.currentTarget.select()} rows={10} /></details> : null}
    {stale ? <Notice tone="warning">Данные устарели: офис не обновляется, показано последнее известное состояние.</Notice> : null}
    {totals.workersAlive === 0 ? <Notice tone="danger">Worker не работает: задания в очереди ждут выполнения.</Notice> : null}
    <div className={styles.workspace}>
      <div className={styles.scenePanel}>
        <div className={styles.sceneHeading}><h2>Рабочие места и комната отдыха</h2><span>{stale ? 'Данные устарели' : loading ? 'Обновление…' : 'Обновляется каждые 5 с'}</span></div>
        <OfficeScene office={office} selectedRole={selectedRole} frozen={frozen} stale={stale} onSelect={setSelection} onOpen={openTasks} />
        <p className={styles.executionLegend}>Прогресс текущего задания или пачки · без известного объёма показывается этап · обновление каждые 5 с</p>
        <div className={styles.rolesHeading}><h2>Состояние по ролям</h2><div className={styles.filters} role="group" aria-label="Фильтр ролей">
          {([['all', 'Все'], ['running', 'Выполняют'], ['failed', 'С ошибками'], ['queued', 'С очередью']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value);if (value !== 'all' && !selected?.[value]) setSelection(roles.find((role) => role[value] > 0)?.role ?? null); }}>{label} · {value === 'all' ? roles.length : roles.filter((role) => role[value] > 0).length}</button>)}
        </div></div>
        <div className={styles.roleRows} role="group" aria-label="Сотрудники и задания">
          {shown.map((role) => <button key={role.role} type="button" className={styles.roleRow} aria-pressed={selectedRole === role.role} onClick={() => setSelection(role.role)}>
            <span className={styles.roleInfo}><strong>{ROLE_TITLE[role.role]}</strong><span className={styles.executionState} data-state={role.execution.state}>{role.execution.label}</span>
              {role.tasks.length ? role.tasks.map((task) => <span className={styles.currentTask} key={task.id ?? `${task.kind}:${task.hidden}`}>
                <span className={styles.taskTitle}>{task.title}{task.count > 1 ? ` · заданий: ${task.count}` : ''}</span><span className={styles.taskTarget}>{task.target}</span>
                <OfficeProgress task={task} frozen={frozen} />
              </span>) : <span>{role.status}</span>}
            </span>
            <span className={styles.roleMetrics}>
              <span data-tone={role.failed ? 'danger' : undefined}>Ошибок: <b>{role.failed}</b></span>
              <span data-tone={role.queued ? 'warning' : undefined}><b>{role.queued}</b> в очереди</span>
              <span data-tone={role.execution.state === 'running' ? 'success' : undefined}><b>{role.running}</b> выполняется</span>
            </span>
            {role.lastErrorCode ? <code className={styles.roleCode}>{role.lastErrorCode}</code> : null}
          </button>)}
          {!shown.length ? <p className={styles.quiet}>{filter === 'failed' ? 'Ролей с нерешёнными ошибками нет.' : filter === 'running' ? 'Сейчас никто не выполняет задания.' : 'Очередей нет.'}</p> : null}
        </div>
      </div>
      <aside className={styles.inspector} aria-label="Подробности выбранной роли">
        <div className={styles.inspectorHeader}><h2>{ROLE_TITLE[selectedRole]}</h2><Button variant="ghost" onClick={() => openTasks(selectedRole)}>Все задачи роли</Button></div>
        {selected ? <div className={styles.inspectorStatus} aria-label="Загрузка агента"><span className={styles.executionState} data-state={selected.execution.state}>{selected.execution.label}</span><span>Выполняется: <b>{selected.running}</b> · В очереди: <b>{selected.queued}</b> · Ошибок: <b>{selected.failed}</b></span>{selected.tasks[0] ? <><span className={styles.taskTarget}>{selected.tasks[0].title}</span><OfficeProgress task={selected.tasks[0]} frozen={frozen} compact /></> : null}</div> : null}
        <div className={styles.inspectorBody} tabIndex={0} role="region" aria-label="Задания по видам и тендерам">
          {selected?.tasks.length ? <div className={styles.currentTasks} aria-label="Текущие задачи"><h3>Сейчас выполняет</h3>{selected.tasks.map(task => <button type="button" className={styles.inspectorTask} key={task.id ?? `${task.kind}:${task.hidden}`} onClick={() => openTasks(selectedRole, task.id ? { jobId: task.id } : {})}><strong>{task.title}</strong><span className={styles.taskTarget}>{task.target}</span><OfficeProgress task={task} frozen={frozen} /><span className={styles.taskTarget}>Открыть этапы →</span></button>)}</div> : null}
          {selected?.lastErrorCode ? <p className={styles.errorCode}>Последняя ошибка<code>{selected.lastErrorCode}</code></p> : null}
          <h3>Задания по видам</h3>
          {groups.length ? <ul className={styles.jobGroups}>{groups.map((item) => <li key={`${item.kind}-${item.status}`}><button type="button" className={styles.inspectorTask} onClick={() => openTasks(selectedRole, { kinds: [item.kind], title: officeJobTitle(item.kind), status: item.status })}><strong>{officeJobTitle(item.kind)}</strong><span data-tone={item.status === 'failed' ? 'danger' : item.status === 'queued' ? 'warning' : undefined}>{item.status === 'failed' ? 'Ошибок' : item.status === 'queued' ? 'В очереди' : 'В работе'}: <b>{item.count}</b></span></button></li>)}</ul> : <p>Активных заданий нет</p>}
          {folders.length ? <><h3>По тендерам</h3><ul className={styles.jobGroups}>{folders.map((folder) => {
            const tasks = selected?.tasks.filter(task => folder.hidden ? task.hidden : !task.hidden && task.tenderId === folder.tenderId) ?? [];
            const total = folder.failed + folder.queued + folder.running;
            return <li key={folder.key}><button type="button" className={styles.inspectorTask} onClick={() => openTasks(selectedRole, { tender: folder.hidden ? 'hidden' : folder.tenderId ?? 'none', title: `${ROLE_TITLE[selectedRole]} · ${folder.title}` })}><strong>{folder.title}</strong><small>В работе: {folder.running} · Очередь: {folder.queued} · Ошибок: {folder.failed}</small>{tasks.length === 1 && tasks[0] ? <OfficeProgress task={tasks[0]} frozen={frozen} compact /> : <span className={styles.folderStatus} role="img" aria-label={`Состояния: в работе ${folder.running}, в очереди ${folder.queued}, ошибок ${folder.failed}`}><span data-status="running" style={{ width: `${folder.running / total * 100}%` }} /><span data-status="queued" style={{ width: `${folder.queued / total * 100}%` }} /><span data-status="failed" style={{ width: `${folder.failed / total * 100}%` }} /></span>}<span className={styles.taskTarget}>Посмотреть задачи →</span></button></li>;
          })}</ul></> : null}
        </div>
      </aside>
    </div>
    {taskScope ? <OfficeTasksDialog key={JSON.stringify(taskScope)} scope={taskScope} onClose={() => setTaskScope(null)} /> : null}
  </section>;
};
