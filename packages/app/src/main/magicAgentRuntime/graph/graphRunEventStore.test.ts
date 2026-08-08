import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  return {
    ...actual,
    default: {
      ...actual,
      realpathSync: (
        value: Parameters<typeof actual.realpathSync>[0],
        options?: Parameters<typeof actual.realpathSync>[1]
      ) =>
        normalize(String(value)).includes('/graph-run-events-')
          ? value
          : actual.realpathSync(value, options as never),
      lstatSync: (
        value: Parameters<typeof actual.lstatSync>[0],
        options?: Parameters<typeof actual.lstatSync>[1]
      ) => {
        const stat = actual.lstatSync(value, options as never)
        return normalize(String(value)).includes('/graph-run-events-') || !stat.isSymbolicLink()
          ? stat
          : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
              isSymbolicLink: () => false
            })
      }
    }
  }
})
import { MagicAgentGraphRunEventStore } from './graphRunEventStore'
import type { MagicAgentGraphRunEvent } from '@shared/magicAgent'

const dirs: string[] = []
const event = (eventId: string, sequence: number): MagicAgentGraphRunEvent => ({
  eventId,
  runId: 'run-1',
  graphId: 'graph-1',
  type: 'node.completed',
  message: 'Bearer top-secret',
  createdAt: 1000 + sequence,
  sequence,
  metadata: { token: 'secret', safe: 'visible', content: 'private' }
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MagicAgentGraphRunEventStore', () => {
  it('persists ordered idempotent events across reopen and applies cursors', () => {
    const dir = path.join(
      'C:\\MagicPot-Terrarium-Tests',
      `graph-run-events-${Date.now()}-${Math.random()}`
    )
    mkdirSync(dir, { recursive: true })
    dirs.push(dir)
    const databasePath = path.join(dir, 'events.sqlite3')
    let store = new MagicAgentGraphRunEventStore(databasePath)
    store.append(event('event-1', 1))
    store.append(event('event-1', 1))
    store.append(event('event-2', 2))
    store.close()

    store = new MagicAgentGraphRunEventStore(databasePath)
    expect(store.listAfter('run-1').map((item) => item.eventId)).toEqual(['event-1', 'event-2'])
    expect(store.listAfter('run-1', 'event-1').map((item) => item.eventId)).toEqual(['event-2'])
    store.close()
  })

  it('projects only allowlisted lineage and identity fields without raw payload leakage', () => {
    const store = new MagicAgentGraphRunEventStore(':memory:')
    const stored = store.append({
      ...event('event-1', 1),
      type: 'output.created',
      nodeId: 'node-1',
      channelId: 'channel-1',
      outputId: 'output-1',
      metadata: {
        toolName: 'safe.tool',
        status: 'delivered',
        channelKind: 'artifact',
        channelCount: 1,
        args: { prompt: 'raw-tool-argument' },
        payload: 'raw-payload',
        content: 'raw-content',
        token: 'raw-token'
      }
    })
    expect(stored.payload).toEqual({
      graphId: 'graph-1',
      nodeId: 'node-1',
      channelId: 'channel-1',
      outputId: 'output-1',
      toolName: 'safe.tool',
      status: 'delivered',
      channelKind: 'artifact',
      channelCount: 1
    })
    expect(JSON.stringify(stored.payload)).not.toMatch(
      /raw-tool-argument|raw-payload|raw-content|raw-token|Bearer/
    )
    store.close()
  })
})
