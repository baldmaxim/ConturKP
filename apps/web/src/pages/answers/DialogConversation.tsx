import { useState, type FC, type FormEvent } from 'react';
import { askQuestion, getAnswerRun, getDialog } from '../../api/answerEndpoints';
import type { IAnswerRun } from '../../api/answerTypes';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import { AnswerCard } from './AnswerCard';
import styles from './Answers.module.css';

interface IDialogConversationProps {
  dialogId: string;
  onBack: () => void;
}

const isOpen = (run: IAnswerRun): boolean => run.status === 'queued' || run.status === 'running';

const pendingReason = (error: unknown): boolean => {
  const current = stateConflictCurrent(error);
  return Boolean(current && typeof current === 'object' && 'reason' in current && (current as { reason: unknown }).reason === 'answer_pending');
};

/**
 * Диалог (D-019): вопросы автора и ответы по области диалога. Ход — задание gpu; ответ получают опросом прогона,
 * пока он не завершится. Новый вопрос — после ответа на предыдущий (один открытый ход на диалог).
 */
export const DialogConversation: FC<IDialogConversationProps> = ({ dialogId, onBack }) => {
  const res = useApiResource((signal) => getDialog(dialogId, signal), dialogId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idem = useIdempotencyKey();
  const dialog = res.data;
  const pending = dialog?.runs.find(isOpen) ?? null;

  usePolling(pending !== null, () => {
    if (!pending) return;
    getAnswerRun(pending.id).then(
      (next) => {
        if (isOpen(next)) return;
        // Ход завершён: перечитать диалог целиком — сообщение ответа и видимость считает сервер.
        res.reload();
      },
      (e: unknown) => setError(e),
    );
  }, 1500);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const question = text.trim();
    if (!question || pending) return;
    setBusy(true);
    setError(null);
    askQuestion(dialogId, question, idem.keyFor({ dialogId, question })).then(
      (accepted) => {
        idem.reset();
        setText('');
        setBusy(false);
        res.setData(accepted.dialog);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
        if (pendingReason(e)) res.reload();
      },
    );
  };

  if (res.loading && !dialog) return <LoadingState />;
  if (res.error && !dialog) return <ErrorState error={res.error} onRetry={res.reload} notFoundTitle="Диалог не найден или нет доступа" />;
  if (!dialog) return null;

  const questions = dialog.messages.filter((m) => m.role === 'user');
  return (
    <section className={styles.conversation} aria-label={`Диалог «${dialog.title}»`}>
      <div className={styles.conversationHead}>
        <Button variant="ghost" icon="arrow-left" className={styles.back} onClick={onBack}>
          К списку
        </Button>
        <h2 className={styles.title}>{dialog.title}</h2>
        <span className={styles.muted}>
          {`${dialog.mode === 'review' ? 'Снимок области' : dialog.mode === 'contract' ? 'Документы договора' : 'Рабочий состав этапа'} · ${dialog.createdAt ? formatDateTime(dialog.createdAt) : ''}`}
        </span>
      </div>
      {questions.length === 0 ? (
        <p className={styles.muted}>Задайте вопрос по документам области. Ответ будет только из процитированных фрагментов.</p>
      ) : (
        <ol className={styles.turns}>
          {questions.map((q) => {
            const run = dialog.runs.find((r) => r.questionMessageId === q.id);
            return (
              <li key={q.id} className={styles.turn}>
                <p className={styles.question}>{q.text}</p>
                {run ? <AnswerCard run={run} /> : null}
              </li>
            );
          })}
        </ol>
      )}
      <form className={styles.ask} onSubmit={submit} aria-label="Новый вопрос">
        <TextAreaField
          label="Вопрос"
          value={text}
          onValueChange={setText}
          rows={3}
          maxLength={4000}
          required
          placeholder="Например: какой гарантийный срок?"
          hint={pending ? 'Дождитесь ответа на предыдущий вопрос.' : 'Уточняющий вопрос учитывает предыдущие ходы этого диалога.'}
        />
        {error ? <Notice tone={pendingReason(error) ? 'info' : 'danger'}>{pendingReason(error) ? 'Предыдущий вопрос ещё обрабатывается.' : describeError(error)}</Notice> : null}
        <div className={form.actions}>
          <Button type="submit" variant="primary" icon="message-square" loading={busy} disabled={!text.trim() || pending !== null}>
            Спросить
          </Button>
        </div>
      </form>
    </section>
  );
};
