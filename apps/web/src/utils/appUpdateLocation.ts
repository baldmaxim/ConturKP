// Сетевая страница обновления отдаёт свежий index.html; маршрут восстанавливаем до запуска BrowserRouter.
export const restoreAppUpdateLocation = (
  location: { pathname: string; search: string; origin: string },
  history: { replaceState: (data: unknown, unused: string, url: string) => void },
): boolean => {
  if (location.pathname !== '/api/ui-update-shell') return false;
  let returnTo = '/';
  try {
    const target = new URL(new URLSearchParams(location.search).get('returnTo') || '/', location.origin);
    if (target.origin === location.origin && !target.pathname.startsWith('/api/')) {
      returnTo = target.pathname + target.search + target.hash;
    }
  } catch {
    // Некорректный адрес возврата не должен мешать открытию портала.
  }
  history.replaceState(null, '', returnTo);
  return true;
};

// Повторная регистрация в той же вкладке может вернуть ещё живой старый контроллер.
// После явного обновления используем сеть до завершения сессии вкладки.
export const shouldRegisterAppWorker = (
  storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void },
  afterUpdate: boolean,
): boolean => {
  try {
    if (afterUpdate) storage.setItem('portal-network-session', '1');
    return !afterUpdate && storage.getItem('portal-network-session') !== '1';
  } catch {
    return false;
  }
};
