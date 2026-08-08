import type { MagicAgentDriveStatus } from '../../../shared/magicAgentPlatform2/drive'

export type DriveStateEvent = Readonly<{
  eventId: string
  driveId: string
  previousStatus?: MagicAgentDriveStatus
  status: MagicAgentDriveStatus
  revision: number
  changedAt: number
}>

export type DriveStateListener = (event: DriveStateEvent) => void
const listeners = new Set<DriveStateListener>()

export const publishDriveState = (event: DriveStateEvent): void => {
  for (const listener of listeners) listener(event)
}

export const subscribeDriveStates = (listener: DriveStateListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const clearDriveStateListenersForTest = (): void => listeners.clear()
