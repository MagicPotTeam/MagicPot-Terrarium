import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import { PersistentRuntimeChannelStore } from '../channels/persistentRuntimeChannelStore'
import { _backupRestoreTesting, restoreEventStoreBackup } from './backupRestore'
import { _crashTesting } from './crashHooks'
import { MagicAgentEventStore, type ResourceKind } from './eventStore'

const operation = process.env.MAGIC_CRASH_OPERATION ?? process.argv[2]
const stage = process.env.MAGIC_CRASH_STAGE ?? process.argv[3]
const databasePath = process.env.MAGIC_CRASH_DB ?? process.argv[4]
const targetPath = process.env.MAGIC_CRASH_TARGET ?? process.argv[5]
const backupPath = process.env.MAGIC_CRASH_BACKUP ?? process.argv[6]
const resourceKind: ResourceKind = process.env.MAGIC_CRASH_RESOURCE_KIND ?? 'session'
const resourceId = process.env.MAGIC_CRASH_RESOURCE_ID ?? 'forced-resource'

if (!operation || !stage || !databasePath) throw new Error('Missing crash worker arguments.')

function block(readyStage: string): never {
  process.stdout.write(`READY:${readyStage}\n`)
  const memory = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(memory, 0, 0)
}

_crashTesting.setHook((current) => {
  if (current === stage) block(current)
})
_backupRestoreTesting.setStageHook((current) => {
  if (current === stage) block(current)
})

function event(sequence = 0): MagicAgentEvent<unknown> {
  return {
    protocolVersion: '2.0.0',
    envelopeKind: 'event',
    id: `forced-event-${sequence}`,
    streamId: 'forced-stream',
    sequence,
    type: 'forced.event',
    createdAt: 1_700_000_000_000 + sequence,
    payload: { deterministic: true, sequence }
  }
}

function resourceEvent(kind: ResourceKind, id: string): MagicAgentEvent<unknown> {
  const identity = `${kind}/${id}`
  return {
    ...event(),
    id: `forced-resource-event:${identity}`,
    streamId: `forced-resource-stream:${identity}`
  }
}

async function main(): Promise<void> {
  if (operation === 'restore') {
    if (!backupPath || !targetPath) throw new Error('Restore requires backup and target paths.')
    const expectedSha256 = `sha256:${createHash('sha256').update(readFileSync(backupPath)).digest('hex')}`
    await restoreEventStoreBackup({
      backupPath,
      targetPath,
      expectedSha256
    })
    return
  }

  const store = new MagicAgentEventStore(databasePath)
  if (operation === 'event') store.appendBatch([event()])
  else if (operation === 'snapshot')
    store.appendSnapshot({
      snapshotId: 'forced-snapshot',
      streamId: 'forced-stream',
      snapshotVersion: 0,
      coveredSequence: 0,
      stateType: 'forced-state',
      state: { deterministic: true },
      createdAt: 1_700_000_000_100
    })
  else if (operation === 'resource')
    store.mutateResource({
      operation: 'create',
      kind: resourceKind,
      id: resourceId,
      idempotencyKey: `forced-resource-create:${resourceKind}/${resourceId}`,
      state: { boundary: resourceKind, deterministic: true },
      createdAt: 1_700_000_000_200,
      event: resourceEvent(resourceKind, resourceId)
    })
  else if (operation === 'channel-membership') {
    const channels = new PersistentRuntimeChannelStore(store)
    const existing = channels.getChannel('forced-channel')
    if (!existing) {
      channels.createChannel({
        channel: { id: 'forced-channel', name: 'Forced', mode: 'queue', capacity: 2, members: [] },
        createdAt: 1_700_000_000_000,
        idempotencyKey: 'create'
      })
      channels.join({
        channelId: 'forced-channel',
        expectedRevision: 0,
        member: {
          memberId: 'consumer',
          agentInstanceId: 'agent',
          role: 'consumer',
          joinedAt: 1_700_000_000_001
        },
        joinedAt: 1_700_000_000_001,
        idempotencyKey: 'join'
      })
    }
  } else if (operation === 'backup') {
    if (!targetPath) throw new Error('Backup requires target path.')
    await store.createBackup(targetPath)
  } else throw new Error(`Unknown operation: ${operation}`)
  store.close()
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
