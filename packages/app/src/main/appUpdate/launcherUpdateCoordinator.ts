import path from 'node:path'
import type { LauncherSettingsV1 } from '../../shared/appUpdate/launcherProtocol'
import { createArtifactPreparer, type PreparedArtifact } from './artifactPreparer'
import { downloadArtifact } from './artifactDownloader'
import type {
  AppArtifactV1,
  ChannelManifestV1,
  RuntimeArtifactV1,
  SelectedArtifactsV1,
  UpdateChannel
} from './channelManifestProtocol'
import {
  compareSemanticVersionsV1,
  parseSemanticVersionV1,
  selectLatestArtifactsV1
} from './channelManifestProtocol'
import { installPreExtractedDirectory } from './directoryInstaller'
import type { LaunchSelection, LocalLauncherCore, ValidatedInstallation } from './launcherCore'
import { runLauncherSmokeTest } from './launcherSmokeTest'
import { UpdateLockError, withUpdateLock } from './updateLock'

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

export type LauncherUpdateFailureStage =
  | 'manifest'
  | 'selection'
  | 'lock'
  | 'download'
  | 'prepare'
  | 'install'
  | 'validate'
  | 'smoke-test'
  | 'activate'

export interface LauncherUpdateAvailable {
  channel: UpdateChannel
  version: string
  buildId: string
  runtimeId: string
  publishedAt: string
  releaseNotesUrl: string
}

export type LauncherUpdateResult =
  | { status: 'manual' }
  | { status: 'up-to-date'; channel: UpdateChannel }
  | { status: 'available'; available: LauncherUpdateAvailable }
  | {
      status: 'activated'
      available: LauncherUpdateAvailable
      runtimeReused: boolean
      installation: ValidatedInstallation
    }
  | {
      status: 'locked' | 'failed'
      stage: LauncherUpdateFailureStage
      error: { name: string; message: string }
      available?: LauncherUpdateAvailable
    }

export interface DownloadedLauncherArtifact {
  path: string
}

export interface PrepareArtifactInput {
  artifact: AppArtifactV1 | RuntimeArtifactV1
  downloadedPath: string
  kind: 'app' | 'runtime'
}

export interface LauncherCoreActivator {
  layout: LocalLauncherCore['layout']
  validateBuild(buildId: string): Promise<ValidatedInstallation | null>
  validateRuntime(runtimeId: string): Promise<unknown | null>
  getActive(): Promise<LaunchSelection | null>
  activate(buildId: string, runtimeId: string): Promise<unknown>
}

export interface LauncherUpdateCoordinatorDependencies {
  fetchManifest(channel: UpdateChannel): Promise<ChannelManifestV1>
  core: LauncherCoreActivator
  downloadArtifact?: (
    artifact: AppArtifactV1 | RuntimeArtifactV1,
    destinationPath: string
  ) => Promise<DownloadedLauncherArtifact>
  prepareArtifact?: (input: PrepareArtifactInput) => Promise<string | PreparedArtifact>
  installDirectory?: typeof installPreExtractedDirectory
  smokeTest?: (installation: ValidatedInstallation) => Promise<unknown>
  withLock?: typeof withUpdateLock
  isRuntimeInstalled?: (runtimeId: string) => Promise<boolean>
  launcherVersion: string
  downloadTimeoutMs?: number
}

function availableFrom(
  selected: SelectedArtifactsV1,
  channel: UpdateChannel
): LauncherUpdateAvailable {
  return {
    channel,
    version: selected.release.version,
    buildId: selected.release.buildId,
    runtimeId: selected.app.runtimeId,
    publishedAt: selected.release.publishedAt,
    releaseNotesUrl: selected.release.releaseNotesUrl
  }
}

function errorDetails(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) }
}

function artifactFileName(artifact: AppArtifactV1 | RuntimeArtifactV1): string {
  const urlName = path.posix.basename(new URL(artifact.url).pathname)
  const extension = path.posix
    .extname(urlName)
    .replace(/[^.a-zA-Z0-9]/g, '')
    .slice(0, 16)
  const identity = artifact.kind === 'app' ? artifact.buildId : artifact.runtimeId
  return `${artifact.kind}-${identity}-${artifact.sha256}${extension}`
}

function activePolicyResult(
  active: LaunchSelection | null,
  selected: SelectedArtifactsV1,
  channel: UpdateChannel
): LauncherUpdateResult | undefined {
  if (
    active?.app.buildId === selected.app.buildId &&
    active.runtime.runtimeId === selected.app.runtimeId
  )
    return { status: 'up-to-date', channel }
  if (active) {
    const versionOrder = compareSemanticVersionsV1(selected.release.version, active.app.version)
    if (versionOrder === undefined || versionOrder <= 0) return { status: 'up-to-date', channel }
  }
  return undefined
}

export class LauncherUpdateCoordinator {
  constructor(private readonly dependencies: LauncherUpdateCoordinatorDependencies) {}

