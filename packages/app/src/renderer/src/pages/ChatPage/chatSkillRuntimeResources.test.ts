import { describe, expect, it, vi } from 'vitest'
import { MAGICPOT_CHAT_TOOLS_RESOURCE_URI } from '@shared/app/types'
import { resolveSkillRuntimeSpec } from './chatSkillRuntime'
import {
  buildSkillRuntimeResourceContext,
  resolveSkillRuntimeResourceEntries
} from './chatSkillRuntimeResources'

describe('chatSkillRuntimeResources', () => {
  const createMinimalConfig = () =>
    ({
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
        usePromptTranslation: false,
        useImageInterrogation: false
      }
    }) as never

  it('loads qapp and local file resources into execution context', async () => {
    const config = {
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
        usePromptTranslation: true,
        promptTranslationPrompt: '',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        usePromptTranslation: true,
        promptTranslationSystemPrompt: 'Translate system',
        promptTranslationUserPrompt: 'Translate user',
        useImageInterrogation: true,
        imageInterrogationSystemPrompt: 'Interrogate system',
        imageInterrogationUserPrompt: 'Interrogate user'
      }
    } as never

    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        prompt: '',
        type: 'normal',
        resources: ['C:\\tmp\\rules.md'],
        bindings: [{ appId: 'qapp.prompt-translation' }]
      },
      config
    )

    const resources = await resolveSkillRuntimeResourceEntries({
      runtime,
      config,
      runtimeApps: [],
      readTextFile: vi.fn().mockResolvedValue('# Local Rules')
    })

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'C:\\tmp\\rules.md',
          content: '# Local Rules',
          source: 'skill',
          status: 'resolved',
          resolutionKind: 'file'
        }),
        expect.objectContaining({
          key: 'qapp.promptTranslation.systemPrompt',
          content: 'Translate system',
          source: 'binding',
          status: 'resolved',
          resolutionKind: 'qapp-setting'
        }),
        expect.objectContaining({
          key: 'qapp.promptTranslation.userPrompt',
          content: 'Translate user',
          source: 'binding',
          status: 'resolved',
          resolutionKind: 'qapp-setting'
        })
      ])
    )

    expect(buildSkillRuntimeResourceContext(resources)).toContain(
      'Loaded skill resources (resolved=3, missing=0, failed=0):'
    )
    expect(buildSkillRuntimeResourceContext(resources)).toContain(
      '--- rules.md [skill; file; resolved] ---'
    )
  })

  it('surfaces missing and failed resource resolutions as governed runtime metadata', async () => {
    const config = {
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
        usePromptTranslation: true,
        promptTranslationPrompt: '',
        useImageInterrogation: false,
        imageInterrogationPrompt: '',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        usePromptTranslation: true,
        promptTranslationSystemPrompt: '',
        promptTranslationUserPrompt: ''
      }
    } as never

    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        prompt: '',
        type: 'normal',
        resources: ['C:\\tmp\\missing.md', 'qapp.promptTranslation.unavailableSetting']
      },
      config
    )

    const resources = await resolveSkillRuntimeResourceEntries({
      runtime,
      config,
      readTextFile: vi.fn().mockRejectedValue(new Error('disk offline'))
    })

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'C:\\tmp\\missing.md',
          status: 'failed',
          resolutionKind: 'file',
          resolutionDetails: 'disk offline'
        }),
        expect.objectContaining({
          key: 'qapp.promptTranslation.unavailableSetting',
          status: 'missing',
          resolutionKind: 'qapp-setting'
        })
      ])
    )

    expect(buildSkillRuntimeResourceContext(resources)).toContain(
      'Loaded skill resources (resolved=0, missing=1, failed=1):'
    )
    expect(buildSkillRuntimeResourceContext(resources)).toContain(
      'qapp.promptTranslation.unavailableSetting [skill; qapp-setting; missing]'
    )
  })

  it('governs runtime tool-catalog resources by the current skill bindings', async () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        prompt: '',
        type: 'normal',
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: ['session.status'],
            resourceUris: [MAGICPOT_CHAT_TOOLS_RESOURCE_URI]
          }
        ]
      },
      null,
      [
        {
          id: 'magicpot.core',
          name: 'MagicPot Core',
          description: 'Core runtime tools.',
          source: 'magicpot-core',
          transport: 'local',
          enabled: true,
          status: 'ready',
          capabilities: {
            tools: [
              { name: 'session.status', description: 'Describe the current chat session.' },
              { name: 'session.summary', description: 'Summarize the session.' }
            ],
            resources: [{ uri: MAGICPOT_CHAT_TOOLS_RESOURCE_URI }]
          }
        }
      ] as never
    )

    const resources = await resolveSkillRuntimeResourceEntries({
      runtime,
      config: createMinimalConfig(),
      runtimeApps: runtime.boundApps
    })

    expect(resources).toEqual([
      expect.objectContaining({
        key: MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
        source: 'binding',
        status: 'resolved',
        resolutionKind: 'runtime-app-catalog',
        resolutionDetails: 'boundApps=1; boundTools=1',
        content:
          'MagicPot Core (magicpot.core): session.status - Describe the current chat session.'
      })
    ])
    expect(resources[0]?.content).not.toContain('session.summary')
  })

  it('treats the runtime app catalog as missing when no tools are bound', async () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        prompt: '',
        type: 'normal',
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: [],
            resourceUris: [MAGICPOT_CHAT_TOOLS_RESOURCE_URI]
          }
        ]
      },
      null,
      [
        {
          id: 'magicpot.core',
          name: 'MagicPot Core',
          description: 'Core runtime tools.',
          source: 'magicpot-core',
          transport: 'local',
          enabled: true,
          status: 'ready',
          capabilities: {
            tools: [{ name: 'session.status', description: 'Describe the current chat session.' }],
            resources: [{ uri: MAGICPOT_CHAT_TOOLS_RESOURCE_URI }]
          }
        }
      ] as never
    )

    const resources = await resolveSkillRuntimeResourceEntries({
      runtime,
      config: createMinimalConfig(),
      runtimeApps: runtime.boundApps
    })

    expect(resources).toEqual([
      expect.objectContaining({
        key: MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
        status: 'missing',
        resolutionKind: 'runtime-app-catalog'
      })
    ])
  })

  it('limits MCP runtime status exposure to bound MCP connections only', async () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        prompt: '',
        type: 'normal',
        bindings: [
          {
            appId: 'mcp.github',
            toolNames: [],
            resourceUris: ['magicpot://mcp/status']
          }
        ]
      },
      null,
      [
        {
          id: 'mcp.github',
          name: 'GitHub MCP',
          description: 'GitHub tools.',
          source: 'mcp-client',
          transport: 'mcp',
          enabled: true,
          status: 'ready',
          configRef: {
            kind: 'mcpClientServer',
            serverId: 'github'
          },
          capabilities: {
            tools: [{ name: 'mcp.github.issues.list', description: 'List issues.' }],
            resources: []
          }
        }
      ] as never
    )

    const governedRuntime = {
      ...runtime,
      resources: ['magicpot://mcp/status'],
      boundBindings: [
        {
          app: {
            id: 'mcp.github',
            name: 'GitHub MCP',
            description: 'GitHub tools.',
            source: 'mcp-client',
            transport: 'mcp',
            enabled: true,
            status: 'ready',
            configRef: {
              kind: 'mcpClientServer',
              serverId: 'github'
            },
            capabilities: {
              tools: [{ name: 'mcp.github.issues.list', description: 'List issues.' }],
              resources: []
            }
          },
          toolNames: [],
          resourceUris: ['magicpot://mcp/status']
        }
      ]
    } as never

    const resources = await resolveSkillRuntimeResourceEntries({
      runtime: governedRuntime,
      config: createMinimalConfig(),
      runtimeMcpStatus: {
        client: {
          connections: [
            {
              id: 'github',
              aliasPrefix: 'mcp.github',
              status: 'connected',
              toolCount: 1,
              toolAliases: ['mcp.github.issues.list'],
              transport: 'stdio'
            },
            {
              id: 'other',
              aliasPrefix: 'mcp.other',
              status: 'connected',
              toolCount: 1,
              toolAliases: ['mcp.other.tasks.list'],
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
      }
    })

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'magicpot://mcp/status',
          status: 'resolved',
          resolutionKind: 'runtime-mcp-status',
          resolutionDetails: 'connections=1',
          content: 'github: status=connected; prefix=mcp.github; tools=mcp.github.issues.list'
        })
      ])
    )
    expect(resources[0]?.content).not.toContain('mcp.other')
  })
})
