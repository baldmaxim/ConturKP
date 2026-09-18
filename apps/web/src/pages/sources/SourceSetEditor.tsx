import { useMemo, useState, type FC } from 'react';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { isSourceSetRevision } from '../../api/guards';
import { replaceSourceSetItems } from '../../api/sourceEndpoints';
import type { IDocument, ISourceSetItemInput, ISourceSetLatestItem, ISourceSetRevision } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConflictDialog } from '../../components/ConflictDialog';
import { Notice } from '../../components/Notice';
import { TextField } from '../../components/TextField';
import { useToast } from '../../hooks/useToast';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import { formatDateTime } from '../../utils/datetime';
import { docTypeLabel } from '../../utils/sourceLabels';
import fieldStyles from '../../components/Field.module.css';
import form from '../../styles/form.module.css';
import styles from './SourceSetEditor.module.css';

type TChoice = 'none' | 'included' | 'excluded';

interface IChoiceState {
  choice: TChoice;
  reason: string;
}

interface IRow {
  revisionId: string;
  title: string;
  /** Номер редакции, если известен (из состава набора). */
  seq: number | null;
  docType: string | null;
  isLatest: boolean;
}

const MIN_REASON = 3;

const CHOICES: Array<{ value: TChoice; label: string }> = [
  { value: 'none', label: 'Не выбрано' },
  { value: 'included', label: 'Включить' },
  { value: 'excluded', label: 'Исключить (неприменимо)' },
];

const buildRows = (documents: IDocument[], items: ISourceSetLatestItem[]): IRow[] => {
  const byRevision = new Map(items.map((item) => [item.documentRevisionId, item]));
  const rows: IRow[] = [];
  const latestIds = new Set<string>();
  for (const doc of documents) {
    if (!doc.latestRevisionId) {
      continue;
    }
    latestIds.add(doc.latestRevisionId);
    rows.push({
      revisionId: doc.latestRevisionId,
      title: doc.title,
      seq: byRevision.get(doc.latestRevisionId)?.revisionSeq ?? null,
      docType: doc.docType,
      isLatest: true,
    });
  }
  // Прежние редакции, уже учтённые в составе, остаются в списке с пометкой «не последняя».
  for (const item of items) {
    if (!latestIds.has(item.documentRevisionId)) {
      rows.push({ revisionId: item.documentRevisionId, title: item.documentTitle, seq: item.revisionSeq, docType: null, isLatest: false });
    }
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title, 'ru') || (b.seq ?? 0) - (a.seq ?? 0));
};

const initialState = (items: ISourceSetLatestItem[]): Record<string, IChoiceState> =>
  Object.fromEntries(
    items.map((item) => [
      item.documentRevisionId,
      { choice: item.inclusion === 'included' ? 'included' : 'excluded', reason: item.reason ?? '' },
    ]),
  );

interface ISourceSetEditorProps {
  revision: ISourceSetRevision;
  items: ISourceSetLatestItem[];
  documents: IDocument[];
  onSaved: () => void;
  onCancel: () => void;
  /** Перечитать состав после конфликта версий. */
  onReload: () => void;
}

