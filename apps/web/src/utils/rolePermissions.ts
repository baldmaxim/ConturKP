import type { IRoleCatalog } from '../api/roleEndpoints';

type TPermission = IRoleCatalog['permissions'][number];

export interface IRolePermissionGroup {
  name: string;
  total: number;
  selected: number;
  permissions: TPermission[];
}

/** Поиск меняет только видимые строки; счётчики относятся ко всей группе. */
export const groupRolePermissions = (
  catalog: readonly TPermission[],
  selected: readonly string[],
  query: string,
): IRolePermissionGroup[] => {
  const filter = query.trim().toLocaleLowerCase('ru');
  const selectedCodes = new Set(selected);
  const groups = new Map<string, IRolePermissionGroup>();
  for (const permission of catalog) {
    let group = groups.get(permission.group);
    if (!group) {
      group = { name: permission.group, total: 0, selected: 0, permissions: [] };
      groups.set(permission.group, group);
    }
    group.total++;
    if (selectedCodes.has(permission.code)) group.selected++;
    if (!filter || [permission.label, permission.group, permission.code].join(' ').toLocaleLowerCase('ru').includes(filter)) {
      group.permissions.push(permission);
    }
  }
  return [...groups.values()].filter((group) => group.permissions.length > 0);
};

/** Переключение одного права сохраняет выбор в скрытых группах и результаты вне поиска. */
export const toggleRolePermission = (selected: readonly string[], code: string, checked: boolean): string[] =>
  checked ? [...new Set([...selected, code])] : selected.filter((item) => item !== code);
