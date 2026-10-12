// Выбор дела и статусы интеграций (проект §5.1).
import { z } from 'zod';
import { listCases } from '../scope.ts';
import { paginate } from '../limits.ts';
import { defineTool } from '../tools.ts';

export const listCasesTool = defineTool({
  name: 'list_cases',
  title: 'Доступные тендеры и этапы',
  description: 'Список тендеров и их этапов, содержимое которых доступно пользователю: код, название, заказчик, сроки. С него начинается работа: остальные инструменты требуют tenderId и stageId или releaseId. Данных тендеров в ответе нет.',
  scope: 'read',
  input: z.object({ search: z.string().trim().max(200).optional(), cursor: z.string().max(400).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  run: async (s, a) => {
    const all = await listCases(s.pool, s, a.search);
    const page = paginate('list_cases', a.search ?? '', all, a.cursor, a.limit);
    return { result: { cases: page.items, nextCursor: page.nextCursor, total: all.length }, details: { cases: all.length } };
  },
});

export const integrationStatusTool = defineTool({
  name: 'get_integration_status',
  title: 'Статусы интеграций',
  description: 'Статусы интеграций портала (TenderHub, MailHub, модель, распознавание, размещение, чат-клиенты) и время последней проверки. Статус VERIFIED_FIXTURE означает проверку на поддельных данных, а не рабочую интеграцию.',
  scope: 'read',
  input: z.object({}).strict(),
  run: async (s) => {
    const rows = (
      await s.pool.query<{ system: string; component: string; status: string; verified_at: Date | null; last_checked_at: Date | null; last_success_at: Date | null; last_error_code: string | null }>(
        'SELECT system, component, status, verified_at, last_checked_at, last_success_at, last_error_code FROM integration_status ORDER BY system, component',
      )
    ).rows;
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      result: {
        integrations: rows.map((r) => ({ system: r.system, component: r.component, status: r.status, verifiedAt: iso(r.verified_at), lastCheckedAt: iso(r.last_checked_at), lastSuccessAt: iso(r.last_success_at), lastErrorCode: r.last_error_code })),
      },
      details: { integrations: rows.length },
    };
  },
});
