import { useState, type FC } from 'react';
import { getFactGraph } from '../../api/factEndpoints';
import type { IGraphFact, IGraphRemark } from '../../api/factTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { DECISION_KIND_LABELS, DOCUMENT_KIND_LABELS, REMARK_KIND_LABELS } from '../../utils/factLabels';
import { FactDecisionDialog } from './FactDecisionDialog';
import { FactItem } from './FactItem';
import styles from './Facts.module.css';

interface IFactGraphPanelProps {
  owner: { kind: 'tender' | 'contract'; id: string };
}

/**
 * Факты документов и редакции (D-018, D-028): что прочитано правилами из документов, что из этого действует, что
 * перекрыто допсоглашением, решением человека или новой редакцией документа, и где правило не может выбрать —
 * замечание человеку. Значение открывается цитатой оригинала.
 */
export const FactGraphPanel: FC<IFactGraphPanelProps> = ({ owner }) => {
  const res = useApiResource((signal) => getFactGraph(owner, signal), `${owner.kind}:${owner.id}`);
  const [deciding, setDeciding] = useState<IGraphRemark | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const toast = useToast();

  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const g = res.data;
  const titleOf = (documentId: string): string => g.documents.find((d) => d.documentId === documentId)?.title ?? 'документ';
  const factById = new Map(g.facts.map((f) => [f.id, f]));
  const open = g.remarks.filter((r) => r.status === 'open');
  const closed = g.remarks.filter((r) => r.status === 'resolved');
  const facts = g.facts.filter((f) => showRetired || !f.retired);
  const types = [...new Set(facts.map((f) => f.type))];
  const retiredCount = g.facts.filter((f) => f.retired).length;

  if (g.documents.length === 0) {
    return <EmptyState icon="scan-search" title="Фактов пока нет" text="Факты читаются правилами из распознанных документов. Распознайте документы — граф появится сам." />;
  }

  return (
    <div className={styles.stack}>
      <p className={styles.muted}>
        {`Документов: ${g.documents.length}, фактов: ${g.facts.length - retiredCount}${g.computedAt ? ` · пересчитано ${formatDateTime(g.computedAt)}` : ''}`}
      </p>
      {(g.coverage.documentsWithoutCurrentFacts ?? 0) > 0 ? (
        <Notice tone="warning">{`Последняя редакция ещё не прочитана у документов: ${g.coverage.documentsWithoutCurrentFacts}. Их факты — по прежней редакции.`}</Notice>
      ) : null}

      {open.length > 0 ? (
        <section className={styles.block} aria-label="Открытые замечания">
          <h3 className={styles.blockTitle}>{`Нужно решение человека: ${open.length}`}</h3>
          <ul className={styles.list}>
            {open.map((r) => (
              <li key={r.id} className={styles.remark}>
                <div className={styles.headLine}>
                  <Badge tone="warning" icon="file-question-mark" dashed label={REMARK_KIND_LABELS[r.kind]} />
                  {g.canDecide && r.factIds.length >= 2 ? (
                    <Button icon="pencil" className={styles.push} onClick={() => setDeciding(r)}>
                      Решить
                    </Button>
                  ) : null}
                </div>
                <p className={styles.text}>{r.message}</p>
                {r.factIds.length ? <p className={styles.muted}>{r.factIds.map((id) => factById.get(id)).filter(Boolean).map((f) => `«${f!.display}» — ${titleOf(f!.documentId)}`).join('; ')}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Notice tone="success">Открытых замечаний нет: правило не встретило неоднозначностей.</Notice>
      )}

      <section className={styles.block} aria-label="Документы и связи">
        <h3 className={styles.blockTitle}>Документы и связи</h3>
        <ul className={styles.list}>
          {g.documents.map((d) => (
            <li key={d.documentId} className={styles.row}>
              <span className={styles.strong}>{d.title}</span>
              <span className={styles.muted}>
                {[DOCUMENT_KIND_LABELS[d.kind] ?? d.kind, d.number ? `№ ${d.number}` : null, d.documentDate ? `от ${d.documentDate}` : 'дата не указана'].filter(Boolean).join(' · ')}
              </span>
              {d.relation ? (
                <span className={styles.muted}>
                  {d.relation.toDocumentId
                    ? `${d.relation.relation === 'amends' ? 'изменяет' : 'приложение к'} «${titleOf(d.relation.toDocumentId)}» (${d.relation.source === '06a' ? 'связь договора' : 'по тексту'})`
                    : `связь не установлена: ${d.relation.reason}`}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.block} aria-label="Факты">
        <div className={styles.headLine}>
          <h3 className={styles.blockTitle}>Факты</h3>
          {retiredCount > 0 ? (
            <Button variant="ghost" className={styles.push} onClick={() => setShowRetired((v) => !v)}>
              {showRetired ? 'Скрыть прежние редакции' : `Показать прежние редакции (${retiredCount})`}
            </Button>
          ) : null}
        </div>
        {types.map((type) => (
          <div key={type} className={styles.group}>
            <h4 className={styles.groupTitle}>{facts.find((f) => f.type === type)!.title}</h4>
            <ul className={styles.list}>
              {facts.filter((f) => f.type === type).map((f) => (
                <FactItem key={f.id} fact={f} documentTitle={titleOf(f.documentId)} replacedBy={f.state?.supersededByFactId ? factById.get(f.state.supersededByFactId) ?? null : null} />
              ))}
            </ul>
          </div>
        ))}
      </section>

      {closed.length > 0 || g.decisions.length > 0 ? (
        <details className={styles.history}>
          <summary className={styles.summary}>{`История: закрытых замечаний ${closed.length}, решений ${g.decisions.length}`}</summary>
          <ul className={styles.list}>
            {g.decisions.map((d) => (
              <li key={d.id} className={styles.muted}>
                {`${d.createdAt ? formatDateTime(d.createdAt) : ''} · «${factById.get(d.factId)?.display ?? '—'}» ${DECISION_KIND_LABELS[d.kind]} «${factById.get(d.otherFactId)?.display ?? '—'}» · ${d.reason}`}
              </li>
            ))}
            {closed.map((r) => (
              <li key={r.id} className={styles.muted}>{`Закрыто ${r.resolvedAt ? formatDateTime(r.resolvedAt) : ''}: ${REMARK_KIND_LABELS[r.kind]} — ${r.message}`}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {deciding ? (
        <FactDecisionDialog
          remark={deciding}
          facts={deciding.factIds.map((id) => factById.get(id)).filter((f): f is IGraphFact => Boolean(f))}
          documentTitle={titleOf}
          onClose={() => setDeciding(null)}
          onDone={(next) => {
            setDeciding(null);
            res.setData(next);
            toast.push({ kind: 'success', text: 'Решение записано, граф пересчитан' });
          }}
        />
      ) : null}
    </div>
  );
};
