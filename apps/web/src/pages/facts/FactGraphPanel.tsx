import { useId, useState, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listContractDocuments } from '../../api/contractEndpoints';
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
import { factValue } from '../../utils/factPresentation';
import { groupFactValues } from '../../utils/factGroups';
import { factTypeSections } from '../../utils/factReview';
import { ContractFilesSidebar } from './ContractFilesSidebar';
import { FactDecisionDialog } from './FactDecisionDialog';
import { FactItem } from './FactItem';
import { FactSourcesDialog } from './FactSourcesDialog';
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
  const documents = useApiResource((signal) => owner.kind === 'contract' ? listContractDocuments(owner.id, signal) : Promise.resolve(null), `fact-documents:${owner.kind}:${owner.id}`);
  const [deciding, setDeciding] = useState<IGraphRemark | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const detailId = useId();
  const showRetired = searchParams.get('retired') === '1';
  const updateView = (changes: Record<string, string | null>): void => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) value === null ? next.delete(key) : next.set(key, value);
      return next;
    }, { replace: true, preventScrollReset: true });
  };
  const toast = useToast();

  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const g = res.data;
  const titleOf = (documentId: string): string => g.documents.find((d) => d.documentId === documentId)?.title ?? 'документ';
  const factById = new Map(g.facts.map((f) => [f.id, f]));
  const open = g.remarks.filter((r) => r.status === 'open');
  const closed = g.remarks.filter((r) => r.status === 'resolved');
  const corpus = documents.data?.items ?? [];
  const selectedFileId = searchParams.get('file') || null;
  const selectedDocument = corpus.find((d) => d.id === selectedFileId) ?? null;
  const visible = (documentId: string): boolean => !selectedFileId || selectedFileId === documentId;
  const facts = g.facts.filter((f) => (showRetired || !f.retired) && visible(f.documentId));
  const groups = groupFactValues(facts);
  const sections = factTypeSections(groups);
  const expandedGroup = groups.find((group) => group.facts.some((f) => f.id === searchParams.get('fact'))) ?? null;
  const retiredCount = g.facts.filter((f) => f.retired).length;

  const factCounts = new Map<string, number>();
  for (const f of g.facts) if (!f.retired) factCounts.set(f.documentId, (factCounts.get(f.documentId) ?? 0) + 1);

  if (g.documents.length === 0 && owner.kind !== 'contract') {
    return <EmptyState icon="scan-search" title="Фактов пока нет" text="Факты читаются правилами из распознанных документов. Распознайте документы — граф появится сам." />;
  }

  return (
    <div className={owner.kind === 'contract' ? styles.workspace : styles.stack}>
      {owner.kind === 'contract' ? <ContractFilesSidebar items={corpus} selectedId={selectedFileId} onSelect={(id) => updateView({ file: id, fact: null, cite: null })} factCounts={factCounts} graphDocuments={g.documents} totalFacts={g.facts.length - retiredCount} computedAt={g.computedAt} withoutFacts={g.coverage.documentsWithoutCurrentFacts ?? 0} /> : null}
      <div className={styles.stack}>
      {documents.error && owner.kind === 'contract' ? <Notice tone="warning">Список файлов не загружен. <Button variant="ghost" onClick={documents.reload}>Повторить</Button></Notice> : null}
      {documents.loading && !documents.data && owner.kind === 'contract' ? <p className={styles.muted}>Загружаем сведения о файлах…</p> : null}
      {owner.kind !== 'contract' ? <p className={styles.muted}>
        {`Документов: ${g.documents.length}, фактов: ${g.facts.length - retiredCount}${g.computedAt ? ` · пересчитано ${formatDateTime(g.computedAt)}` : ''}`}
      </p> : null}

      {open.length > 0 ? (
        <details className={styles.remarkDisclosure}>
          <summary className={styles.summary}><Badge tone="warning" icon="file-question-mark" label={`Нужно решение человека: ${open.length}`} /></summary>
        <section className={styles.block} aria-label="Открытые замечания">
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
                {r.factIds.length ? <p className={styles.muted}>{r.factIds.map((id) => factById.get(id)).filter(Boolean).map((f) => `«${factValue(f!)}» — ${titleOf(f!.documentId)}`).join('; ')}</p> : null}
              </li>
            ))}
          </ul>
        </section>
        </details>
      ) : null}

      <section className={styles.block} aria-label="Факты">
        <div className={styles.headLine}>
          <h3 className={styles.blockTitle}>{`${selectedFileId ? 'Факты файла' : 'Факты'} · ${groups.length}`}</h3>
          {selectedFileId ? <Button variant="ghost" onClick={() => updateView({ file: null, fact: null, cite: null })}>Все факты договора</Button> : null}
          {retiredCount > 0 ? <Button variant="ghost" className={styles.push} onClick={() => updateView({ retired: showRetired ? null : '1', fact: null })}>{showRetired ? 'Скрыть прежние редакции' : `Прежние редакции (${retiredCount})`}</Button> : null}
        </div>
        {selectedFileId ? <p className={styles.strong}>{selectedDocument?.title ?? titleOf(selectedFileId)}</p> : null}
        {!facts.length ? <p className={styles.muted}>{selectedDocument ? 'В этом файле пока нет извлечённых фактов. Состояние текста показано в списке файлов.' : 'Факты пока не выделены. Состояние текста показано в списке файлов.'}</p> : null}
        {sections.map((section) => <section key={section.type} className={styles.typeSection} aria-label={`Тип фактов: ${section.title}`}>
          <h4 className={styles.typeLabel}>{section.title}</h4>
          <ul className={styles.factList}>{section.groups.map((group) => <FactItem key={group.id} group={group} expanded={expandedGroup?.id === group.id} controlsId={detailId} onToggle={() => updateView({ fact: group.id, cite: null })} />)}</ul>
        </section>)}
        {expandedGroup ? <FactSourcesDialog id={detailId} selected={expandedGroup} groups={sections.find((section) => section.type === expandedGroup.facts[0]!.type)!.groups} documents={g.documents} citationId={searchParams.get('cite')} onSelectValue={(id) => updateView({ fact: id, cite: null })} onSelectCitation={(id) => updateView({ cite: id })} onClose={() => updateView({ fact: null, cite: null })} onShowAll={() => updateView({ file: null, fact: null, cite: null })} fileSelected={Boolean(selectedFileId)} /> : null}
      </section>

      {owner.kind !== 'contract' ? <details className={styles.history}>
        <summary className={styles.summary}>Документы и связи · {g.documents.filter((d) => visible(d.documentId)).length}</summary>
      <section className={styles.block} aria-label="Документы и связи">
        <ul className={styles.list}>
          {g.documents.filter((d) => visible(d.documentId)).map((d) => (
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
      </details> : null}

      {closed.length > 0 || g.decisions.length > 0 ? (
        <details className={styles.history}>
          <summary className={styles.summary}>{`История: закрытых замечаний ${closed.length}, решений ${g.decisions.length}`}</summary>
          <ul className={styles.list}>
            {g.decisions.map((d) => (
              <li key={d.id} className={styles.muted}>
                {`${d.createdAt ? formatDateTime(d.createdAt) : ''} · «${factById.has(d.factId) ? factValue(factById.get(d.factId)!) : '—'}» ${DECISION_KIND_LABELS[d.kind]} «${factById.has(d.otherFactId) ? factValue(factById.get(d.otherFactId)!) : '—'}» · ${d.reason}`}
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
    </div>
  );
};
