import { useEffect, useRef, type FC } from 'react';
import { getFinding } from '../../api/reviewEndpoints';
import type { IEvidenceItem, IFindingDetail } from '../../api/reviewTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { cx } from '../../utils/cx';
import { formatDateTime } from '../../utils/datetime';
import { CONFIDENCE_LABELS, DECISION_TYPE_LABELS, EVENT_KIND_LABELS, FINDING_STATUS_LABELS, ORIGIN_LABELS, SEVERITY_LABELS, SIDE_LABELS, statusLabel } from '../../utils/reviewLabels';
import { DiscrepancyPanel } from './DiscrepancyPanel';
import { FindingActions } from './FindingActions';
import styles from './Review.module.css';

interface IFindingDetailProps {
  findingId: string;
  tenderId: string;
  onChanged: () => void;
  onClose: () => void;
}

const EvidenceView: FC<{ e: IEvidenceItem }> = ({ e }) => (
  <div className={styles.block}>
    {e.fragment ? (
      e.fragment.readable ? (
        <>
          <blockquote className={styles.quote}>{e.fragment.text}</blockquote>
          <span className={styles.muted}>
            {[e.fragment.documentTitle, e.fragment.pageIndex !== null ? `стр. ${e.fragment.pageIndex + 1}` : null].filter(Boolean).join(' · ')}{' '}
            <AppLink to={`/evidence/${e.fragment.id}`}>открыть цитату</AppLink>
          </span>
        </>
      ) : (
        <Badge label="Цитата недоступна по правам источника" icon="lock" tone="muted" />
      )
    ) : null}
    {e.calculation ? (
      <span className={styles.text}>
        {`Расчёт: ${e.calculation.text ?? 'позиция'}${e.calculation.quantity ? ` — ${Number(e.calculation.quantity)} ${e.calculation.unit ?? ''}` : ''}`}
      </span>
    ) : null}
    {e.requirement?.requirementId ? (
      <AppLink to={`/requirements/${e.requirement.requirementId}`}>{`Требование ${e.requirement.code ?? ''}`}</AppLink>
    ) : null}
    {e.fact ? <span className={styles.text}>{`Факт: ${e.fact.rawValue ?? 'значение недоступно'}`}</span> : null}
    {e.qaItemRevision ? <span className={styles.text}>{`Вопрос: ${e.qaItemRevision.question ?? '—'}`}</span> : null}
    {e.question ? <span className={styles.text}>Вопрос заказчику</span> : null}
    {e.documentRevision ? (
      <span className={styles.text}>{e.documentRevision.readable ? `Новая редакция: ${e.documentRevision.title ?? ''}, ред. ${e.documentRevision.revisionSeq ?? ''}` : 'Редакция документа недоступна'}</span>
    ) : null}
  </div>
);

