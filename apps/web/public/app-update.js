(() => {
  const status = document.getElementById('update-status');
  const retry = document.getElementById('update-retry');
  const back = document.getElementById('update-back');
  const origin = window.location.origin;
  let returnTo = '/';
  try {
    const target = new URL(new URLSearchParams(window.location.search).get('returnTo') || '/', origin);
    if (target.origin === origin && !target.pathname.startsWith('/api/')) {
      returnTo = target.pathname + target.search + target.hash;
    }
  } catch {
    // Некорректный адрес возврата ведёт на главную страницу этого же портала.
  }
  back.href = returnTo;

  const bounded = async (promise, step) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`update_timeout:${step}`)), 8000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  let running = false;
  const update = async () => {
    if (running) return;
    running = true;
    retry.hidden = true;
    status.textContent = 'Загружаем новую версию…';
    try {
      if ('serviceWorker' in navigator) {
        const registration = await bounded(navigator.serviceWorker.getRegistration(`${origin}/`), 'lookup');
        // Работаем только с регистрацией этого приложения, сохраняя сессию и данные форм.
        const appWorker = registration && registration.scope === `${origin}/`
          && [registration.active, registration.waiting, registration.installing].some((worker) => {
            if (!worker) return false;
            const script = new URL(worker.scriptURL);
            return script.origin === origin && ['/sw.js', '/api/ui-update-worker.js'].includes(script.pathname);
          });
        if (appWorker) await bounded(registration.unregister(), 'unregister');
      }
      // Новый документ тоже идёт через /api/: старый контроллер не сможет вернуть кешированный index.html.
      window.location.replace(`/api/ui-update-shell?returnTo=${encodeURIComponent(returnTo)}`);
    } catch (error) {
      console.warn('Не удалось обновить портал', error);
      status.textContent = 'Не удалось обновить портал. Проверьте соединение и повторите попытку.';
      retry.hidden = false;
      running = false;
    }
  };

  retry.addEventListener('click', () => { void update(); });
  void update();
})();
