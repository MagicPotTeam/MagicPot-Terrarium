import path from 'node:path'
import type { BuildEnv } from '@shared/config/buildEnv'
import type { Config } from '@shared/config/config'
import { ConfigUtils } from '@shared/config/configUtils'
import { normalizeComfyInstanceOrigin, type ComfyInstanceRegistry } from './instanceRegistry'

export const MANAGED_LOCAL_COMFY_INSTANCE_ID = 'managed-local'

export type ManagedLocalComfyBootstrapResult =
  'created' | 'updated' | 'unchanged' | 'preserved' | 'skipped'

type ManagedLocalComfyBootstrapOptions = Readonly<{
  config: Config
  buildEnv: BuildEnv
  registry: ComfyInstanceRegistry
  now?: () => number
}>

export function bootstrapManagedLocalComfyInstance({
  config,
  buildEnv,
  registry,
  now = Date.now
}: ManagedLocalComfyBootstrapOptions): ManagedLocalComfyBootstrapResult {
  if (config.use_remote_comfyui) return 'skipped'

  const configUtils = new ConfigUtils(config, buildEnv, path)
  if (!configUtils.isComfyUICommandAvailable()) return 'skipped'

  const origin = normalizeComfyInstanceOrigin(configUtils.getComfyUIOrigin(), 'local')
  const current = registry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)

  if (current) {
    if (current.deleted || !current.state.enabled || current.state.kind !== 'local') {
      return 'preserved'
    }
    if (current.state.origin === origin) return 'unchanged'

    registry.update({
      id: MANAGED_LOCAL_COMFY_INSTANCE_ID,
      expectedRevision: current.revision,
      updatedAt: now(),
      idempotencyKey: `managed-local-bootstrap-origin-${current.revision}`,
      patch: { origin }
    })
    return 'updated'
  }

  try {
    registry.create({
      id: MANAGED_LOCAL_COMFY_INSTANCE_ID,
      name: 'Managed local',
      origin,
      kind: 'local',
      maxConcurrency: 1,
      enabled: true,
      createdAt: now(),
      idempotencyKey: 'managed-local-bootstrap-create-v1'
    })
    return 'created'
  } catch (error) {
    if (error instanceof Error && error.message === 'ComfyUI instance idempotency conflict.') {
      return 'preserved'
    }
    throw error
  }
}
