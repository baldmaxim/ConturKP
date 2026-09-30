import type { FC } from 'react';
import type { ISearchHit } from '../../api/types';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { anchorLabel, isLocalEngine, originMeta, RECOGNITION_OUTCOME } from '../../utils/localRecognitionLabels';
import { SEARCH_BRANCH_LABELS } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './SearchTab.module.css';

interface ISearchHitCardProps {
  hit: ISearchHit;
}

/**
 * Результат поиска — цитата фрагмента портала: документ, редакция, страница, происхождение и ветки,
 * которые его нашли. Открывает участок локального оригинала (ADR-008 §12, ADR-012 §23). Фрагмент
 * локального распознавания помечен движком и итогом прогона и цитируется структурным якорем (A43).
 */
export const SearchHitCard: FC<ISearchHitCardProps> = ({ hit }) => {
  const origin = originMeta(hit.origin, hit.engine);
  const local = isLocalEngine(hit.engine);
  const page = hit.pageIndex === null ? 'без страницы' : `стр. ${hit.pageLabel ?? hit.pageIndex + 1}`;
  const review = local && hit.runOutcome === 'needs_review' ? RECOGNITION_OUTCOME.needs_review : null;
  const where = [
    hit.documentTitle ?? 'Документ',
    hit.revisionSeq !== null ? `ред. ${hit.revisionSeq}` : null,
    hit.locator ? anchorLabel(hit.locator) : page,
    !hit.locator && hit.sheetLabel ? `лист ${hit.sheetLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={styles.hit}>
      <div className={styles.hitHead}>
        <span className={styles.rank}>{hit.rank}</span>
        <span className={styles.where}>{where}</span>
      </div>
      <p className={styles.snippet}>
        {hit.text}
        {hit.textTruncated ? '…' : ''}
      </p>
      <div className={styles.hitFoot}>
        <Badge tone={origin.tone} icon={origin.icon} dashed={origin.dashed} label={origin.label} />
        {hit.contractId ? <Badge tone="info" icon="file-signature" label="Документ договора" /> : null}
        {review ? <Badge tone={review.tone} icon={review.icon} dashed={review.dashed} label={review.label} /> : null}
        <span className={list.muted}>{`Найдено: ${hit.matchedVia.map((b) => SEARCH_BRANCH_LABELS[b] ?? b).join(', ')}`}</span>
        <AppLink className={styles.open} to={`/evidence/${hit.fragmentId}`}>
          Открыть доказательство
        </AppLink>
      </div>
    </li>
  );
};
