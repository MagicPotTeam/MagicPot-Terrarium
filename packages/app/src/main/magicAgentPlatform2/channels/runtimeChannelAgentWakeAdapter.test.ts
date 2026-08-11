import { describe, expect, it, vi } from 'vitest'
import { readRuntimeChannelTrustedDispatchContext } from '../../magicAgentRuntime/runtimeChannelTrustedDispatchContext'
import { createRuntimeChannelAgentWakeAdapter } from './runtimeChannelAgentWakeAdapter'

describe('runtimeChannelAgentWakeAdapter', () => {
  it('starts stopped Agent instances through the lifecycle-owned command service', async () => {
    const instance = {
      id: 'instance',
      revision: 3,
      state: {
        status: 'stopped',
        definitionId: 'agent-definition',
        limits: { allowedToolNames: ['read'] }
      }
    }
    const start = vi.fn(async (_input: unknown) => undefined)
    const adapter = createRuntimeChannelAgentWakeAdapter({
      store: { get: vi.fn(() => instance) },
      commands: { start }
    } as never)
    await adapter({
      channelId: 'channel',
      agentInstanceId: 'instance',
      memberId: 'member',
      pendingMessageIds: ['message-1', 'message-2']
    })
    const call = start.mock.calls[0]?.[0] as {
      request: Parameters<typeof readRuntimeChannelTrustedDispatchContext>[0]
    }
    expect(call).toMatchObject({
      instanceId: 'instance',
      expectedRevision: 3,
      actor: { kind: 'system', id: 'runtime-channel-wakeup' },
      request: {
        agentId: 'agent-definition',
        text: 'Runtime Channel channel has pending messages: message-1, message-2',
        route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel' },
        allowedToolNames: ['read']
      },
      idempotencyKey: 'channel-wake:channel:message-1:message-2'
    })
    expect(readRuntimeChannelTrustedDispatchContext(call.request)).toEqual({
      channelId: 'channel',
      memberId: 'member',
      pendingMessageIds: ['message-1', 'message-2'],
      agentInstanceId: 'instance'
    })
    expect(JSON.parse(JSON.stringify(call.request))).toEqual({
      agentId: 'agent-definition',
      text: 'Runtime Channel channel has pending messages: message-1, message-2',
      route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel' },
      allowedToolNames: ['read']
    })
  })

  it('carries Runtime Channel identity in the route scope for config enforcement', async () => {
    const start = vi.fn(async (_input: unknown) => undefined)
    const adapter = createRuntimeChannelAgentWakeAdapter({
      store: {
        get: vi.fn(() => ({
          id: 'instance',
          revision: 1,
          state: { status: 'stopped', definitionId: 'definition', limits: { allowedToolNames: [] } }
        }))
      },
      commands: { start }
    } as never)
    await adapter({
      channelId: 'bound-channel',
      agentInstanceId: 'instance',
      memberId: 'member',
      pendingMessageIds: ['message']
    })
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'bound-channel' }
        })
      })
    )
  })

  it('does not wake missing or non-stopped Agent instances', async () => {
    const start = vi.fn()
    const adapter = createRuntimeChannelAgentWakeAdapter({
      store: { get: vi.fn(() => ({ state: { status: 'running' } })) },
      commands: { start }
    } as never)
    await adapter({
      channelId: 'channel',
      agentInstanceId: 'instance',
      memberId: 'member',
      pendingMessageIds: ['message']
    })
    expect(start).not.toHaveBeenCalled()
  })
})
