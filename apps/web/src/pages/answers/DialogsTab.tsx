import { useState, type FC } from 'react';
import { createDialog, listStageDialogs } from '../../api/answerEndpoints';
import { describeError } from '../../api/errors';
import { listEvidenceScopes } from '../../api/searchEndpoints';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { cx } from '../../utils/cx';
import { formatDateTime } from '../../utils/datetime';
import { DialogConversation } from './DialogConversation';
import styles from './Answers.module.css';

interface IDialogsTabProps {
  tenderId: string;
  stageId: string;
}

const WORKING = 'working';

/**
 * Вопросы к документам этапа (этап 08a, D-019): свои диалоги автора. Область диалога — рабочий состав этапа или
 * снимок области; задаётся при создании и не меняется. Ответы — по правилам ответного ядра (D-027), не регламентная
 * проверка.
 */
export const DialogsTab: FC<IDialogsTabProps> = ({ tenderId, stageId }) => {
  const dialogs = useApiResource((signal) => listStageDialogs(stageId, signal), stageId);
  const scopes = useApiResource((signal) => listEvidenceScopes(stageId, signal), stageId);
  const [scope, setScope] = useState(WORKING);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idem = useIdempotencyKey();

  const create = (): void => {
    setCreating(true);
    setError(null);
    const context = scope === WORKING ? { kind: 'tender' as const, tenderId, mode: 'working' as const, stageId } : { kind: 'tender' as const, tenderId, mode: 'review' as const, evidenceScopeId: scope };
    createDialog(context, idem.keyFor(context)).then(
      (dialog) => {
        idem.reset();
        setCreating(false);
        dialogs.reload();
        setSelected(dialog.id);
      },
      (e: unknown) => {
        setCreating(false);
        setError(e);
      },
    );
  };

  const options = [
    { value: WORKING, label: 'Рабочий состав этапа' },
    ...(scopes.data?.items ?? []).map((s) => ({ value: s.id, label: `Снимок от ${formatDateTime(s.createdAt)} · ${s.units ?? 0} ед.` })),
  ];
  const items = dialogs.data?.items ?? [];

  return (
    <div className={cx(styles.layout, selected !== null && styles.hasSelection)}>
      <div className={styles.listPane}>
        <Notice tone="info">
          Ответ составляется из цитат области: модель пишет черновик, правила проверяют цитаты, числа и редакции. Это не регламентная проверка — сверяйте с оригиналом.
        </Notice>
        <div className={styles.create}>
          <SelectField label="Область нового диалога" value={scope} options={options} onValueChange={setScope} />
          <Button variant="primary" icon="plus" loading={creating} onClick={create}>
            Новый диалог
          </Button>
        </div>
        {error ? <Notice tone="danger">{describeError(error)}</Notice> : null}
        {dialogs.error ? <ErrorState error={dialogs.error} onRetry={dialogs.reload} /> : null}
        {items.length === 0 && !dialogs.loading && !dialogs.error ? (
          <EmptyState icon="message-square" title="Диалогов пока нет" text="Создайте диалог и задайте вопрос по документам этапа. Диалоги видите только вы." />
        ) : (
          <ul className={styles.dialogs} aria-label="Мои диалоги этапа">
            {items.map((d) => (
              <li key={d.id}>
                <button type="button" className={cx(styles.dialogItem, d.id === selected && styles.dialogActive)} aria-current={d.id === selected ? 'true' : undefined} onClick={() => setSelected(d.id)}>
                  <span className={styles.dialogTitle}>{d.title}</span>
                  <span className={styles.muted}>{`${d.mode === 'review' ? 'Снимок области' : 'Рабочий состав'} · ${formatDateTime(d.createdAt)}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.mainPane}>
        {selected ? (
          <DialogConversation dialogId={selected} onBack={() => setSelected(null)} />
        ) : (
          <p className={cx(styles.muted, styles.placeholder)}>Выберите диалог слева или создайте новый.</p>
        )}
      </div>
    </div>
  );
};
