import type { FC } from 'react';
import type { IGraphFact } from '../../api/factTypes';
import { AppLink } from '../../components/AppLink';
import { decidedByBadge, factStateBadge } from '../../utils/factLabels';
import styles from './Facts.module.css';

/** Факт графа: значение, состояние (правило или человек), документ и пункт, срок действия, цитата оригинала. */
export const FactItem: FC<{ fact: IGraphFact; documentTitle: string; replacedBy: IGraphFact | null }> = ({ fact, documentTitle, replacedBy }) => (
  <li className={styles.fact}>
    <div className={styles.headLine}>
      <span className={styles.value}>{fact.display}</span>
      {factStateBadge(fact.state)}
      {decidedByBadge(fact.state)}
    </div>
    <p className={styles.muted}>
      {[documentTitle, fact.clauseRef ? `п. ${fact.clauseRef}` : null, fact.state?.validFrom ? `с ${fact.state.validFrom}` : null, fact.state?.validTo ? `по ${fact.state.validTo}` : null, replacedBy ? `заменено значением «${replacedBy.display}»` : null]
        .filter(Boolean)
        .join(' · ')}
    </p>
    <p className={styles.quote}>{fact.rawValue}</p>
    {fact.fragmentIds[0] ? (
      <AppLink className={styles.open} to={`/evidence/${fact.fragmentIds[0]}`}>
        Открыть цитату
      </AppLink>
    ) : null}
  </li>
);
