import { useState, type FC } from 'react';
import { decideFacts } from '../../api/factEndpoints';
import type { IFactGraphView, IGraphFact, IGraphRemark } from '../../api/factTypes';
import { describeError } from '../../api/errors';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { TextAreaField } from '../../components/TextAreaField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { REMARK_KIND_LABELS } from '../../utils/factLabels';
import styles from './Facts.module.css';

interface IFactDecisionDialogProps {
  remark: IGraphRemark;
  facts: IGraphFact[];
  documentTitle: (documentId: string) => string;
  onClose: () => void;
  onDone: (graph: IFactGraphView) => void;
}

const DISTINCT = 'distinct';

/**
 * Решение человека по неоднозначности графа (D-018, D-028): какое значение действует — или значения независимы.
 * Решение — ребро графа с причиной, а не правка прочитанного факта; граф пересчитывается сервером.
 */
export const FactDecisionDialog: FC<IFactDecisionDialogProps> = ({ remark, facts, documentTitle, onClose, onDone }) => {
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  const submit = async (): Promise<void> => {
    if (!choice || !reason.trim()) {
      setError('Выберите решение и укажите причину');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pairs =
        choice === DISTINCT
          ? facts.flatMap((a, i) => facts.slice(i + 1).map((b) => ({ factId: a.id, otherFactId: b.id, kind: 'distinct' as const })))
          : facts.filter((f) => f.id !== choice).map((f) => ({ factId: choice, otherFactId: f.id, kind: 'prevails' as const }));
      let graph: IFactGraphView | null = null;
      for (const p of pairs) {
        graph = (await decideFacts(p.factId, { otherFactId: p.otherFactId, kind: p.kind, reason: reason.trim() }, idem.keyFor({ remark: remark.id, ...p, reason }))).graph;
        idem.reset();
      }
      if (graph) onDone(graph);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={REMARK_KIND_LABELS[remark.kind]}
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="check" loading={busy}>
            Записать решение
          </Button>
        </>
      }
    >
      <p className={styles.muted}>{remark.message}</p>
      <fieldset className={styles.choices}>
        <legend className={styles.legend}>Решение</legend>
        {facts.map((f) => (
          <label key={f.id} className={styles.choice}>
            <input type="radio" name="fact-decision" value={f.id} checked={choice === f.id} onChange={() => setChoice(f.id)} />
            <span>{`Действует «${f.display}» — ${documentTitle(f.documentId)}${f.clauseRef ? `, п. ${f.clauseRef}` : ''}`}</span>
          </label>
        ))}
        <label className={styles.choice}>
          <input type="radio" name="fact-decision" value={DISTINCT} checked={choice === DISTINCT} onChange={() => setChoice(DISTINCT)} />
          <span>Значения независимы — это разные условия</span>
        </label>
      </fieldset>
      <TextAreaField label="Причина" value={reason} onValueChange={setReason} rows={3} maxLength={2000} required placeholder="Например: ДС № 1 подписано после договора" />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
};
