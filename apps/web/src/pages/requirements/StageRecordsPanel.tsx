import { useState, type FC } from 'react';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { createAssumption, createNote, createQuestion, listAssumptions, listNotes, listQuestions, reviseAssumption, updateQuestion } from '../../api/requirementEndpoints';
import type { IAssumption, ICustomerQuestion } from '../../api/requirementTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import styles from './Requirements.module.css';

const ASSUMPTION_LABELS: Record<IAssumption['status'], string> = { open: 'Открыто', confirmed: 'Подтверждено', rejected: 'Отклонено', superseded: 'Заменено' };
const QUESTION_LABELS: Record<ICustomerQuestion['status'], string> = { draft: 'Черновик', sent: 'Отправлен', answered: 'Ответ получен', closed: 'Закрыт' };
const NEXT: Partial<Record<ICustomerQuestion['status'], ICustomerQuestion['status'][]>> = { draft: ['sent', 'closed'], sent: ['answered', 'closed'], answered: ['closed'] };

/**
 * Допущение, вопрос заказчику и пометка этапа (OD-08-6): три отдельных типа, не требования и не факты.
 * Вопрос не отправляется порталом — статус «Отправлен» ставит человек (C04). Пометка в полноту не входит.
 */
export const StageRecordsPanel: FC<{ stageId: string; caps: string[] }> = ({ stageId, caps }) => {
  const [version, setVersion] = useState(0);
  const assumptions = useApiResource((s) => listAssumptions(stageId, s), `as:${stageId}:${version}`);
  const questions = useApiResource((s) => listQuestions(stageId, s), `qs:${stageId}:${version}`);
  const notes = useApiResource((s) => listNotes(stageId, s), `ns:${stageId}:${version}`);
  const [text, setText] = useState({ assumption: '', question: '', note: '', answer: '' });
  const [error, setError] = useState<string | null>(null);
  const canCreate = caps.includes('requirement.create');
  const canConfirm = caps.includes('requirement.confirm');
  const run = async (fn: () => Promise<unknown>, clear?: keyof typeof text): Promise<void> => {
    setError(null);
    try {
      await fn();
      if (clear) setText((t) => ({ ...t, [clear]: '' }));
      setVersion((v) => v + 1);
    } catch (e) {
      setError(describeError(e));
    }
  };
  if ((assumptions.loading && !assumptions.data) || (questions.loading && !questions.data) || (notes.loading && !notes.data)) return <LoadingState />;
  const failed = assumptions.error ?? questions.error ?? notes.error;
  if (failed) return <ErrorState error={failed} onRetry={() => setVersion((v) => v + 1)} />;
  return (
    <div className={styles.stack}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <section className={form.section} aria-label="Допущения">
        <h2 className={form.sectionTitle}>Допущения ПД</h2>
        {canCreate ? (
          <div className={styles.stack}>
            <TextAreaField label="Новое допущение" value={text.assumption} onValueChange={(v) => setText({ ...text, assumption: v })} rows={2} hint="Рабочее предположение при недостатке данных; точная величина не выдумывается" />
            <div className={styles.actions}>
              <Button variant="secondary" icon="plus" disabled={!text.assumption.trim()} onClick={() => void run(() => createAssumption(stageId, { statement: text.assumption.trim() }, newUuid()), 'assumption')}>
                Добавить
              </Button>
            </div>
          </div>
        ) : null}
        <ul className={styles.cards}>
          {(assumptions.data?.items ?? []).map((a) => (
            <li key={a.id} className={styles.card}>
              <div className={styles.headLine}>
                <Badge tone={a.status === 'confirmed' ? 'success' : a.status === 'open' ? 'warning' : 'muted'} icon={a.status === 'open' ? 'hourglass' : 'check'} dashed={a.status === 'open'} label={ASSUMPTION_LABELS[a.status]} />
                {a.requirementCode ? <span className={styles.code}>{a.requirementCode}</span> : null}
              </div>
              {a.visible ? <p className={styles.statement}>{a.statement}</p> : <p className={styles.restricted}>Текст скрыт: основание из закрытого источника.</p>}
              {a.status === 'open' && canConfirm ? (
                <div className={styles.actions}>
                  <Button variant="primary" icon="check" onClick={() => void run(() => reviseAssumption(a, { status: 'confirmed' }))}>
                    Подтвердить
                  </Button>
                  <Button variant="danger" icon="x" onClick={() => void run(() => reviseAssumption(a, { status: 'rejected', reason: 'Отклонено руководителем' }))}>
                    Отклонить
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section className={form.section} aria-label="Вопросы заказчику">
        <h2 className={form.sectionTitle}>Вопросы заказчику</h2>
        {canCreate ? (
          <div className={styles.stack}>
            <TextAreaField label="Новый вопрос" value={text.question} onValueChange={(v) => setText({ ...text, question: v })} rows={2} />
            <div className={styles.actions}>
              <Button variant="secondary" icon="plus" disabled={!text.question.trim()} onClick={() => void run(() => createQuestion(stageId, { text: text.question.trim() }, newUuid()), 'question')}>
                Добавить черновик
              </Button>
            </div>
          </div>
        ) : null}
        <ul className={styles.cards}>
          {(questions.data?.items ?? []).map((q) => (
            <li key={q.id} className={styles.card}>
              <div className={styles.headLine}>
                <Badge tone={q.status === 'answered' ? 'success' : q.status === 'closed' ? 'muted' : 'warning'} icon={q.status === 'answered' ? 'check' : 'message-square'} label={QUESTION_LABELS[q.status]} />
                {q.askedAt ? <span className={styles.muted}>{`отправлен ${formatDateTime(q.askedAt)} МСК`}</span> : null}
              </div>
              <p className={styles.statement}>{q.text}</p>
              {q.answerNote || q.answerQaItemNo ? <p className={styles.quote}>{`Ответ: ${q.answerNote ?? ''}${q.answerQaItemNo ? ` (вопрос–ответ № ${q.answerQaItemNo})` : ''}`}</p> : null}
              {canCreate && NEXT[q.status] ? (
                <div className={styles.actions}>
                  {q.status === 'sent' ? (
                    <TextAreaField label="Ответ заказчика" value={text.answer} onValueChange={(v) => setText({ ...text, answer: v })} rows={2} />
                  ) : null}
                  {NEXT[q.status]!.map((s) => (
                    <Button
                      key={s}
                      variant={s === 'closed' ? 'ghost' : 'secondary'}
                      disabled={s === 'answered' && !text.answer.trim()}
                      onClick={() => void run(() => updateQuestion(q, s === 'answered' ? { status: s, answerNote: text.answer.trim() } : { status: s }), s === 'answered' ? 'answer' : undefined)}
                    >
                      {QUESTION_LABELS[s]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section className={form.section} aria-label="Пометки этапа">
        <h2 className={form.sectionTitle}>Пометки этапа</h2>
        {canCreate ? (
          <div className={styles.stack}>
            <TextAreaField label="Новая пометка" value={text.note} onValueChange={(v) => setText({ ...text, note: v })} rows={2} hint="Рабочая заметка: в полноту, факты и вход модели не попадает" />
            <div className={styles.actions}>
              <Button variant="secondary" icon="plus" disabled={!text.note.trim()} onClick={() => void run(() => createNote(stageId, text.note.trim(), newUuid()), 'note')}>
                Добавить
              </Button>
            </div>
          </div>
        ) : null}
        <ul className={styles.cards}>
          {(notes.data?.items ?? []).map((n) => (
            <li key={n.id} className={styles.card}>
              <p className={styles.statement}>{n.text}</p>
              <p className={styles.muted}>{`${formatDateTime(n.createdAt)} МСК${n.supersededBy ? ' · заменена' : ''}`}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
