import type { FC, MouseEvent } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { useAppNavigate } from '../hooks/useAppNavigate';

/** Ссылка внутри портала: переход с кросс-фейдом View Transitions, где браузер поддерживает. */
export const AppLink: FC<LinkProps> = ({ onClick, to, replace, state, target, ...rest }) => {
  const navigate = useAppNavigate();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target && target !== '_self')
    ) {
      return;
    }
    event.preventDefault();
    navigate(to, { replace, state });
  };

  return <Link {...rest} to={to} replace={replace} state={state} target={target} onClick={handleClick} />;
};
