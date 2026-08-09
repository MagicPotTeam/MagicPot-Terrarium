import type { MagicAgentActorRef } from '../../magicAgentPlatform2/envelope'

export type ServiceInvocationContext = {
  methodName: string
  senderId?: number
  senderUrl?: string
  frameUrl?: string
  isMainFrame?: boolean
  authenticatedActor?: MagicAgentActorRef
}
