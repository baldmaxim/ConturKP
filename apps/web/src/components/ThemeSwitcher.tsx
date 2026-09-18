import type { FC } from 'react';
import type { TThemeMode } from '../hooks/themeStore';
import { useThemeMode } from '../hooks/useThemeMode';
import { cx } from '../utils/cx';
import { Icon, type TIconName } from './Icon';
import styles from './ThemeSwitcher.module.css';

const OPTIONS: Array<{ mode: TThemeMode; label: string; icon: TIconName }> = [
  { mode: 'system', label: 'Системная', icon: 'monitor' },
  { mode: 'light', label: 'Светлая', icon: 'sun' },
  { mode: 'dark', label: 'Тёмная', icon: 'moon' },
];

interface IThemeSwitcherProps {
  /** Только иконки (подпись — в aria-label и подсказке). */
  compact?: boolean;
}

/** Переключатель темы из трёх вариантов (BRAND.md §11). */
export const ThemeSwitcher: FC<IThemeSwitcherProps> = ({ compact = false }) => {
  const [mode, setMode] = useThemeMode();
  return (
    <div className={styles.group} role="radiogroup" aria-label="Тема оформления">
      {OPTIONS.map((option) => {
        const checked = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={compact ? `Тема: ${option.label.toLowerCase()}` : undefined}
            title={`Тема: ${option.label.toLowerCase()}`}
            className={cx(styles.option, checked && styles.checked, compact && styles.compact)}
            onClick={() => setMode(option.mode)}
          >
            <Icon name={option.icon} />
            {compact ? null : <span>{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
};
