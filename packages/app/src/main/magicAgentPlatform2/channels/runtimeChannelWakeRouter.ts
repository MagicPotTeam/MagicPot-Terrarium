import type { RuntimeChannelGraphWakeRequest } from '../../../shared/magicAgentPlatform2/runtimeChannel'
import type { RuntimeChannelWakeEvent } from './productionRuntimeChannelLifecycle'
import type { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'

export type RuntimeChannelAgentWake = Readonly<{
  channelId: string
  agentInstanceId: string
  memberId: string
  pendingMessageIds: readonly string[]
}>
export type RuntimeChannelGraphWake = Readonly<{
  channelId: string
  graphTargetId: string
  memberId: string
  graphWakeRequest?: RuntimeChannelGraphWakeRequest
  pendingMessageIds: readonly string[]
}>

export class RuntimeChannelWakeRouter {
  constructor(
    private readonly channels: PersistentRuntimeChannelStore,
    private readonly wakeAgent: (wake: RuntimeChannelAgentWake) => void | Promise<void>,
    private readonly wakeGraph: (wake: RuntimeChannelGraphWake) => void | Promise<void>
  ) {}

  async route(event: RuntimeChannelWakeEvent): Promise<void> {
    const channel = this.channels.getChannel(event.channelId)
    if (!channel) return
    const consumers = channel.state.members.filter((member) => member.role !== 'producer')
    await Promise.allSettled(
      consumers.flatMap((member) => [
        ...(member.agentInstanceId
          ? [
              Promise.resolve(
                this.wakeAgent({
                  channelId: channel.id,
                  agentInstanceId: member.agentInstanceId,
                  memberId: member.memberId,
                  pendingMessageIds: event.pendingMessageIds
                })
              )
            ]
          : []),
        ...(member.graphTargetId
          ? [
              Promise.resolve(
                this.wakeGraph({
                  channelId: channel.id,
                  graphTargetId: member.graphTargetId,
                  memberId: member.memberId,
                  ...(member.graphWakeRequest ? { graphWakeRequest: member.graphWakeRequest } : {}),
                  pendingMessageIds: event.pendingMessageIds
                })
              )
            ]
          : [])
      ])
    )
  }
}
