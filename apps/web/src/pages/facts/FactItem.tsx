import type { FC } from 'react';
import { Badge } from '../../components/Badge';
import { decidedByBadge, factStateBadge } from '../../utils/factLabels';
import { factValue } from '../../utils/factPresentation';
import { factSourceLabel, type IFactValueGroup } from '../../utils/factGroups';
import styles from './Facts.module.css';

/** Stable selector: expanded content lives below the complete list of facts. */
export const FactItem: FC<{ group: IFactValueGroup; expanded: boolean; controlsId: string; onToggle: () => void }> = ({ group, expanded, controlsId, onToggle }) => {
  const fact = group.facts[0]!;
  const conflict = group.facts.some((f) => f.state?.status === 'conflict');
  const superseded = group.facts.filter((f) => f.state?.status === 'superseded');
  const unknown = group.facts.some((f) => !f.state);
  const human = group.facts.find((f) => f.state?.decidedBy === 'human');
  return (
  <li className={styles.fact}>
    <button type="button" className={`${styles.factSummary} ${expanded ? styles.factSelected : ''}`} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? controlsId : undefined} onClick={onToggle} title={`${fact.title} · ${factSourceLabel(group)}`}>
        <span className={styles.factLabel}>{fact.title}</span>
        <span className={styles.value}>{factValue(fact)}</span>
        {group.facts.length > 1 ? <span className={styles.sourceCount}>{factSourceLabel(group)}</span> : null}
        <span className={styles.factStatus}>
          {fact.retired ? <Badge tone="muted" icon="clock-alert" label="Прежняя редакция" /> : <>
            {conflict ? <Badge tone="warning" icon="file-exclamation-point" label="Конфликт" /> : null}
            {superseded.length ? superseded.length === group.facts.length ? factStateBadge(superseded[0]!.state) : <Badge tone="muted" icon="clock-alert" label="Есть прежние условия" /> : null}
            {unknown ? <Badge tone="muted" icon="hourglass" label="Есть факты без состояния" /> : null}
          </>}
          {decidedByBadge(human?.state ?? null)}
        </span>
        <span className={styles.factChevron} aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
    </button>
  </li>
  );
};
