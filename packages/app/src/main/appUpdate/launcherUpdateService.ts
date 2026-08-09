import type { LauncherSettingsV1 } from '../../shared/appUpdate/launcherProtocol'
import type {
  LauncherActiveVersion,
  LauncherTargetRelease,
  LauncherUpdatePhase,
  LauncherUpdateStatus
} from '../../shared/appUpdate/launcherUpdateStatus'
import type { LaunchSelection } from './launcherCore'
import type {
  LauncherUpdateAvailable,
  LauncherUpdateCoordinator,
  LauncherUpdateResult
} from './launcherUpdateCoordinator'

export type LauncherUpdateCheckTrigger = 'manual' | 'launch'
export type LauncherUpdateStatusListener = (status: LauncherUpdateStatus) => void

export interface LauncherUpdateServiceDependencies {
  coordinator: Pick<LauncherUpdateCoordinator, 'runOnLaunch'>
  getSettings(): Promise<LauncherSettingsV1>
  getActive(): Promise<LaunchSelection | null>
  now?: () => Date
}

function activeFrom(selection: LaunchSelection | null): LauncherActiveVersion | undefined {
  if (!selection) return undefined
  return {
    version: selection.app.version,
    buildId: selection.app.buildId,
    runtimeId: selection.runtime.runtimeId
  }
}

function targetFrom(available: LauncherUpdateAvailable): LauncherTargetRelease {
  return { ...available }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return typeof error === 'string' ? error : 'Launcher update failed'
}

export class LauncherUpdateService {
  private readonly listeners = new Set<LauncherUpdateStatusListener>()
  private readonly now: () => Date
  private status: LauncherUpdateStatus
  private inFlight?: Promise<LauncherUpdateStatus>

  constructor(private readonly dependencies: LauncherUpdateServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.status = { phase: 'idle', updatedAt: this.now().toISOString() }
  }

  getStatus(): LauncherUpdateStatus {
    return this.status
  }

  subscribe(listener: LauncherUpdateStatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  check(trigger: LauncherUpdateCheckTrigger): Promise<LauncherUpdateStatus> {
    if (this.inFlight) return this.inFlight
    const operation = this.runCheck(trigger)
    this.inFlight = operation
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined
    })
    return operation
  }

  private async runCheck(trigger: LauncherUpdateCheckTrigger): Promise<LauncherUpdateStatus> {
    this.setStatus('checking')
    try {
      const [storedSettings, active] = await Promise.all([
        this.dependencies.getSettings(),
        this.dependencies.getActive()
      ])
      const settings =
        trigger === 'manual' && storedSettings.updateMode === 'manual'
          ? { ...storedSettings, updateMode: 'notify-on-launch' as const }
          : storedSettings
      const result = await this.dependencies.coordinator.runOnLaunch(settings)
      return this.mapResult(result, activeFrom(active))
    } catch (error) {
      return this.setStatus('error', { message: errorMessage(error) })
    }
  }

  private mapResult(
    result: LauncherUpdateResult,
    active: LauncherActiveVersion | undefined
  ): LauncherUpdateStatus {
    switch (result.status) {
      case 'manual':
        return this.setStatus('up-to-date', { active, message: 'Automatic updates are disabled' })
      case 'up-to-date':
        return this.setStatus('up-to-date', { active })
      case 'available':
        return this.setStatus('available', { active, target: targetFrom(result.available) })
      case 'activated':
        return this.setStatus('ready', {
          active: activeFrom({ ...result.installation, source: 'installed' }),
          target: targetFrom(result.available)
        })
      case 'locked':
      case 'failed':
        return this.setStatus('error', {
          active,
          target: result.available ? targetFrom(result.available) : undefined,
          message: result.error.message
        })
    }
  }

  private setStatus(
    phase: LauncherUpdatePhase,
    details: Omit<LauncherUpdateStatus, 'phase' | 'updatedAt'> = {}
  ): LauncherUpdateStatus {
    this.status = { phase, ...details, updatedAt: this.now().toISOString() }
    for (const listener of this.listeners) {
      try {
        listener(this.status)
      } catch {
        // A consumer cannot interrupt update state transitions or other consumers.
      }
    }
    return this.status
  }
}

export function createLauncherUpdateService(
  dependencies: LauncherUpdateServiceDependencies
): LauncherUpdateService {
  return new LauncherUpdateService(dependencies)
}
