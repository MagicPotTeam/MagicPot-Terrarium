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
    const buildEnvModule = await import('./buildEnv')
    vi.mocked(buildEnvModule.getBuildEnv).mockReturnValue(createBuildEnv())
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = ''
    vi.clearAllMocks()
  })

  it('creates new configs with the local LLM proxy server disabled', async () => {
    const configModule = await loadConfigModule()
    await configModule.initConfig()

    expect(configModule.getConfig().local_llm_server_config.enable_server).toBe(false)
    const savedConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'))
    expect(savedConfig.local_llm_server_config.enable_server).toBe(false)
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

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890)
    const writeFileSpy = vi.spyOn(fs, 'writeFile')
    const renameSpy = vi.spyOn(fs, 'rename')

    try {
      await configModule.saveConfig({
        use_remote_llm: !DEFAULT_CONFIG.use_remote_llm
      })

      const tempPath = `${configPath}.1234567890.tmp`
      expect(writeFileSpy).toHaveBeenCalledTimes(1)
      expect(writeFileSpy).toHaveBeenCalledWith(
        tempPath,
        expect.stringContaining('"use_remote_llm"'),
        'utf-8'
      )
      expect(renameSpy).toHaveBeenCalledTimes(1)
      expect(renameSpy).toHaveBeenCalledWith(tempPath, configPath)

      const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'))
      expect(savedConfig.use_remote_llm).toBe(!DEFAULT_CONFIG.use_remote_llm)
    } finally {
      nowSpy.mockRestore()
      writeFileSpy.mockRestore()
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
