import { useRef, useState, type ChangeEvent, type FC } from 'react';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { listStages } from '../../api/endpoints';
import { uploadManifest } from '../../api/upload';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from '../mail/Mail.module.css';

interface IManifestUploadProps {
  tenderId: string;
  kind: 'qa' | 'negotiation';
  onImported: () => void;
}

const FORMAT = { qa: 'kontur.qa.v1', negotiation: 'kontur.negotiation.v1' } as const;

/** Импорт manifest (JSON) в тендер: повтор того же файла подряд идемпотентен, изменения — новые ревизии. */
export const ManifestUpload: FC<IManifestUploadProps> = ({ tenderId, kind, onImported }) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const stagesRes = useApiResource((signal) => listStages(tenderId, signal), `manifest-stages:${tenderId}`);
  const [stageId, setStageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await uploadManifest(tenderId, kind, file, stageId || null, newUuid(), () => undefined).promise;
      if (r.reused) toast.push({ kind: 'info', text: 'Этот файл уже импортирован последним — изменений нет.' });
      else if ('newRevisions' in r) toast.push({ kind: 'success', text: `Импортировано. Новых ревизий вопросов: ${r.newRevisions}.` });
      else toast.push({ kind: 'success', text: r.createdRevision ? 'Импортирована новая редакция транскрипции.' : 'Транскрипция не изменилась — новой редакции нет.' });
      onImported();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={form.section} aria-label="Импорт файла">
      <SelectField
        label="Этап"
        value={stageId}
        options={[{ value: '', label: 'Без этапа' }, ...(stagesRes.data?.items ?? []).map((st) => ({ value: st.id, label: st.title }))]}
        onValueChange={setStageId}
        hint="Этап получит событие входа «добавлены вопросы–ответы» или «новая редакция транскрипции»."
      />
      <input ref={inputRef} className={styles.fileInput} type="file" accept=".json,application/json" onChange={(e) => void onPick(e)} />
      <div className={form.actions}>
        <Button variant="primary" icon="upload" loading={busy} onClick={() => inputRef.current?.click()}>
          Импортировать файл
        </Button>
      </div>
      <p className={list.muted}>{`Формат файла — ${FORMAT[kind]} (JSON).`}</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </section>
  );
};
