import type { FC, ReactNode } from 'react';
import type { IImportItem } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { cx } from '../../utils/cx';
import { formatDateTime } from '../../utils/datetime';
import { formatBytes, ITEM_STATUS, NEEDS_OUTCOME, needsOutcome, rejectReasonLabel, RESOLUTION, shortSha } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './ImportItemsList.module.css';

interface IImportItemsListProps {
  items: IImportItem[];
  /** Исход можно задать (партия не в обработке и есть хотя бы одно право). */
  canResolve: boolean;
  onResolve: (item: IImportItem) => void;
}

const reasonCell = (item: IImportItem): ReactNode => {
  if (!item.rejectReason && !item.rejectDetail) {
    return <span className={list.muted}>—</span>;
  }
  return (
    <div className={styles.reason}>
      {item.rejectReason ? <span>{rejectReasonLabel(item.rejectReason)}</span> : null}
      {item.rejectDetail ? <span className={styles.detail}>{item.rejectDetail}</span> : null}
    </div>
  );
};

const sizeText = (item: IImportItem): ReactNode =>
  item.sizeBytes === null ? <span className={list.muted}>нет данных</span> : formatBytes(item.sizeBytes);

export const ImportItemsList: FC<IImportItemsListProps> = ({ items, canResolve, onResolve }) => {
  if (items.length === 0) {
    return <EmptyState icon="inbox" title="Элементов пока нет" text="Партия ещё разбирается или в загрузке не оказалось файлов." />;
  }

  const outcomeCell = (item: IImportItem): ReactNode => {
    if (item.resolution !== 'none') {
      return (
        <div className={styles.reason}>
          <Badge {...RESOLUTION[item.resolution]} />
          {item.resolvedAt ? <span className={cx(styles.detail, list.num)}>{formatDateTime(item.resolvedAt)} МСК</span> : null}
        </div>
      );
    }
    if (!needsOutcome(item)) {
      return <span className={list.muted}>—</span>;
    }
    return (
      <div className={styles.reason}>
        <Badge {...NEEDS_OUTCOME} />
        <span className={styles.detail}>Нужен исход: повторный импорт или решение руководителя</span>
        {canResolve ? (
          <Button onClick={() => onResolve(item)}>Задать исход…</Button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className={list.tableWrap}>
        <table className={list.table}>
          <thead>
            <tr>
              <th scope="col">Путь</th>
              <th scope="col">Статус</th>
              <th scope="col">Причина отказа</th>
              <th scope="col" className={list.right}>
                Размер
              </th>
              <th scope="col">Исход</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className={cx(needsOutcome(item) && styles.flagRow)}>
                <td>
                  <span className={styles.path}>{item.memberPath}</span>
                  {item.sha256 ? (
                    <span className={cx(styles.detail, styles.sha)} title={item.sha256}>
                      SHA-256 {shortSha(item.sha256)}…
                    </span>
                  ) : null}
                </td>
                <td>
                  <Badge {...ITEM_STATUS[item.status]} />
                </td>
                <td>{reasonCell(item)}</td>
                <td className={`${list.num} ${list.right}`}>{sizeText(item)}</td>
                <td>{outcomeCell(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={list.cards}>
        {items.map((item) => (
          <li key={item.id} className={cx(list.card, needsOutcome(item) && styles.flagCard)}>
            <div className={list.cardHead}>
              <span className={cx(list.cardTitle, styles.path)}>{item.memberPath}</span>
              <Badge {...ITEM_STATUS[item.status]} />
            </div>
            <dl className={list.meta}>
              <dt>Размер</dt>
              <dd className={list.num}>{sizeText(item)}</dd>
              {item.rejectReason || item.rejectDetail ? (
                <>
                  <dt>Причина</dt>
                  <dd>{reasonCell(item)}</dd>
                </>
              ) : null}
              {item.sha256 ? (
                <>
                  <dt>SHA-256</dt>
                  <dd className={styles.sha} title={item.sha256}>
                    {shortSha(item.sha256)}…
                  </dd>
                </>
              ) : null}
              <dt>Исход</dt>
              <dd>{outcomeCell(item)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
};
