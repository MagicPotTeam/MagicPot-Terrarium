import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, type Config } from './config'
import { ConfigUtils } from './configUtils'
import type { BuildEnv } from './buildEnv'

type ConfigOverrides = Partial<Omit<Config, 'local_comfyui_config' | 'remote_comfyui_config'>> & {
  local_comfyui_config?: Partial<Config['local_comfyui_config']>
  remote_comfyui_config?: Partial<Config['remote_comfyui_config']>
}

const createConfig = (overrides: ConfigOverrides = {}): Config => ({
  ...DEFAULT_CONFIG,
  client_id: 'test-client',
  ...overrides,
  local_comfyui_config: {
    ...DEFAULT_CONFIG.local_comfyui_config,
    ...overrides.local_comfyui_config
  },
  remote_comfyui_config: {
    ...DEFAULT_CONFIG.remote_comfyui_config,
    ...overrides.remote_comfyui_config
  }
})

const createBuildEnv = (overrides: Partial<BuildEnv> = {}): BuildEnv => ({
  env: {
    build: 'development',
    platform: 'windows',
    buildMode: 'pure',
    packageVersion: 'test',
    ...overrides.env
  },
  pathMap: {
    data: '/user-data',
    file: '/app-root',
    resources: '/resources',
    ...overrides.pathMap
  },
  embeddedDefaults: {
    pythonCmd: 'vendor/comfyui/python_embeded/python.exe',
    comfyuiDir: 'vendor/comfyui/ComfyUI',
    comfyuiArgs: [],
    ...overrides.embeddedDefaults
  }
})

describe('ConfigUtils qApp paths', () => {
  it('separates writable qApps from bundled qApps', () => {
    const configUtils = new ConfigUtils(
      {} as never,
      {
        env: {
          build: 'development',
          platform: 'unknown',
          buildMode: 'pure',
          packageVersion: 'test'
        },
        pathMap: {
          data: '/user-data',
          file: '/app-root',
          resources: '/resources'
        },
        embeddedDefaults: {
          pythonCmd: '',
          comfyuiDir: '',
          comfyuiArgs: []
        }
      } as never,
      path
    )

    expect(configUtils.getQAppDir()).toBe(path.join('/user-data', 'qApps'))
    expect(configUtils.getBuiltinQAppDir()).toBe(path.join('/app-root', 'packages', 'qapps'))
    expect(configUtils.getBundledCustomSkillDir()).toBe(
      path.join('/app-root', 'packages', 'skills')
    )
    expect(configUtils.getBundledTargetSchemeDir()).toBe(
      path.join('/app-root', 'packages', 'target-schemes')
    )
    expect(configUtils.getAutomationSchemeDir()).toBe(
      path.join('/user-data', 'automationSchemeDefinitions')
    )
  })

  it('keeps packaged bundled content paths compatible with existing install layout', () => {
    const configUtils = new ConfigUtils(
      {} as never,
      createBuildEnv({
        env: {
          build: 'prod',
          platform: 'windows',
          buildMode: 'pure',
          packageVersion: 'test'
        }
      }),
      path
    )

    expect(configUtils.getBuiltinQAppDir()).toBe(path.join('/app-root', 'qApps'))
    expect(configUtils.getBundledCustomSkillDir()).toBe(path.join('/app-root', 'customSkills'))
    expect(configUtils.getBundledTargetSchemeDir()).toBe(path.join('/app-root', 'targetSchemes'))
  })
})

describe('ConfigUtils ComfyUI paths', () => {
  it('resolves development embedded default model dirs against comfyui_data', () => {
    const config = createConfig()
    const configUtils = new ConfigUtils(config, createBuildEnv(), path)

    expect(configUtils.getComfyUIDir()).toEqual([
      path.join('/app-root', 'vendor/comfyui/ComfyUI'),
      true
    ])
    expect(configUtils.getCheckpointsDir()).toBe(
      path.join('/app-root', 'vendor/comfyui/comfyui_data', 'models/checkpoints')
    )
    expect(config.local_comfyui_config.comfyui_dir).toBe('')
  })

  it('resolves configured relative ComfyUI dirs against the app root', () => {
    const configUtils = new ConfigUtils(
      createConfig({
        local_comfyui_config: {
          comfyui_dir: 'vendor/ComfyUI'
        }
      }),
      createBuildEnv(),
      path
    )

    expect(configUtils.getComfyUIDir()).toEqual([path.join('/app-root', 'vendor/ComfyUI'), true])
    expect(configUtils.getCheckpointsDir()).toBe(
      path.join('/app-root', 'vendor/ComfyUI', 'models/checkpoints')
    )
  })

  it('keeps bare Python commands in pure builds and resolves path-like commands', () => {
    const bareCommandUtils = new ConfigUtils(
      createConfig({
        local_comfyui_config: {
          python_cmd: 'python'
        }
      }),
      createBuildEnv(),
      path
    )
    const pathCommandUtils = new ConfigUtils(
      createConfig({
        local_comfyui_config: {
          python_cmd: 'python_embeded/python.exe'
        }
      }),
      createBuildEnv(),
      path
    )

    expect(bareCommandUtils.getPythonCmd()).toEqual(['python', true])
    expect(pathCommandUtils.getPythonCmd()).toEqual([
      path.join('/app-root', 'python_embeded/python.exe'),
      true
    ])
  })
})
