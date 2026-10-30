import { useCallback, useEffect, useId, useMemo, useRef, useState, type FC } from 'react';
import { Notice } from '../../../components/Notice';
import type { IOfficeModel, TOfficeRole } from './officeModel';
import type { IOfficeSceneController, IOfficeSceneProps } from './officeSceneRenderer';
import styles from './Office.module.css';
import { createOfficeAlertLayout, officePopoverPosition, type IOfficeAgentAnchor } from './officeAlerts';
import { officeExecution } from './officeExecution';
import { createOfficeHover } from './officeHover';
import { OfficeTaskProgress as OfficeProgress } from './OfficeTaskProgress';

/** Движок и Three.js попадают в отдельный chunk и загружаются только на странице офиса. */
export const OfficeScene: FC<{ office: IOfficeModel; selectedRole: TOfficeRole; frozen: boolean; stale: boolean; onSelect: (role: TOfficeRole) => void; onOpen?: (role: TOfficeRole) => void }> = (props) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<IOfficeSceneController | null>(null);
  const badges = useRef(new Map<TOfficeRole, HTMLButtonElement>());
  const leaders = useRef(new Map<TOfficeRole, SVGLineElement>());
  const popover = useRef<HTMLDivElement>(null);
  const popoverRole = useRef<TOfficeRole | null>(null);
  const popoverId = useId();
  const lastAnchors = useRef<IOfficeAgentAnchor[]>([]);
  const layout = useRef(createOfficeAlertLayout());
  const interactionRole = useRef<TOfficeRole | null>(null);
  const popupPosition = useRef<{ role: TOfficeRole; sceneWidth: number; sceneHeight: number; x: number; y: number } | null>(null);
  const [hoveredRole, setHoveredRole] = useState<TOfficeRole | null>(null);
  const [focusedRole, setFocusedRole] = useState<TOfficeRole | null>(null);
  const hover = useMemo(() => createOfficeHover(setHoveredRole), []);
  const onHover = useCallback((role: TOfficeRole | null) => hover.set('scene', role), [hover]);
  useEffect(() => () => hover.dispose(), [hover]);
  const onAnchors = useCallback((anchors: IOfficeAgentAnchor[]) => {
    lastAnchors.current = anchors;
    if (!canvas.current) return;
    for (const anchor of anchors) { const badge = badges.current.get(anchor.role);if (badge) badge.style.visibility = 'visible'; }
    // Места скрытых свободных агентов тоже зарезервированы: появление ярлыка не сдвигает соседей.
    const measured = anchors.filter(anchor => badges.current.has(anchor.role)).map(anchor => ({ ...anchor, width: badges.current.get(anchor.role)!.offsetWidth, height: badges.current.get(anchor.role)!.offsetHeight }));
    const sceneWidth = canvas.current.clientWidth, sceneHeight = canvas.current.clientHeight;
    const positions = layout.current(measured, sceneWidth, sceneHeight, interactionRole.current !== null);
    for (const position of positions) {
      const badge = badges.current.get(position.role);
      if (!badge) continue;
      badge.style.transform = `translate(${Math.round(position.x)}px, ${Math.round(position.y)}px)`;
      badge.style.visibility = 'visible';
      const leader = leaders.current.get(position.role), anchor = anchors.find((point) => point.role === position.role);
      if (leader && anchor) {
        leader.setAttribute('x1', String(position.x + badge.offsetWidth / 2));leader.setAttribute('y1', String(position.y + badge.offsetHeight));
        leader.setAttribute('x2', String(anchor.x));leader.setAttribute('y2', String(anchor.y));
      }
    }
    const popup = popover.current, anchor = positions.find(point => point.role === popoverRole.current);
    if (popup && anchor) {
      const badge = badges.current.get(anchor.role)!, width = popup.offsetWidth, height = popup.offsetHeight;
      const previous = popupPosition.current;
      const point = previous?.role === anchor.role && previous.sceneWidth === sceneWidth && previous.sceneHeight === sceneHeight
        ? previous : officePopoverPosition({ ...anchor, width: badge.offsetWidth, height: badge.offsetHeight }, sceneWidth, sceneHeight, width, height);
      const x = Math.max(4, Math.min(point.x, sceneWidth - width - 4)), y = Math.max(4, Math.min(point.y, sceneHeight - height - 4));
      popupPosition.current = { role: anchor.role, sceneWidth, sceneHeight, x, y };
      popup.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;popup.style.visibility = 'visible';
    }
  }, []);
  const current = { ...props, onAnchors, onHover };
  const latest = useRef<IOfficeSceneProps>(current);
  latest.current = current;
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    void import('./officeSceneRenderer').then(({ mountOfficeScene }) => {
      if (disposed || !canvas.current) return;
      try {
        controller.current = mountOfficeScene(canvas.current, latest.current, () => {
          controller.current?.dispose();controller.current = null;
          if (!disposed) setUnavailable(true);
        });
      } catch {
        setUnavailable(true);
      }
    }).catch(() => { if (!disposed) setUnavailable(true); });
    return () => { disposed = true; controller.current?.dispose(); controller.current = null; };
  }, []);

  useEffect(() => { controller.current?.update({ ...props, onAnchors, onHover });onAnchors(lastAnchors.current); }, [props.office, props.selectedRole, props.frozen, props.stale, props.onSelect, onAnchors, onHover]);
  useEffect(() => { onAnchors(lastAnchors.current); }, [hoveredRole, focusedRole, onAnchors]);

  const agents = [...props.office.desks, ...props.office.lounge].map((person) => {
    const execution = officeExecution(person, props.office.totals.workersAlive, props.stale);
    return { person, tasks: 'tasks' in person ? person.tasks ?? [] : [], execution,
      visible: execution.state !== 'idle' || person.failed > 0 || person.role === hoveredRole || person.role === focusedRole };
  });
  interactionRole.current = hoveredRole ?? focusedRole;
  const expanded = agents.find(({ person }) => person.role === interactionRole.current);
  popoverRole.current = expanded?.person.role ?? null;
  if (!expanded) popupPosition.current = null;

  return unavailable
    ? <Notice tone="info">Объёмный вид недоступен в этом браузере. Все роли, очереди и ошибки доступны ниже.</Notice>
    : <div className={styles.sceneWrap} onPointerLeave={() => hover.clear()}>
      <canvas ref={canvas} className={styles.scene} role="img" aria-label="Объёмный офис: рабочие места и комната отдыха. Выберите агента или его уведомление." />
      <svg className={styles.agentLeaders} aria-hidden="true">{agents.map(({ person, visible }) => <line key={person.role} data-visible={visible} data-selected={props.selectedRole === person.role} ref={(element) => { if (element) leaders.current.set(person.role, element);else leaders.current.delete(person.role); }} />)}</svg>
      <div className={styles.agentAlerts} aria-label="Уведомления агентов">
        {agents.map(({ person, execution, visible }) => <button type="button" key={person.role} ref={(element) => { if (element) badges.current.set(person.role, element);else badges.current.delete(person.role); }} className={styles.agentAlert} data-visible={visible} data-mini="true" data-execution={execution.state} data-tone={person.failed ? 'danger' : execution.queued > 0 ? 'warning' : undefined} aria-pressed={props.selectedRole === person.role} aria-haspopup={props.onOpen ? 'dialog' : undefined} aria-label={`${person.title}: ${execution.state === 'running' ? 'Работает' : execution.label}${person.failed ? `; ошибок: ${person.failed}` : ''}`} aria-describedby={expanded?.person.role === person.role ? popoverId : undefined} onPointerEnter={() => hover.set('badge', person.role)} onPointerLeave={() => hover.set('badge', null)} onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setFocusedRole(person.role); }} onBlur={() => setFocusedRole(null)} onKeyDown={(event) => { if (event.key === 'Escape') { hover.clear();event.currentTarget.blur(); } }} onClick={() => { props.onSelect(person.role);if (props.onOpen) { hover.clear();setFocusedRole(null);props.onOpen(person.role); } }}>
          {execution.state === 'running' ? <span className={styles.workingAnimation} aria-hidden="true"><i /><i /><i /></span> : null}
          <span className={styles.executionState} data-state={execution.state}>{execution.state === 'running' ? 'Работает' : execution.state === 'idle' && person.failed ? `Ошибок: ${person.failed}` : execution.state === 'queued' ? `Очередь: ${execution.queued}` : execution.label}</span>
          {person.failed > 0 && execution.state !== 'idle' ? <span className={styles.miniError}>! {person.failed}</span> : null}
        </button>)}
        {expanded ? <div ref={popover} id={popoverId} className={styles.agentPopover} role="tooltip" aria-label={expanded.person.title} onPointerEnter={() => hover.set('popover', expanded.person.role)} onPointerLeave={() => hover.set('popover', null)}>
          <strong className={styles.popoverTitle}>{expanded.person.title}</strong>
          <span className={styles.executionState} data-state={expanded.execution.state}>{expanded.execution.label}</span>
          {expanded.tasks.length ? expanded.tasks.map(task => <div className={styles.popoverTask} key={task.id ?? `${task.kind}:${task.hidden}`}>
            <strong>{task.title}</strong><span className={styles.taskTarget}>{task.target}</span><OfficeProgress task={task} frozen={props.frozen} />
          </div>) : <p>{expanded.person.status}</p>}
          <small>В очереди: {expanded.execution.queued} · Ошибок: {expanded.person.failed}</small>
          {expanded.person.lastErrorCode ? <code className={styles.miniError}>{expanded.person.lastErrorCode}</code> : null}
        </div> : null}
      </div>
    </div>;
};
