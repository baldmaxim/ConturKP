import type { FC } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Notice } from './Notice';
import styles from './ConflictDialog.module.css';

export interface IConflictRow {
  label: string;
  mine: string;
  current: string;
}

interface IConflictDialogProps {
  title: string;
  rows: IConflictRow[];
  /** Текущее состояние с сервера неизвестно (сервер не прислал current, перечитать не удалось). */
  currentUnknown?: boolean;
  onReload: () => void;
  onClose: () => void;
  reloading?: boolean;
}

/**
 * Конфликт версий (412): показываем ваши и текущие значения и предлагаем перечитать.
 * Автоматической перезаписи нет — правки переносит человек.
 */
export const ConflictDialog: FC<IConflictDialogProps> = ({ title, rows, currentUnknown = false, onReload, onClose, reloading }) => (
  <Dialog
    title={title}
    onClose={onClose}
    busy={reloading}
    footer={
      <>
        <Button variant="ghost" onClick={onClose} disabled={reloading}>
          Вернуться к правке
        </Button>
        <Button variant="primary" icon="refresh-cw" onClick={onReload} loading={reloading}>
          Перечитать
        </Button>
      </>
    }
  >
    <Notice tone="warning">
      Ваши изменения не сохранены. «Перечитать» загрузит текущие значения в форму — затем внесите свои правки заново.
    </Notice>
    {currentUnknown ? (
      <p>Текущие значения сервер не передал. Перечитайте объект, чтобы увидеть их.</p>
    ) : (
      <div className={styles.rows}>
        {rows.map((row) => (
          <div key={row.label} className={styles.row}>
            <div className={styles.label}>
              {row.label}
              {row.mine !== row.current ? <span className={styles.diff}> · отличается</span> : null}
            </div>
            <dl className={styles.values}>
              <dt>Ваше значение</dt>
              <dd>{row.mine || '—'}</dd>
              <dt>Сейчас на сервере</dt>
              <dd>{row.current || '—'}</dd>
            </dl>
          </div>
        ))}
      </div>
    )}
  </Dialog>
);
