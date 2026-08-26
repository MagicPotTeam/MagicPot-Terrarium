import type { ComfyBatchProfile } from '@shared/api/svcComfyBatch'
import { DEFAULT_COMFYUI_ORIGIN, type Config } from '@shared/config/config'
import { getConfig } from '../config/config'
import { ConfigUtils } from '@shared/config/configUtils'
import { getBuildEnv } from '../config/buildEnv'
import { ComfyHttpCli } from './http'
import { normalizeComfyBatchBaseUrl } from './batchHttp'
import { findNotInstalledNodeInfo } from '@shared/comfy/funcs'
import type { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import path from 'node:path'

const DEFAULT_CACHE_TTL_MS = 5_000
const INSTANCE_PROBE_TIMEOUT_MS = 8_000

export type ComfyPoolInstance = {
  profile: ComfyBatchProfile
  client: ComfyHttpCli
  objectInfo: ObjectInfoMap
}

type PoolClient = Pick<ComfyHttpCli, 'objectInfo'>

export type ComfyInstancePoolOptions = {
  profiles?: ComfyBatchProfile[] | (() => ComfyBatchProfile[])
  clients?: Record<string, PoolClient>
  clientFactory?: (baseUrl: string) => ComfyHttpCli
  cacheTtlMs?: number
}

function normalizeProfile(profile: ComfyBatchProfile): ComfyBatchProfile {
  const id = String(profile.id || '').trim()
  if (!id) throw new Error('Profile id is required')
  return {
    id,
    baseUrl: normalizeComfyBatchBaseUrl(profile.baseUrl),
    enabled: profile.enabled !== false,
    maxConcurrency: Math.max(1, Math.min(32, Math.floor(profile.maxConcurrency || 1)))
  }
}

function defaultProfile(): ComfyBatchProfile {
  const config = getConfig() as Config
  const configuredOrigin = config.remote_comfyui_config
    ? new ConfigUtils(config, getBuildEnv(), path).getComfyUIOrigin()
    : DEFAULT_COMFYUI_ORIGIN
  return {
    id: 'default',
    baseUrl: normalizeComfyBatchBaseUrl(configuredOrigin),
    enabled: true,
    maxConcurrency: 1
  }
}

export function getConfiguredComfyProfiles(): ComfyBatchProfile[] {
  const configured = (getConfig() as Partial<Config>).comfy_batch_profiles
  if (!Array.isArray(configured) || configured.length === 0) {
    return [defaultProfile()]
  }
  const profiles = configured.flatMap((profile) => {
    try {
      return [normalizeProfile(profile)]
    } catch {
      return []
    }
  })
  return profiles.length > 0 ? profiles : [defaultProfile()]
}

/**
 * Shared pool for all regular Quick App ComfyUI calls.
 * Availability is based on a non-empty object_info response, which also
 * avoids showing a false "ComfyUI API unavailable" warning in the renderer.
 */
export class ComfyInstancePool {
  private readonly profilesSource: () => ComfyBatchProfile[]
  private readonly clients: Record<string, PoolClient>
  private readonly clientFactory: (baseUrl: string) => ComfyHttpCli
  private readonly cacheTtlMs: number
  private cached: { expiresAt: number; instances: ComfyPoolInstance[] } | null = null
  private cursor = 0
  /**
   * A successful upload/object-info lookup establishes endpoint affinity for
   * the next queued prompt. Keep it separate from the round-robin cursor so
   * intermediate metadata calls cannot accidentally move the prompt to a
   * different ComfyUI instance.
   */
  private preferredBaseUrl: string | null = null

  constructor(options: ComfyInstancePoolOptions = {}) {
    if (typeof options.profiles === 'function') {
      this.profilesSource = options.profiles
    } else {
      const profiles = options.profiles
      this.profilesSource = () => profiles ?? getConfiguredComfyProfiles()
    }
    this.clients = options.clients ?? {}
    this.clientFactory =
      options.clientFactory ?? ((baseUrl) => new ComfyHttpCli(undefined, undefined, { baseUrl }))
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
  }

  private makeClient(baseUrl: string): ComfyHttpCli {
    const existing = this.clients[baseUrl]
    if (existing) return existing as ComfyHttpCli
    return this.clientFactory(baseUrl)
  }

  async getAvailableInstances(force = false): Promise<ComfyPoolInstance[]> {
    const now = Date.now()
    if (!force && this.cached && this.cached.expiresAt > now) {
      return [...this.cached.instances]
    }

    const instances: ComfyPoolInstance[] = []
    let profiles: ComfyBatchProfile[]
    try {
      profiles = this.profilesSource()
    } catch {
      profiles = []
    }
    const enabledProfiles = profiles.flatMap((rawProfile) => {
      try {
        const profile = normalizeProfile(rawProfile)
        return profile.enabled ? [profile] : []
      } catch {
        return []
      }
    })
    const probes = await Promise.allSettled(
      enabledProfiles.map(async (profile) => {
        const client = this.makeClient(profile.baseUrl)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), INSTANCE_PROBE_TIMEOUT_MS)
        try {
          const objectInfo = await client.objectInfo(controller.signal)
          if (
            !objectInfo ||
            typeof objectInfo !== 'object' ||
            Object.keys(objectInfo).length === 0
          ) {
            return null
          }
          return { profile, client, objectInfo }
        } finally {
          clearTimeout(timeout)
        }
      })
    )
    for (const probe of probes) {
      if (probe.status !== 'fulfilled' || !probe.value) continue
      instances.push(probe.value)
    }

    this.cached = { expiresAt: now + this.cacheTtlMs, instances }
    if (instances.length === 0) {
      this.cursor = 0
    } else {
      this.cursor %= instances.length
    }
    return [...instances]
  }

  private compatibleInstances(instances: ComfyPoolInstance[], workflow?: Workflow) {
    if (!workflow) return instances
    return instances.filter(
      (instance) => findNotInstalledNodeInfo(workflow, instance.objectInfo).length === 0
    )
  }

  private rotateInstances(
    instances: ComfyPoolInstance[],
    consumePreferred: boolean
  ): ComfyPoolInstance[] {
    if (instances.length <= 1) return instances

    const preferredIndex = this.preferredBaseUrl
      ? instances.findIndex((instance) => instance.profile.baseUrl === this.preferredBaseUrl)
      : -1
    if (preferredIndex >= 0) {
      if (consumePreferred) this.preferredBaseUrl = null
      this.cursor = (preferredIndex + 1) % instances.length
      return [...instances.slice(preferredIndex), ...instances.slice(0, preferredIndex)]
    }

    const start = this.cursor % instances.length
    this.cursor = (start + 1) % instances.length
    return [...instances.slice(start), ...instances.slice(0, start)]
  }

  async orderedAvailableInstances(
    force = false,
    workflow?: Workflow
  ): Promise<ComfyPoolInstance[]> {
    const instances = this.compatibleInstances(await this.getAvailableInstances(force), workflow)
    return this.rotateInstances(instances, true)
  }

  async nextAvailableInstance(force = false, workflow?: Workflow): Promise<ComfyPoolInstance> {
    const instances = await this.orderedAvailableInstances(force, workflow)
    const instance = instances[0]
    if (!instance) throw new Error('No compatible ComfyUI instance is available')
    return instance
  }

  async getObjectInfo(workflow?: Workflow): Promise<ObjectInfoMap> {
    const instances = await this.getAvailableInstances()
    if (instances.length === 0) throw new Error('No compatible ComfyUI instance is available')

    // Prefer a workflow-compatible endpoint for dependency preflight and
    // LoRA processing. If none is compatible, return an available endpoint's
    // object info so the caller can still display the missing-node diagnosis.
    const compatible = this.compatibleInstances(instances, workflow)
    const candidates = compatible.length > 0 ? compatible : instances
    const preferred = this.preferredBaseUrl
      ? candidates.find((instance) => instance.profile.baseUrl === this.preferredBaseUrl)
      : undefined
    const instance = preferred ?? this.rotateInstances(candidates, false)[0] ?? candidates[0]
    // Keep object_info and the following queued prompt on the same endpoint.
    this.preferredBaseUrl = instance.profile.baseUrl
    return instance.objectInfo
  }

  preferBaseUrl(baseUrl: string): void {
    const instances = this.cached?.instances || []
    const index = instances.findIndex((instance) => instance.profile.baseUrl === baseUrl)
    if (index >= 0) this.preferredBaseUrl = instances[index].profile.baseUrl
  }

  invalidate(): void {
    this.cached = null
    this.preferredBaseUrl = null
  }
}

let sharedPool: ComfyInstancePool | null = null

export function getComfyInstancePool(): ComfyInstancePool {
  if (!sharedPool) sharedPool = new ComfyInstancePool()
  return sharedPool
}

export function resetComfyInstancePoolForTests(): void {
  sharedPool = null
}
