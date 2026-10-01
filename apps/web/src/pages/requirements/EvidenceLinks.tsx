import type { FC } from 'react';
import type { IEvidenceLink } from '../../api/requirementTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { ROLE_LABELS, SOURCE_KIND_LABELS } from '../../utils/requirementLabels';
import styles from './Requirements.module.css';

/**
 * Основания с ролью (AD-08-3): текст — только по правам источника; закрытое основание показано пометкой,
 * без текста. Цитата открывается отдельно и снова проверяет права источника (Р-08-5).
 */
export const EvidenceLinks: FC<{ links: IEvidenceLink[] }> = ({ links }) =>
  links.length === 0 ? null : (
    <ul className={styles.evidence} aria-label="Основания">
      {links.map((l) => (
        <li key={`${l.fragmentId}:${l.role}`} className={styles.evidenceItem}>
          <div className={styles.headLine}>
            <Badge tone={l.role === 'supports' ? 'accent' : l.role === 'contradicts' ? 'danger' : 'neutral'} icon="link" label={ROLE_LABELS[l.role]} />
            <span className={styles.muted}>{SOURCE_KIND_LABELS[l.sourceKind] ?? l.sourceKind}</span>
            {l.pageIndex !== null ? <span className={styles.muted}>{`стр. ${l.pageIndex + 1}`}</span> : null}
          </div>
          {l.restricted ? (
            <p className={styles.restricted}>
              <Badge tone="muted" icon="lock" label="Основание недоступно" /> Нет права на источник — текст не показывается.
            </p>
          ) : (
            <>
              <p className={styles.quote}>{l.text}</p>
              <AppLink to={`/evidence/${l.fragmentId}`} className={styles.link}>
                Открыть цитату
              </AppLink>
            </>
          )}
        </li>
      ))}
    </ul>
  );
