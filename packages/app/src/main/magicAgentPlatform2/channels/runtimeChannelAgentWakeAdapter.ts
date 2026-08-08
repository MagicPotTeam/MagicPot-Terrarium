import type { ProductionAgentInstanceLifecycle } from '../agents/productionAgentInstanceLifecycleOwner'
import type { RuntimeChannelAgentWake } from './runtimeChannelWakeRouter'

export const createRuntimeChannelAgentWakeAdapter =
  (agents: Pick<ProductionAgentInstanceLifecycle, 'store' | 'commands'>) =>
  async (wake: RuntimeChannelAgentWake): Promise<void> => {
    const instance = agents.store.get(wake.agentInstanceId)
    if (!instance || instance.state.status !== 'stopped') return
    await agents.commands.start({
      instanceId: instance.id,
      expectedRevision: instance.revision,
      actor: { kind: 'system', id: 'runtime-channel-wakeup' },
      request: {
        agentId: instance.state.definitionId,
        text: `Runtime Channel ${wake.channelId} has pending messages: ${wake.pendingMessageIds.join(', ')}`,
        route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: wake.channelId },
        allowedToolNames: [...instance.state.limits.allowedToolNames]
      },
      idempotencyKey: `channel-wake:${wake.channelId}:${wake.pendingMessageIds.join(':')}`
    })
  }
