import type { ChannelMessageTriggerEvent } from './channelMessageTriggerSource'

export type ChannelMessageListener = (event: ChannelMessageTriggerEvent) => void

const listeners = new Set<ChannelMessageListener>()

export const publishTrustedChannelMessage = (event: ChannelMessageTriggerEvent): void => {
  for (const listener of listeners) listener(event)
}

export const subscribeTrustedChannelMessages = (listener: ChannelMessageListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const clearTrustedChannelMessageListenersForTest = (): void => listeners.clear()
