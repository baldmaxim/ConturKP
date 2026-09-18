// Ранняя установка темы до отрисовки (BRAND.md §11). Подключается в <head> обычным <script src>,
// без inline-кода: CSP сервера — script-src 'self'. Цвета = --surface светлой и тёмной темы.
(() => {
  const THEME_COLORS = { light: '#FFFFFF', dark: '#151C23' };
  let stored = null;
  try {
    stored = window.localStorage.getItem('kontur-kp:theme');
  } catch {
    stored = null;
  }
  let system = 'light';
  try {
    system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    system = 'light';
  }
  const theme = stored === 'light' || stored === 'dark' ? stored : system;
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
})();
