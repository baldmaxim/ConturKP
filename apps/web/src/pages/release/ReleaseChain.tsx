import type { FC } from 'react';
import type { ICandidateView } from '../../api/releaseTypes';
import { Icon, type TIconName } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { formatDateTime } from '../../utils/datetime';
import { EVENT_LABELS, SEND_READINESS } from '../../utils/releaseLabels';
import styles from './Approval.module.css';

interface IStep {
  key: string;
  icon: TIconName;
  done: boolean;
  label: string;
  facts: string | null;
  tone?: 'danger' | 'warning';
}

/**
 * Цепочка выпуска (BRAND.md §4.3, I01): согласование, выпуск и готовность к отправке — разные события, у каждого свои
 * факты. Размещение и регистрация отправки — этапы 14 и 15: показываются как ещё не реализованные, а не «дорисовываются».
 * Удержание отправки — баннер над цепочкой; прежнее согласование остаётся видимым.
 */
export const ReleaseChain: FC<{ c: ICandidateView }> = ({ c }) => {
  const a = c.approval ?? null;
  const r = c.release ?? null;
  const send = r ? SEND_READINESS[r.sendReadiness.state]! : null;
  const steps: IStep[] = [
    {
      key: 'approval',
      icon: 'stamp',
      done: !!a,
      label: a ? 'Согласовано' : 'Не согласовано',
      facts: a ? `${a.approvedBy.name}, ${formatDateTime(a.approvedAt)} · комплект № ${c.seq} · ${(c.files ?? []).length} файлов${a.comment ? ` · «${a.comment}»` : ''}` : null,
    },
    {
      key: 'release',
      icon: 'package-check',
      done: !!r,
      label: r ? (r.mode === 'test' ? 'Выпущено (тестовый выпуск)' : 'Выпущено') : 'Не выпущено',
      facts: r ? `${r.releasedBy.name}, ${formatDateTime(r.releasedAt)} · манифест ${r.manifestSha256.slice(0, 12)}…` : null,
    },
    {
      key: 'send',
      icon: send?.icon ?? 'send',
      done: !!r && r.sendReadiness.sendable,
      label: r ? (r.sendReadiness.testRelease ? `${send!.label}; тестовый выпуск не отправляется` : send!.label) : 'Отправка — после выпуска',
      facts: 'Размещение и регистрация отправки — этапы 14 и 15',
      ...(r && r.sendReadiness.state !== 'ready' ? { tone: 'danger' as const } : {}),
    },
  ];
  const held = r && (r.sendReadiness.state === 'held' || r.sendReadiness.state === 'excluded');
  return (
    <div className={styles.chainWrap}>
      {held ? (
        <Notice tone="danger" icon="octagon-pause">
          {`${r.sendReadiness.state === 'excluded' ? 'Отправка исключена: по событию решено «влияет» — нужен новый комплект' : 'Отправка удержана: после согласования поступило'}${
            r.sendReadiness.events.length ? ` — ${r.sendReadiness.events.map((e) => `№ ${e.seq} ${EVENT_LABELS[e.type] ?? e.type}`).join('; ')}` : ''
          }. Прежнее согласование сохранено.`}
        </Notice>
      ) : null}
      {c.returned ? <Notice tone="warning" icon="undo-2">{`Возвращён на доработку: ${c.returned.reason ?? 'причина закрыта вместе с предметом события'} (${c.returned.returnedBy.name}, ${formatDateTime(c.returned.returnedAt)})`}</Notice> : null}
      <ol className={styles.chain} aria-label="Цепочка выпуска">
        {steps.map((s) => (
          <li key={s.key} className={styles.step} data-done={s.done ? 'true' : 'false'} data-tone={s.tone ?? ''}>
            <span className={styles.stepIcon}>
              <Icon name={s.icon} />
            </span>
            <span className={styles.stepText}>
              <span className={styles.label}>{s.label}</span>
              {s.facts ? <span className={styles.muted}>{s.facts}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};
