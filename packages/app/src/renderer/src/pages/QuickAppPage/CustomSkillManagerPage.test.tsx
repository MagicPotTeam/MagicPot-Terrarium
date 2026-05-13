import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import { buildBuiltInImageInterrogationSkill } from '../ChatPage/builtInSkills'
import CustomSkillManagerPage from './CustomSkillManagerPage'

const baseSkills = [
  {
    id: 'skill-1',
    category: 'Art',
    skillName: 'Three-view',
    prompt: 'Create a three-view sheet',
    type: 'normal',
    apiKey: '',
    apiAddress: ''
  },
  {
    id: 'skill-2',
    category: 'Art',
    skillName: 'Frame Motion',
    prompt: 'Plan frame-by-frame motion',
    type: 'agent',
    apiKey: 'abc',
    apiAddress: 'https://example.com/api'
  }
]

type MockConfigPatch = {
  llm_config?: {
    customSkills?: Array<Record<string, unknown>>
    customSkillCategories?: string[]
    [key: string]: unknown
  }
  plugin_config?: Record<string, unknown>
  [key: string]: unknown
}

const {
  navigateMock,
  updateConfigMock,
  listCustomSkillsMock,
  batchSaveCustomSkillsMock,
  getMcpStatusMock,
  resetConfigState,
  getConfigState,
  subscribeConfig,
  applyConfigPatch
} = vi.hoisted(() => {
  let configState = {
    llm_config: {
      customSkills: [] as Array<Record<string, unknown>>,
      customSkillCategories: [] as string[],
      useImageInterrogation: true,
      imageInterrogationProfileId: 'vision-default'
    },
    plugin_config: {
      useImageInterrogation: true,
      imageInterrogationProfileId: 'vision-default',
      imageInterrogationSystemPrompt: 'Describe {{description}} carefully.',
      imageInterrogationUserPrompt: 'Mention recognizable characters and concepts.'
    }
  }
  const listeners = new Set<() => void>()
  let fsState = {
    skills: [] as Array<Record<string, unknown>>,
    categories: [] as string[]
  }

  const cloneSkills = (skills: Array<Record<string, unknown>>) =>
    skills.map((skill) => ({ ...skill }))
  const cloneCategories = (categories: string[]) => categories.slice()
  const notify = () => listeners.forEach((listener) => listener())

  const listCustomSkillsMock = vi.fn(async () => ({
    skills: cloneSkills(fsState.skills),
    categories: cloneCategories(fsState.categories)
  }))
  const batchSaveCustomSkillsMock = vi.fn(
    async (payload: { skills: Array<Record<string, unknown>>; categories: string[] }) => {
      fsState = {
        skills: cloneSkills(payload.skills),
        categories: cloneCategories(payload.categories)
      }
      return {}
    }
  )
  const getMcpStatusMock = vi.fn(async () => ({
    client: {
      connections: [],
      discoveredToolCount: 1
    },
    server: {
      enabled: true,
      path: '/api/mcp',
      exposeResources: false,
      authRequired: false
    }
  }))

  return {
    navigateMock: vi.fn(),
    updateConfigMock: vi.fn(),
    listCustomSkillsMock,
    batchSaveCustomSkillsMock,
    getMcpStatusMock,
    resetConfigState: (skills: Array<Record<string, unknown>>) => {
      configState = {
        ...configState,
        llm_config: {
          ...configState.llm_config,
          customSkills: cloneSkills(skills),
          customSkillCategories: [
            ...new Set(
              cloneSkills(skills)
                .map((skill) => String(skill.category || '').trim())
                .filter(Boolean)
            )
          ]
        }
      }
      fsState = {
        skills: [],
        categories: []
      }
      notify()
    },
    getConfigState: () => configState,
    subscribeConfig: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    applyConfigPatch: (partial: MockConfigPatch) => {
      configState = {
        ...configState,
        ...partial,
        llm_config: {
          ...configState.llm_config,
          ...partial.llm_config,
          customSkills:
            partial.llm_config?.customSkills?.map((skill: Record<string, unknown>) => ({
              ...skill
            })) ?? configState.llm_config.customSkills,
          customSkillCategories:
            partial.llm_config?.customSkillCategories?.slice() ??
            configState.llm_config.customSkillCategories
        },
        plugin_config: {
          ...configState.plugin_config,
          ...partial.plugin_config
        }
      }
      notify()
    }
  }
})

