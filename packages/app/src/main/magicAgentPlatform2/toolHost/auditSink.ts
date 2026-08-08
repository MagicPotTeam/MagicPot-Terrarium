import { createHash } from 'node:crypto'
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import type { MagicAgentEventStore } from '../persistence/eventStore'
import type { FilesToolAuditEvidence } from './files'
import type { GitToolAuditEvidence } from './git'
import type { NotebookAuditEvidence } from './notebook'

export const TOOL_AUDIT_STREAM_ID = 'magic-agent.tool-audit.v1'

type ToolAuditEvidence = FilesToolAuditEvidence | GitToolAuditEvidence | NotebookAuditEvidence
type StoreState = { tail: Promise<void> }
const states = new WeakMap<MagicAgentEventStore, StoreState>()

export const createMagicAgentToolAuditSink = (
  store: MagicAgentEventStore,
  callIdentity: string
): ((evidence: ToolAuditEvidence) => Promise<void>) => {
  return async (evidence) => {
    const state = states.get(store) ?? { tail: Promise.resolve() }
    states.set(store, state)
    const operation = state.tail.then(() => appendEvidence(store, callIdentity, evidence))
    state.tail = operation.catch(() => undefined)
    await operation
  }
}

const appendEvidence = (
  store: MagicAgentEventStore,
  callIdentity: string,
  evidence: ToolAuditEvidence
): void => {
  const metadata = redactedMetadata(evidence)
  const kinds: Array<'tool-call' | 'file-change'> = ['tool-call']
  if (isFileChange(evidence)) kinds.push('file-change')
  for (const kind of kinds) {
    const identity = digest(`${kind}\0${callIdentity}`)
    if (store.getEvent(`audit-${identity}`)) continue
    const sequence = (store.getLastSequence(TOOL_AUDIT_STREAM_ID) ?? -1) + 1
    store.appendBatch([eventFor(kind, callIdentity, sequence, metadata)])
  }
}

const eventFor = (
  kind: 'tool-call' | 'file-change',
  callIdentity: string,
  sequence: number,
  payload: Record<string, unknown>
): MagicAgentEvent<unknown> => {
  const identity = digest(`${kind}\0${callIdentity}`)
  return {
    protocolVersion: '2.1.0',
    envelopeKind: 'event',
    id: `audit-${identity}`,
    idempotencyKey: `tool-audit:${identity}`,
    type: `magic-agent.audit.${kind}.v1`,
    createdAt: 0,
    streamId: TOOL_AUDIT_STREAM_ID,
    sequence,
    actor: { kind: 'system', id: 'tool-host' },
    redaction: {
      applied: true,
      paths: ['route', 'sessionId', 'input', 'output', 'content', 'source', 'path', 'repository'],
      reason: 'Content-free tool audit metadata allowlist.'
    },
    payload
  } as MagicAgentEvent<unknown>
}

const redactedMetadata = (evidence: ToolAuditEvidence): Record<string, unknown> => {
  const value = evidence as unknown as Record<string, unknown>
  const metadata: Record<string, unknown> = {
    tool: evidence.tool,
    outcome: evidence.outcome
  }
  for (const key of [
    'bytes',
    'returnedBytes',
    'entryCount',
    'matchCount',
    'filesSearched',
    'count',
    'cellCount',
    'additions',
    'deletions',
    'diffBytes',
    'truncated',
    'mutationUncertain',
    'rollback',
    'beforeSha256',
    'afterSha256',
    'beforeHead',
    'afterHead'
  ]) {
    const item = value[key]
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      metadata[key] = item
    }
  }
  return metadata
}

const isFileChange = (evidence: ToolAuditEvidence): boolean => {
  const value = evidence as unknown as Record<string, unknown>
  return (
    typeof value.afterSha256 === 'string' ||
    [
      'files.write',
      'files.edit',
      'files.patch',
      'files.multi-edit',
      'files.json.write',
      'files.snapshot.restore'
    ].includes(evidence.tool) ||
    (evidence.tool.startsWith('notebook.') &&
      !['notebook.list', 'notebook.read'].includes(evidence.tool))
  )
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