/** Карточка замечания: обе стороны с цитатами, затронутые позиции, критичность, действие, ответственный, история. */
export const FindingDetail: FC<IFindingDetailProps> = ({ findingId, tenderId, onChanged, onClose }) => {
  const res = useApiResource((signal) => getFinding(findingId, signal), findingId);
  const ref = useRef<HTMLElement>(null);
  const loaded = Boolean(res.data);
  // До 1280 px карточка под списком: после выбора замечания экран переходит к ней.
  useEffect(() => {
    if (loaded && window.matchMedia('(max-width: 1279px)').matches) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      ref.current?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    }
  }, [loaded, findingId]);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const f = res.data;
  const changed = (next?: IFindingDetail): void => {
    if (next) res.setData(next);
    else res.reload();
    onChanged();
  };
  const sides = (['left', 'right'] as const).map((side) => ({ side, items: f.evidence.filter((e) => e.side === side) })).filter((s) => s.items.length > 0);
  const context = f.evidence.filter((e) => e.side === 'context');

  return (
    <section ref={ref} className={cx(styles.card, f.status === 'stale' && styles.stale)} aria-label="Карточка замечания">
      <div className={styles.headLine}>
        <Badge {...FINDING_STATUS_LABELS[f.status]} />
        <Badge label={SEVERITY_LABELS[f.severity].label} icon="file-exclamation-point" tone={SEVERITY_LABELS[f.severity].tone} />
        <span className={styles.muted}>{`уверенность: ${CONFIDENCE_LABELS[f.confidence]} · ${ORIGIN_LABELS[f.origin] ?? f.origin}`}</span>
        <Button variant="ghost" icon="x" iconOnly aria-label="Закрыть карточку" className={styles.push} onClick={onClose} />
      </div>
      <h3 className={styles.title}>{f.title}</h3>
      {f.restricted ? <Notice tone="info">Часть оснований вам недоступна: текст замечания и цитаты скрыты, изменять его нельзя.</Notice> : null}
      {f.detail ? <p className={styles.text}>{f.detail}</p> : null}
      {f.status === 'stale' && f.invalidations.length > 0 ? (
        <Notice tone="warning">{`Основание изменилось: ${f.invalidations.at(-1)!.reason}. Решение по замечанию сохранено в истории и требует пересмотра.`}</Notice>
      ) : null}
      {f.basisOutdated && f.status !== 'stale' ? <Notice tone="info">После проверки, нашедшей замечание, входы этапа изменились — перепроверьте.</Notice> : null}

      <dl className={styles.meta}>
        <dt>Вид</dt>
        <dd>{f.kindTitle}</dd>
        <dt>Действие</dt>
        <dd>{f.action ?? '—'}</dd>
        <dt>Влияние</dt>
        <dd>{f.impact ?? '—'}</dd>
        <dt>Ответственный</dt>
        <dd>{f.owner?.name ?? 'не назначен'}</dd>
      </dl>

      {sides.length > 0 ? (
        <div className={styles.sides}>
          {sides.map((s) => (
            <div key={s.side} className={cx(styles.side, f.suggestedSide === s.side && styles.suggested)}>
              <h4 className={styles.sideTitle}>
                {SIDE_LABELS[s.side]}
                {f.suggestedSide === s.side ? ' · выше по приоритету источников (подсказка, решает человек)' : ''}
              </h4>
              {s.items.map((e, i) => (
                <EvidenceView key={`${s.side}:${i}`} e={e} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {f.kind === 'source_conflict' && f.suggestedSide === null ? <p className={styles.muted}>Приоритет источников стороны не различает; дата приоритетом не является.</p> : null}
      {context.length > 0 ? (
        <details className={styles.history}>
          <summary className={styles.summary}>{`Контекст: ${context.length}`}</summary>
          {context.map((e, i) => (
            <EvidenceView key={`c:${i}`} e={e} />
          ))}
        </details>
      ) : null}

      <FindingActions finding={f} tenderId={tenderId} onChanged={changed} />
      <DiscrepancyPanel finding={f} onChanged={changed} />

      {f.decisions.length > 0 ? (
        <section className={styles.block} aria-label="Решения по замечанию">
          <h4 className={styles.sideTitle}>Решения</h4>
          <ul className={styles.list}>
            {f.decisions.map((d) => (
              <li key={d.id} className={cx(styles.check, d.invalidatedReason && styles.checkGap)}>
                <span className={styles.title}>{`${DECISION_TYPE_LABELS[d.type] ?? d.type}: ${d.statement ?? 'текст скрыт'}`}</span>
                <span className={styles.muted}>{`${d.decidedBy} · ${d.createdAt ? formatDateTime(d.createdAt) : ''}${d.rationale ? ` · ${d.rationale}` : ''}`}</span>
                {d.invalidatedReason ? <Badge label={`недействительно: ${d.invalidatedReason}`} icon="clock-alert" tone="warning" dashed /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className={styles.history}>
        <summary className={styles.summary}>{`История: событий ${f.events.length}, обнаружений проверкой ${f.occurrences.length}`}</summary>
        <ul className={styles.list}>
          {f.events.map((e) => (
            <li key={e.seq} className={styles.muted}>
              {`${e.createdAt ? formatDateTime(e.createdAt) : ''} · ${e.actor ?? ''} · ${EVENT_KIND_LABELS[e.kind] ?? e.kind}${e.kind === 'created' ? '' : `: ${statusLabel(e.from)} → ${statusLabel(e.to)}`}${e.reason ? ` · ${e.reason}` : ''}`}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
};