const originalWindowApi = window.api

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ pathname: '/custom-skill-manager' })
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      (
        ({
          'custom_workshop.attention_desc': `${options?.count ?? 0} skill(s) still need fixes before they are ready to use.`,
          'custom_workshop.create_skill_title': 'Create skill',
          'custom_workshop.create_skill_cancel': 'Cancel',
          'custom_workshop.create_skill_confirm': 'Create',
          'custom_workshop.category_empty': 'Uncategorized',
          'custom_workshop.delete_skill': 'Delete skill',
          'custom_workshop.new_skill_default': 'New Skill',
          'custom_workshop.skill_untitled': 'Untitled Skill',
          'custom_workshop.prompt_collapse': 'Collapse Prompt',
          'custom_workshop.prompt_expand': 'Expand Prompt',
          'custom_workshop.skill_api_address_label': 'API Address',
          'custom_workshop.skill_api_key_label': 'API Key',
          'custom_workshop.skill_category_empty': 'No categories yet',
          'custom_workshop.skill_category_label': 'Category name',
          'custom_workshop.skill_category_helper': 'Editing the category updates this skill.',
          'custom_workshop.skill_name_empty': 'No skills in this category yet',
          'custom_workshop.skill_name_label': 'Skill name',
          'custom_workshop.skill_system_prompt_label': 'System Prompt',
          'custom_workshop.skill_user_prompt_label': 'User Prompt',
          'custom_workshop.skill_history_policy_label': 'History Policy',
          'custom_workshop.skill_output_mode_label': 'Output Mode',
          'custom_workshop.skill_fallback_strategy_label': 'Input Strategy',
          'custom_workshop.skill_session_policy_label': 'Context reference',
          'custom_workshop.skill_resources_label': 'Resources',
          'custom_workshop.skill_resources_helper': 'One resource path per line.',
          'custom_workshop.skill_scripts_label': 'Scripts',
          'custom_workshop.skill_scripts_helper': 'One script path per line.',
          'custom_workshop.skill_bound_apps_label': 'Bound Apps',
          'custom_workshop.skill_bound_apps_helper':
            'Click an app to bind or unbind it. Selected apps show their tools and resources below.',
          'custom_workshop.skill_bound_apps_empty': 'No apps are currently bound to this skill.',
          'custom_workshop.skill_type_agent': 'Agent',
          'custom_workshop.skill_type_label': 'Skill type',
          'menu.custom_app': 'Custom App',
          'project.delete_confirm': 'Delete'
        }) as Record<string, string>
      )[key] ??
      options?.defaultValue ??
      key,
    i18n: {
      language: 'en',
      resolvedLanguage: 'en'
    }
  })
}))

vi.mock('../../hooks/useConfig', async () => {
  const React = await import('react')

  return {
    useConfig: () => {
      const config = React.useSyncExternalStore(subscribeConfig, getConfigState, getConfigState)

      return {
        config,
        buildEnv: {},
        configUtils: {},
        isReady: true,
        updateConfig: async (partial: MockConfigPatch) => {
          updateConfigMock(partial)
          applyConfigPatch(partial)
        }
      }
    }
  }
})

const getPersistedSkills = () =>
  getConfigState().llm_config.customSkills as Array<Record<string, unknown>>

const createSelectableFile = (name: string, mimeType: string, path: string): File => {
  const file = new File(['mock-content'], name, { type: mimeType })
  Object.defineProperty(file, 'path', {
    configurable: true,
    value: path
  })
  return file
}

const renderPage = async () => {
  render(
    <ThemeProvider theme={theme}>
      <CustomSkillManagerPage />
    </ThemeProvider>
  )

  await screen.findByTestId('custom-skill-card-skill-1')
}

