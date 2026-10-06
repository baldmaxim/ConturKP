import { useState, type FC } from 'react';
import { describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { decideFieldSuggestion, fieldAction } from '../../api/formsEndpoints';
import type { IFieldView, TFieldAction } from '../../api/formsTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { formatFieldValue, ORIGIN_LABEL, STATE_LABEL } from '../../utils/formsLabels';
import { DiscussDialog } from './DiscussDialog';
import { FieldEditor } from './FieldEditor';
import { FieldHistory } from './FieldHistory';
import { WordingDialog } from './WordingDialog';
import styles from './Forms.module.css';

interface IFieldCardProps {
  draftId: string;
  tenderId: string;
  field: IFieldView;
  canFill: boolean;
  canAskCustomer: boolean;
  onChanged: () => void;
}

/**
 * Поле приложения: значение, происхождение, основание с цитатами, состояние и быстрые действия (D-031 В-11-4…В-11-6).
 * Предложение системы или модели становится значением только кнопкой «Принять»; «устарело» — значение сохранено,
 * подтвердить его по заменённому основанию нельзя.
 */
export const FieldCard: FC<IFieldCardProps> = ({ draftId, tenderId, field: f, canFill, canAskCustomer, onChanged }) => {
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'edit' | 'wording' | 'discuss'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const d = f.definition;
  const v = f.latest;

  const run = (body: TFieldAction, done = 'Значение сохранено'): void => {
    setBusy(true);
    setError(null);
    fieldAction(draftId, f, body).then(
      () => {
        setBusy(false);
        setMode('view');
        toast.push({ kind: 'success', text: done });
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        if (hasCode(e, 'VERSION_CONFLICT')) {
          toast.push({ kind: 'error', text: 'Поле изменил другой пользователь: значение перечитано, проверьте и повторите.' });
          setMode('view');
          onChanged();
          return;
        }
        const fieldErr = fieldErrorsOf(e)[d.key];
        setError(fieldErr ?? describeError(e));
        if (mode === 'view') toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };

  const decide = (id: string, decision: 'accept' | 'reject'): void => {
    const s = f.suggestions.find((x) => x.id === id)!;
    setBusy(true);
    decideFieldSuggestion(s, decision).then(
      () => {
        setBusy(false);
        toast.push({ kind: 'success', text: decision === 'accept' ? 'Предложение принято: значение — от вашего имени' : 'Предложение отклонено' });
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        onChanged();
      },
    );
  };

  const openSuggestions = f.suggestions.filter((s) => s.status === 'open');
  const state = v ? STATE_LABEL[v.state] : null;
  const canConfirm = v !== null && v.value !== null && (v.state === 'carried_over' || v.state === 'needs_discussion' || v.stale);
  return (
    <article id={`field-${f.key}`} className={[styles.card, v?.stale ? styles.cardStale : '', f.applicable ? '' : styles.cardInactive].join(' ')} aria-labelledby={`field-${f.key}-label`}>
      <div className={styles.cardHead}>
        <h4 id={`field-${f.key}-label`} className={styles.label}>
          {d.label}
        </h4>
        <div className={styles.badges}>
          {f.required ? <Badge label="Обязательное" icon="circle-dot" tone="accent" /> : null}
          {!f.applicable ? <Badge label="Не применяется" icon="info" tone="muted" /> : null}
          {state ? <Badge label={state.label} icon={state.icon} tone={state.tone} dashed={v?.state === 'carried_over'} /> : <Badge label="Не заполнено" icon="circle-dot" tone="muted" dashed />}
          {v?.stale ? <Badge label="Устарело" icon="clock-alert" tone="warning" dashed /> : null}
        </div>
      </div>
      {d.help ? <p className={styles.muted}>{d.help}</p> : null}
      {mode === 'edit' ? (
        <FieldEditor definition={d} initial={v && v.state !== 'cleared' ? v.value : null} busy={busy} error={error} onSave={(value) => run({ action: 'set', value })} onCancel={() => setMode('view')} />
      ) : (
        <>
          <p className={styles.value}>{v?.restricted ? 'Значение скрыто: среди оснований есть закрытые для вас материалы.' : formatFieldValue(d, v && v.state !== 'cleared' ? v.value : null)}</p>
          {v ? (
            <p className={styles.muted}>
              {`${ORIGIN_LABEL[v.origin]}${v.wording ? ` «${v.wording.title}», версия ${v.wording.version}` : ''}${v.valueFromVersionId && v.state !== 'carried_over' ? ' · значение прежней версии' : ''} · ${v.actor.name} · ${formatDateTime(v.createdAt)}`}
            </p>
          ) : null}
          {v?.wording?.newerApproved ? <p className={styles.muted}>В библиотеке есть новая редакция этой формулировки.</p> : null}
          {v?.comment ? <p className={styles.muted}>{`Обсуждение: ${v.comment}${v.responsible ? ` (ответственный — ${v.responsible.name})` : ''}`}</p> : null}
          {v?.bases.map((b, i) => (
            <p key={i} className={styles.quote}>
              {b.problemText ? `Основание заменено: ${b.problemText}. ` : ''}
              {b.quote ?? b.text ?? (b.basisType === 'evidence_fact' ? 'Факт из документа' : 'Основание')}
            </p>
          ))}
          {v?.inheritedProblem ? <p className={styles.quote}>{`Основание исходного значения заменено: ${v.inheritedProblem.text}. Подтвердите значение по действующему основанию.`}</p> : null}
          {v?.invalidations.length ? <p className={styles.muted}>{`Основание изменилось: ${v.invalidations[v.invalidations.length - 1]!.reason}`}</p> : null}
        </>
      )}
      {mode === 'view' && f.systemProposals.length + openSuggestions.length > 0 ? (
        <div className={styles.proposal}>
          {f.systemProposals.map((p) => (
            <div key={p.evidenceFactId} className={styles.fields}>
              <p className={styles.muted}>{`Предложение системы из факта «${p.title}»`}</p>
              <p className={styles.value}>{p.restricted ? 'Основание факта закрыто для вас.' : formatFieldValue(d, p.value)}</p>
              {p.text ? <p className={styles.quote}>{p.text}</p> : null}
              {canFill && !p.restricted ? (
                <div className={styles.actions}>
                  <Button variant="primary" icon="check" loading={busy} onClick={() => run({ action: 'accept_fact', evidenceFactId: p.evidenceFactId }, 'Предложение принято')}>
                    Принять
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          {openSuggestions.map((s) => (
            <div key={s.id} className={styles.fields}>
              <p className={styles.muted}>Предложение модели — гипотеза с цитатами, значением становится после принятия</p>
              <p className={styles.value}>{s.restricted ? 'Скрыто: среди цитат есть закрытые для вас материалы.' : formatFieldValue(d, s.value)}</p>
              {s.evidence.map((e) => (e.quote ? <p key={e.fragmentId} className={styles.quote}>{e.quote}</p> : null))}
              {canFill && !s.restricted ? (
                <div className={styles.actions}>
                  <Button variant="primary" icon="check" loading={busy} onClick={() => decide(s.id, 'accept')}>
                    Принять
                  </Button>
                  <Button variant="ghost" icon="x" disabled={busy} onClick={() => decide(s.id, 'reject')}>
                    Отклонить
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {f.conflictingFacts.length > 0 ? <p className={styles.muted}>{`Факты «${f.conflictingFacts[0]!.title}» в документах расходятся: предложения нет, значение подтверждает человек.`}</p> : null}
      {canFill && mode === 'view' ? (
        <div className={styles.actions}>
          {d.type === 'text' ? (
            <Button icon="scroll-text" onClick={() => setMode('wording')} disabled={busy}>
              Выбрать
            </Button>
          ) : null}
          <Button icon="pencil" onClick={() => setMode('edit')} disabled={busy}>
            {d.type === 'choice' ? 'Выбрать' : 'Изменить'}
          </Button>
          {canConfirm ? (
            <Button icon="check" onClick={() => run({ action: 'confirm' }, 'Значение подтверждено')} loading={busy}>
              Подтвердить
            </Button>
          ) : null}
          {v?.restricted ? null : (
            <Button icon="message-square" onClick={() => setMode('discuss')} disabled={busy}>
              Обсудить
            </Button>
          )}
          <Button variant="ghost" icon="list-checks" aria-expanded={history} onClick={() => setHistory(!history)}>
            История
          </Button>
        </div>
      ) : null}
      {!canFill && mode === 'view' ? (
        <div className={styles.actions}>
          <Button variant="ghost" icon="list-checks" aria-expanded={history} onClick={() => setHistory(!history)}>
            История
          </Button>
        </div>
      ) : null}
      {history ? <FieldHistory draftId={draftId} definition={d} token={v?.version ?? 0} /> : null}
      {mode === 'wording' ? <WordingDialog tenderId={tenderId} busy={busy} onChoose={(id) => run({ action: 'choose_wording', wordingVersionId: id }, 'Формулировка выбрана')} onClose={() => setMode('view')} /> : null}
      {mode === 'discuss' ? (
        <DiscussDialog label={d.label} busy={busy} canAskCustomer={canAskCustomer} onSubmit={(comment, createQuestion) => run({ action: 'discuss', comment, createQuestion }, 'Поле отмечено «требует обсуждения»')} onClose={() => setMode('view')} />
      ) : null}
    </article>
  );
};
