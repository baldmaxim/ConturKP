import { useCallback, useEffect, useState, type FC } from 'react';
import { API_BASE } from '../../api/client';
import { describeError } from '../../api/errors';
import { listComparisonItems } from '../../api/sendEndpoints';
import type { IComparisonItem, IItemSide, TCompareSection } from '../../api/sendTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../utils/datetime';
import { SEVERITY_LABELS } from '../../utils/reviewLabels';
import { CHANGE, COVERAGE, DISPOSITION, REASON_KIND, REASON_STATUS, SUBJECT } from '../../utils/sendLabels';
import { ItemReasonDialog } from './ItemReasonDialog';
import styles from './Comparison.module.css';

const valueText = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

// Состояние вопроса и серьёзность принятого замечания — закреплённые в выпуске, а не текущие.
const noteText = (subjectType: string, note: string): string => {
  if (subjectType === 'customer_question') return note === 'sent' ? 'на момент выпуска: отправлен, ответа нет' : `на момент выпуска: ${note}`;
  if (subjectType === 'finding_risk') return `серьёзность на момент выпуска: ${SEVERITY_LABELS[note as keyof typeof SEVERITY_LABELS]?.label ?? note}`;
  return note;
};

const Side: FC<{ side: IItemSide; which: 'left' | 'right'; showValue: boolean; subjectType: string }> = ({ side, which, showValue, subjectType }) => (
  <div className={styles.side} data-side={which}>
    <span className={styles.sideLabel}>{which === 'left' ? 'Было' : 'Стало'}</span>
    <span>{side.label ?? '—'}</span>
    {showValue && 'value' in side ? <span>{valueText(side.value)}</span> : null}
    {side.note ? <span className={styles.muted}>{noteText(subjectType, side.note)}</span> : null}
    {side.sha256 ? <span className={styles.mono}>{`SHA-256 ${side.sha256.slice(0, 16)}…`}</span> : null}
  </div>
);

