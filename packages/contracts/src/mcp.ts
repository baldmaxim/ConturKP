// Этап 16 (D-037; проект docs/architecture/16-mcp-design.md): токены чат-клиентов.
import { z } from 'zod';

export const API_TOKEN_SCOPES = ['read', 'propose'] as const;
export const API_TOKEN_CLIENTS = ['codex', 'cursor', 'other'] as const;
export const API_TOKEN_LIFETIMES = [7, 30, 90] as const;
export const API_TOKEN_DEFAULT_LIFETIME = 30;
export const API_TOKEN_MAX_ACTIVE = 5;

// Область `read` есть у каждого токена; `propose` добавляется явно (D-037 В-16-2: срок 7, 30 или 90 дней).
export const IssueApiTokenRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    clientKind: z.enum(API_TOKEN_CLIENTS),
    propose: z.boolean().default(false),
    lifetimeDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(API_TOKEN_DEFAULT_LIFETIME),
  })
  .strict();
export type IssueApiTokenRequest = z.infer<typeof IssueApiTokenRequest>;

// Решение человека по предложению чат-клиента (проект §6). Для замечания человек сам задаёт серьёзность и уверенность:
// подсказка модели значением не становится.
export const AcceptMcpProposalRequest = z
  .object({
    severity: z.enum(['critical', 'major', 'minor']).optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();
export type AcceptMcpProposalRequest = z.infer<typeof AcceptMcpProposalRequest>;

export const RejectMcpProposalRequest = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type RejectMcpProposalRequest = z.infer<typeof RejectMcpProposalRequest>;

export const McpProposalsQuery = z.object({ status: z.enum(['open', 'accepted', 'rejected']).optional() }).strict();
