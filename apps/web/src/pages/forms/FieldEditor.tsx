import { useState, type FC } from 'react';
import type { IFieldDefinition, TFieldValue } from '../../api/formsTypes';
import { Button } from '../../components/Button';
import { CheckboxGroup } from '../../components/CheckboxGroup';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import styles from './Forms.module.css';

interface IFieldEditorProps {
  definition: IFieldDefinition;
  initial: TFieldValue | null;
  busy: boolean;
  error: string | null;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}

type TRow = Record<string, string | string[] | null>;

/**
 * Ввод значения по типу поля: текст (без обрезания, многострочный — область ввода), число — строкой с единицей,
 * дата — календарём, вариант — списком или флажками, таблица — строками. Проверку по схеме выполняет сервер.
 */
export const FieldEditor: FC<IFieldEditorProps> = ({ definition: d, initial, busy, error, onSave, onCancel }) => {
  const [text, setText] = useState(typeof initial === 'string' ? initial : '');
  const [many, setMany] = useState<string[]>(Array.isArray(initial) && initial.every((x) => typeof x === 'string') ? (initial as string[]) : []);
  const [rows, setRows] = useState<TRow[]>(d.type === 'table' && Array.isArray(initial) ? (initial as TRow[]) : []);
  const columns = d.columns ?? [];

  const value = (): unknown => {
    if (d.type === 'choice' && d.multiple) return many;
    if (d.type === 'table') return rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key] === '' ? null : (r[c.key] ?? null)])));
    return text;
  };
  const setCell = (i: number, key: string, v: string): void => setRows(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));

  return (
    <form
      className={styles.fields}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value());
      }}
    >
      {d.type === 'text' ? (
        d.multiline ? (
          <TextAreaField label={d.label} value={text} onValueChange={setText} rows={6} maxLength={d.maxLength} error={error ?? undefined} hint={d.maxLength ? `до ${d.maxLength} символов` : undefined} />
        ) : (
          <TextField label={d.label} value={text} onValueChange={setText} maxLength={d.maxLength} error={error ?? undefined} />
        )
      ) : null}
      {d.type === 'number' ? (
        <TextField
          label={`${d.label}${d.unit ? `, ${d.unit}` : ''}`}
          value={text}
          onValueChange={setText}
          inputMode="decimal"
          error={error ?? undefined}
          hint={d.scale !== undefined ? `до ${d.scale} знаков после запятой` : undefined}
        />
      ) : null}
      {d.type === 'date' ? <TextField label={d.label} type="date" value={text} onValueChange={setText} error={error ?? undefined} /> : null}
      {d.type === 'choice' && !d.multiple ? (
        <SelectField label={d.label} value={text} placeholder="Выберите вариант" options={(d.options ?? []).map((o) => ({ value: o.value, label: o.label }))} onValueChange={setText} error={error ?? undefined} />
      ) : null}
      {d.type === 'choice' && d.multiple ? (
        <CheckboxGroup legend={d.label} options={(d.options ?? []).map((o) => ({ value: o.value, label: o.label }))} selected={many} onChange={setMany} error={error ?? undefined} />
      ) : null}
      {d.type === 'table' ? (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col">
                      {c.label}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="visually-hidden">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c.key}>
                        <input
                          className={styles.cellInput}
                          aria-label={`${c.label}, строка ${i + 1}`}
                          type={c.type === 'date' ? 'date' : 'text'}
                          inputMode={c.type === 'number' ? 'decimal' : undefined}
                          value={typeof r[c.key] === 'string' ? (r[c.key] as string) : ''}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <Button type="button" variant="ghost" icon="x" iconOnly aria-label={`Удалить строку ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.actions}>
            <Button type="button" icon="plus" onClick={() => setRows([...rows, {}])}>
              Добавить строку
            </Button>
          </div>
          {error ? <p className={styles.muted}>{error}</p> : null}
        </>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" icon="check" loading={busy}>
          Сохранить
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Отмена
        </Button>
      </div>
    </form>
  );
};
