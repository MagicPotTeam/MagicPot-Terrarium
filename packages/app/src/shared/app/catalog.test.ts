import { describe, expect, it } from 'vitest'
import {
  buildMagicPotAppCatalogSnapshot,
  buildUnifiedMagicPotAppCatalog,
  buildCustomSkillAppCatalog,
  buildMagicPotAppCatalog,
  getMagicPotAppDiscoverySnapshot,
  enrichMagicPotAppCatalogWithRuntime,
  findMagicPotAppById,
  listMagicPotAppsBySource,
  listMagicPotAppsByTransport,
  QUICK_APP_IMAGE_INTERROGATION_APP_ID,
  QUICK_APP_PROMPT_TRANSLATION_APP_ID
} from './catalog'
import {
  MAGICPOT_CHAT_APPS_RESOURCE_URI,
  MAGICPOT_APP_CATALOG_SCHEMA_VERSION,
  MAGICPOT_CORE_APP_ID,
  MAGICPOT_CORE_TOOL_DESCRIPTORS,
  MAGICPOT_CORE_TOOL_NAMES
} from './types'

describe('buildMagicPotAppCatalog', () => {
  it('builds read-only custom skill catalog entries from persisted skills', () => {
    const catalog = buildCustomSkillAppCatalog([
      {
        id: 'skill-1',
        category: 'Art',
        skillName: 'Three-view',
        prompt: 'Create a three-view sheet',
        type: 'normal',
        description: 'Sketch a structured concept sheet.',
        version: 2,
        instructions: {
          systemPrompt: 'Create a three-view sheet',
          userPrompt: 'Keep it concise.'
        },
        resources: ['notes.md'],
        scripts: ['render.js'],
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: ['session.status'],
            resourceUris: ['magicpot://mcp/status']
          }
        ]
      }
    ])

    expect(catalog).toEqual([
      expect.objectContaining({
        id: 'custom-skill.skill-1',
        name: 'Three-view',
        description: 'Sketch a structured concept sheet.',
        enabled: true,
        status: 'ready',
        transport: 'local',
        source: 'custom-skill',
        configRef: {
          kind: 'customSkill',
          skillId: 'skill-1'
        },
        capabilities: expect.objectContaining({
          tools: [],
          resources: expect.arrayContaining([
            expect.objectContaining({ uri: 'magicpot://custom-skills/skill-1' }),
            expect.objectContaining({ uri: 'magicpot://custom-skills/skill-1/instructions' }),
            expect.objectContaining({ uri: 'magicpot://custom-skills/skill-1/bindings' })
          ])
        }),
        metadata: expect.objectContaining({
          skillId: 'skill-1',
          category: 'Art',
          type: 'normal',
          version: 2,
          bindingCount: 1,
          resourceCount: 1,
          scriptCount: 1,
          hasInstructions: true
        })
      })
    ])

    expect(listMagicPotAppsBySource(catalog, 'custom-skill').map((app) => app.id)).toEqual([
      'custom-skill.skill-1'
    ])
  })

  it('builds core, qapp, and MCP-backed app definitions from config', () => {
    const catalog = buildMagicPotAppCatalog({
      llm_config: {
        api_profiles: [],
        customSkills: [],
        customSkillCategories: [],
        usePromptOptimization: false,
        promptOptimizationQAppKey: '',
        promptOptimizationDefaultWidth: 1024,
        promptOptimizationDefaultHeight: 1024,
        promptOptimizationTipoModel: '',
        promptOptimizationTagLength: '',
        promptOptimizationNlLength: '',
        promptOptimizationDevice: '',
        promptOptimizationSeed: -1,
        usePromptTranslation: false,
        promptTranslationPrompt: '',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        imageInterrogationProfileId: 'vision-default',
        imageInterrogationSystemPrompt: 'system',
        imageInterrogationUserPrompt: 'user',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        useImageInterrogation: true,
        imageInterrogationProfileId: 'vision-default',
        imageInterrogationSystemPrompt: 'system',
        imageInterrogationUserPrompt: 'user'
      },
      mcp_config: {
        client: {
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'streamable-http',
              command: '',
              args: [],
              cwd: '',
              env: {},
              url: 'https://example.com/mcp',
              headers: {
                Authorization: 'Bearer abc'
              },
              toolPrefix: 'mcp.github',
              startupTimeoutMs: 15000,
              requestTimeoutMs: 60000
            }
          ]
        },
        server: {
          enabled: true,
          path: '/api/mcp',
          expose_resources: true,
          auth_required: false,
          auth_token: ''
        }
      }
    } as never)

    expect(findMagicPotAppById(catalog, MAGICPOT_CORE_APP_ID)).toEqual(
      expect.objectContaining({
        id: MAGICPOT_CORE_APP_ID,
        source: 'magicpot-core',
        transport: 'local',
        capabilities: expect.objectContaining({
          tools: expect.arrayContaining(
            MAGICPOT_CORE_TOOL_DESCRIPTORS.map((tool) => expect.objectContaining(tool))
          ),
          resources: expect.arrayContaining([
            expect.objectContaining({ uri: MAGICPOT_CHAT_APPS_RESOURCE_URI }),
            expect.objectContaining({ uri: 'magicpot://mcp/status' })
          ])
        })
      })
    )

    expect(findMagicPotAppById(catalog, MAGICPOT_CORE_APP_ID)?.capabilities.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspaces.list' }),
        expect.objectContaining({ name: 'workspace.inspect' }),
        expect.objectContaining({ name: 'workflow.inspect' }),
        expect.objectContaining({ name: 'workflow.resume' })
      ])
    )

    expect(findMagicPotAppById(catalog, QUICK_APP_IMAGE_INTERROGATION_APP_ID)).toEqual(
      expect.objectContaining({
        id: QUICK_APP_IMAGE_INTERROGATION_APP_ID,
        source: 'builtin',
        transport: 'qapp',
        enabled: true,
        configRef: {
          kind: 'qapp',
          key: 'imageInterrogation'
        },
        capabilities: expect.objectContaining({
          tools: [],
          resources: expect.arrayContaining([
            expect.objectContaining({ uri: 'qapp.imageInterrogation.systemPrompt' }),
            expect.objectContaining({ uri: 'qapp.imageInterrogation.userPrompt' })
          ])
        }),
        metadata: expect.objectContaining({
          profileId: 'vision-default'
        })
      })
    )

    expect(findMagicPotAppById(catalog, QUICK_APP_PROMPT_TRANSLATION_APP_ID)).toEqual(
      expect.objectContaining({
        id: QUICK_APP_PROMPT_TRANSLATION_APP_ID,
        source: 'builtin',
        transport: 'qapp',
        enabled: false,
        configRef: {
          kind: 'qapp',
          key: 'promptTranslation'
        },
        capabilities: expect.objectContaining({
          tools: [],
          resources: expect.arrayContaining([
            expect.objectContaining({ uri: 'qapp.promptTranslation.systemPrompt' }),
            expect.objectContaining({ uri: 'qapp.promptTranslation.userPrompt' })
          ])
        })
      })
    )

    expect(findMagicPotAppById(catalog, 'mcp.github')).toEqual(
      expect.objectContaining({
        id: 'mcp.github',
        source: 'mcp-client',
        transport: 'mcp',
        enabled: true,
        configRef: {
          kind: 'mcpClientServer',
          serverId: 'github'
        },
        metadata: expect.objectContaining({
          transport: 'streamable-http',
          toolPrefix: 'mcp.github',
          url: 'https://example.com/mcp'
        })
      })
    )
  })

  it('marks the qapp app disabled when image interrogation is turned off', () => {
    const catalog = buildMagicPotAppCatalog({
      llm_config: {
        api_profiles: [],
        customSkills: [],
        customSkillCategories: [],
        usePromptOptimization: false,
        promptOptimizationQAppKey: '',
        promptOptimizationDefaultWidth: 1024,
        promptOptimizationDefaultHeight: 1024,
        promptOptimizationTipoModel: '',
        promptOptimizationTagLength: '',
        promptOptimizationNlLength: '',
        promptOptimizationDevice: '',
        promptOptimizationSeed: -1,
        usePromptTranslation: false,
        promptTranslationPrompt: '',
        useImageInterrogation: false,
        imageInterrogationPrompt: '',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        useImageInterrogation: false
      }
    } as never)

    expect(findMagicPotAppById(catalog, QUICK_APP_IMAGE_INTERROGATION_APP_ID)).toEqual(
      expect.objectContaining({
        enabled: false,
        status: 'disabled'
      })
    )
  })

  it('enriches MCP app definitions with discovered runtime tool aliases', () => {
    const catalog = buildMagicPotAppCatalog({
      llm_config: {
        api_profiles: [],
        customSkills: [],
        customSkillCategories: [],
        usePromptOptimization: false,
        promptOptimizationQAppKey: '',
        promptOptimizationDefaultWidth: 1024,
        promptOptimizationDefaultHeight: 1024,
        promptOptimizationTipoModel: '',
        promptOptimizationTagLength: '',
        promptOptimizationNlLength: '',
        promptOptimizationDevice: '',
        promptOptimizationSeed: -1,
        usePromptTranslation: false,
        promptTranslationPrompt: '',
        useImageInterrogation: false,
        imageInterrogationPrompt: '',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        useImageInterrogation: false
      },
      mcp_config: {
        client: {
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'stdio',
              command: 'npx',
              args: [],
              cwd: '',
              env: {},
              url: '',
              headers: {},
              toolPrefix: 'mcp.github',
              startupTimeoutMs: 15000,
              requestTimeoutMs: 60000
            }
          ]
        },
        server: {
          enabled: true,
          path: '/api/mcp',
          expose_resources: true,
          auth_required: false,
          auth_token: ''
        }
      }
    } as never)

    const enriched = enrichMagicPotAppCatalogWithRuntime(catalog, {
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
        path: '/api/mcp',
        exposeResources: true,
        authRequired: false
      }
    })

    expect(findMagicPotAppById(enriched, 'mcp.github')).toEqual(
      expect.objectContaining({
        status: 'ready',
        capabilities: expect.objectContaining({
          tools: [{ name: 'mcp.github.issues.list' }, { name: 'mcp.github.pulls.list' }]
        }),
        metadata: expect.objectContaining({
          aliasPrefix: 'mcp.github',
          toolCount: 2
        })
      })
    )
  })

  it('exposes structured discovery metadata for transport, auth, and state', () => {
    const catalog = buildMagicPotAppCatalog({
      llm_config: {
        api_profiles: [],
        customSkills: [],
        customSkillCategories: [],
        usePromptOptimization: false,
        promptOptimizationQAppKey: '',
        promptOptimizationDefaultWidth: 1024,
        promptOptimizationDefaultHeight: 1024,
        promptOptimizationTipoModel: '',
        promptOptimizationTagLength: '',
        promptOptimizationNlLength: '',
        promptOptimizationDevice: '',
        promptOptimizationSeed: -1,
        usePromptTranslation: false,
        promptTranslationPrompt: '',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        imageInterrogationProfileId: 'vision-default',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        useImageInterrogation: true,
        imageInterrogationProfileId: 'vision-default',
        imageInterrogationSystemPrompt: 'system',
        imageInterrogationUserPrompt: 'user'
      },
      mcp_config: {
        client: {
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'streamable-http',
              command: '',
              args: [],
              cwd: '',
              env: {},
              url: 'https://example.com/mcp',
              headers: {
                Authorization: 'Bearer abc'
              },
              toolPrefix: 'mcp.github',
              startupTimeoutMs: 15000,
              requestTimeoutMs: 60000
            }
          ]
        },
        server: {
          enabled: true,
          path: '/api/mcp',
          expose_resources: true,
          auth_required: false,
          auth_token: ''
        }
      }
    } as never)

    const coreApp = findMagicPotAppById(catalog, 'magicpot.core')
    expect(coreApp && getMagicPotAppDiscoverySnapshot(coreApp)).toEqual(
      expect.objectContaining({
        id: 'magicpot.core',
        transport: 'local',
        status: 'ready',
        toolNames: expect.arrayContaining(['session.status', 'session.summary']),
        resourceUris: expect.arrayContaining([
          MAGICPOT_CHAT_APPS_RESOURCE_URI,
          'magicpot://mcp/status'
        ]),
        discovery: expect.objectContaining({
          transport: expect.objectContaining({
            kind: 'local',
            mode: 'builtin'
          }),
          auth: expect.objectContaining({
            kind: 'none',
            configured: false
          }),
          state: expect.objectContaining({
            enabled: true,
            status: 'ready'
          })
        })
      })
    )

    const mcpApp = findMagicPotAppById(catalog, 'mcp.github')
    expect(mcpApp && getMagicPotAppDiscoverySnapshot(mcpApp)).toEqual(
      expect.objectContaining({
        transport: 'mcp',
        discovery: expect.objectContaining({
          transport: expect.objectContaining({
            kind: 'mcp',
            mode: 'configured',
            endpoint: 'https://example.com/mcp',
            toolPrefix: 'mcp.github'
          }),
          auth: expect.objectContaining({
            kind: 'header',
            configured: true,
            labels: expect.arrayContaining(['Authorization']),
            source: 'remote'
          })
        })
      })
    )
  })

  it('filters apps by transport without losing catalog identity', () => {
    const catalog = buildMagicPotAppCatalog({
      llm_config: {
        api_profiles: [],
        customSkills: [],
        customSkillCategories: [],
        usePromptOptimization: false,
        promptOptimizationQAppKey: '',
        promptOptimizationDefaultWidth: 1024,
        promptOptimizationDefaultHeight: 1024,
        promptOptimizationTipoModel: '',
        promptOptimizationTagLength: '',
        promptOptimizationNlLength: '',
        promptOptimizationDevice: '',
        promptOptimizationSeed: -1,
        usePromptTranslation: false,
        promptTranslationPrompt: '',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        imageInterrogationProfileId: 'vision-default',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        useImageInterrogation: true,
        imageInterrogationProfileId: 'vision-default',
        imageInterrogationSystemPrompt: 'system',
        imageInterrogationUserPrompt: 'user'
      }
    } as never)

    expect(listMagicPotAppsByTransport(catalog, 'qapp').map((app) => app.id)).toEqual(
      expect.arrayContaining([
        QUICK_APP_IMAGE_INTERROGATION_APP_ID,
        QUICK_APP_PROMPT_TRANSLATION_APP_ID
      ])
    )
    expect(listMagicPotAppsByTransport(catalog, 'local').map((app) => app.id)).toEqual(
      expect.arrayContaining(['magicpot.core'])
    )
  })

  it('builds a unified, versioned app catalog snapshot', () => {
    const runtimeStatus = {
      client: {
        connections: [
          {
            id: 'github',
            aliasPrefix: 'mcp.github',
            status: 'connected' as const,
            toolCount: 1,
            toolAliases: ['mcp.github.issues.list'],
            transport: 'streamable-http' as const
          }
        ],
        discoveredToolCount: 1
      },
      server: {
        enabled: true,
        path: '/api/mcp',
        exposeResources: true,
        authRequired: false
      }
    }

    const apps = buildUnifiedMagicPotAppCatalog(
      {
        llm_config: {
          api_profiles: [],
          customSkills: [
            {
              id: 'skill-1',
              category: 'Art',
              skillName: 'Three-view',
              prompt: 'Create a three-view sheet',
              type: 'normal',
              description: 'Sketch a structured concept sheet.',
              version: 2
            }
          ],
          customSkillCategories: [],
          usePromptOptimization: false,
          promptOptimizationQAppKey: '',
          promptOptimizationDefaultWidth: 1024,
          promptOptimizationDefaultHeight: 1024,
          promptOptimizationTipoModel: '',
          promptOptimizationTagLength: '',
          promptOptimizationNlLength: '',
          promptOptimizationDevice: '',
          promptOptimizationSeed: -1,
          usePromptTranslation: false,
          promptTranslationPrompt: '',
          useImageInterrogation: true,
          imageInterrogationPrompt: '',
          imageInterrogationProfileId: 'vision-default',
          imageInterrogationSystemPrompt: 'system',
          imageInterrogationUserPrompt: 'user',
          useRandomPromptGeneration: false,
          randomPromptGenerationPrompt: ''
        },
        plugin_config: {
          api_profiles: [],
          light_adjustment_prompt: '',
          useImageInterrogation: true,
          imageInterrogationProfileId: 'vision-default',
          imageInterrogationSystemPrompt: 'system',
          imageInterrogationUserPrompt: 'user'
        },
        mcp_config: {
          client: {
            servers: [
              {
                id: 'github',
                enabled: true,
                transport: 'streamable-http',
                command: '',
                args: [],
                cwd: '',
                env: {},
                url: 'https://example.com/mcp',
                headers: {},
                toolPrefix: 'mcp.github',
                startupTimeoutMs: 15000,
                requestTimeoutMs: 60000
              }
            ]
          },
          server: {
            enabled: true,
            path: '/api/mcp',
            expose_resources: true,
            auth_required: false,
            auth_token: ''
          }
        }
      } as never,
      undefined,
      runtimeStatus
    )

    const snapshot = buildMagicPotAppCatalogSnapshot(
      {
        llm_config: {
          api_profiles: [],
          customSkills: [
            {
              id: 'skill-1',
              category: 'Art',
              skillName: 'Three-view',
              prompt: 'Create a three-view sheet',
              type: 'normal',
              description: 'Sketch a structured concept sheet.',
              version: 2
            }
          ],
          customSkillCategories: [],
          usePromptOptimization: false,
          promptOptimizationQAppKey: '',
          promptOptimizationDefaultWidth: 1024,
          promptOptimizationDefaultHeight: 1024,
          promptOptimizationTipoModel: '',
          promptOptimizationTagLength: '',
          promptOptimizationNlLength: '',
          promptOptimizationDevice: '',
          promptOptimizationSeed: -1,
          usePromptTranslation: false,
          promptTranslationPrompt: '',
          useImageInterrogation: true,
          imageInterrogationPrompt: '',
          imageInterrogationProfileId: 'vision-default',
          imageInterrogationSystemPrompt: 'system',
          imageInterrogationUserPrompt: 'user',
          useRandomPromptGeneration: false,
          randomPromptGenerationPrompt: ''
        },
        plugin_config: {
          api_profiles: [],
          light_adjustment_prompt: '',
          useImageInterrogation: true,
          imageInterrogationProfileId: 'vision-default',
          imageInterrogationSystemPrompt: 'system',
          imageInterrogationUserPrompt: 'user'
        },
        mcp_config: {
          client: {
            servers: [
              {
                id: 'github',
                enabled: true,
                transport: 'streamable-http',
                command: '',
                args: [],
                cwd: '',
                env: {},
                url: 'https://example.com/mcp',
                headers: {},
                toolPrefix: 'mcp.github',
                startupTimeoutMs: 15000,
                requestTimeoutMs: 60000
              }
            ]
          },
          server: {
            enabled: true,
            path: '/api/mcp',
            expose_resources: true,
            auth_required: false,
            auth_token: ''
          }
        }
      } as never,
      {
        runtimeStatus,
        generatedAt: '2026-04-12T12:00:00.000Z'
      }
    )

    expect(snapshot).toEqual({
      schemaVersion: MAGICPOT_APP_CATALOG_SCHEMA_VERSION,
      generatedAt: '2026-04-12T12:00:00.000Z',
      apps
    })
    expect(snapshot.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'magicpot.core' }),
        expect.objectContaining({ id: QUICK_APP_IMAGE_INTERROGATION_APP_ID }),
        expect.objectContaining({ id: 'mcp.github' }),
        expect.objectContaining({ id: 'custom-skill.skill-1' })
      ])
    )
  })
})
