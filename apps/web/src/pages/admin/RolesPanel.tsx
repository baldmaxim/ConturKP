import { useId, useState, type FC } from 'react';
import { createPortalRole, listPortalRoles, updatePortalRole, type IPortalRole, type IRoleCatalog, type IRoleInput } from '../../api/roleEndpoints';
import { describeError, hasCode } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Icon } from '../../components/Icon';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { useAuth } from '../../hooks/useAuth';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import { globalRoleLabel } from '../../utils/labels';
import { groupRolePermissions, toggleRolePermission } from '../../utils/rolePermissions';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './RolesPanel.module.css';

interface IRoleEditorProps {
  role: IPortalRole | null;
  catalog: IRoleCatalog;
  onClose: () => void;
  onSaved: () => void;
}

const RoleEditor: FC<IRoleEditorProps> = ({ role, catalog, onClose, onSaved }) => {
  const initial = role ?? catalog.items.find((item) => item.code === 'engineer')!;
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [baseRole, setBaseRole] = useState<IPortalRole['baseRole']>(initial.baseRole);
  const [permissions, setPermissions] = useState<string[]>([...initial.permissions]);
  const [status, setStatus] = useState<IPortalRole['status']>(role?.status ?? 'active');
  const [filter, setFilter] = useState('');
  const [activeGroup, setActiveGroup] = useState(catalog.permissions[0]?.group ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelId = useId();
  const key = useIdempotencyKey();
  const input: IRoleInput = { name: name.trim(), description: description.trim(), baseRole, permissions: [...new Set(permissions)].sort() };
  useUnsavedChanges(name !== (role?.name ?? '') || description !== (role?.description ?? '') || baseRole !== initial.baseRole
    || status !== (role?.status ?? 'active') || JSON.stringify([...permissions].sort()) !== JSON.stringify([...initial.permissions].sort()));

  const save = async (): Promise<void> => {
    if (busy) return;
    if (!input.name) {
      setError('Укажите название роли.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (role) await updatePortalRole(role, { ...input, status });
      else await createPortalRole(input, key.keyFor(input));
      onSaved();
    } catch (cause) {
      setError(hasCode(cause, 'VERSION_CONFLICT')
        ? 'Роль изменил другой администратор. Закройте окно и перечитайте список.' : describeError(cause));
      setBusy(false);
    }
  };

  const groups = groupRolePermissions(catalog.permissions, permissions, filter);
  const current = groups.find((group) => group.name === activeGroup) ?? groups[0];
  const selectedCodes = new Set(permissions);
  const selectedCount = catalog.permissions.filter((permission) => selectedCodes.has(permission.code)).length;

  return (
    <Dialog
      wide
      title={role ? 'Настройка роли · ' + role.name : 'Новая роль'}
      onClose={onClose}
      busy={busy}
      onSubmit={() => void save()}
      footer={
        <>
          <span className={styles.selectionSummary} role="status">Выбрано разрешений: {selectedCount} из {catalog.permissions.length}</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Отмена</Button>
          <Button variant="primary" type="submit" loading={busy}>Сохранить</Button>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className={styles.settings}>
        <TextField label="Название роли" value={name} onValueChange={setName} required disabled={busy} />
        {role ? (
          <SelectField
            label="Состояние роли"
            value={status}
            onValueChange={(value) => setStatus(value === 'disabled' ? 'disabled' : 'active')}
            options={[{ value: 'active', label: 'Активна' }, { value: 'disabled', label: 'Отключена' }]}
            hint="Отключённая роль перестаёт давать права всем назначенным пользователям."
            disabled={busy}
          />
        ) : null}
        {!role?.builtIn ? (
          <SelectField
            label="Основа участия в тендерах"
            value={baseRole}
            options={['engineer', 'manager', 'admin'].map((value) => ({ value, label: globalRoleLabel(value) }))}
            onValueChange={(value) => {
              const base = value as IPortalRole['baseRole'];
              setBaseRole(base);
              if (!role) setPermissions([...(catalog.items.find((item) => item.code === base)?.permissions ?? [])]);
            }}
            hint="Определяет, в какой роли пользователь может быть назначен на тендер. Разрешения ниже ограничивают доступные действия."
            disabled={busy}
          />
        ) : null}
        <div className={role && !role.builtIn ? styles.description : styles.descriptionWide}>
          <TextAreaField label="Описание" value={description} onValueChange={setDescription} rows={2} disabled={busy} />
        </div>
      </div>
      {role?.builtIn ? <p className={styles.baseInfo}>Основа: {globalRoleLabel(baseRole)}. Для другой основы создайте собственную роль.</p> : null}
      <Notice tone="info">
        {role ? 'Изменения применятся ко всем пользователям этой роли: ' + role.users + '. ' : ''}
        Если назначено несколько ролей, их разрешения объединяются. Изменения и решения по тендеру требуют назначения; общий просмотр включается отдельно.
      </Notice>
      <TextField
        label="Найти разрешение"
        type="search"
        value={filter}
        onValueChange={setFilter}
        placeholder="Название действия или группы"
        onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
      />
      {current ? (
        <div className={styles.workspace}>
          <nav className={styles.groups} aria-label="Группы разрешений">
            {groups.map((group) => (
              <button
                key={group.name}
                type="button"
                className={styles.groupButton}
                aria-current={current.name === group.name ? 'true' : undefined}
                aria-controls={panelId}
                aria-label={group.name + ': выбрано ' + group.selected + ' из ' + group.total}
                onClick={() => setActiveGroup(group.name)}
              >
                <span>{group.name}</span>
                <span className={styles.count}>{group.selected}/{group.total}</span>
                <span className={styles.groupArrow}><Icon name="chevron-right" size={16} /></span>
              </button>
            ))}
          </nav>
          <section className={styles.permissions} id={panelId} aria-label={'Разрешения группы «' + current.name + '»'}>
            <div className={styles.permissionHead}>
              <h3 className={styles.permissionTitle}>Разрешённые действия</h3>
              <span className={styles.count}>Выбрано {current.selected} из {current.total}</span>
            </div>
            {filter.trim() ? <p className={styles.searchCount}>Найдено в группе: {current.permissions.length}</p> : null}
            <fieldset className={styles.permissionGrid} aria-label={'Действия группы «' + current.name + '»'} disabled={busy}>
              {current.permissions.map((permission) => (
                <label className={styles.permission} key={permission.code}>
                  <input
                    type="checkbox"
                    checked={selectedCodes.has(permission.code)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setPermissions((selected) => toggleRolePermission(selected, permission.code, checked));
                    }}
                  />
                  <span>{permission.label}</span>
                </label>
              ))}
            </fieldset>
          </section>
        </div>
      ) : (
        <EmptyState icon="search" title="Разрешения не найдены" text="Измените поисковый запрос." />
      )}
    </Dialog>
  );
};

export const RolesPanel:FC=()=>{
 const {data,error,loading,reload}=useApiResource(signal=>listPortalRoles(signal),'portal-roles');const [editing,setEditing]=useState<IPortalRole|null|undefined>(undefined);const {refresh}=useAuth();
 const saved=()=>{setEditing(undefined);reload();void refresh();};
 if(loading&&!data)return <LoadingState/>;if(error)return <ErrorState error={error} onRetry={reload}/>;if(!data)return null;
 return <section className={form.stack} aria-label="Роли и разрешения">
  <div className={form.actions}><Button variant="primary" icon="plus" onClick={()=>setEditing(null)}>Создать роль</Button></div>
  <p>Создавайте собственные роли, открывайте разделы и выбирайте разрешённые действия. Роли назначаются в разделе «Пользователи».</p>
  <div className={list.tableWrap}><table className={list.table}><thead><tr><th>Роль</th><th>Основа</th><th>Пользователи</th><th>Состояние</th><th><span className="visually-hidden">Действия</span></th></tr></thead><tbody>{data.items.map(role=><tr key={role.id}><td className={list.roleIdentity}><strong>{role.name}</strong>{role.description?<p>{role.description}</p>:null}<span className={list.muted}>{role.builtIn?'Системная':'Собственная'} · разрешений: {role.permissions.length}</span></td><td>{globalRoleLabel(role.baseRole)}</td><td>{role.users}</td><td><Badge icon="circle-dot" tone={role.status==='active'?'neutral':'muted'} label={role.status==='active'?'Активна':'Отключена'}/></td><td><Button icon="pencil" onClick={()=>setEditing(role)}>Настроить</Button></td></tr>)}</tbody></table></div>
  {editing!==undefined?<RoleEditor role={editing} catalog={data} onClose={()=>setEditing(undefined)} onSaved={saved}/>:null}
 </section>;
};
