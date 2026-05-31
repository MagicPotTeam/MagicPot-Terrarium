import fs from 'fs/promises'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StateSvcImpl } from './svcStateImpl'
import type { McpClientConnectionSnapshot } from '@shared/api/svcState'
import { DeepPartial } from '@shared/utils/utilTypes'
import { Config, DEFAULT_CONFIG } from '@shared/config/config'
import * as config from '../config/config'
import { BuildEnv, DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import * as buildEnv from '../config/buildEnv'
import * as mcpRuntime from '../mcp/runtime'
import * as userDataDirectory from '../config/userDataDirectory'
import * as portablePaths from '../config/portablePaths'
import * as llmProxyServer from '../llmProxy/server'
import * as llmProxyAccessUsage from '../llmProxy/accessUsage'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

vi.mock(import('../config/config'), () => {
  return {
    getConfig: vi.fn()
  }
})

vi.mock(import('../config/buildEnv'), () => {
  return {
    getBuildEnv: vi.fn()
  }
})

vi.mock(import('../mcp/runtime'), () => {
  return {
    getMcpClientManager: vi.fn(),
    syncMcpClientManager: vi.fn()
  }
})

vi.mock(import('../config/userDataDirectory'), () => {
  return {
    getCurrentUserDataDirectoryState: vi.fn(),
    getDefaultUserDataDirectory: vi.fn(),
    prepareUserDataDirectoryChange: vi.fn()
  }
})

vi.mock(import('../config/portablePaths'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getLegacyPortableUserDataDirectory: vi.fn()
  }
})

vi.mock(import('../llmProxy/server'), () => {
  return {
    getLLMProxyServerStatus: vi.fn(() => ({
      running: false,
      port: 3721
    }))
  }
})

vi.mock(import('../llmProxy/accessUsage'), () => {
  return {
    getLlmProxyAccessUsageSnapshot: vi.fn(() => [])
  }
})

function mockConfig(v: DeepPartial<Config>): void {
  vi.mocked(config.getConfig).mockReturnValue({
    ...DEFAULT_CONFIG,
    ...v
  } as Config)
}

function mockBuildEnv(v: DeepPartial<BuildEnv>): void {
  vi.mocked(buildEnv.getBuildEnv).mockReturnValue({
    ...DEFAULT_BUILD_ENV,
    ...v
  } as BuildEnv)
}

