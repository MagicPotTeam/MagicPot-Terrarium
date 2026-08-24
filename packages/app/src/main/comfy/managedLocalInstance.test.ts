import { afterEach, describe, expect, it } from 'vitest'
import type { BuildEnv } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { ComfyInstanceRegistry } from './instanceRegistry'
import {
  bootstrapManagedLocalComfyInstance,
  MANAGED_LOCAL_COMFY_INSTANCE_ID
} from './managedLocalInstance'

type ConfigOverrides = Partial<Omit<Config, 'local_comfyui_config' | 'remote_comfyui_config'>> & {
  local_comfyui_config?: Partial<Config['local_comfyui_config']>
  remote_comfyui_config?: Partial<Config['remote_comfyui_config']>
}

const createConfig = (overrides: ConfigOverrides = {}): Config => ({
  ...DEFAULT_CONFIG,
  ...overrides,
  local_comfyui_config: {
    ...DEFAULT_CONFIG.local_comfyui_config,
    comfyui_dir: '/runtime/ComfyUI',
    python_cmd: 'python',
    comfyui_args: ['main.py'],
    ...overrides.local_comfyui_config
  },
  remote_comfyui_config: {
    ...DEFAULT_CONFIG.remote_comfyui_config,
    ...overrides.remote_comfyui_config
  }
})

const buildEnv: BuildEnv = {
  env: {
    build: 'prod',
    platform: 'windows',
    buildMode: 'pure',
    packageVersion: 'test'
  },
  pathMap: {
    data: '/user-data',
    file: '/app',
    resources: '/resources'
  },
  embeddedDefaults: {
    pythonCmd: '',
    comfyuiDir: '',
    comfyuiArgs: []
  }
}

const stores: MagicAgentEventStore[] = []
const openRegistry = (): ComfyInstanceRegistry => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  return new ComfyInstanceRegistry(store)
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('bootstrapManagedLocalComfyInstance', () => {
  it('creates one stable managed-local entry and is idempotent on repeated startup', () => {
    const registry = openRegistry()
    const config = createConfig({ local_comfyui_config: { comfyui_port: '9191' } })

    expect(bootstrapManagedLocalComfyInstance({ config, buildEnv, registry, now: () => 100 })).toBe(
      'created'
    )
    expect(bootstrapManagedLocalComfyInstance({ config, buildEnv, registry, now: () => 200 })).toBe(
      'unchanged'
    )

    expect(registry.list()).toHaveLength(1)
    expect(registry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)).toMatchObject({
      revision: 0,
      deleted: false,
      state: {
        id: 'managed-local',
        name: 'Managed local',
        origin: 'http://localhost:9191/',
        kind: 'local',
        maxConcurrency: 1,
        enabled: true
      }
    })
  })

  it('skips remote mode and local installs without a usable command', () => {
    const remoteRegistry = openRegistry()
    const unavailableRegistry = openRegistry()
    const unavailableConfig = createConfig({
      local_comfyui_config: {
        comfyui_dir: '',
        python_cmd: '',
        comfyui_args: []
      }
    })

    expect(
      bootstrapManagedLocalComfyInstance({
        config: createConfig({ use_remote_comfyui: true }),
        buildEnv,
        registry: remoteRegistry
      })
    ).toBe('skipped')
    expect(
      bootstrapManagedLocalComfyInstance({
        config: unavailableConfig,
        buildEnv,
        registry: unavailableRegistry
      })
    ).toBe('skipped')
    expect(remoteRegistry.list()).toHaveLength(0)
    expect(unavailableRegistry.list()).toHaveLength(0)
  })

  it('updates only the origin when the configured local port changes', () => {
    const registry = openRegistry()
    const initialConfig = createConfig({ local_comfyui_config: { comfyui_port: '8188' } })
    bootstrapManagedLocalComfyInstance({
      config: initialConfig,
      buildEnv,
      registry,
      now: () => 100
    })

    const result = bootstrapManagedLocalComfyInstance({
      config: createConfig({ local_comfyui_config: { comfyui_port: '8288' } }),
      buildEnv,
      registry,
      now: () => 300
    })

    expect(result).toBe('updated')
    expect(registry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)).toMatchObject({
      revision: 1,
      state: {
        name: 'Managed local',
        origin: 'http://localhost:8288/',
        kind: 'local',
        enabled: true,
        maxConcurrency: 1
      }
    })
  })

  it('does not resurrect a disabled or removed managed-local entry', () => {
    const disabledRegistry = openRegistry()
    const removedRegistry = openRegistry()
    const initialConfig = createConfig()

    bootstrapManagedLocalComfyInstance({
      config: initialConfig,
      buildEnv,
      registry: disabledRegistry,
      now: () => 1
    })
    const disabled = disabledRegistry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)!
    disabledRegistry.update({
      id: MANAGED_LOCAL_COMFY_INSTANCE_ID,
      expectedRevision: disabled.revision,
      updatedAt: 10,
      idempotencyKey: 'disable',
      patch: { enabled: false }
    })

    bootstrapManagedLocalComfyInstance({
      config: initialConfig,
      buildEnv,
      registry: removedRegistry,
      now: () => 1
    })
    const removable = removedRegistry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)!
    removedRegistry.remove({
      id: MANAGED_LOCAL_COMFY_INSTANCE_ID,
      expectedRevision: removable.revision,
      removedAt: 10,
      idempotencyKey: 'remove'
    })

    const changedPort = createConfig({ local_comfyui_config: { comfyui_port: '8288' } })
    expect(
      bootstrapManagedLocalComfyInstance({
        config: changedPort,
        buildEnv,
        registry: disabledRegistry
      })
    ).toBe('preserved')
    expect(
      bootstrapManagedLocalComfyInstance({
        config: changedPort,
        buildEnv,
        registry: removedRegistry
      })
    ).toBe('preserved')
    expect(disabledRegistry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)).toMatchObject({
      revision: 1,
      deleted: false,
      state: { enabled: false, origin: 'http://localhost:8188/' }
    })
    expect(removedRegistry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)).toBeUndefined()
    expect(removedRegistry.list()).toEqual([])
  })

  it('does not rewrite an enabled non-local entry that occupies the stable id', () => {
    const registry = openRegistry()
    registry.create({
      id: MANAGED_LOCAL_COMFY_INSTANCE_ID,
      name: 'User endpoint',
      origin: 'https://comfy.example',
      kind: 'remote',
      enabled: true,
      maxConcurrency: 1,
      createdAt: 1,
      idempotencyKey: 'user-entry'
    })

    expect(bootstrapManagedLocalComfyInstance({ config: createConfig(), buildEnv, registry })).toBe(
      'preserved'
    )
    expect(registry.get(MANAGED_LOCAL_COMFY_INSTANCE_ID)).toMatchObject({
      revision: 0,
      state: { kind: 'remote', origin: 'https://comfy.example/' }
    })
  })
})
