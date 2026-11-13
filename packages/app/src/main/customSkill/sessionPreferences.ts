import { createHash } from 'node:crypto'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { AgentSkillPreferenceRecord, AgentSkillPreferenceReq } from '@shared/api/agentThreadSkillSession'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const owner = (scope: AgentThreadInteractionScope) => hash([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export class SkillPreferenceRejected extends Error {
  constructor(readonly reason: 'revision-conflict' | 'capacity') { super(reason === 'revision-conflict' ? 'Procedural skill preference revision conflict; refresh before changing.' : 'Procedural skill session preferences exceed capacity.') }
}
const fail = (): never => { throw new Error('Procedural skill session preferences are invalid or exceed capacity.') }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function readSkillPreferenceRecords(value: unknown): AgentSkillPreferenceRecord[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128 || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) return fail()
  const seen = new Set<string>()
  for (const row of value) {
    if (!object(row) || Object.keys(row).some(key => !['owner', 'revision', 'disabledIds', 'receipts'].includes(key)) || !hex(row.owner) || seen.has(row.owner) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 ||
      !Array.isArray(row.disabledIds) || row.disabledIds.length > 100 || row.disabledIds.some(value => !id(value)) || new Set(row.disabledIds).size !== row.disabledIds.length || !Array.isArray(row.receipts) || !row.receipts.length || row.receipts.length > 16) return fail()
    seen.add(row.owner)
    const operations = new Set<string>()
    for (const receipt of row.receipts) {
      if (!object(receipt) || Object.keys(receipt).some(key => !['operationId', 'digest'].includes(key)) || typeof receipt.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.operationId) || operations.has(receipt.operationId) || !hex(receipt.digest)) return fail()
      operations.add(receipt.operationId)
    }
  }
  return structuredClone(value) as AgentSkillPreferenceRecord[]
}
export function skillPreferenceSnapshot(value: unknown, scope: AgentThreadInteractionScope) {
  const row = readSkillPreferenceRecords(value).find(row => row.owner === owner(scope))
  return { revision: row?.revision ?? 0, disabledIds: row?.disabledIds ?? [] }
}
export function validateSkillPreferenceRequest(req: AgentSkillPreferenceReq): void {
  if (!object(req) || Object.keys(req).some(key => !['route', 'conversationId', 'documentToken', 'id', 'enabled', 'expectedRevision', 'operationId'].includes(key)) || !id(req.id) || typeof req.enabled !== 'boolean' ||
    !Number.isSafeInteger(req.expectedRevision) || req.expectedRevision < 0 || req.expectedRevision >= Number.MAX_SAFE_INTEGER || typeof req.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.operationId)) throw new Error('Invalid procedural skill session preference.')
}
/** Pure revision/replay transition, committed only by a guarded user service. */
export function changeSkillPreference(value: unknown, req: AgentSkillPreferenceReq) {
  validateSkillPreferenceRequest(req)
  const records = readSkillPreferenceRecords(value), key = owner(req), row = records.find(row => row.owner === key)
  const digest = hash([req.id, req.enabled, req.expectedRevision]), receipt = row?.receipts.find(receipt => receipt.operationId === req.operationId)
  if (receipt) {
    if (receipt.digest !== digest) throw new Error('Procedural skill preference replay conflict.')
    return { records, replay: true, revision: row!.revision }
  }
  if ((row?.revision ?? 0) !== req.expectedRevision) throw new SkillPreferenceRejected('revision-conflict')
  const next: AgentSkillPreferenceRecord = { owner: key, revision: req.expectedRevision + 1, disabledIds: [...(row?.disabledIds ?? []).filter(value => value !== req.id), ...(!req.enabled ? [req.id] : [])].sort(), receipts: [...(row?.receipts ?? []), { operationId: req.operationId, digest }].slice(-16) }
  const changed = [...records.filter(row => row.owner !== key), next]
  if (changed.length > 128 || next.disabledIds.length > 100 || Buffer.byteLength(JSON.stringify(changed)) > 512 * 1024) throw new SkillPreferenceRejected('capacity')
  readSkillPreferenceRecords(changed) // No eviction of owners/revisions to make space.
  return { records: changed, replay: false, revision: next.revision }
}
