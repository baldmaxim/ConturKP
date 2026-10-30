import { useEffect, useId, useState, type FC } from 'react';
import type { IContractDocument } from '../../api/contractTypes';
import type { IGraphDocument } from '../../api/factTypes';
import { AppLink } from '../../components/AppLink';
import { formatDateTime } from '../../utils/datetime';
import { DOCUMENT_KIND_LABELS } from '../../utils/factLabels';
import { documentCoverage, documentQuality, type DocumentQuality } from '../../utils/factPresentation';
import styles from './Facts.module.css';

const labels: Record<DocumentQuality, string> = { complete: 'Готово', review: 'Частично', unread: 'Нет пригодного текста', pending: 'В обработке' };
const roles = [{ key: 'contract', label: 'Основные договоры' }, { key: 'addendum', label: 'Допсоглашения' }, { key: 'appendix', label: 'Приложения' }] as const;

export const ContractFilesSidebar: FC<{
  items: IContractDocument[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  factCounts: ReadonlyMap<string, number>;
  graphDocuments: IGraphDocument[];
  totalFacts: number;
  computedAt: string | null;
  withoutFacts: number;
}> = ({ items, selectedId, onSelect, factCounts, graphDocuments, totalFacts, computedAt, withoutFacts }) => {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const [filter, setFilter] = useState('all');
  useEffect(() => { if (selectedId === null) { setQuery(''); setFilter('all'); } }, [selectedId]);
  const showAll = (): void => { setQuery(''); setFilter('all'); onSelect(null); };
  const shown = items.filter((doc) => doc.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')) && (filter === 'all' || documentQuality(doc) === filter));
  const ready = items.filter((doc) => documentQuality(doc) === 'complete').length;
  const review = items.filter((doc) => documentQuality(doc) === 'review').length;
  const selected = items.find((doc) => doc.id === selectedId);

  return <aside className={styles.sidebar} aria-label="Файлы и качество распознавания">
    <button type="button" className={styles.sidebarToggle} aria-controls={panelId} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{`Файлы и качество · ${items.length}`} <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>
    <div id={panelId} className={`${styles.sidebarContent} ${expanded ? styles.sidebarExpanded : ''}`}>
    <div className={styles.sidebarHead}>
      <h3 className={styles.blockTitle}>Файлы договора <span className={styles.muted}>{items.length}</span></h3>
      <p className={styles.muted}>{`Документов: ${items.length} · Упоминаний: ${totalFacts}`}</p>
      {computedAt ? <p className={styles.qualityHint}>Пересчитано <time dateTime={computedAt}>{formatDateTime(computedAt)}</time></p> : null}
      <p className={styles.muted}>{`Готово: ${ready} · Частично: ${review} · Остальные: ${items.length - ready - review}`}</p>
      {withoutFacts > 0 ? <p className={styles.qualityHint}>{`Без фактов по текущей редакции: ${withoutFacts}`}</p> : null}
      <label className={styles.fileSearch}>Найти файл
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название документа" />
      </label>
      <div className={styles.fileSearch}><label htmlFor={`${panelId}-filter`}>Обработка</label>
        <select id={`${panelId}-filter`} value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">Все файлы</option>
          <option value="complete">Распознаны полностью</option>
          <option value="review">Частично распознаны</option>
          <option value="unread">Нет пригодного текста</option>
          <option value="pending">В обработке</option>
        </select>
      </div>
      <button type="button" className={`${styles.fileButton} ${selectedId === null ? styles.fileSelected : ''}`} aria-pressed={selectedId === null} onClick={showAll}>Все факты договора</button>
    </div>
    <div className={styles.fileTree}>
      {roles.map((role) => {
        const docs = shown.filter((doc) => doc.role === role.key);
        if (!docs.length) return null;
        return <details key={role.key} open className={styles.fileGroup}>
          <summary>{role.label} <span className={styles.muted}>{docs.length}</span></summary>
          <ul className={styles.list}>{docs.map((doc) => {
            const quality = documentQuality(doc), coverage = documentCoverage(doc);
            const graphDoc = graphDocuments.find((item) => item.documentId === doc.id);
            const relation = graphDoc?.relation;
            const metadata = graphDoc ? [DOCUMENT_KIND_LABELS[graphDoc.kind] ?? graphDoc.kind, graphDoc.number ? `№ ${graphDoc.number}` : null, graphDoc.documentDate ? `от ${graphDoc.documentDate}` : 'дата не указана', relation ? relation.toDocumentId ? `${relation.relation === 'amends' ? 'изменяет' : 'приложение к'} «${items.find((item) => item.id === relation.toDocumentId)?.title ?? 'договору'}» (${relation.source === '06a' ? 'связь договора' : 'по тексту'})` : `связь не установлена: ${relation.reason}` : null].filter(Boolean).join(' · ') : 'Нет фактов по текущей редакции';
            return <li key={doc.id} className={`${styles.fileCard} ${doc.id === selectedId ? styles.fileCardSelected : ''}`}>
              <button type="button" className={`${styles.fileButton} ${doc.id === selectedId ? styles.fileSelected : ''}`} aria-pressed={doc.id === selectedId} onClick={() => onSelect(doc.id)}>
                <span className={styles.fileName} title={`${doc.title}\n${metadata}`}>{doc.title}</span>
                <span className={styles.fileMeta}><span className={`${styles.qualityDot} ${styles[`quality_${quality}`]}`} aria-hidden="true" />{labels[quality]} · {factCounts.get(doc.id) ?? 0} факт.</span>
                {coverage ? <>
                  <progress className={styles.fileProgress} max={coverage.total} value={coverage.recognized} aria-label={`Пригодный текст: ${doc.title}`} />
                  <span className={styles.fileMeta}>{`Пригодно: ${coverage.recognized} из ${coverage.total} ${doc.latestRevision.mediaType === 'application/pdf' ? 'стр.' : 'разд.'} · ${coverage.percent}%`}</span>
                </> : null}
              </button>
              {graphDoc ? <details className={styles.fileDetails}><summary>Сведения и связи</summary><p className={styles.qualityHint}>{metadata}</p></details> : null}
            </li>;
          })}</ul>
        </details>;
      })}
      {!shown.length ? <p className={styles.muted}>Нет файлов по выбранному условию.</p> : null}
    </div>
    <p className={styles.qualityHint}>Процент — доля страниц или разделов, прошедших проверку текста, а не точность каждого символа.</p>
    {selected ? <AppLink className={styles.open} to={`/contract-documents/${selected.id}`}>Открыть выбранный документ</AppLink> : null}
    </div>
  </aside>;
};
