// Пункты контекстного меню (ContextMenu, MenuPanel).

export interface IMenuAction {
  kind: 'action';
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface IMenuSubmenu {
  kind: 'submenu';
  id: string;
  label: string;
  entries: TMenuEntry[];
  disabled?: boolean;
}

export interface IMenuSeparator {
  kind: 'separator';
  id: string;
}

export type TMenuEntry = IMenuAction | IMenuSubmenu | IMenuSeparator;
