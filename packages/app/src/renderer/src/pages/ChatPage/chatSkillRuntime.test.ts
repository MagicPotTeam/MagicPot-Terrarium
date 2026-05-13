import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  BUILT_IN_TAGGING_SKILL_ID,
  buildBuiltInImageInterrogationSkill,
  buildBuiltInPromptTranslationSkill,
  buildBuiltInTaggingSkill
} from './builtInSkills'
import {
  resolveAssistantReplyDownloadMode,
  resolveAssistantSidecarExportEntries
} from './chatReplyDownloadUtils'
import { resolveSkillExecutionContext } from './chatTaggingExecutionUtils'
import {
  buildSystemPromptFromSkillRuntime,
  buildUserPromptFromSkillRuntime,
  resolveSkillRuntimeSpec,
  serializeSkillRuntimeSpec
} from './chatSkillRuntime'
import {
  MAGICPOT_CHAT_APPS_RESOURCE_URI,
  MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
  MAGICPOT_CORE_TOOL_NAMES
} from '@shared/app/types'

describe('chatSkillRuntime', () => {
  it('keeps legacy prompt-only skills compatible with the new runtime', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'legacy-skill',
        category: 'Ops',
        skillName: 'Legacy Skill',
        prompt: 'Use the legacy system prompt.',
        type: 'normal'
      },
      null
    )

    expect(runtime.instructions).toEqual({
      systemPrompt: 'Use the legacy system prompt.'
    })
    expect(runtime.execution).toEqual(
      expect.objectContaining({
        mode: 'inherit',
        allowHistory: true,
        outputMode: 'default',
        fallbackStrategy: 'default',
        persistSessionUrl: true
      })
    )
    expect(runtime.boundApps).toEqual([])
  })

  it('ignores prompt instructions for external agent skills', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-agent',
        category: 'Ops',
        skillName: 'Ops Agent',
        type: 'agent',
        apiAddress: 'https://example.com/agent',
        prompt: 'Legacy prompt should not be used.',
        instructions: {
          systemPrompt: 'Keep the output terse.',
          userPrompt: 'Summarize the incident.'
        }
      },
      null
    )

    expect(runtime.instructions).toEqual({})
    expect(runtime.execution).toEqual(
      expect.objectContaining({
        mode: 'inherit',
        allowHistory: true,
        outputMode: 'default',
        fallbackStrategy: 'default',
        persistSessionUrl: true
      })
    )
  })

  it('preserves finite context limits in serialized skill runtime execution', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'limited-context',
        category: 'Ops',
        skillName: 'Limited Context',
        prompt: 'Use recent context only.',
        type: 'normal',
        execution: {
          mode: 'inherit',
          allowHistory: true,
          contextMessageLimit: 5,
          persistSessionUrl: false
        }
      },
      null
    )

    expect(serializeSkillRuntimeSpec(runtime)?.execution).toEqual(
      expect.objectContaining({
        mode: 'inherit',
        allowHistory: true,
        contextMessageLimit: 5,
        persistSessionUrl: false
      })
    )
  })

  it('resolves built-in tagging as an isolated skill bound to the qapp image interrogation app', () => {
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
        usePromptTranslation: false,
        promptTranslationPrompt: '',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        useImageInterrogation: true,
        imageInterrogationProfileId: 'vision-default',
        imageInterrogationSystemPrompt: 'System {{description}}',
        imageInterrogationUserPrompt: 'User {{description}}'
      }
    } as never

    const runtime = resolveSkillRuntimeSpec(buildBuiltInTaggingSkill({ config }), config)

    expect(runtime.skill?.id).toBe(BUILT_IN_TAGGING_SKILL_ID)
    expect(runtime.execution).toEqual(
      expect.objectContaining({
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'structured',
        fallbackStrategy: 'smaller-batches',
        persistSessionUrl: false
      })
    )
    expect(runtime.boundApps).toEqual([
      expect.objectContaining({
        id: 'qapp.image-interrogation',
        transport: 'qapp'
      })
    ])
    expect(runtime.boundBindings).toEqual([
      expect.objectContaining({
        app: expect.objectContaining({ id: 'qapp.image-interrogation' }),
        toolNames: [],
        resourceUris: ['qapp.imageInterrogation.systemPrompt', 'qapp.imageInterrogation.userPrompt']
      })
    ])
    expect(buildSystemPromptFromSkillRuntime(runtime)).toContain(
      'Describe the uploaded image and produce sidecar-ready tags and caption.'
    )
    expect(buildUserPromptFromSkillRuntime(runtime)).toContain(
      'Describe the uploaded image and produce sidecar-ready tags and caption.'
    )
  })

  it('resolves explicit app bindings for custom skills', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        type: 'normal',
        prompt: '',
        instructions: {
          systemPrompt: 'Review the artifact.',
          userPrompt: 'Return only the final report.'
        },
        execution: {
          mode: 'isolated',
          outputMode: 'sidecar'
        },
        bindings: [{ appId: 'magicpot.core' }, { appId: 'mcp.github' }]
      },
      {
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
                args: ['-y', '@modelcontextprotocol/server-github'],
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
      } as never
    )

    expect(runtime.instructions).toEqual({
      systemPrompt: 'Review the artifact.',
      userPrompt: 'Return only the final report.'
    })
    expect(runtime.boundApps.map((app) => app.id)).toEqual(['magicpot.core', 'mcp.github'])
    expect(buildSystemPromptFromSkillRuntime(runtime)).toBe('Review the artifact.')
    expect(buildUserPromptFromSkillRuntime(runtime)).toBe('Return only the final report.')
    expect(runtime.unavailableBindings).toEqual([])
  })

  it('serializes runtime bindings into a request-friendly skillRuntime payload', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        type: 'normal',
        prompt: '',
        instructions: {
          systemPrompt: 'Review the artifact.',
          userPrompt: 'Return only the final report.'
        },
        execution: {
          mode: 'isolated',
          outputMode: 'structured'
        },
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' }
          }
        },
        resources: ['docs/review.md'],
        scripts: ['scripts/preflight.ts'],
        bindings: [{ appId: 'magicpot.core' }]
      },
      {
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
      } as never
    )

    expect(serializeSkillRuntimeSpec(runtime)).toEqual({
      skillId: 'ops-review',
      instructions: {
        systemPrompt: 'Review the artifact.',
        userPrompt: 'Return only the final report.'
      },
      execution: expect.objectContaining({
        mode: 'isolated',
        outputMode: 'structured'
      }),
      outputSchema: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: { type: 'string' }
        }
      },
      resources: ['docs/review.md'],
      scripts: ['scripts/preflight.ts'],
      bindings: [
        expect.objectContaining({
          appId: 'magicpot.core',
          appName: 'MagicPot Core',
          transport: 'local',
          source: 'magicpot-core',
          toolNames: [...MAGICPOT_CORE_TOOL_NAMES],
          resourceUris: [
            MAGICPOT_CHAT_APPS_RESOURCE_URI,
            MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
            'magicpot://mcp/status'
          ]
        })
      ]
    })
  })

  it('preserves explicit empty tool and resource bindings instead of falling back to all app capabilities', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        type: 'normal',
        prompt: '',
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: [],
            resourceUris: []
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
              { name: 'session.status', description: 'Describe current chat session.' },
              { name: 'session.summary', description: 'Summarize the current session.' }
            ],
            resources: [
              {
                uri: MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
                description: 'Tool catalog'
              },
              {
                uri: 'magicpot://mcp/status',
                description: 'MCP status'
              }
            ]
          }
        }
      ] as never
    )

    expect(runtime.boundBindings).toEqual([
      expect.objectContaining({
        toolNames: [],
        resourceUris: []
      })
    ])
    expect(serializeSkillRuntimeSpec(runtime)).toMatchObject({
      skillId: 'ops-review',
      execution: expect.objectContaining({
        mode: 'inherit',
        outputMode: 'default'
      }),
      bindings: [
        expect.objectContaining({
          appId: 'magicpot.core',
          toolNames: [],
          resourceUris: []
        })
      ]
    })
  })

  it('preserves explicit empty tool and resource bindings instead of expanding them to app defaults', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: 'ops-review',
        category: 'Ops',
        skillName: 'Ops Review',
        type: 'normal',
        prompt: '',
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: [],
            resourceUris: []
          }
        ]
      },
      {
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
      } as never
    )

    expect(runtime.boundBindings).toEqual([
      expect.objectContaining({
        app: expect.objectContaining({ id: 'magicpot.core' }),
        toolNames: [],
        resourceUris: []
      })
    ])
    expect(serializeSkillRuntimeSpec(runtime)?.bindings).toEqual([
      expect.objectContaining({
        appId: 'magicpot.core',
        toolNames: [],
        resourceUris: []
      })
    ])
  })

  it('treats disabled bound apps as unavailable runtime bindings', () => {
    const runtime = resolveSkillRuntimeSpec(
      {
        id: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
        category: 'Prompt Translation',
        skillName: 'Prompt Translation',
        type: 'normal',
        prompt: '',
        bindings: [{ appId: 'qapp.prompt-translation' }]
      },
      {
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
      } as never
    )

    expect(runtime.boundBindings).toEqual([])
    expect(runtime.unavailableBindings).toEqual([
      expect.objectContaining({
        appId: 'qapp.prompt-translation',
        reason: 'disabled'
      })
    ])
  })

  it('builds prompt translation instructions from explicit qapp bindings', () => {
    const runtime = resolveSkillRuntimeSpec(
      buildBuiltInPromptTranslationSkill({
        config: {
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
            promptTranslationProfileId: 'translation-model',
            useImageInterrogation: false,
            imageInterrogationPrompt: '',
            useRandomPromptGeneration: false,
            randomPromptGenerationPrompt: ''
          },
          plugin_config: {
            api_profiles: [],
            light_adjustment_prompt: '',
            usePromptTranslation: true,
            promptTranslationSystemPrompt: 'Translate this prompt.',
            promptTranslationUserPrompt: 'Return only the translated text.'
          }
        } as never
      }),
      {
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
          promptTranslationProfileId: 'translation-model',
          useImageInterrogation: false,
          imageInterrogationPrompt: '',
          useRandomPromptGeneration: false,
          randomPromptGenerationPrompt: ''
        },
        plugin_config: {
          api_profiles: [],
          light_adjustment_prompt: '',
          usePromptTranslation: true,
          promptTranslationSystemPrompt: 'Translate this prompt.',
          promptTranslationUserPrompt: 'Return only the translated text.'
        }
      } as never
    )

    expect(runtime.skill?.id).toBe(BUILT_IN_PROMPT_TRANSLATION_SKILL_ID)
    expect(buildSystemPromptFromSkillRuntime(runtime)).toBe('Translate this prompt.')
    expect(buildUserPromptFromSkillRuntime(runtime)).toBe('Return only the translated text.')
  })

  it('routes image interrogation and prompt translation through the same qapp-backed skill runtime foundation', () => {
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
        promptTranslationProfileId: 'translation-model',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        imageInterrogationProfileId: 'vision-model',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        usePromptTranslation: true,
        promptTranslationSystemPrompt: 'Translate this prompt.',
        promptTranslationUserPrompt: 'Return only the translated text.',
        promptTranslationProfileId: 'translation-model',
        useImageInterrogation: true,
        imageInterrogationSystemPrompt: 'Inspect this image.',
        imageInterrogationUserPrompt: 'Return only the inspection result.',
        imageInterrogationProfileId: 'vision-model'
      }
    } as never

    const imageRuntime = resolveSkillRuntimeSpec(
      buildBuiltInImageInterrogationSkill({ config }),
      config
    )
    const translationRuntime = resolveSkillRuntimeSpec(
      buildBuiltInPromptTranslationSkill({ config }),
      config
    )

    expect(imageRuntime.skill?.id).toBe(BUILT_IN_IMAGE_INTERROGATION_SKILL_ID)
    expect(imageRuntime.execution).toEqual(
      expect.objectContaining({
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        persistSessionUrl: false
      })
    )
    expect(buildSystemPromptFromSkillRuntime(imageRuntime)).toBe('Inspect this image.')
    expect(buildUserPromptFromSkillRuntime(imageRuntime)).toBe('Return only the inspection result.')
    expect(serializeSkillRuntimeSpec(imageRuntime)?.bindings).toEqual([
      expect.objectContaining({
        appId: 'qapp.image-interrogation',
        toolNames: [],
        resourceUris: ['qapp.imageInterrogation.systemPrompt', 'qapp.imageInterrogation.userPrompt']
      })
    ])

    expect(translationRuntime.skill?.id).toBe(BUILT_IN_PROMPT_TRANSLATION_SKILL_ID)
    expect(translationRuntime.execution).toEqual(
      expect.objectContaining({
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        persistSessionUrl: false
      })
    )
    expect(buildSystemPromptFromSkillRuntime(translationRuntime)).toBe('Translate this prompt.')
    expect(buildUserPromptFromSkillRuntime(translationRuntime)).toBe(
      'Return only the translated text.'
    )
    expect(serializeSkillRuntimeSpec(translationRuntime)?.bindings).toEqual([
      expect.objectContaining({
        appId: 'qapp.prompt-translation',
        toolNames: [],
        resourceUris: ['qapp.promptTranslation.systemPrompt', 'qapp.promptTranslation.userPrompt']
      })
    ])
  })

  it('keeps built-in tagging isolated and sidecar-oriented while reusing the same built-in runtime skeleton', () => {
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
        promptTranslationProfileId: 'translation-model',
        useImageInterrogation: true,
        imageInterrogationPrompt: '',
        imageInterrogationProfileId: 'vision-model',
        useRandomPromptGeneration: false,
        randomPromptGenerationPrompt: ''
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: '',
        usePromptTranslation: true,
        promptTranslationSystemPrompt: 'Translate this prompt.',
        promptTranslationUserPrompt: 'Return only the translated text.',
        promptTranslationProfileId: 'translation-model',
        useImageInterrogation: true,
        imageInterrogationSystemPrompt: 'Inspect this image.',
        imageInterrogationUserPrompt: 'Return only the inspection result.',
        imageInterrogationProfileId: 'vision-model'
      }
    } as never

    const taggingRuntime = resolveSkillRuntimeSpec(buildBuiltInTaggingSkill({ config }), config)
    const imageRuntime = resolveSkillRuntimeSpec(
      buildBuiltInImageInterrogationSkill({ config }),
      config
    )
    const translationRuntime = resolveSkillRuntimeSpec(
      buildBuiltInPromptTranslationSkill({ config }),
      config
    )

    expect(taggingRuntime.execution).toEqual(
      expect.objectContaining({
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'structured',
        fallbackStrategy: 'smaller-batches',
        persistSessionUrl: false
      })
    )
    expect(
      resolveSkillExecutionContext({
        skillId: BUILT_IN_TAGGING_SKILL_ID,
        sessionMessages: [{ role: 'user', content: 'history' }],
        sessionUrl: 'session-1'
      })
    ).toEqual({
      historyMessages: [],
      sessionUrl: undefined,
      shouldPersistSessionUrl: false
    })

    const taggingMessages: ChatMessage[] = [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/hero-shot.png',
            fileName: 'hero-shot.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: 'hero-shot, cinematic'
      },
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/hero-shot.png',
            fileName: 'hero-shot.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: 'hero-shot, dramatic lighting'
      }
    ]

    expect(resolveAssistantReplyDownloadMode(taggingMessages, 1, BUILT_IN_TAGGING_SKILL_ID)).toBe(
      'sidecar'
    )
    expect(
      resolveAssistantSidecarExportEntries(taggingMessages, BUILT_IN_TAGGING_SKILL_ID)
    ).toEqual([
      {
        assistantMessageIndex: 1,
        baseName: 'hero-shot',
        textContent: 'hero-shot, cinematic'
      },
      {
        assistantMessageIndex: 3,
        baseName: 'hero-shot_2',
        textContent: 'hero-shot, dramatic lighting'
      }
    ])

    expect(imageRuntime.execution).toEqual(
      expect.objectContaining({
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        persistSessionUrl: false
      })
    )
    expect(translationRuntime.execution).toEqual(
      expect.objectContaining({
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        persistSessionUrl: false
      })
    )
  })
})