describe('CustomSkillManagerPage', () => {
  const slowTestTimeoutMs = 15000

  beforeEach(() => {
    navigateMock.mockReset()
    updateConfigMock.mockReset()
    listCustomSkillsMock.mockClear()
    batchSaveCustomSkillsMock.mockClear()
    resetConfigState(baseSkills)
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcCustomSkill: {
          listCustomSkills: listCustomSkillsMock,
          batchSaveCustomSkills: batchSaveCustomSkillsMock
        },
        svcState: {
          getMcpStatus: getMcpStatusMock
        }
      } as unknown as Window['api']
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalWindowApi
    })
  })

  it(
    'renders grouped skills without surfacing the removed tagging skill',
    async () => {
      await renderPage()

      expect(screen.getByRole('button', { name: 'Create skill' })).toBeInTheDocument()
      expect(screen.getByLabelText('Search skills')).toBeInTheDocument()
      expect(screen.queryByText('Unified extension catalog')).toBeNull()
      expect(screen.getByTestId('custom-skill-card-skill-1')).toHaveTextContent('Three-view')
      expect(screen.queryByTestId('custom-skill-card-preview-skill-1')).not.toBeInTheDocument()
      expect(screen.getAllByText('Art').length).toBeGreaterThan(0)
      expect(screen.queryByText('Tagging')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Delete skill Tagging' })).toBeNull()
    },
    slowTestTimeoutMs
  )

  it(
    'hides the removed card prompt preview even for long prompts',
    async () => {
      resetConfigState([
        {
          ...baseSkills[0],
          prompt:
            'Create a three-view sheet with front, side, and back poses, call out the silhouette changes, keep proportions stable, and add concise material notes for each view.'
        }
      ])

      await renderPage()

      expect(screen.queryByTestId('custom-skill-card-preview-skill-1')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Create a three-view sheet with front, side, and back poses')
      ).toBeNull()
    },
    slowTestTimeoutMs
  )

  it(
    'opens a repair dialog from the attention alert and jumps to the broken skill',
    async () => {
      resetConfigState([
        {
          ...baseSkills[0],
          prompt: ''
        }
      ])

      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-attention-alert'))

      const attentionDialog = await screen.findByTestId('custom-skill-attention-dialog')
      expect(attentionDialog).toHaveTextContent('Three-view')
      expect(attentionDialog).toHaveTextContent('Prompt is required.')

      fireEvent.click(within(attentionDialog).getByTestId('custom-skill-attention-item-skill-1'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(within(editDialog).getByLabelText('Skill name')).toHaveValue('Three-view')
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Skills Requiring Attention' })).toBeNull()
      )
    },
    slowTestTimeoutMs
  )

  it(
    'persists built-in image interrogation edits using the rich skill fields',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByTitle('Image Interrogation'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(
        within(editDialog).getByRole('button', { name: 'Collapse Prompt' })
      ).toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Description')).toBeNull()
      expect(within(editDialog).queryByLabelText('User Prompt')).not.toBeInTheDocument()
      expect(within(editDialog).queryByText('Bound Apps')).not.toBeInTheDocument()

      fireEvent.change(within(editDialog).getByLabelText('System Prompt'), {
        target: { value: 'tags: concise tags\\ncaption: concise caption' }
      })
      fireEvent.click(within(editDialog).getByRole('button', { name: 'Create' }))

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'builtin-image-interrogation',
              prompt:
                'tags: concise tags\\ncaption: concise caption\n\nMention recognizable characters and concepts.',
              instructions: expect.objectContaining({
                systemPrompt: 'tags: concise tags\\ncaption: concise caption'
              }),
              execution: expect.objectContaining({
                mode: 'isolated',
                outputMode: 'chat'
              }),
              bindings: expect.arrayContaining([
                expect.objectContaining({ appId: 'qapp.image-interrogation' })
              ])
            })
          ])
        )
      )

      expect(getConfigState().plugin_config?.imageInterrogationSystemPrompt).toBe(
        'tags: concise tags\\ncaption: concise caption'
      )
      expect(getConfigState().plugin_config?.imageInterrogationUserPrompt).toBe(
        'Mention recognizable characters and concepts.'
      )
      expect(
        buildBuiltInImageInterrogationSkill({ config: getConfigState() as never }).prompt
      ).toBe(
        'tags: concise tags\\ncaption: concise caption\n\nMention recognizable characters and concepts.'
      )
      expect(
        getPersistedSkills().find((skill) => skill.id === 'builtin-image-interrogation')
      ).not.toHaveProperty('builtinOrigin')
    },
    slowTestTimeoutMs
  )

  it(
    'persists the renamed simplified execution options from the edit dialog',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-2'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      const outputModeSelect = within(editDialog).getByLabelText('Output Mode')
      const outputModeOptions = within(outputModeSelect).getAllByRole(
        'option'
      ) as HTMLOptionElement[]
      expect(outputModeOptions.map((option) => option.value)).toEqual([
        'default',
        'text',
        'image',
        'video',
        'model3d'
      ])

      fireEvent.change(within(editDialog).getByLabelText('Input Strategy'), {
        target: { value: 'single-file' }
      })
      fireEvent.change(within(editDialog).getByLabelText(/Context reference/i), {
        target: { value: '0' }
      })

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-2',
              execution: expect.objectContaining({
                mode: 'isolated',
                allowHistory: false,
                fallbackStrategy: 'single-file',
                persistSessionUrl: false,
                contextMessageLimit: 0
              })
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'persists locked image and document references on the skill',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-1'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      const imageInput = within(editDialog).getByTestId(
        'custom-skill-reference-image-input'
      ) as HTMLInputElement
      const documentInput = within(editDialog).getByTestId(
        'custom-skill-reference-document-input'
      ) as HTMLInputElement

      fireEvent.change(imageInput, {
        target: {
          files: [createSelectableFile('hero.png', 'image/png', 'C:\\refs\\hero.png')]
        }
      })

      fireEvent.change(documentInput, {
        target: {
          files: [createSelectableFile('brief.pdf', 'application/pdf', 'C:\\refs\\brief.pdf')]
        }
      })

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-1',
              referenceAttachments: expect.arrayContaining([
                expect.objectContaining({
                  type: 'image',
                  fileName: 'hero.png',
                  mimeType: 'image/png',
                  url: 'file:///C:/refs/hero.png'
                }),
                expect.objectContaining({
                  type: 'file',
                  fileName: 'brief.pdf',
                  mimeType: 'application/pdf',
                  url: 'file:///C:/refs/brief.pdf'
                })
              ])
            })
          ])
        )
      )

      expect(within(editDialog).getByText(/hero\.png/i)).toBeInTheDocument()
      expect(within(editDialog).getByText(/brief\.pdf/i)).toBeInTheDocument()
    },
    slowTestTimeoutMs
  )

  it(
    'clears system prompt and locked references when switching a skill to agent',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-1'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      const imageInput = within(editDialog).getByTestId(
        'custom-skill-reference-image-input'
      ) as HTMLInputElement

      fireEvent.change(within(editDialog).getByLabelText('System Prompt'), {
        target: { value: 'Review the storyboard and keep it consistent.' }
      })
      fireEvent.change(imageInput, {
        target: {
          files: [createSelectableFile('hero.png', 'image/png', 'C:\\refs\\hero.png')]
        }
      })

      await waitFor(() => expect(within(editDialog).getByText(/hero\.png/i)).toBeInTheDocument())

      fireEvent.change(within(editDialog).getByLabelText('Skill type'), {
        target: { value: 'agent' }
      })

      await waitFor(() => expect(within(editDialog).queryByLabelText('System Prompt')).toBeNull())
      expect(within(editDialog).queryByTestId('custom-skill-reference-image-input')).toBeNull()
      expect(within(editDialog).queryByTestId('custom-skill-reference-document-input')).toBeNull()

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-1',
              type: 'agent',
              prompt: '',
              instructions: undefined,
              referenceAttachments: []
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'updates agent skill fields and execution policy from the edit dialog',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-2'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(within(editDialog).queryByLabelText('System Prompt')).toBeNull()
      expect(within(editDialog).queryByLabelText('Description')).toBeNull()
      expect(
        within(editDialog).queryByTestId('custom-skill-reference-image-input')
      ).not.toBeInTheDocument()
      expect(
        within(editDialog).queryByTestId('custom-skill-reference-document-input')
      ).not.toBeInTheDocument()
      fireEvent.change(within(editDialog).getByLabelText('Category name'), {
        target: { value: 'Ops' }
      })
      fireEvent.change(within(editDialog).getByLabelText('Skill name'), {
        target: { value: 'Motion Board' }
      })
      fireEvent.blur(within(editDialog).getByLabelText('Skill name'))
      fireEvent.change(within(editDialog).getByLabelText('API Address'), {
        target: { value: 'https://agents.example.com/motion' }
      })
      expect(within(editDialog).queryByLabelText('Session Reference')).toBeNull()
      fireEvent.change(within(editDialog).getByLabelText(/Context reference/i), {
        target: { value: '0' }
      })
      fireEvent.change(within(editDialog).getByLabelText('Output Mode'), {
        target: { value: 'image' }
      })

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-2',
              skillName: 'Motion Board',
              apiAddress: 'https://agents.example.com/motion',
              prompt: '',
              instructions: undefined,
              referenceAttachments: [],
              execution: expect.objectContaining({
                mode: 'isolated',
                allowHistory: false,
                contextMessageLimit: 0,
                outputMode: 'image'
              })
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'shows fixed context-reference options without the warning tooltip',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-2'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      const contextSelect = within(editDialog).getByLabelText(/Context reference/i)
      const options = within(contextSelect).getAllByRole('option') as HTMLOptionElement[]

      expect(options.map((option) => option.value)).toEqual(['0', '3', '5', '10', 'all'])
      expect(within(editDialog).queryByTestId('custom-skill-context-hint')).toBeNull()

      fireEvent.change(contextSelect, {
        target: { value: '5' }
      })

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-2',
              execution: expect.objectContaining({
                mode: 'inherit',
                allowHistory: true,
                contextMessageLimit: 5,
                persistSessionUrl: false
              })
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'preserves hidden advanced fields when editing visible skill settings',
    async () => {
      resetConfigState([
        baseSkills[0],
        {
          ...baseSkills[1],
          resources: ['magicpot://chat/tools'],
          scripts: ['pre:trim-text'],
          bindings: [
            {
              appId: 'magicpot.core',
              toolNames: [],
              resourceUris: []
            }
          ]
        }
      ])

      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-2'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(within(editDialog).queryByText('Bound Apps')).not.toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Resources')).not.toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Scripts')).not.toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Description')).toBeNull()

      fireEvent.change(within(editDialog).getByLabelText('API Address'), {
        target: { value: 'https://agents.example.com/keep-hidden' }
      })

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-2',
              apiAddress: 'https://agents.example.com/keep-hidden',
              resources: ['magicpot://chat/tools'],
              scripts: ['pre:trim-text'],
              bindings: expect.arrayContaining([
                expect.objectContaining({
                  appId: 'magicpot.core',
                  toolNames: [],
                  resourceUris: []
                })
              ])
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'keeps explicit empty bindings when saving without the binding editor',
    async () => {
      resetConfigState([
        ...baseSkills,
        {
          id: 'skill-empty-bindings',
          category: 'Ops',
          skillName: 'Strict Binder',
          prompt: 'Only use explicitly selected capabilities.',
          type: 'normal',
          apiKey: '',
          apiAddress: '',
          bindings: [
            {
              appId: 'magicpot.core',
              toolNames: [],
              resourceUris: []
            }
          ]
        }
      ])

      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-empty-bindings'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(within(editDialog).queryByText('Bound Apps')).not.toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Description')).toBeNull()

      fireEvent.change(within(editDialog).getByLabelText('Skill name'), {
        target: { value: 'Strict Binder Updated' }
      })
      fireEvent.click(within(editDialog).getByRole('button', { name: 'Create' }))

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'skill-empty-bindings',
              skillName: 'Strict Binder Updated',
              bindings: [
                {
                  appId: 'magicpot.core',
                  toolNames: [],
                  resourceUris: []
                }
              ]
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'creates an uncategorized skill with rich prompt fields',
    async () => {
      await renderPage()

      fireEvent.click(screen.getByRole('button', { name: 'Create skill' }))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(within(editDialog).getByLabelText('Category name')).toHaveValue('__UNCATEGORIZED__')

      fireEvent.change(within(editDialog).getByLabelText('Skill name'), {
        target: { value: 'Loose Idea' }
      })
      fireEvent.change(within(editDialog).getByLabelText('System Prompt'), {
        target: { value: 'Collect loose inspiration notes.' }
      })
      fireEvent.click(within(editDialog).getByRole('button', { name: 'Create' }))

      await waitFor(() =>
        expect(getPersistedSkills()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: '',
              skillName: 'Loose Idea',
              prompt: 'Collect loose inspiration notes.',
              instructions: expect.objectContaining({
                systemPrompt: 'Collect loose inspiration notes.'
              }),
              execution: expect.objectContaining({
                outputMode: 'default'
              })
            })
          ])
        )
      )
    },
    slowTestTimeoutMs
  )

  it(
    'hides removed advanced sections for a skill that still has legacy bindings',
    async () => {
      resetConfigState([
        ...baseSkills,
        {
          id: 'skill-missing-binding',
          category: 'Ops',
          skillName: 'Broken Binder',
          prompt: 'Use only approved capabilities.',
          type: 'normal',
          apiKey: '',
          apiAddress: '',
          bindings: [
            {
              appId: 'magicpot.core',
              toolNames: ['session.status', 'missing.tool'],
              resourceUris: ['magicpot://chat/tools', 'magicpot://missing-resource']
            }
          ]
        }
      ])

      await renderPage()

      fireEvent.click(screen.getByTestId('custom-skill-card-skill-missing-binding'))

      const editDialog = await screen.findByTestId('custom-skill-edit-dialog')
      expect(within(editDialog).queryByText('Bound Apps')).not.toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Resources')).not.toBeInTheDocument()
      expect(within(editDialog).queryByLabelText('Scripts')).not.toBeInTheDocument()
      expect(within(editDialog).getByLabelText('System Prompt')).toHaveValue(
        'Use only approved capabilities.'
      )
    },
    slowTestTimeoutMs
  )
})
