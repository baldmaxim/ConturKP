import type { FC } from 'react';
import { AppLink } from '../../../components/AppLink';
import { Badge } from '../../../components/Badge';
import { Icon } from '../../../components/Icon';
import { cx } from '../../../utils/cx';
import { plural } from '../../../utils/sourceLabels';
import { OfficeSprite } from './OfficeSprite';
import { FOLDERS_SHOWN, type IOfficeDesk, type IOfficeFolder } from './officeModel';
import { shirtClassOf } from './shirtClass';
import styles from './Office.module.css';

/** Счёт папки словами: только ненулевые части. */
const folderCounts = (f: IOfficeFolder): string =>
  [f.running > 0 ? `в работе ${f.running}` : null, f.queued > 0 ? `в очереди ${f.queued}` : null, f.failed > 0 ? `ошибок ${f.failed}` : null]
    .filter(Boolean)
    .join(' · ');

const Folder: FC<{ folder: IOfficeFolder }> = ({ folder }) => {
  const inner = (
    <>
      <Icon name="folder" size={16} className={styles.folderIcon} />
      <span className={styles.folderTitle}>{folder.title}</span>
      <span className={styles.folderCounts}>{folderCounts(folder)}</span>
    </>
  );
  return (
    <li className={styles.folderItem}>
      {folder.tenderId ? (
        <AppLink to={`/tenders/${folder.tenderId}`} className={cx(styles.folder, styles.folderLink)}>
          {inner}
        </AppLink>
      ) : (
        <span className={cx(styles.folder, folder.hidden && styles.folderHidden)}>{inner}</span>
      )}
    </li>
  );
};

/** Стол роли: человечек, имя, счётчики, папки по тендерам и бейдж ошибок. Рисунок декоративный, состояние — в тексте. */
export const OfficeDesk: FC<{ desk: IOfficeDesk }> = ({ desk }) => {
  const shown = desk.folders.slice(0, FOLDERS_SHOWN);
  const more = desk.folders.length - shown.length;
  return (
    <li className={cx(styles.desk, shirtClassOf(desk.role), desk.mood === 'alarm' && styles.deskAlarm, desk.mood === 'dozing' && styles.deskDozing)}>
      <div className={styles.deskSprite}>
        <OfficeSprite pose={desk.pose} />
      </div>
      <div className={styles.deskHead}>
        <h3 className={styles.role}>{desk.title}</h3>
        <p className={styles.status} aria-hidden="true">
          {desk.status}
        </p>
        <p className="visually-hidden">{desk.caption}</p>
      </div>
      <dl className={styles.counts} aria-hidden="true">
        <div>
          <dt>В работе</dt>
          <dd>{desk.running}</dd>
        </div>
        <div>
          <dt>В очереди</dt>
          <dd>{desk.queued}</dd>
        </div>
      </dl>
      {desk.failed > 0 ? (
        <div className={styles.deskBadge}>
          <Badge tone="danger" icon="circle-x" label={`Ошибок за 24 ч: ${desk.failed}${desk.lastErrorCode ? ` · ${desk.lastErrorCode}` : ''}`} />
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className={styles.folders} aria-label="Папки по тендерам">
          {shown.map((folder) => (
            <Folder key={folder.key} folder={folder} />
          ))}
          {more > 0 ? <li className={styles.folderMore}>{`и ещё ${more} ${plural(more, ['папка', 'папки', 'папок'])}`}</li> : null}
        </ul>
      ) : null}
    </li>
  );
};
