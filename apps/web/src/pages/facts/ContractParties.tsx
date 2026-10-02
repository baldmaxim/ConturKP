import type { FC } from 'react';
import { getContractFactGraph } from '../../api/factEndpoints';
import { useApiResource } from '../../hooks/useApiResource';
import { factStateBadge } from '../../utils/factLabels';
import styles from './Facts.module.css';

/**
 * Стороны по тексту договора (D-018, судьба `contract_card`; D-028): показываются рядом с карточкой, поля карточки
 * не меняются — расхождение с карточкой видно человеку, а не исправляется молча.
 */
export const ContractParties: FC<{ contractId: string }> = ({ contractId }) => {
  const res = useApiResource((signal) => getContractFactGraph(contractId, signal), `parties:${contractId}`);
  const parties = res.data?.parties ?? [];
  if (parties.length === 0) return null;
  return (
    <section className={styles.block} aria-label="Стороны по тексту договора">
      <h3 className={styles.blockTitle}>Стороны по тексту договора</h3>
      <ul className={`${styles.list} ${styles.parties}`}>
        {parties.map((p) => (
          <li key={p.factId} className={styles.row}>
            <span className={styles.muted}>{p.title}</span>
            <span className={styles.strong}>{p.name}</span>
            {p.status && p.status !== 'active' ? factStateBadge({ status: p.status, supersededReason: null, supersededByFactId: null, validFrom: null, validTo: null, decidedBy: 'rule', decisionId: null }) : null}
          </li>
        ))}
      </ul>
      <p className={styles.muted}>Прочитано правилами из документов договора; карточку выше это не меняет.</p>
    </section>
  );
};
