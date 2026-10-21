import type { FC } from 'react';
import { cx } from '../../../utils/cx';
import { LoungeSprite } from './LoungeSprite';
import type { IOfficeResident } from './officeModel';
import { shirtClassOf } from './shirtClass';
import styles from './Office.module.css';

/** Комната отдыха: роли без заданий занимаются своим делом; ошибки за 24 ч остаются видны и здесь. */
export const OfficeLounge: FC<{ residents: IOfficeResident[] }> = ({ residents }) => (
  <section className={styles.lounge} aria-labelledby="office-lounge-title">
    <h3 className={styles.loungeTitle} id="office-lounge-title">
      Комната отдыха
    </h3>
    {residents.length === 0 ? (
      <p className={styles.loungeEmpty}>Все за столами: свободных нет.</p>
    ) : (
      <ul className={styles.residents}>
        {residents.map((r) => (
          <li key={r.role} className={cx(styles.resident, shirtClassOf(r.role))}>
            <div className={styles.residentSprite}>
              <LoungeSprite activity={r.activity} />
            </div>
            <p className={styles.residentName}>{r.title}</p>
            <p className={styles.residentWord} aria-hidden="true">
              {r.status}
            </p>
            {r.failed > 0 ? <p className={styles.residentError} aria-hidden="true">{`Ошибок за 24 ч: ${r.failed}${r.lastErrorCode ? ` · ${r.lastErrorCode}` : ''}`}</p> : null}
            <p className="visually-hidden">{r.caption}</p>
          </li>
        ))}
      </ul>
    )}
  </section>
);
