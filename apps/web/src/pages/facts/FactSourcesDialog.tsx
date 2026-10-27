import { useEffect, useRef, useState, type FC } from 'react';
import type { IGraphDocument, IGraphFact } from '../../api/factTypes';
import type { IEvidenceDetail } from '../../api/types';
import { getEvidence } from '../../api/recognitionEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { decidedByBadge, factStateBadge } from '../../utils/factLabels';
import { factSourceLabel, type IFactValueGroup } from '../../utils/factGroups';
import { factValue } from '../../utils/factPresentation';
import { citationTextGroups } from '../../utils/factReview';
import { anchorLabel } from '../../utils/localRecognitionLabels';
import { EvidenceViewer } from '../evidence/EvidenceViewer';
import styles from './Facts.module.css';

const status = (fact: IGraphFact) => <>
  {fact.retired ? <Badge tone="muted" icon="clock-alert" label="Прежняя редакция" /> : fact.state?.status !== 'active' ? factStateBadge(fact.state) : null}
  {decidedByBadge(fact.state)}
</>;

export const FactSourcesDialog: FC<{
  id: string;
  selected: IFactValueGroup;
  groups: IFactValueGroup[];
  documents: IGraphDocument[];
  citationId: string | null;
  onSelectValue: (id: string) => void;
  onSelectCitation: (id: string) => void;
  onClose: () => void;
  onShowAll: () => void;
  fileSelected: boolean;
}> = ({ id, selected, groups, documents, citationId, onSelectValue, onSelectCitation, onClose, onShowAll, fileSelected }) => {
  const cache = useRef(new Map<string, IEvidenceDetail>());
  const [evidence, setEvidence] = useState(new Map<string, IEvidenceDetail>());
  const [errors, setErrors] = useState(new Set<string>());
  const [retry, setRetry] = useState(0);
  const ids = [...new Set(selected.facts.flatMap((f) => f.fragmentIds))];
  const idsKey = ids.join('|');
  useEffect(() => {
    const controller = new AbortController();
    const queue = ids.filter((key) => !cache.current.has(key));
    setErrors(new Set());
    const worker = async (): Promise<void> => {
      while (queue.length && !controller.signal.aborted) {
        const key = queue.shift()!;
        try {
          const data = await getEvidence(key, controller.signal);
          if (controller.signal.aborted) return;
          cache.current.set(key, data);
          setEvidence(new Map(cache.current));
        } catch {
          if (!controller.signal.aborted) setErrors((previous) => new Set([...previous, key]));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return () => controller.abort();
  }, [idsKey, retry]);

  const citations = citationTextGroups(selected.facts, evidence, documents);
  const loaded = ids.filter((key) => evidence.has(key)).length;
  const selectedEvidence = citations.flatMap((group) => group.evidence).find((item) => item.id === citationId);
  const titleOf = (documentId: string): string => documents.find((document) => document.documentId === documentId)?.title ?? 'Документ';
  return <Dialog id={id} wide title={`${selected.facts[0]!.title} — источники и цитаты`} onClose={onClose} footer={<>
    {fileSelected ? <Button onClick={onShowAll}>Все факты договора</Button> : null}
    <Button onClick={onClose}>Закрыть</Button>
  </>}>
    <div className={styles.comparisonTable}>
      <table>
        <caption>Значения для сравнения{fileSelected ? ' · выбранный файл' : ' · все файлы'}</caption>
        <thead><tr><th>Значение</th><th>Источники</th><th>Цитаты</th><th>Состояние</th></tr></thead>
        <tbody>{groups.map((group) => <tr key={group.id}>
          <td><button type="button" className={styles.valueChoice} aria-pressed={group.id === selected.id} onClick={() => onSelectValue(group.id)}>{factValue(group.facts[0]!)}</button></td>
          <td>{factSourceLabel(group)}</td>
          <td>{new Set(group.facts.flatMap((fact) => fact.fragmentIds)).size}</td>
          <td>{group.facts.some((fact) => fact.state?.status === 'conflict') ? <Badge tone="warning" icon="file-exclamation-point" label="Конфликт" /> : group.facts.some((fact) => fact.retired || fact.state?.status === 'superseded') ? <span className={styles.muted}>Есть прежние условия</span> : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className={styles.muted} role="status">{loaded < ids.length - errors.size ? `Загружаем тексты цитат: ${loaded} из ${ids.length}…` : `Различных текстов: ${citations.length} · Ссылок на страницы и фрагменты: ${ids.length}. Одинаковый текст одного файла показан один раз.`}</p>
    {errors.size ? <p className={styles.muted}>{`Не удалось загрузить цитаты: ${errors.size}. `}<Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>Повторить</Button></p> : null}
    <div className={styles.reviewWorkspace}>
      <section className={styles.reviewSources} aria-label="Тексты для сравнения">
        {selected.facts.filter((fact) => !fact.fragmentIds.length || fact.fragmentIds.every((key) => errors.has(key))).map((fact) => <article key={fact.id} className={styles.citationCard}><h4>{titleOf(fact.documentId)}</h4>{status(fact)}<p className={styles.quote}>{fact.rawValue}</p><p className={styles.muted}>Текст фрагментов недоступен; показана сохранённая цитата факта.</p></article>)}
        {citations.map((group) => <article key={group.id} className={styles.citationCard} aria-label={`Текст источника: ${titleOf(group.documentId)}`}>
          <h4 className={styles.blockTitle}>{titleOf(group.documentId)}</h4>
          <div className={styles.headLine}>{group.facts.map((fact) => <span key={fact.id}>{status(fact)}</span>)}</div>
          {group.facts[0]?.condition ? <p className={styles.muted}>{group.facts[0].condition}</p> : null}
          <p className={styles.reviewQuote}>{group.text}</p>
          <p className={styles.muted}>{group.evidence.length > 1 ? `Одинаковый текст · ${group.evidence.length} фрагментов. Выберите страницу для проверки оригинала:` : 'Место в оригинале:'}</p>
          <div className={styles.pageChoices}>{group.evidence.map((item) => <button key={item.id} type="button" className={styles.pageChoice} aria-pressed={item.id === citationId} onClick={() => onSelectCitation(item.id)} title={item.locator ? anchorLabel(item.locator) : item.text.slice(0, 100)}>{item.pageIndex !== null ? `Стр. ${item.pageIndex + 1}` : item.locator ? anchorLabel(item.locator) : `Фрагмент ${item.ordinal}`}</button>)}</div>
        </article>)}
      </section>
      <section className={styles.reviewPreview} aria-label="Просмотр цитаты">
        {selectedEvidence ? <>
          <h4 className={styles.blockTitle}>{titleOf(selectedEvidence.documentId!)}{selectedEvidence.pageIndex !== null ? ` · стр. ${selectedEvidence.pageIndex + 1}` : ''}</h4>
          <EvidenceViewer key={selectedEvidence.id} fragmentId={selectedEvidence.id} embedded />
        </> : <p className={styles.muted}>Тексты уже видны слева. Выберите номер страницы, чтобы посмотреть фрагмент и открыть страницу оригинала здесь, без перехода из договора.</p>}
      </section>
    </div>
  </Dialog>;
};
