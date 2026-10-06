import { useState, type FC } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextAreaField } from '../../components/TextAreaField';
import styles from './Forms.module.css';

interface IDiscussDialogProps {
  label: string;
  busy: boolean;
  canAskCustomer: boolean;
  onSubmit: (comment: string, createQuestion: boolean) => void;
  onClose: () => void;
}

/** «Обсудить» (D-031 В-11-4): комментарий и, по желанию, черновик вопроса заказчику; значение поля сохраняется. */
export const DiscussDialog: FC<IDiscussDialogProps> = ({ label, busy, canAskCustomer, onSubmit, onClose }) => {
  const [comment, setComment] = useState('');
  const [question, setQuestion] = useState(false);
  return (
    <Dialog
      title={`Обсудить: ${label}`}
      onClose={onClose}
      busy={busy}
      onSubmit={() => onSubmit(comment.trim(), question)}
      footer={
        <>
          <Button type="submit" variant="primary" icon="message-square" loading={busy} disabled={!comment.trim()}>
            Отметить «требует обсуждения»
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <TextAreaField label="Что обсудить" value={comment} onValueChange={setComment} rows={4} maxLength={4000} required />
        {canAskCustomer ? (
          <label className={styles.row}>
            <input type="checkbox" checked={question} onChange={(e) => setQuestion(e.target.checked)} />
            <span>Создать черновик вопроса заказчику со ссылкой на поле</span>
          </label>
        ) : null}
        <p className={styles.muted}>Ответ заказчика поле сам не меняет: значение подтверждает человек.</p>
      </div>
    </Dialog>
  );
};
