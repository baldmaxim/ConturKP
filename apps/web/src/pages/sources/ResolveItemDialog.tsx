import { useEffect, useState, type FC } from 'react';
import { isAbortError } from '../../api/client';
import { describeError, hasCode } from '../../api/errors';
import { getImport, listImports, resolveImportItem } from '../../api/sourceEndpoints';
import type { IImportItem, TResolveItemInput } from '../../api/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField, type ISelectOption } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import { formatDateTime } from '../../utils/datetime';
import { ITEM_STATUS, rejectReasonLabel } from '../../utils/sourceLabels';
import fieldStyles from '../../components/Field.module.css';
import form from '../../styles/form.module.css';

type TMode = 'reimported' | 'not_applicable';

/** Сколько последних партий этапа просматривать в поисках повторного импорта. */
const CANDIDATE_BATCHES = 10;
const MIN_REASON = 5;

interface ICandidate {
  item: IImportItem;
  batchCreatedAt: string;
}

interface IResolveItemDialogProps {
  item: IImportItem;
  /** Этап, из партий которого собираются кандидаты повторного импорта; null — только решение руководителя. */
  stageId: string | null;
  canReimport: boolean;
  canDecide: boolean;
  onClose: () => void;
  onResolved: (item: IImportItem) => void;
  /** 412 или 409: элемент изменился — страница перечитывает партию. */
  onStale: (message: string) => void;
}

/** Исход отклонённого элемента: повторный импорт (инженер) или «неприменимо» (руководитель тендера). */
export const ResolveItemDialog: FC<IResolveItemDialogProps> = ({ item, stageId, canReimport, canDecide, onClose, onResolved, onStale }) => {
  const [mode, setMode] = useState<TMode>(canReimport ? 'reimported' : 'not_applicable');
  const [candidates, setCandidates] = useState<ICandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<unknown>(null);
  const [byItemId, setByItemId] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useIdempotencyKey();
  useUnsavedChanges(reason.trim() !== '' || byItemId !== '');

  // Кандидаты: зарегистрированные элементы других завершённых партий этапа, совпадающие по имени — первыми.
  useEffect(() => {
    if (mode !== 'reimported' || !stageId || candidates !== null) {
      return undefined;
    }
    const controller = new AbortController();
    const load = async (): Promise<ICandidate[]> => {
      const batches = (await listImports(stageId, controller.signal)).items
        .filter((b) => b.id !== item.batchId && b.status !== 'running' && b.counts.registered + b.counts.duplicate > 0)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, CANDIDATE_BATCHES);
      const details = await Promise.all(batches.map((b) => getImport(b.id, controller.signal)));
      const found: ICandidate[] = [];
      for (const detail of details) {
        for (const candidate of detail.items) {
          if (candidate.status === 'registered' || candidate.status === 'duplicate') {
            found.push({ item: candidate, batchCreatedAt: detail.createdAt });
          }
        }
      }
      const sameName = (c: ICandidate): number => (c.item.observedName === item.observedName ? 0 : 1);
      return found.sort((a, b) => sameName(a) - sameName(b) || b.batchCreatedAt.localeCompare(a.batchCreatedAt));
    };
    load()
      .then((found) => {
        setCandidates(found);
        const first = found[0];
        if (first && first.item.observedName === item.observedName) {
          setByItemId(first.item.id);
        }
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setCandidatesError(error);
        }
      });
    return () => controller.abort();
  }, [mode, stageId, candidates, item.batchId, item.observedName]);

  const options: ISelectOption[] = (candidates ?? []).map((c) => ({
    value: c.item.id,
    label: `${c.item.memberPath} · ${ITEM_STATUS[c.item.status].label.split(' —')[0]} · партия ${formatDateTime(c.batchCreatedAt)}`,
  }));

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    let input: TResolveItemInput;
    if (mode === 'reimported') {
      if (!byItemId) {
        nextErrors.resolvedByItemId = 'Выберите файл повторного импорта.';
      }
      input = { resolution: 'reimported', resolvedByItemId: byItemId };
    } else {
      if (reason.trim().length < MIN_REASON) {
        nextErrors.reason = `Опишите причину: не меньше ${MIN_REASON} символов.`;
      }
      input = { resolution: 'not_applicable', reason: reason.trim() };
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    setSaving(true);
    try {
      const updated = await resolveImportItem(item.id, item.rowVersion, input, idempotency.keyFor({ id: item.id, input }));
      idempotency.reset();
      onResolved(updated);
    } catch (error) {
      setSaving(false);
      if (hasCode(error, 'VERSION_CONFLICT')) {
        onStale('Элемент изменён другим пользователем. Данные партии перечитаны — проверьте исход.');
        return;
      }
      if (hasCode(error, 'STATE_CONFLICT')) {
        onStale(`Исход не задан: ${describeError(error)}`);
        return;
      }
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
        idempotency.reset();
      }
      setFormError(describeError(error));
    }
  };

  const renderReimport = () => {
    if (!stageId) {
      return <Notice tone="info">Откройте партию со страницы этапа, чтобы выбрать файл повторного импорта.</Notice>;
    }
    if (candidatesError) {
      return <Notice tone="danger">{`Не удалось собрать кандидатов: ${describeError(candidatesError)}`}</Notice>;
    }
    if (candidates === null) {
      return <LoadingState label="Ищем зарегистрированные файлы в других партиях…" />;
    }
    if (candidates.length === 0) {
      return (
        <Notice tone="info">
          В последних {CANDIDATE_BATCHES} партиях этапа нет зарегистрированных файлов. Загрузите исправленный файл заново, затем
          вернитесь к этому элементу.
        </Notice>
      );
    }
    return (
      <SelectField
        label="Файл повторного импорта"
        required
        value={byItemId}
        placeholder="Выберите файл"
        options={options}
        onValueChange={setByItemId}
        error={errors.resolvedByItemId}
        hint="Зарегистрированный файл другой партии этого тендера. Совпадающие по имени — в начале списка."
      />
    );
  };

  return (
    <Dialog
      title="Исход отклонённого файла"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving} autoFocus>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon={mode === 'reimported' ? 'repeat' : 'user-check'} loading={saving}>
            {mode === 'reimported' ? 'Связать с повторным импортом' : 'Признать неприменимым'}
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <dl className={form.details}>
        <dt>Файл</dt>
        <dd className={form.mono}>{item.memberPath}</dd>
        <dt>Причина отказа</dt>
        <dd>{[ITEM_STATUS[item.status].label, rejectReasonLabel(item.rejectReason), item.rejectDetail].filter(Boolean).join(' · ')}</dd>
      </dl>

      {canReimport && canDecide ? (
        <fieldset className={fieldStyles.fieldset}>
          <legend className={fieldStyles.label}>Исход</legend>
          <div className={fieldStyles.options}>
            <label className={fieldStyles.option}>
              <input type="radio" name="resolution" checked={mode === 'reimported'} onChange={() => setMode('reimported')} />
              <span>Заменён повторным импортом</span>
            </label>
            <label className={fieldStyles.option}>
              <input type="radio" name="resolution" checked={mode === 'not_applicable'} onChange={() => setMode('not_applicable')} />
              <span>Неприменим (решение руководителя)</span>
            </label>
          </div>
        </fieldset>
      ) : null}

      {mode === 'reimported' ? (
        renderReimport()
      ) : (
        <TextAreaField
          label="Почему файл неприменим"
          required
          value={reason}
          onValueChange={setReason}
          error={errors.reason}
          hint="Решение руководителя тендера записывается в журнал с этой причиной."
          maxLength={4000}
        />
      )}
    </Dialog>
  );
};