/** Правка черновика состава: полная замена списка редакций с решением «включить / исключить с причиной». */
export const SourceSetEditor: FC<ISourceSetEditorProps> = ({ revision, items, documents, onSaved, onCancel, onReload }) => {
  const toast = useToast();
  const rows = useMemo(() => buildRows(documents, items), [documents, items]);
  const initial = useMemo(() => initialState(items), [items]);
  const [state, setState] = useState<Record<string, IChoiceState>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ current: ISourceSetRevision | null } | null>(null);

  const stateOf = (revisionId: string): IChoiceState => state[revisionId] ?? { choice: 'none', reason: '' };
  const dirty = JSON.stringify(state) !== JSON.stringify(initial);
  useUnsavedChanges(dirty);

  const update = (revisionId: string, changes: Partial<IChoiceState>): void =>
    setState((prev) => ({ ...prev, [revisionId]: { ...(prev[revisionId] ?? { choice: 'none', reason: '' }), ...changes } }));

  const includeUndecided = (): void =>
    setState((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        if (row.isLatest && (next[row.revisionId]?.choice ?? 'none') === 'none') {
          next[row.revisionId] = { choice: 'included', reason: '' };
        }
      }
      return next;
    });

  const counts = rows.reduce(
    (acc, row) => {
      acc[stateOf(row.revisionId).choice] += 1;
      return acc;
    },
    { none: 0, included: 0, excluded: 0 } as Record<TChoice, number>,
  );

  const save = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    const payload: ISourceSetItemInput[] = [];
    for (const row of rows) {
      const { choice, reason } = stateOf(row.revisionId);
      if (choice === 'none') {
        continue;
      }
      if (choice === 'excluded' && reason.trim().length < MIN_REASON) {
        nextErrors[row.revisionId] = `Укажите причину исключения: не меньше ${MIN_REASON} символов.`;
      }
      payload.push({
        documentRevisionId: row.revisionId,
        inclusion: choice === 'included' ? 'included' : 'excluded_not_applicable',
        reason: choice === 'excluded' ? reason.trim() : null,
      });
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      setFormError('Не у всех исключённых редакций указана причина.');
      return;
    }
    setSaving(true);
    try {
      await replaceSourceSetItems(revision.id, revision.rowVersion, payload);
      toast.push({ kind: 'success', text: 'Состав источников сохранён.' });
      onSaved();
    } catch (error) {
      setSaving(false);
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflict({ current: conflictCurrent(error, isSourceSetRevision) });
        return;
      }
      const fieldErrors = fieldErrorsOf(error);
      setErrors(fieldErrors);
      setFormError(describeError(error));
    }
  };

  const summary = `включено ${counts.included} · исключено ${counts.excluded} · без решения ${counts.none}`;

  return (
    <form
      className={form.stack}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <div className={form.sectionHead}>
        <p className={form.num}>{summary}</p>
        {counts.none > 0 ? (
          <Button onClick={includeUndecided} disabled={saving}>
            Включить все без решения
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Notice tone="info" icon="file-question-mark">
          Нет данных: у тендера ещё нет зарегистрированных редакций документов. Загрузите файлы во вкладке «Импорт».
        </Notice>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => {
            const current = stateOf(row.revisionId);
            return (
              <li key={row.revisionId} className={styles.row}>
                <fieldset className={fieldStyles.fieldset}>
                  <legend className={styles.legend}>
                    <span className={styles.title}>{row.title}</span>
                    <span className={styles.meta}>
                      {[row.seq !== null ? `ред. ${row.seq}` : 'последняя редакция', row.docType ? docTypeLabel(row.docType) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </legend>
                  {row.isLatest ? null : <Badge tone="warning" icon="clock-alert" dashed label="Не последняя редакция" />}
                  <div className={fieldStyles.options}>
                    {CHOICES.map((option) => (
                      <label key={option.value} className={fieldStyles.option}>
                        <input
                          type="radio"
                          name={`choice-${row.revisionId}`}
                          checked={current.choice === option.value}
                          onChange={() => update(row.revisionId, { choice: option.value })}
                          disabled={saving}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {current.choice === 'excluded' ? (
                  <TextField
                    label="Причина исключения"
                    required
                    value={current.reason}
                    onValueChange={(value) => update(row.revisionId, { reason: value })}
                    error={errors[row.revisionId]}
                    maxLength={2000}
                    autoComplete="off"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className={form.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Отмена
        </Button>
        <Button variant="primary" type="submit" loading={saving} disabled={!dirty}>
          Сохранить состав
        </Button>
      </div>

      {conflict ? (
        <ConflictDialog
          title="Черновик состава изменён другим пользователем"
          rows={[
            {
              label: 'Черновик состава',
              mine: `ваша правка на основе версии ${revision.rowVersion}: ${summary}`,
              current: conflict.current
                ? `версия ${conflict.current.rowVersion} от ${formatDateTime(conflict.current.updatedAt)} МСК`
                : '',
            },
          ]}
          currentUnknown={!conflict.current}
          onReload={() => {
            setConflict(null);
            onReload();
          }}
          onClose={() => setConflict(null)}
        />
      ) : null}
    </form>
  );
};
