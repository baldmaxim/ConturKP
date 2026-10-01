import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { confirmCandidate, listCandidates, rebaseCandidate, rejectCandidate } from '../../api/requirementEndpoints';
import type { IFactCandidate, IRequirementCandidate } from '../../api/requirementTypes';
import { newUuid } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { candidateStatusBadge, originBadge } from '../../utils/requirementLabels';
import { CandidateForm, type ICandidateDraft } from './CandidateForm';
import { EvidenceLinks } from './EvidenceLinks';
import styles from './Requirements.module.css';

type TCandidate = IRequirementCandidate | IFactCandidate;

const textOf = (c: TCandidate): string | null => (c.kind === 'requirement' ? c.statement : c.displayValue ? `${c.factKindTitle}: ${c.displayValue}${c.unit ? ` ${c.unit}` : ''}` : null);

/**
 * Последовательный обход кандидатов (OD-08-7 — полнота отдельно): по одному, вперёд и назад. Подтверждает и
 * отклоняет только пользователь с requirement.confirm / fact.confirm; модель лишь предлагает (граница AI safety).
 * Кандидат прежнего реестра подтверждается только после явного переноса в активный реестр.
 */
export const CandidateQueue: FC<{ registryId: string; caps: string[]; onChanged: () => void }> = ({ registryId, caps, onChanged }) => {
  const [kind, setKind] = useState<'requirement' | 'fact'>('requirement');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [version, setVersion] = useState(0);
  const [index, setIndex] = useState(0);
  const [form, setForm] = useState<ICandidateDraft | null>(null);
  const [rejecting, setRejecting] = useState<TCandidate | null>(null);
  const [reason, setReason] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const res = useApiResource((signal) => listCandidates(registryId, kind, signal), `cand:${registryId}:${kind}:${version}`);
  const refresh = (): void => {
    setVersion((v) => v + 1);
    onChanged();
  };
  const canConfirm = caps.includes(kind === 'requirement' ? 'requirement.confirm' : 'fact.confirm');
  const canCreate = caps.includes(kind === 'requirement' ? 'requirement.create' : 'fact.create');
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const items = (res.data.items as TCandidate[]).filter((c) => !onlyOpen || c.status === 'proposed');
  const i = Math.min(index, Math.max(items.length - 1, 0));
  const c = items[i];
  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.push({ kind: 'success', text: done });
      setEdit(null);
      refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.stack}>
      <div className={styles.actions}>
        <Button variant={kind === 'requirement' ? 'primary' : 'secondary'} aria-pressed={kind === 'requirement'} onClick={() => { setKind('requirement'); setIndex(0); }}>
          Требования
        </Button>
        <Button variant={kind === 'fact' ? 'primary' : 'secondary'} aria-pressed={kind === 'fact'} onClick={() => { setKind('fact'); setIndex(0); }}>
          Факты
        </Button>
        <Button variant="ghost" aria-pressed={onlyOpen} onClick={() => { setOnlyOpen(!onlyOpen); setIndex(0); }}>
          {onlyOpen ? 'Показать все' : 'Только ждущие решения'}
        </Button>
        {canCreate ? (
          <Button variant="secondary" icon="plus" onClick={() => setForm({})}>
            {kind === 'requirement' ? 'Предложить требование' : 'Предложить факт'}
          </Button>
        ) : null}
      </div>
      {!c ? (
        <EmptyState icon="inbox" title="Кандидатов нет" text={onlyOpen ? 'Все предложения рассмотрены или ещё не созданы.' : 'В этом реестре кандидатов нет.'} />
      ) : (
        <article className={styles.card} aria-label={`Кандидат ${i + 1} из ${items.length}`}>
          <div className={styles.headLine}>
            <strong>{`${i + 1} из ${items.length}`}</strong>
            {originBadge(c.origin)}
            {candidateStatusBadge(c.status)}
            {c.kind === 'requirement' && c.targetCode ? <Badge tone="neutral" icon="pencil" label={`Правка ${c.targetCode}`} /> : null}
            {c.restricted ? <Badge tone="muted" icon="lock" label="Есть закрытое основание" /> : null}
          </div>
          {c.visible ? <p className={styles.statement}>{textOf(c)}</p> : <p className={styles.restricted}>Текст скрыт: основание из источника, на который у вас нет права.</p>}
          {c.visible && c.rationale ? <p className={styles.muted}>{`Обоснование: ${c.rationale}`}</p> : null}
          {c.visible && c.confidence !== null ? <p className={styles.muted}>{`Уверенность модели: ${Math.round(c.confidence * 100)} % — не проверка`}</p> : null}
          {c.statusReason ? <p className={styles.muted}>{`Причина: ${c.statusReason}`}</p> : null}
          <EvidenceLinks links={c.evidence} />
          {!c.registryActive && c.status === 'proposed' ? (
            <Notice tone="warning">Кандидат прежнего реестра: подтверждение — только после явного переноса в активный реестр.</Notice>
          ) : null}
          {edit !== null && c.kind === 'requirement' ? (
            <TextAreaField label="Формулировка при подтверждении" value={edit} onValueChange={setEdit} rows={3} hint="Исходный текст останется у кандидата" />
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className={styles.actions}>
            <Button variant="ghost" icon="arrow-left" disabled={i === 0} onClick={() => setIndex(i - 1)}>
              Назад
            </Button>
            <Button variant="ghost" icon="chevron-right" disabled={i >= items.length - 1} onClick={() => setIndex(i + 1)}>
              Далее
            </Button>
            {c.status === 'proposed' && c.registryActive && canConfirm && c.visible ? (
              <>
                {c.kind === 'requirement' && edit === null ? (
                  <Button variant="secondary" icon="pencil" onClick={() => setEdit(c.statement ?? '')}>
                    Уточнить и подтвердить
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  icon="check"
                  loading={busy}
                  onClick={() => void act(() => confirmCandidate(c.kind, c, edit !== null && c.kind === 'requirement' ? { statement: edit } : {}, newUuid()), 'Подтверждено')}
                >
                  Подтвердить
                </Button>
                <Button variant="danger" icon="x" disabled={busy} onClick={() => { setRejecting(c); setReason(''); }}>
                  Отклонить
                </Button>
              </>
            ) : null}
            {c.status === 'proposed' && c.registryActive && canCreate && c.visible ? (
              <Button
                variant="ghost"
                icon="pencil"
                onClick={() =>
                  setForm({
                    statement: c.kind === 'requirement' ? (c.statement ?? '') : undefined,
                    factKind: c.kind === 'fact' ? c.factKind : undefined,
                    displayValue: c.kind === 'fact' ? (c.displayValue ?? '') : undefined,
                    evidence: c.evidence.filter((e) => !e.restricted).map((e) => ({ fragmentId: e.fragmentId, role: e.role })),
                    derivedFromCandidateId: c.id,
                  })
                }
              >
                Править предложение
              </Button>
            ) : null}
            {c.status === 'proposed' && !c.registryActive && canCreate ? (
              <Button variant="secondary" icon="repeat" loading={busy} onClick={() => void act(() => rebaseCandidate(c.kind, c.id, newUuid()), 'Кандидат перенесён в активный реестр')}>
                Перенести в активный реестр
              </Button>
            ) : null}
          </div>
        </article>
      )}
      {form ? (
        <CandidateForm
          registryId={registryId}
          kind={kind}
          draft={form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            toast.push({ kind: 'success', text: 'Предложение сохранено' });
            refresh();
          }}
        />
      ) : null}
      {rejecting ? (
        <Dialog
          title="Отклонить кандидата"
          onClose={() => setRejecting(null)}
          onSubmit={() => void act(() => rejectCandidate(rejecting.kind, rejecting, reason.trim()), 'Отклонено').then(() => setRejecting(null))}
          busy={busy}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRejecting(null)}>
                Отмена
              </Button>
              <Button type="submit" variant="danger" disabled={!reason.trim()}>
                Отклонить
              </Button>
            </>
          }
        >
          <TextAreaField label="Причина" value={reason} onValueChange={setReason} required rows={2} />
        </Dialog>
      ) : null}
    </div>
  );
};
