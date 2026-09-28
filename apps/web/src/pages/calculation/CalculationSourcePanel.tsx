import { useState, type FC, type FormEvent } from 'react';
import type { ICalculationSources } from '../../api/calculationTypes';
import { setCalculationSource } from '../../api/calculationEndpoints';
import { describeError } from '../../api/errors';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { TextField } from '../../components/TextField';
import { useToast } from '../../hooks/useToast';
import form from '../../styles/form.module.css';
import styles from './Calculation.module.css';

interface ICalculationSourcePanelProps {
  stageId: string;
  sources: ICalculationSources;
  canAdmin: boolean;
  onChanged: (next: ICalculationSources) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Связь этапа с тендером TenderHub (Q-03): id тендера TenderHub — каждая его версия отдельной строкой.
 * Прежняя основная связь остаётся справочной, её ревизии не пропадают.
 */
export const CalculationSourcePanel: FC<ICalculationSourcePanelProps> = ({ stageId, sources, canAdmin, onChanged }) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [externalId, setExternalId] = useState(sources.primary?.externalTenderId ?? '');
  const [version, setVersion] = useState(sources.primary?.externalVersion?.toString() ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const primary = sources.primary;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const id = externalId.trim().toLowerCase();
    const v = version.trim();
    if (!UUID.test(id) || (v !== '' && !/^\d{1,7}$/u.test(v))) {
      setError(new Error('Укажите id тендера TenderHub (uuid) и, если известна, версию — целым числом.'));
      return;
    }
    setBusy(true);
    setError(null);
    setCalculationSource(stageId, sources.version, id, v === '' ? null : Number(v)).then(
      (next) => {
        setBusy(false);
        setEditing(false);
        onChanged(next);
        toast.push({ kind: 'success', text: 'Связь с TenderHub сохранена.' });
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      },
    );
  };

  return (
    <section className={form.section} aria-labelledby="calc-source-title">
      <div className={form.sectionHead}>
        <h2 id="calc-source-title" className={form.sectionTitle}>
          Источник расчёта — TenderHub
        </h2>
        {canAdmin && !editing ? (
          <Button icon="pencil" onClick={() => setEditing(true)}>
            {primary ? 'Изменить связь' : 'Связать с TenderHub'}
          </Button>
        ) : null}
      </div>
      {primary ? (
        <dl className={form.details}>
          <dt>Тендер TenderHub</dt>
          <dd className={form.mono}>{primary.externalTenderId}</dd>
          <dt>Версия (заявлена при связывании)</dt>
          <dd>{primary.externalVersion ?? <span className={form.absent}>не указана — версию покажет выгрузка</span>}</dd>
        </dl>
      ) : (
        <p className={styles.muted}>Этап не связан с тендером TenderHub. Связь задаёт администратор-участник тендера.</p>
      )}
      {sources.references.length > 0 ? (
        <p className={styles.muted}>{`Справочных связей: ${sources.references.length} — их ревизии сохраняются.`}</p>
      ) : null}
      {editing ? (
        <form className={styles.sourceForm} onSubmit={submit}>
          <TextField label="Id тендера TenderHub" value={externalId} onValueChange={setExternalId} required maxLength={36} autoComplete="off" spellCheck={false} />
          <TextField label="Версия тендера" value={version} onValueChange={setVersion} inputMode="numeric" maxLength={7} hint="Необязательно: TenderHub отдаёт версию сам." />
          {error ? <Notice tone="danger">{describeError(error)}</Notice> : null}
          <div className={form.actions}>
            <Button onClick={() => setEditing(false)} disabled={busy}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" icon="check" loading={busy}>
              Сохранить связь
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
};