const detailText = (i: IComparisonItem): string | null => {
  const d = i.detail;
  const parts: string[] = [];
  if ('leftCoverage' in d || 'rightCoverage' in d) {
    const name = (x: unknown) => (typeof x === 'string' ? (COVERAGE[x] ?? x) : 'оценки нет');
    parts.push(`покрытие: ${name(d.leftCoverage)} → ${name(d.rightCoverage)}`);
  }
  if (typeof d.disposition === 'string') parts.push(DISPOSITION[d.disposition] ?? d.disposition);
  if (d.unrecognized === true) parts.push('в снимке без распознавания');
  if (typeof d.leftStatus === 'string' && typeof d.rightStatus === 'string' && d.leftStatus !== d.rightStatus) parts.push(`статус: ${d.leftStatus} → ${d.rightStatus}`);
  if (typeof d.leftDecision === 'string' || typeof d.rightDecision === 'string') {
    const name = (x: unknown) => (x === 'not_applicable' ? '«не влияет»' : x === 'requires_new_candidate' ? '«влияет»' : '—');
    parts.push(`решение: ${name(d.leftDecision)} → ${name(d.rightDecision)}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
};

// Доказательство — ссылка на неизменяемую запись; у документа открывается оригинал редакции.
const evidenceHref = (e: { type: string; id: string }): string | null => (e.type === 'document_revision' ? `${API_BASE}/document-revisions/${encodeURIComponent(e.id)}/content` : null);

interface IComparisonItemsProps {
  comparisonId: string;
  section: TCompareSection;
  canSetReason: boolean;
  onReasonChanged: () => void;
}

/**
 * Выводы одного раздела сравнения: вид изменения, «было» и «стало», доказательства (ссылки на записи) и статус причины.
 * Закрытый вывод показывается без названий и значений: среди его оснований есть то, что читатель открыть не может.
 */
export const ComparisonItems: FC<IComparisonItemsProps> = ({ comparisonId, section, canSetReason, onReasonChanged }) => {
  const [items, setItems] = useState<IComparisonItem[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<IComparisonItem | null>(null);

  const load = useCallback(
    (after: number, replace: boolean): void => {
      setLoading(true);
      setError(null);
      listComparisonItems(comparisonId, section, after).then(
        (r) => {
          setItems((prev) => (replace ? r.items : [...prev, ...r.items]));
          setNext(r.hasMore ? r.nextAfter : null);
          setLoading(false);
        },
        (e: unknown) => {
          setError(describeError(e));
          setLoading(false);
        },
      );
    },
    [comparisonId, section],
  );
  useEffect(() => load(0, true), [load]);

  if (error) return <p className={styles.muted}>{error}</p>;
  if (!loading && items.length === 0) return <p className={styles.muted}>Изменений нет.</p>;
  return (
    <>
      <ul className={styles.list}>
        {items.map((i) => {
          const change = CHANGE[i.change] ?? { label: i.change, icon: 'info' as const, tone: 'neutral' as const };
          const reason = REASON_STATUS[i.reasonStatus]!;
          const detail = i.closed ? null : detailText(i);
          return (
            <li key={i.id} className={styles.item}>
              <div className={styles.head}>
                <span className={styles.title}>{SUBJECT[i.subjectType] ?? i.subjectType}</span>
                <span className={styles.badges}>
                  <Badge label={change.label} icon={change.icon} tone={change.tone} dashed={change.dashed} />
                  <Badge label={reason.label} icon={reason.icon} tone={reason.tone} dashed={reason.dashed} />
                </span>
              </div>
              {i.closed ? (
                <p className={styles.muted}>Закрыто для вас: среди оснований вывода есть то, что вы не можете читать.</p>
              ) : (
                <>
                  <div className={styles.sides}>
                    {i.left ? <Side side={i.left} which="left" showValue={i.subjectType === 'field_version'} subjectType={i.subjectType} /> : null}
                    {i.right ? <Side side={i.right} which="right" showValue={i.subjectType === 'field_version'} subjectType={i.subjectType} /> : null}
                  </div>
                  {detail ? <p className={styles.muted}>{detail}</p> : null}
                  {i.evidence.length > 0 ? (
                    <p className={styles.muted}>
                      {'Доказательства: '}
                      {i.evidence.map((e, n) => {
                        const href = evidenceHref(e);
                        const text = `${SUBJECT[e.type] ?? e.type} ${e.id.slice(0, 8)}…`;
                        return (
                          <span key={e.id}>
                            {n > 0 ? '; ' : ''}
                            {href ? (
                              <a href={href} target="_blank" rel="noreferrer">
                                {text}
                              </a>
                            ) : (
                              <span className={styles.mono}>{text}</span>
                            )}
                          </span>
                        );
                      })}
                    </p>
                  ) : null}
                </>
              )}
              {i.reason ? (
                <div className={styles.reason}>
                  <span>{i.reason.restricted ? 'Пояснение причины закрыто: его основания недоступны вам.' : `${REASON_KIND[i.reason.reasonKind] ?? i.reason.reasonKind}: ${i.reason.rationale ?? '—'}`}</span>
                  <span className={styles.muted}>{`${i.reason.actor.name}, ${formatDateTime(i.reason.createdAt)} · версия ${i.reason.version} · оснований: ${i.reason.bases}`}</span>
                </div>
              ) : null}
              {canSetReason && !i.closed ? (
                <span className={styles.actions}>
                  <Button icon="pencil" onClick={() => setDialog(i)}>
                    Указать причину…
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {next !== null && items.length > 0 ? (
        <Button loading={loading} onClick={() => load(next, false)}>
          Показать ещё
        </Button>
      ) : null}
      {dialog ? (
        <ItemReasonDialog
          item={dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            load(0, true);
            onReasonChanged();
          }}
        />
      ) : null}
    </>
  );
};
