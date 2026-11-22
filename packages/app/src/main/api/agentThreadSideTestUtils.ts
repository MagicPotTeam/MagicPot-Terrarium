import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createCheckpointBinaryCodec } from '../figplugin/checkpointBinaryCodec'
import type { AgentSideDocument, SideCodec } from './agentThreadSideStore'
/** Authenticated synthetic key for tests only; production never falls back from OS encryption. */
export function sideTestCodec(key = randomBytes(32)): SideCodec {
  const keys = { available: () => true,
    encrypt(text: string) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]) },
    decrypt(data: Buffer) { const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(-16)); return Buffer.concat([d.update(data.subarray(12, -16)), d.final()]).toString('utf8') }
  }
  return { available: keys.available, ...createCheckpointBinaryCodec(keys) }
}
export const sideScope = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }, conversationId: 'chat' } as const
export const sideDocument = (id = '11111111-1111-4111-8111-111111111111'): AgentSideDocument => ({ version: 1, id, revision: 1, generation: 1, turns: 1, status: 'running', createdAt: 1, updatedAt: 1, title: 'PRIVATE_SIDE_TITLE', profileId: 'profile', modelLabel: 'MODEL', profileDigest: 'a'.repeat(64), snapshot: [{ role: 'user', content: 'PRIVATE_SNAPSHOT' }], snapshotTruncated: true, messages: [{ role: 'user', kind: 'question', content: 'PRIVATE_QUESTION' }], modelSteps: 0, toolCalls: 0, receipts: [{ operationId: 'op', digest: 'b'.repeat(64), generation: 1 }] })