  async runOnLaunch(settings: LauncherSettingsV1): Promise<LauncherUpdateResult> {
    if (settings.updateMode === 'manual') return { status: 'manual' }

    let selected: SelectedArtifactsV1 | undefined
    try {
      const manifest = await this.dependencies.fetchManifest(settings.channel)
      selected = selectLatestArtifactsV1(manifest, 'win32', 'x64', (release) => {
        const releaseVersion = parseSemanticVersionV1(release.version)
        const launcherCompatibility = compareSemanticVersionsV1(
          this.dependencies.launcherVersion,
          release.minimumLauncherVersion
        )
        return (
          releaseVersion !== undefined &&
          (settings.allowPrerelease || releaseVersion.prerelease.length === 0) &&
          launcherCompatibility !== undefined &&
          launcherCompatibility >= 0
        )
      })
    } catch (error) {
      return { status: 'failed', stage: 'manifest', error: errorDetails(error) }
    }
    if (!selected)
      return {
        status: 'failed',
        stage: 'selection',
        error: {
          name: 'LauncherUpdateSelectionError',
          message: 'No compatible win-x64 release is available'
        }
      }

    const available = availableFrom(selected, settings.channel)
    let active: LaunchSelection | null
    try {
      active = await this.dependencies.core.getActive()
    } catch (error) {
      return { status: 'failed', stage: 'selection', error: errorDetails(error), available }
    }
    const initialPolicyResult = activePolicyResult(active, selected, settings.channel)
    if (initialPolicyResult) return initialPolicyResult
    if (settings.updateMode === 'notify-on-launch') return { status: 'available', available }
    let stage: LauncherUpdateFailureStage = 'lock'
    try {
      return await (this.dependencies.withLock ?? withUpdateLock)(
        this.dependencies.core.layout.root,
        async () => {
          const lockedActive = await this.dependencies.core.getActive()
          const lockedPolicyResult = activePolicyResult(lockedActive, selected, settings.channel)
          if (lockedPolicyResult) return lockedPolicyResult

          const runtimeReused = this.dependencies.isRuntimeInstalled
            ? await this.dependencies.isRuntimeInstalled(selected.app.runtimeId)
            : (await this.dependencies.core.validateRuntime(selected.app.runtimeId)) !== null

          if (!runtimeReused) {
            stage = 'download'
            const runtimeDownload = await this.download(selected.runtime)
            stage = 'prepare'
            const runtimeSource = await this.prepare(
              selected.runtime,
              runtimeDownload.path,
              'runtime'
            )
            try {
              stage = 'install'
              await (this.dependencies.installDirectory ?? installPreExtractedDirectory)({
                root: this.dependencies.core.layout.root,
                sourceDirectory: runtimeSource.sourceDirectory,
                kind: 'runtime',
                expectedId: selected.runtime.runtimeId
              })
            } finally {
              await runtimeSource.cleanup?.().catch(() => undefined)
            }
          }

          stage = 'download'
          const appDownload = await this.download(selected.app)
          stage = 'prepare'
          const appSource = await this.prepare(selected.app, appDownload.path, 'app')
          try {
            stage = 'install'
            await (this.dependencies.installDirectory ?? installPreExtractedDirectory)({
              root: this.dependencies.core.layout.root,
              sourceDirectory: appSource.sourceDirectory,
              kind: 'app',
              expectedId: selected.app.buildId,
              expectedRuntimeId: selected.app.runtimeId
            })
          } finally {
            await appSource.cleanup?.().catch(() => undefined)
          }

          stage = 'validate'
          const installation = await this.dependencies.core.validateBuild(selected.app.buildId)
          if (!installation || installation.runtime.runtimeId !== selected.app.runtimeId)
            throw new Error('Installed app/runtime pair failed validation')

          stage = 'smoke-test'
          await (this.dependencies.smokeTest ?? runLauncherSmokeTest)(installation)
          stage = 'activate'
          await this.dependencies.core.activate(selected.app.buildId, selected.app.runtimeId)
          return { status: 'activated', available, runtimeReused, installation }
        }
      )
    } catch (error) {
      if (error instanceof UpdateLockError)
        return { status: 'locked', stage: 'lock', error: errorDetails(error), available }
      return { status: 'failed', stage, error: errorDetails(error), available }
    }
  }

  private download(
    artifact: AppArtifactV1 | RuntimeArtifactV1
  ): Promise<DownloadedLauncherArtifact> {
    const destinationPath = path.join(
      this.dependencies.core.layout.root,
      'downloads',
      artifactFileName(artifact)
    )
    if (this.dependencies.downloadArtifact)
      return this.dependencies.downloadArtifact(artifact, destinationPath)
    return downloadArtifact({
      url: artifact.url,
      destinationPath,
      expected: { size: artifact.size, sha256: artifact.sha256 },
      maxBytes: artifact.size,
      timeoutMs: this.dependencies.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
    })
  }

  private async prepare(
    artifact: AppArtifactV1 | RuntimeArtifactV1,
    downloadedPath: string,
    kind: 'app' | 'runtime'
  ): Promise<PreparedArtifact> {
    const prepareArtifact =
      this.dependencies.prepareArtifact ??
      createArtifactPreparer({
        stagingParent: path.join(this.dependencies.core.layout.root, 'prepared')
      })
    const prepared = await prepareArtifact({ artifact, downloadedPath, kind })
    return typeof prepared === 'string' ? { sourceDirectory: prepared } : prepared
  }
}

export function createLauncherUpdateCoordinator(
  dependencies: LauncherUpdateCoordinatorDependencies
): LauncherUpdateCoordinator {
  return new LauncherUpdateCoordinator(dependencies)
}
