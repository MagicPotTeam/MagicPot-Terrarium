import { describe, expect, it, vi } from 'vitest'
import {
  createRuntimeChannelGraphWakeAdapter,
  RUNTIME_CHANNEL_GRAPH_WAKE_INVOCATION
} from './runtimeChannelGraphWakeAdapter'

describe('runtimeChannelGraphWakeAdapter', () => {
  it('invokes the real Graph service boundary with trusted identity-only wake input', async () => {
    const runGraph = vi.fn(async () => ({
      runId: 'run-1',
      graphId: 'graph-definition',
      status: 'completed',
      outputs: {},
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const adapter = createRuntimeChannelGraphWakeAdapter({ runGraph } as never)
    await adapter({
      channelId: 'channel',
      graphTargetId: 'target',
      memberId: 'member',
      pendingMessageIds: ['message'],
      graphWakeRequest: {
        graphId: 'graph-definition',
        route: { channel: 'wake', scopeType: 'dm', scopeId: 'target' },
        input: { configured: true }
      }
    })
    expect(runGraph).toHaveBeenCalledWith(
      {
        graphId: 'graph-definition',
        route: { channel: 'wake', scopeType: 'dm', scopeId: 'target' },
        input: JSON.stringify({
          channelWake: {
            channelId: 'channel',
            graphTargetId: 'target',
            pendingMessageIds: ['message'],
            input: { configured: true }
          }
        })
      },
      RUNTIME_CHANNEL_GRAPH_WAKE_INVOCATION
    )
  })

  it('does not invoke Graph without an explicit wake request', async () => {
    const runGraph = vi.fn()
    const adapter = createRuntimeChannelGraphWakeAdapter({ runGraph } as never)
    await adapter({
      channelId: 'channel',
      graphTargetId: 'target',
      memberId: 'member',
      pendingMessageIds: ['message']
    })
    expect(runGraph).not.toHaveBeenCalled()
  })
})
