import type { AgentThreadInteractionScope } from './agentThreadInteraction'
export type AgentHtmlScope = AgentThreadInteractionScope & { documentToken: string }
export type AgentHtmlScopeReq = AgentThreadInteractionScope & { active: boolean; lifecycleRevision: number }
export type AgentHtmlApp = { id: string; title: string; revision: number; sha256: string; status: 'ready' | 'opening' | 'open' | 'stopping' | 'closed' | 'failed' | 'unknown'; createdAt: number; expiresAt: number; surface: 'canvas' | 'chat'; savedId?: string; savedRevision?: number; snapshotReady?: boolean }
export type AgentHtmlSaved = { id: string; title: string; storageRevision: number; documentRevision: number; createdAt: number; updatedAt: number; sha256: string; htmlBytes: number; surface: 'canvas' | 'chat' }
export type AgentHtmlSaveReq = AgentHtmlReq & AgentHtmlScope & { expectedStorageRevision: number; operationId: string }
export type AgentHtmlSavedReq = AgentHtmlScope & { savedId: string; expectedStorageRevision: number }
export type AgentHtmlRestoreReq = AgentHtmlSavedReq & { operationId: string }
export type AgentHtmlStorageStatus = { enabled: boolean; initialized: boolean; available: boolean; unconfirmedRuns: number | null; canInitialize: boolean; saveEnabled: boolean }
export type AgentHtmlReq = AgentThreadInteractionScope & { appId: string; expectedRevision: number }
export const HTML_APP_INPUT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string', minLength: 1, maxLength: 120 }, html: { type: 'string', minLength: 1, maxLength: 262144 }, data: { type: 'object' },
  surface: { enum: ['canvas', 'chat'] }, read: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, update: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
  expectedRevision: { type: 'integer', minimum: 1 },
  patch: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['find', 'replace'], properties: { find: { type: 'string', minLength: 1, maxLength: 65536 }, replace: { type: 'string', maxLength: 65536 } } } },
  wait_for: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$' } }, timeout_s: { type: 'integer', minimum: 1, maximum: 300 }
} }
