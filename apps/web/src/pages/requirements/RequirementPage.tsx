import { useState, type FC } from 'react';
import { useParams } from 'react-router-dom';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { getRequirementCard, recordDecision } from '../../api/requirementEndpoints';
import type { IRequirementCard } from '../../api/requirementTypes';
import { getStage, getTender } from '../../api/endpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { COVERAGE_LABELS, coverageBadge } from '../../utils/requirementLabels';
import form from '../../styles/form.module.css';
import { CoverageForm } from './CoverageForm';
import { EvidenceLinks } from './EvidenceLinks';
import styles from './Requirements.module.css';

const CHANGE_LABELS = { confirmation: 'Подтверждение кандидата', carry_over: 'Перенос в новый реестр', supersede: 'Замена' } as const;

const DecisionForm: FC<{ card: IRequirementCard; onSaved: (c: IRequirementCard) => void }> = ({ card, onSaved }) => {
  const [statement, setStatement] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = card.decisions.find((d) => d.status === 'active') ?? null;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await recordDecision(card.id, { statement: statement.trim(), rationale: rationale.trim(), supersedesDecisionId: active?.id ?? null }, newUuid());
      onSaved(r.requirement);
      setStatement('');
      setRationale('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.stack}>
      <TextAreaField label={active ? 'Новое решение (заменит действующее)' : 'Решение'} value={statement} onValueChange={setStatement} rows={2} required />
      <TextAreaField label="Обоснование" value={rationale} onValueChange={setRationale} rows={2} required />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className={styles.actions}>
        <Button variant="primary" icon="check" loading={busy} disabled={!statement.trim() || !rationale.trim()} onClick={() => void submit()}>
          Записать решение
        </Button>
      </div>
    </div>
  );
};

/**
 * Карточка требования (AD-08-1, Р-08-2, Р-08-3): ревизии формулировки, основания, история оценок покрытия и
 * решения. Из закрытого источника — только оболочка; новая оценка и решение не меняют ревизию требования.
 */
