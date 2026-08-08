import type { MagicAgentPlatformSvcImpl } from '../../api/svcMagicAgentPlatformImpl'
import type { RuntimeChannelGraphWake } from './runtimeChannelWakeRouter'

export const RUNTIME_CHANNEL_GRAPH_WAKE_INVOCATION = {
  methodName: 'magic-agent.channel.graph-wake',
  senderUrl: 'magicpot-runtime-channel://wakeup',
  isMainFrame: true
} as const

export const createRuntimeChannelGraphWakeAdapter =
  (platformService: Pick<MagicAgentPlatformSvcImpl, 'runGraph'>) =>
  async (wake: RuntimeChannelGraphWake): Promise<void> => {
    if (!wake.graphWakeRequest) return
    await platformService.runGraph(
      {
        graphId: wake.graphWakeRequest.graphId,
        route: wake.graphWakeRequest.route as never,
        input: JSON.stringify({
          channelWake: {
            channelId: wake.channelId,
            graphTargetId: wake.graphTargetId,
            pendingMessageIds: wake.pendingMessageIds,
            input: wake.graphWakeRequest.input
          }
        })
      },
      RUNTIME_CHANNEL_GRAPH_WAKE_INVOCATION
    )
  }
