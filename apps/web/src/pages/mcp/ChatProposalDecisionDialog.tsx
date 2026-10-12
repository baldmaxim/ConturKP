import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { acceptChatProposal, rejectChatProposal } from '../../api/mcpEndpoints';
import type { IChatProposal, TChatProposalKind } from '../../api/mcpTypes';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import styles from './ChatProposals.module.css';

export const CHAT_PROPOSAL_KIND: Record<TChatProposalKind, string> = { finding: 'Замечание', question: 'Вопрос заказчику', condition_text: 'Текст условия', change_reason: 'Причина изменения' };
const ACCEPTED: Record<TChatProposalKind, string> = {
  finding: 'Замечание создано от вашего имени.',
  question: 'Создан черновик вопроса заказчику.',
  condition_text: 'Предложение принято. Перенесите текст в поле приложения.',
  change_reason: 'Причина записана как гипотеза.',
};
// Что произойдёт при принятии — до нажатия кнопки.
const WILL: Record<TChatProposalKind, string> = {
  finding: 'Замечание будет создано от вашего имени.',
  question: 'Будет создан черновик вопроса заказчику от вашего имени.',
  condition_text: 'Запись не создаётся: после принятия перенесите текст в поле приложения сами.',
  change_reason: 'Причина будет записана к выводу сравнения как гипотеза, от вашего имени.',
};
const SEVERITY = [
  { value: 'critical', label: 'Критичное' },
  { value: 'major', label: 'Существенное' },
  { value: 'minor', label: 'Незначительное' },
];
const CONFIDENCE = [
  { value: 'high', label: 'Высокая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'low', label: 'Низкая' },
];

interface IChatProposalDecisionDialogProps {
  proposal: IChatProposal;
  mode: 'accept' | 'reject';
  onDone: () => void;
  onClose: () => void;
}

/**
 * Решение человека по предложению из чата: принять (у замечания — со своей серьёзностью и уверенностью) или отклонить
 * с причиной. Запись создаётся от имени решающего; подсказка чата значением не становится.
 */
export const ChatProposalDecisionDialog: FC<IChatProposalDecisionDialogProps> = ({ proposal, mode, onDone, onClose }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [severity, setSeverity] = useState('');
  const [confidence, setConfidence] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isFinding = proposal.kind === 'finding';

  const submit = async (): Promise<void> => {
    const next: Record<string, string> = {};
    if (mode === 'reject' && !reason.trim()) next.reason = 'Укажите причину отклонения.';
    if (mode === 'accept' && isFinding && !severity) next.severity = 'Выберите серьёзность.';
    if (mode === 'accept' && isFinding && !confidence) next.confidence = 'Выберите уверенность.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    try {
      if (mode === 'reject') {
        await rejectChatProposal(proposal, reason.trim(), idem.keyFor({ id: proposal.id, mode, reason }));
        toast.push({ kind: 'success', text: 'Предложение отклонено.' });
      } else {
        const body = isFinding ? { severity: severity as 'critical' | 'major' | 'minor', confidence: confidence as 'low' | 'medium' | 'high' } : {};
        await acceptChatProposal(proposal, body, idem.keyFor({ id: proposal.id, mode, body }));
        toast.push({ kind: 'success', text: ACCEPTED[proposal.kind] });
      }
      onDone();
    } catch (error) {
      setFormError(describeError(error));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={mode === 'accept' ? `Принять: ${CHAT_PROPOSAL_KIND[proposal.kind].toLowerCase()}` : 'Отклонить предложение'}
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant={mode === 'accept' ? 'primary' : 'danger'} type="submit" loading={saving}>
            {mode === 'accept' ? 'Принять' : 'Отклонить'}
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <div className={styles.stack}>
        {proposal.title ? <p className={styles.title}>{proposal.title}</p> : null}
        <p className={styles.body}>{proposal.body}</p>
        {mode === 'accept' && isFinding ? (
          <>
            <Notice tone="info">{WILL.finding} Серьёзность и уверенность задаёте вы: подсказка чата значением не становится.</Notice>
            <SelectField label="Серьёзность" required value={severity} options={SEVERITY} onValueChange={setSeverity} placeholder="Выберите" error={errors.severity} />
            <SelectField label="Уверенность" required value={confidence} options={CONFIDENCE} onValueChange={setConfidence} placeholder="Выберите" error={errors.confidence} />
          </>
        ) : null}
        {mode === 'accept' && !isFinding ? <Notice tone="info">{WILL[proposal.kind]}</Notice> : null}
        {mode === 'reject' ? <TextAreaField label="Причина отклонения" required maxLength={1000} value={reason} onValueChange={setReason} error={errors.reason} /> : null}
      </div>
    </Dialog>
  );
};