export const RequirementPage: FC = () => {
  const { requirementId = '' } = useParams();
  const res = useApiResource((signal) => getRequirementCard(requirementId, signal), requirementId);
  const stageId = res.data?.stageId ?? '';
  const stage = useApiResource((signal) => (stageId ? getStage(stageId, signal) : Promise.resolve(null)), stageId);
  const tenderId = stage.data?.tenderId ?? '';
  const tender = useApiResource((signal) => (tenderId ? getTender(tenderId, signal) : Promise.resolve(null)), tenderId);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} notFoundTitle="Требование не найдено или нет доступа" />;
  const card = res.data;
  const caps = tender.data?.capabilities ?? [];
  const current = card.revisions[card.revisions.length - 1];
  const editable = card.registryActive && card.status === 'confirmed' && card.visible;
  return (
    <>
      <PageHeader
        back={{ to: `/stages/${card.stageId}?tab=requirements`, label: stage.data ? `Этап № ${stage.data.seq}. ${stage.data.title}` : 'К этапу' }}
        title={`Требование ${card.code}`}
        subtitle={
          <span className={styles.headLine}>
            {card.status === 'superseded' ? <Badge tone="muted" icon="repeat" label={`Заменено ${card.supersededByCode ?? ''}`.trim()} /> : <Badge tone="success" icon="user-check" label="Подтверждено человеком" />}
            {coverageBadge(card.coverageState)}
            {!card.registryActive ? <Badge tone="muted" icon="archive" label="Прежний реестр" /> : null}
          </span>
        }
      />
      <div className={styles.stack}>
        <section className={form.section} aria-label="Формулировка">
          {card.visible ? (
            <>
              <p className={styles.statement}>{card.statement}</p>
              {card.parameters && card.parameters.length > 0 ? (
                <ul className={styles.evidence}>
                  {card.parameters.map((p) => (
                    <li key={p.name} className={styles.muted}>{`${p.name}: ${p.value}${p.unit ? ` ${p.unit}` : ''}`}</li>
                  ))}
                </ul>
              ) : null}
              {card.objectScope && Object.keys(card.objectScope).length > 0 ? (
                <p className={styles.muted}>{Object.entries(card.objectScope).map(([k, v]) => `${{ object: 'Объект', section: 'Секция', floor: 'Этаж', room: 'Помещение' }[k] ?? k}: ${v}`).join(' · ')}</p>
              ) : null}
            </>
          ) : (
            <Notice tone="info" icon="lock">Формулировка скрыта: её основание — договор, письмо или иной источник, на который у вас нет права. Видны только служебные данные.</Notice>
          )}
          {current ? <EvidenceLinks links={current.evidence} /> : null}
        </section>
        <section className={form.section} aria-label="Ревизии">
          <h2 className={form.sectionTitle}>Ревизии</h2>
          <ol className={styles.cards}>
            {card.revisions.map((r) => (
              <li key={r.id} className={styles.card}>
                <div className={styles.headLine}>
                  <strong>{`Ревизия ${r.seq}`}</strong>
                  <span className={styles.muted}>{`${CHANGE_LABELS[r.changeKind]} · реестр № ${r.registrySeq} · ${formatDateTime(r.createdAt)} МСК`}</span>
                </div>
                {r.visible ? <p className={styles.statement}>{r.statement}</p> : <p className={styles.restricted}>Текст скрыт.</p>}
              </li>
            ))}
          </ol>
        </section>
        <section className={form.section} aria-label="Покрытие">
          <h2 className={form.sectionTitle}>Покрытие</h2>
          {card.coverage.length === 0 ? <p className={styles.muted}>Покрытие ещё не оценивалось.</p> : null}
          <ol className={styles.cards}>
            {[...card.coverage].reverse().map((c) => (
              <li key={c.id} className={styles.card}>
                <div className={styles.headLine}>
                  {coverageBadge(c.state)}
                  <span className={styles.muted}>{`${c.origin === 'system' ? 'Система' : 'Человек'} · ${formatDateTime(c.createdAt)} МСК${c.revisionId !== card.currentRevisionId ? ' · прежняя ревизия' : ''}`}</span>
                </div>
                {c.reason ? <p className={styles.muted}>{c.reason}</p> : null}
                {c.objects.map((o) => (
                  <p key={o.id} className={styles.quote}>
                    {o.type === 'calculation_revision'
                      ? `Расчёт, ревизия ${o.calculationRevisionSeq ?? ''}${o.calculationRevisionKind === 'provisional' ? ' (предварительная)' : ''}: позиция ${o.positionNumber ?? ''} ${o.positionName ?? ''} — ${o.match === 'complex_rate' ? 'комплексная расценка' : 'строка расчёта'}`
                      : o.type === 'decision'
                        ? 'Решение по требованию'
                        : o.type === 'evidence_fragment'
                          ? 'Фрагмент-основание'
                          : `Ручное подтверждение: ${o.note ?? ''}`}
                  </p>
                ))}
              </li>
            ))}
          </ol>
          {editable && caps.includes('requirement.confirm') ? <CoverageForm card={card} onSaved={(next) => res.setData(next)} /> : null}
          {card.coverageState === 'needs_review' ? <Notice tone="warning">{`${COVERAGE_LABELS.needs_review}: появилась новая ревизия расчёта этапа.`}</Notice> : null}
        </section>
        <section className={form.section} aria-label="Решения">
          <h2 className={form.sectionTitle}>Решения</h2>
          {card.decisions.length === 0 ? <p className={styles.muted}>Решений нет.</p> : null}
          <ol className={styles.cards}>
            {card.decisions.map((d) => (
              <li key={d.id} className={styles.card}>
                <div className={styles.headLine}>
                  {d.status === 'active' ? <Badge tone="success" icon="user-check" label="Действует" /> : <Badge tone="muted" icon="repeat" label="Заменено" />}
                  <span className={styles.muted}>{`${formatDateTime(d.decidedAt)} МСК`}</span>
                </div>
                {d.visible ? (
                  <>
                    <p className={styles.statement}>{d.statement}</p>
                    <p className={styles.muted}>{d.rationale}</p>
                  </>
                ) : (
                  <p className={styles.restricted}>Текст скрыт.</p>
                )}
              </li>
            ))}
          </ol>
          {caps.includes('requirement.decide') && card.status === 'confirmed' ? <DecisionForm card={card} onSaved={(next) => res.setData(next)} /> : null}
        </section>
      </div>
    </>
  );
};