describe('svcStateImpl', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  const mockMcpClientManager = {
    listConnections: vi.fn((): McpClientConnectionSnapshot[] => [])
  }

  vi.mocked(mcpRuntime.getMcpClientManager).mockReturnValue(
    mockMcpClientManager as unknown as ReturnType<typeof mcpRuntime.getMcpClientManager>
  )
  vi.mocked(mcpRuntime.syncMcpClientManager).mockResolvedValue(undefined)

  it('should get config', async () => {
    mockConfig({
      use_remote_comfyui: true,
      remote_comfyui_config: {
        comfyui_origin: 'impossible'
      }
    })
    const svcStateImpl = new StateSvcImpl()
    const config = await svcStateImpl.getConfig({})
    expect(config).toBeDefined()
    expect(config.config.use_remote_comfyui).toBe(true)
    expect(config.config.remote_comfyui_config.comfyui_origin).toBe('impossible')
  })
  it('should get build env', async () => {
    mockBuildEnv({
      env: {
        packageVersion: 'impossible'
      }
    })
    const svcStateImpl = new StateSvcImpl()
    const buildEnv = await svcStateImpl.getBuildEnv({})
    expect(buildEnv).toBeDefined()
    expect(buildEnv.buildEnv.env.packageVersion).toBe('impossible')
  })

  it('should get the user data directory state', async () => {
    vi.mocked(userDataDirectory.getCurrentUserDataDirectoryState).mockReturnValue({
      currentPath: 'C:/MagicPot/data',
      defaultPath: 'C:/MagicPot/default-data',
      isCustom: true,
      source: 'persisted'
    })

    const svcStateImpl = new StateSvcImpl()
    const response = await svcStateImpl.getUserDataDirectoryState({})

    expect(response).toEqual({
      state: {
        currentPath: 'C:/MagicPot/data',
        defaultPath: 'C:/MagicPot/default-data',
        isCustom: true,
        source: 'persisted'
      }
    })
  })

  it('should get MCP runtime status', async () => {
    mockConfig({
      mcp_config: {
        client: {
          servers: []
        },
        server: {
          enabled: true,
          path: '/api/mcp-dev',
          auth_token: 'secret-token',
          expose_resources: false
        }
      }
    })
    mockMcpClientManager.listConnections.mockReturnValue([
      {
        id: 'github',
        aliasPrefix: 'mcp.github',
        status: 'connected',
        toolCount: 2,
        toolAliases: ['mcp.github.issues.list', 'mcp.github.pulls.list'],
        transport: 'stdio'
      }
    ])

    const svcStateImpl = new StateSvcImpl()
    const status = await svcStateImpl.getMcpStatus({})

    expect(mcpRuntime.syncMcpClientManager).toHaveBeenCalled()
    expect(status).toEqual({
      client: {
        connections: [
          {
            id: 'github',
            aliasPrefix: 'mcp.github',
            status: 'connected',
            toolCount: 2,
            toolAliases: ['mcp.github.issues.list', 'mcp.github.pulls.list'],
            transport: 'stdio'
          }
        ],
        discoveredToolCount: 2
      },
      server: {
        enabled: true,
        path: '/api/mcp-dev',
        exposeResources: false,
        authRequired: true
      },
      platform: expect.objectContaining({
        state: 'created',
        version: '1.0.0',
        transportCount: 1,
        auditEntryCount: 0,
        counts: {
          sources: 0,
          sessions: 0,
          tools: 0,
          resources: 0,
          prompts: 0
        }
      })
    })
  })

  it('should get local LLM proxy access usage stats', async () => {
    vi.mocked(llmProxyServer.getLLMProxyServerStatus).mockReturnValue({
      running: true,
      port: 4850
    })
    vi.mocked(llmProxyAccessUsage.getLlmProxyAccessUsageSnapshot).mockReturnValue([
      {
        tokenId: 'alice',
        label: 'Alice',
        resourceScope: 'alice',
        requestCount: 8,
        statusRequestCount: 1,
        profileListRequestCount: 1,
        chatRequestCount: 3,
        openAiRequestCount: 1,
        quickAppListRequestCount: 1,
        quickAppGetRequestCount: 0,
        mediaDownloadCount: 2,
        generatedMediaCount: 4,
        generatedMediaBytes: 1024,
        storedMediaCount: 4,
        storedMediaBytes: 1024,
        lastSeenAt: 123,
        lastRequesterAddress: '10.0.0.5',
        lastProfileId: 'gpt-5.4',
        lastActivity: 'chat'
      }
    ])

    const svcStateImpl = new StateSvcImpl()
    const response = await svcStateImpl.getLlmProxyAccessUsage({})

    expect(response).toEqual({
      running: true,
      port: 4850,
      usage: [
        expect.objectContaining({
          tokenId: 'alice',
          requestCount: 8,
          generatedMediaCount: 4,
          lastRequesterAddress: '10.0.0.5'
        })
      ]
    })
  })

  it('should list current and detected storage locations', async () => {
    const tempRoot = await createNodeTestArtifactDir('state-storage')
    const currentDataDir = path.join(tempRoot, 'current-data')
    const currentFileRoot = path.join(tempRoot, 'current-root')
    const installedRoot = path.join(tempRoot, 'LocalAppData', 'Programs', 'magicpot-pure')
    const installedDataDir = path.join(installedRoot, 'aiengineelectron')
    const oldLocalAppData = process.env['LOCALAPPDATA']
    try {
      await fs.rm(tempRoot, { recursive: true, force: true })
      await fs.mkdir(currentDataDir, { recursive: true })
      await fs.mkdir(currentFileRoot, { recursive: true })
      await fs.mkdir(installedDataDir, { recursive: true })
      await fs.mkdir(path.join(installedRoot, 'qApps'), { recursive: true })
      await fs.mkdir(path.join(installedDataDir, 'customSkills'), { recursive: true })
      await fs.writeFile(path.join(installedDataDir, 'config.json'), '{}', 'utf8')

      process.env['LOCALAPPDATA'] = path.join(tempRoot, 'LocalAppData')

      mockConfig({})
      mockBuildEnv({
        env: {
          build: 'development'
        },
        pathMap: {
          data: currentDataDir,
          file: currentFileRoot
        }
      })
      vi.mocked(userDataDirectory.getDefaultUserDataDirectory).mockReturnValue(currentDataDir)
      vi.mocked(portablePaths.getLegacyPortableUserDataDirectory).mockReturnValue(null)

      const svcStateImpl = new StateSvcImpl()
      const response = await svcStateImpl.getStorageLocations({})

      expect(response.locations[0]).toMatchObject({
        isCurrent: true,
        kind: 'current-development',
        userDataDir: currentDataDir,
        fileRootDir: currentFileRoot
      })
      expect(response.locations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'standard-installed-pure',
            userDataDir: installedDataDir,
            configExists: true,
            qAppsExists: true,
            customSkillsExists: true
          })
        ])
      )
    } finally {
      if (oldLocalAppData === undefined) {
        delete process.env['LOCALAPPDATA']
      } else {
        process.env['LOCALAPPDATA'] = oldLocalAppData
      }

      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('should list legacy app-root user data when present', async () => {
    const tempRoot = await createNodeTestArtifactDir('state-legacy-storage')
    const currentDataDir = path.join(tempRoot, 'current-data')
    const currentFileRoot = path.join(tempRoot, 'current-root')
    const legacyRoot = path.join(tempRoot, 'Programs', 'magicpot-pure')
    const legacyDataDir = path.join(legacyRoot, 'aiengineelectron')
    const originalResourcesPath = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(legacyRoot, 'resources')
    })
    try {
      await fs.mkdir(currentDataDir, { recursive: true })
      await fs.mkdir(path.join(legacyDataDir, 'customSkills'), { recursive: true })
      await fs.writeFile(path.join(legacyDataDir, 'config.json'), '{}', 'utf8')

      mockConfig({})
      mockBuildEnv({
        env: {
          build: 'prod'
        },
        pathMap: {
          data: currentDataDir,
          file: currentFileRoot
        }
      })
      vi.mocked(userDataDirectory.getDefaultUserDataDirectory).mockReturnValue(currentDataDir)
      vi.mocked(portablePaths.getLegacyPortableUserDataDirectory).mockReturnValue(legacyDataDir)

      const svcStateImpl = new StateSvcImpl()
      const response = await svcStateImpl.getStorageLocations({})

      expect(response.locations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'legacy-app-root',
            userDataDir: legacyDataDir,
            configExists: true,
            customSkillsExists: true
          })
        ])
      )
    } finally {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: originalResourcesPath
      })
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})
