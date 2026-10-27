import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { HttpError } from './http/errors.ts';

// Отдельная сетевая страница обновления: старые Service Worker уже исключают /api/ из кеша навигации.
const FILES: Record<string, string> = {
  '/ui-update': 'app-update.html',
  '/ui-update.js': 'app-update.js',
  '/ui-update.css': 'app-update.css',
  '/ui-update-shell': 'index.html',
};

export const appUpdateRouter = (webDist: string): Router => {
  const router = Router();
  router.get('/ui-version', async (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Читаем при каждом запросе: публикация новой сборки не требует перезапуска сервера.
      const manifest = JSON.parse(await readFile(join(webDist, 'version.json'), 'utf8')) as { version?: unknown };
      if (typeof manifest.version !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(manifest.version)) {
        throw new Error('Invalid build version');
      }
      res.json({ version: manifest.version });
    } catch {
      next(new HttpError(503, 'INTERNAL', 'Версия интерфейса временно недоступна'));
    }
  });
  router.get(Object.keys(FILES), (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(webDist, FILES[req.path]!), (error) => {
      if (error) next(new HttpError(404, 'NOT_FOUND', 'Файл обновления интерфейса недоступен'));
    });
  });
  return router;
};
