import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import iconv from 'iconv-lite'
import type { BuildEnv } from '@shared/config/buildEnv'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_INTERROGATION_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_USER_PROMPT,
  type Config
} from '@shared/config/config'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn()
  }
}))

vi.mock(import('./buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

let tempDir = ''

const createBuildEnv = (): BuildEnv => ({
  ...DEFAULT_BUILD_ENV,
  pathMap: {
    ...DEFAULT_BUILD_ENV.pathMap,
    data: tempDir
  }
})

const loadConfigModule = async () => {
  vi.resetModules()
  const buildEnvModule = await import('./buildEnv')
  vi.mocked(buildEnvModule.getBuildEnv).mockReturnValue(createBuildEnv())
  return import('./config')
}

describe('config', () => {
  beforeEach(async () => {
    tempDir = await createNodeTestArtifactDir('config')
    delete process.env['MAGICPOT_USER_DATA_DIR']
    delete process.env['MAGICPOT_STORAGE_ROOT']
    const buildEnvModule = await import('./buildEnv')
    vi.mocked(buildEnvModule.getBuildEnv).mockReturnValue(createBuildEnv())
  })

  afterEach(async () => {
    delete process.env['MAGICPOT_USER_DATA_DIR']
    delete process.env['MAGICPOT_STORAGE_ROOT']
    await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = ''
    vi.clearAllMocks()
  })

  it('derives the project root for a fresh explicitly unified Data directory', async () => {
    const storageRoot = tempDir
    tempDir = path.join(storageRoot, 'Data')
    process.env['MAGICPOT_STORAGE_ROOT'] = storageRoot
    await fs.mkdir(tempDir, { recursive: true })
    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().download_dir).toBe(path.join(path.dirname(tempDir), 'Projects'))
  })

  it('repairs a stale non-empty project root in an explicitly unified target config', async () => {
    const storageRoot = tempDir
    tempDir = path.join(storageRoot, 'Data')
    process.env['MAGICPOT_STORAGE_ROOT'] = storageRoot
    await fs.mkdir(tempDir, { recursive: true })
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, download_dir: path.join(tempDir, 'old-projects') }),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const expected = path.join(path.dirname(tempDir), 'Projects')
    expect(configModule.getConfig().download_dir).toBe(expected)
    expect(
      JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8')).download_dir
    ).toBe(expected)
  })

  it('preserves download_dir for a legacy user-data layout', async () => {
    const legacyProjects = path.join(tempDir, 'legacy-projects')
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, download_dir: legacyProjects }),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().download_dir).toBe(legacyProjects)
  })

  it('does not infer a unified layout from an otherwise unknown Data basename', async () => {
    tempDir = path.join(tempDir, 'Data')
    const legacyProjects = path.join(tempDir, 'legacy-projects')
    await fs.mkdir(tempDir, { recursive: true })
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, download_dir: legacyProjects }),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().download_dir).toBe(legacyProjects)
  })

  it('preserves download_dir when the legacy exact user-data override is named Data', async () => {
    tempDir = path.join(tempDir, 'Data')
    const legacyProjects = path.join(tempDir, 'legacy-projects')
    process.env['MAGICPOT_USER_DATA_DIR'] = tempDir
    await fs.mkdir(tempDir, { recursive: true })
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, download_dir: legacyProjects }),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().download_dir).toBe(legacyProjects)
  })

  it('creates new configs with the local LLM proxy and MCP server disabled', async () => {
    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().local_llm_server_config.enable_server).toBe(false)
    expect(configModule.getConfig().mcp_config.server.enabled).toBe(false)
    expect(configModule.getConfig().mcp_config.server.expose_resources).toBe(false)
    const savedConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'))
    expect(savedConfig.local_llm_server_config.enable_server).toBe(false)
    expect(savedConfig.mcp_config.server.enabled).toBe(false)
    expect(savedConfig.mcp_config.server.expose_resources).toBe(false)
  })

  it('persists custom skills and reloads them from disk', async () => {
    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const customSkill = {
      id: 'skill-1',
      category: 'Ops',
      skillName: 'Render Assistant',
      prompt: 'Help with render tasks',
      type: 'agent' as const,
      apiKey: 'secret-key',
      apiAddress: 'https://example.com/api/chat'
    }

    await configModule.saveConfig({
      use_remote_llm: true,
      mcp_config: {
        client: {
          servers: [
            {
              id: 'echo',
              enabled: true,
              transport: 'stdio',
              command: 'node',
              args: ['scripts/mcp/echoServer.cjs'],
              toolPrefix: 'mcp.echo'
            }
          ]
        },
        server: {
          enabled: true,
          path: '/api/mcp',
          auth_token: 'mcp-secret',
          expose_resources: true
        }
      },
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Model A',
            base_url: 'https://example.com',
            api_key: 'api-key',
            is_ollama: false
          }
        ],
        customSkills: [customSkill]
      }
    })

    const savedConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'))
    expect(savedConfig.llm_config.customSkills).toEqual([customSkill])
    expect(savedConfig.llm_config.api_profiles).toHaveLength(1)
    expect(savedConfig.use_remote_llm).toBe(true)
    expect(savedConfig.mcp_config.client.servers).toEqual([
      {
        id: 'echo',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: ['scripts/mcp/echoServer.cjs'],
        toolPrefix: 'mcp.echo'
      }
    ])
    expect(savedConfig.mcp_config.server).toEqual({
      enabled: true,
      path: '/api/mcp',
      auth_token: 'mcp-secret',
      expose_resources: true
    })

    const reloadedModule = await loadConfigModule()
    await reloadedModule.initConfig()
    const reloadedConfig = reloadedModule.getConfig()

    expect(reloadedConfig.llm_config.customSkills).toEqual([customSkill])
    expect(reloadedConfig.llm_config.api_profiles).toHaveLength(1)
    expect(reloadedConfig.use_remote_llm).toBe(true)
    expect(reloadedConfig.mcp_config.client.servers).toEqual([
      {
        id: 'echo',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: ['scripts/mcp/echoServer.cjs'],
        toolPrefix: 'mcp.echo'
      }
    ])
    expect(reloadedConfig.mcp_config.server).toEqual({
      enabled: true,
      path: '/api/mcp',
      auth_token: 'mcp-secret',
      expose_resources: true
    })
    expect(reloadedConfig.llm_config.usePromptOptimization).toBe(
      DEFAULT_CONFIG.llm_config.usePromptOptimization
    )
  })

  it('writes config atomically through a temp file and rename', async () => {
    const configPath = path.join(tempDir, 'config.json')
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const writeFileSpy = vi.spyOn(fs, 'writeFile')
    const renameSpy = vi.spyOn(fs, 'rename')

    try {
      await configModule.saveConfig({
        use_remote_llm: !DEFAULT_CONFIG.use_remote_llm
      })

      expect(writeFileSpy).toHaveBeenCalledTimes(1)
      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^.*config\.json\.[0-9a-f-]+\.tmp$/),
        expect.stringContaining('"use_remote_llm"'),
        'utf-8'
      )
      expect(renameSpy).toHaveBeenCalledTimes(1)
      const tempPath = writeFileSpy.mock.calls[0][0]
      expect(renameSpy).toHaveBeenCalledWith(tempPath, configPath)

      const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'))
      expect(savedConfig.use_remote_llm).toBe(!DEFAULT_CONFIG.use_remote_llm)
    } finally {
      writeFileSpy.mockRestore()
      renameSpy.mockRestore()
    }
  })

  it('serializes concurrent saves and merges them in call order', async () => {
    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const originalRename = fs.rename.bind(fs)
    const renameGate = Promise.withResolvers<void>()
    let firstRename = true
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (firstRename) {
        firstRename = false
        await renameGate.promise
      }
      await originalRename(oldPath, newPath)
    })

    try {
      const firstSave = configModule.saveConfig({
        remote_llm_server_config: { server_origin: 'https://first.example' }
      })
      const secondSave = configModule.saveConfig({
        remote_llm_server_config: { access_token: 'second-token' }
      })
      const thirdSave = configModule.saveConfig({
        remote_llm_server_config: { server_origin: 'https://latest.example' }
      })

      await vi.waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1))
      expect(configModule.getConfig().remote_llm_server_config).toEqual(
        DEFAULT_CONFIG.remote_llm_server_config
      )

      renameGate.resolve()
      await Promise.all([firstSave, secondSave, thirdSave])

      const expectedRemoteConfig = {
        server_origin: 'https://latest.example',
        access_token: 'second-token'
      }
      expect(configModule.getConfig().remote_llm_server_config).toEqual(expectedRemoteConfig)
      expect(renameSpy).toHaveBeenCalledTimes(3)
      expect(new Set(renameSpy.mock.calls.map(([tempPath]) => tempPath)).size).toBe(3)
      const savedConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'))
      expect(savedConfig.remote_llm_server_config).toEqual(expectedRemoteConfig)
    } finally {
      renameGate.resolve()
      renameSpy.mockRestore()
    }
  })

  it('continues processing queued saves after a save fails', async () => {
    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const originalRename = fs.rename.bind(fs)
    let shouldFail = true
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (shouldFail) {
        shouldFail = false
        throw new Error('simulated rename failure')
      }
      await originalRename(oldPath, newPath)
    })

    try {
      const failedSave = configModule.saveConfig({
        remote_llm_server_config: { server_origin: 'https://failed.example' }
      })
      const nextSave = configModule.saveConfig({
        remote_llm_server_config: { access_token: 'survived-token' }
      })

      await expect(failedSave).rejects.toThrow('simulated rename failure')
      await expect(nextSave).resolves.toBeUndefined()

      const expectedRemoteConfig = {
        ...DEFAULT_CONFIG.remote_llm_server_config,
        access_token: 'survived-token'
      }
      expect(configModule.getConfig().remote_llm_server_config).toEqual(expectedRemoteConfig)
      const savedConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'))
      expect(savedConfig.remote_llm_server_config).toEqual(expectedRemoteConfig)
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('preserves proxy access tokens and legacy proxy token fields when reloading config', async () => {
    const configPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...DEFAULT_CONFIG,
          local_llm_server_config: {
            ...DEFAULT_CONFIG.local_llm_server_config,
            access_token: 'legacy-token',
            access_tokens: [
              {
                id: 'alice',
                label: 'Alice',
                token: 'alice-secret',
                resource_scope: 'alice'
              },
              {
                id: 'bob',
                label: 'Bob',
                token: 'bob-secret',
                resource_scope: 'bob'
              }
            ]
          },
          remote_llm_server_config: {
            ...DEFAULT_CONFIG.remote_llm_server_config,
            access_token: 'remote-secret'
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().local_llm_server_config.access_token).toBe('legacy-token')
    expect(configModule.getConfig().local_llm_server_config.access_tokens).toEqual([
      {
        id: 'alice',
        label: 'Alice',
        token: 'alice-secret',
        resource_scope: 'alice'
      },
      {
        id: 'bob',
        label: 'Bob',
        token: 'bob-secret',
        resource_scope: 'bob'
      }
    ])
    expect(configModule.getConfig().remote_llm_server_config.access_token).toBe('remote-secret')
  })

  it('backfills project trace config when loading an older config file', async () => {
    const configPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          use_remote_llm: true,
          llm_config: {
            api_profiles: []
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().project_trace_config).toEqual({
      enable_agent_reranker: false,
      enable_agent_terminal: false
    })
    const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(savedConfig.project_trace_config).toEqual({
      enable_agent_reranker: false,
      enable_agent_terminal: false
    })
  })

  it('repairs legacy mojibake proxy access token labels when reloading config', async () => {
    const configPath = path.join(tempDir, 'config.json')
    const mojibakeLabel = iconv.decode(Buffer.from('用户 1', 'utf8'), 'gbk')
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...DEFAULT_CONFIG,
          local_llm_server_config: {
            ...DEFAULT_CONFIG.local_llm_server_config,
            access_tokens: [
              {
                id: 'alice',
                label: mojibakeLabel,
                token: 'alice-secret',
                resource_scope: 'user-1'
              }
            ]
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().local_llm_server_config.access_tokens).toEqual([
      {
        id: 'alice',
        label: '用户 1',
        token: 'alice-secret',
        resource_scope: 'user-1'
      }
    ])

    const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(savedConfig.local_llm_server_config.access_tokens).toEqual([
      {
        id: 'alice',
        label: '用户 1',
        token: 'alice-secret',
        resource_scope: 'user-1'
      }
    ])
  })

  it('loads configs with a bom and embedded nul bytes when they are otherwise valid', async () => {
    const configPath = path.join(tempDir, 'config.json')
    const bomAndNulConfig = `\uFEFF{
  "use_remote_llm": true,
  "llm_config": {
    "api_profiles": [
      {
        "id": "profile-1",
        "model_name": "BOM Model",
        "base_url": "https://example.com",
        "api_key": "api-key",
        "is_ollama": false
      }
    ]
  }\u0000
}`
    await fs.writeFile(configPath, bomAndNulConfig, 'utf8')

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const loadedConfig = configModule.getConfig()
    expect(loadedConfig.use_remote_llm).toBe(true)
    expect(loadedConfig.llm_config.api_profiles).toEqual([
      {
        id: 'profile-1',
        model_name: 'BOM Model',
        base_url: 'https://example.com',
        api_key: 'api-key',
        is_ollama: false
      }
    ])
    const persistedConfig = await fs.readFile(configPath, 'utf8')
    expect(persistedConfig).not.toContain('\u0000')
    expect(persistedConfig).not.toContain('\uFEFF')
  })

  it('backs up a broken config but does not overwrite it with defaults during init', async () => {
    const configPath = path.join(tempDir, 'config.json')
    const brokenConfig = '{"use_remote_llm": true,\n'
    await fs.writeFile(configPath, brokenConfig, 'utf8')

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().use_remote_llm).toBe(DEFAULT_CONFIG.use_remote_llm)
    expect(configModule.getConfig().llm_config.api_profiles).toEqual(
      DEFAULT_CONFIG.llm_config.api_profiles
    )
    expect(configModule.getConfig().plugin_config?.api_profiles).toEqual(
      DEFAULT_CONFIG.plugin_config?.api_profiles
    )
    expect(await fs.readFile(configPath, 'utf8')).toBe(brokenConfig)

    const entries = await fs.readdir(tempDir)
    expect(
      entries.some((entry) => entry.startsWith('config.json.broken-') && entry.endsWith('.bak'))
    ).toBe(true)
  })

  it('seeds quick app api profiles once when loading a legacy config without plugin api profiles', async () => {
    const legacyConfigPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      legacyConfigPath,
      JSON.stringify(
        {
          use_remote_llm: true,
          llm_config: {
            api_profiles: [
              {
                id: 'agent-profile',
                model_name: 'Agent Model',
                base_url: 'https://agent.example/v1',
                api_key: 'agent-key',
                is_ollama: false
              }
            ]
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()
    const loadedConfig = configModule.getConfig()
    const savedConfig = JSON.parse(await fs.readFile(legacyConfigPath, 'utf8'))
    expect(loadedConfig.plugin_config).toBeDefined()

    expect(loadedConfig.plugin_config!.api_profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'Agent Model',
        base_url: 'https://agent.example/v1',
        api_key: 'agent-key',
        is_ollama: false
      }
    ])
    expect(savedConfig.plugin_config.api_profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'Agent Model',
        base_url: 'https://agent.example/v1',
        api_key: 'agent-key',
        is_ollama: false
      }
    ])
  })

  it('keeps an explicitly empty quick app api list empty after reload', async () => {
    const legacyConfigPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      legacyConfigPath,
      JSON.stringify(
        {
          use_remote_llm: true,
          llm_config: {
            api_profiles: [
              {
                id: 'agent-profile',
                model_name: 'Agent Model',
                base_url: 'https://agent.example/v1',
                api_key: 'agent-key',
                is_ollama: false
              }
            ]
          },
          plugin_config: {
            api_profiles: []
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()
    const loadedConfig = configModule.getConfig()
    const savedConfig = JSON.parse(await fs.readFile(legacyConfigPath, 'utf8'))
    expect(loadedConfig.plugin_config).toBeDefined()

    expect(loadedConfig.plugin_config!.api_profiles).toEqual([])
    expect(savedConfig.plugin_config.api_profiles).toEqual([])
  })

  it('preserves existing quick app plugin settings during legacy LLM migration', async () => {
    const legacyConfigPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      legacyConfigPath,
      JSON.stringify(
        {
          use_remote_llm: true,
          llm_config: {
            api_profiles: []
          },
          plugin_config: {
            api_profiles: [],
            promptTranslationSystemPrompt: 'custom translation system',
            promptTranslationUserPrompt: 'custom translation user',
            imageInterrogationSystemPrompt: 'custom image system',
            imageInterrogationUserPrompt: 'custom image user',
            duplicateCheck: {
              ...DEFAULT_CONFIG.plugin_config!.duplicateCheck!,
              enabled: false,
              defaultPreset: 'strict'
            }
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()
    const loadedConfig = configModule.getConfig()
    const savedConfig = JSON.parse(await fs.readFile(legacyConfigPath, 'utf8'))

    expect(loadedConfig.plugin_config?.promptTranslationSystemPrompt).toBe(
      'custom translation system'
    )
    expect(loadedConfig.plugin_config?.promptTranslationUserPrompt).toBe('custom translation user')
    expect(loadedConfig.plugin_config?.imageInterrogationSystemPrompt).toBe('custom image system')
    expect(loadedConfig.plugin_config?.imageInterrogationUserPrompt).toBe('custom image user')
    expect(loadedConfig.plugin_config?.duplicateCheck).toEqual({
      ...DEFAULT_CONFIG.plugin_config!.duplicateCheck!,
      enabled: false,
      defaultPreset: 'strict'
    })
    expect(savedConfig.plugin_config.promptTranslationSystemPrompt).toBe(
      'custom translation system'
    )
    expect(savedConfig.plugin_config.promptTranslationUserPrompt).toBe('custom translation user')
    expect(savedConfig.plugin_config.imageInterrogationSystemPrompt).toBe('custom image system')
    expect(savedConfig.plugin_config.imageInterrogationUserPrompt).toBe('custom image user')
    expect(savedConfig.plugin_config.duplicateCheck).toEqual({
      ...DEFAULT_CONFIG.plugin_config!.duplicateCheck!,
      enabled: false,
      defaultPreset: 'strict'
    })
  })

  it('persists migrated quick app image interrogation system and user prompts', async () => {
    const legacyConfigPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      legacyConfigPath,
      JSON.stringify(
        {
          llm_config: {
            ...DEFAULT_CONFIG.llm_config,
            imageInterrogationPrompt: 'legacy agent interrogation prompt'
          },
          plugin_config: {
            api_profiles: [],
            light_adjustment_prompt: DEFAULT_CONFIG.plugin_config!.light_adjustment_prompt
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const loadedConfig = configModule.getConfig()
    const savedConfig = JSON.parse(await fs.readFile(legacyConfigPath, 'utf8'))

    expect(loadedConfig.plugin_config?.imageInterrogationSystemPrompt).toBe(
      'legacy agent interrogation prompt'
    )
    expect(loadedConfig.plugin_config?.imageInterrogationUserPrompt).toBe(
      DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    )
    expect(savedConfig.plugin_config.imageInterrogationSystemPrompt).toBe(
      'legacy agent interrogation prompt'
    )
    expect(savedConfig.plugin_config.imageInterrogationUserPrompt).toBe(
      DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    )
  })

  it('replaces the historical default quick app image interrogation system prompt on reload', async () => {
    const legacyConfigPath = path.join(tempDir, 'config.json')
    await fs.writeFile(
      legacyConfigPath,
      JSON.stringify(
        {
          ...DEFAULT_CONFIG,
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            imageInterrogationPrompt: DEFAULT_IMAGE_INTERROGATION_PROMPT,
            imageInterrogationSystemPrompt: DEFAULT_IMAGE_INTERROGATION_PROMPT,
            imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const configModule = await loadConfigModule()
    await configModule.initConfig()

    const loadedConfig = configModule.getConfig()
    const savedConfig = JSON.parse(await fs.readFile(legacyConfigPath, 'utf8'))

    expect(loadedConfig.plugin_config?.imageInterrogationSystemPrompt).toBe(
      DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT
    )
    expect(loadedConfig.plugin_config?.imageInterrogationUserPrompt).toBe(
      DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    )
    expect(savedConfig.plugin_config.imageInterrogationSystemPrompt).toBe(
      DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT
    )
    expect(savedConfig.plugin_config.imageInterrogationUserPrompt).toBe(
      DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    )
  })
})
