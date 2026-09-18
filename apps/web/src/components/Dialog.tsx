import { useEffect, useId, useRef, type FC, type FormEvent, type ReactNode } from 'react';
import { Button } from './Button';
import styles from './Dialog.module.css';

interface IDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Если задан, тело диалога — форма, footer — внутри неё (кнопка type="submit" работает). */
  onSubmit?: () => void;
  /** Нельзя закрыть (идёт запрос к серверу). */
  busy?: boolean;
}

/** Модальный диалог на нативном <dialog>: фокус внутри, Esc закрывает. На смартфоне — нижний лист. */
export const Dialog: FC<IDialogProps> = ({ title, onClose, children, footer, onSubmit, busy = false }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return undefined;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    const onCancel = (event: Event): void => {
      event.preventDefault();
      if (!busyRef.current) {
        onCloseRef.current();
      }
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) {
        dialog.close();
      }
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit?.();
  };

  const content = (
    <>
      <div className={styles.body}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </>
  );

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId}>
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <Button variant="ghost" icon="x" iconOnly aria-label="Закрыть" title="Закрыть" onClick={onClose} disabled={busy} />
      </div>
      {onSubmit ? (
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {content}
        </form>
      ) : (
        <div className={styles.form}>{content}</div>
      )}
    </dialog>
  );
};
