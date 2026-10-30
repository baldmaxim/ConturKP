/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app/App';
import { restoreAppUpdateLocation, shouldRegisterAppWorker } from './utils/appUpdateLocation';
import './index.css';

const afterUpdate = restoreAppUpdateLocation(window.location, window.history);
try {
  if (shouldRegisterAppWorker(window.sessionStorage, afterUpdate)) registerSW();
} catch {
  // Недоступное хранилище не мешает работе сетевого интерфейса.
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Не найден элемент #root');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
