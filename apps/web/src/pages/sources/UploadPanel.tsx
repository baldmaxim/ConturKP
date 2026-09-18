import { useRef, useState, type DragEvent, type FC } from 'react';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import type { IUploadEntry, IUploadQueue } from '../../hooks/useUploadQueue';
import { cx } from '../../utils/cx';
import { formatBytes } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import styles from './UploadPanel.module.css';

interface IUploadPanelProps {
  stageId: string;
  queue: IUploadQueue;
}

const percent = (entry: IUploadEntry): number => Math.round(entry.progress * 100);

const statusBadge = (entry: IUploadEntry) => {
  switch (entry.status) {
    case 'queued':
      return <Badge tone="muted" icon="hourglass" label="В очереди" />;
    case 'uploading':
      return <Badge tone="info" icon="upload" label={`Отправляется · ${percent(entry)} %`} />;
    case 'accepted':
      return <Badge tone="success" icon="check" label="Принят сервером" />;
    default:
      return <Badge tone="danger" icon="circle-x" label="Не отправлен" />;
  }
};

/** Загрузка файлов в этап: выбор нескольких файлов, перетаскивание (десктоп), прогресс по каждому файлу. */
export const UploadPanel: FC<IUploadPanelProps> = ({ stageId, queue }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { entries } = queue;
  const hasFinished = entries.some((entry) => entry.status === 'accepted');

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    queue.add(Array.from(event.dataTransfer.files));
  };

  return (
    <section className={form.section} aria-labelledby="upload-title">
      <div className={form.sectionHead}>
        <h2 id="upload-title" className={form.sectionTitle}>
          Загрузка файлов
        </h2>
        {hasFinished ? (
          <Button variant="ghost" onClick={queue.clearFinished}>
            Убрать принятые
          </Button>
        ) : null}
      </div>

      <div
        className={cx(styles.drop, dragging && styles.dragging)}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <Icon name="upload" size={32} className={styles.dropIcon} />
        <p className={styles.dropText}>
          Каждый файл станет отдельной партией импорта.
          <span className={styles.desktopOnly}> Файлы можно перетащить в эту область.</span>
        </p>
        <p className={styles.hint}>ZIP распаковывается на сервере; RAR и 7z не поддерживаются.</p>
        <Button variant="primary" icon="upload" onClick={() => inputRef.current?.click()}>
          Выбрать файлы
        </Button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = event.target.files;
            if (files) {
              queue.add(Array.from(files));
            }
            // Сброс: повторный выбор того же файла снова вызовет onChange.
            event.target.value = '';
          }}
        />
      </div>

      {entries.length > 0 ? (
        <ul className={styles.list} aria-label="Отправляемые файлы">
          {entries.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <div className={styles.entryHead}>
                <span className={styles.name}>{entry.name}</span>
                {statusBadge(entry)}
              </div>
              <div className={styles.meta}>
                <span className={styles.num}>{formatBytes(entry.size)}</span>
                {entry.batch ? (
                  <AppLink to={`/imports/${entry.batch.id}?stage=${stageId}`}>Открыть партию</AppLink>
                ) : null}
              </div>
              {entry.status === 'uploading' ? (
                <div
                  className={styles.track}
                  role="progressbar"
                  aria-label={`Отправка ${entry.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent(entry)}
                >
                  {/* Динамическое значение прогресса: анимируется transform, не ширина. */}
                  <div className={styles.bar} style={{ transform: `scaleX(${entry.progress})` }} />
                </div>
              ) : null}
              {entry.error ? <p className={styles.error}>{entry.error}</p> : null}
              <div className={styles.actions}>
                {entry.status === 'error' ? (
                  <Button icon="refresh-cw" onClick={() => queue.retry(entry.id)}>
                    Повторить
                  </Button>
                ) : null}
                {entry.status === 'uploading' ? (
                  <Button variant="ghost" icon="x" onClick={() => queue.cancel(entry.id)}>
                    Отменить
                  </Button>
                ) : (
                  <Button variant="ghost" icon="x" onClick={() => queue.remove(entry.id)}>
                    Убрать
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
