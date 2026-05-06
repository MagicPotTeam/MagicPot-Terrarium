import React from 'react'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import CustomSkillManagerPage from './CustomSkillManagerPage'

const originalWindowApi = window.api

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/custom-skill-manager' })
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'custom_workshop.attention_desc') {
        return `${options?.count ?? 0} skill(s) still need fixes before they are ready to use.`
      }

      return (
        (
          {
            'custom_workshop.custom_skill': 'Custom Skills',
            'custom_workshop.create': 'Create',
            'custom_workshop.new_skill_default': 'New Skill',
            'custom_workshop.category_empty': 'Uncategorized',
            'custom_workshop.skill_category_empty': 'No categories yet',
            'custom_workshop.create_skill_cancel': 'Cancel',
            'project.delete_confirm': 'Delete'
          } as Record<string, string>
        )[key] ?? key
      )
    },
    i18n: {
      language: 'en',
      resolvedLanguage: 'en'
    }
  })
}))

vi.mock('../../hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      llm_config: {
        customSkills: [
          {
            id: 'skill-1',
            category: 'Art',
            skillName: 'Three-view',
            prompt: 'Create a three-view sheet',
            type: 'normal',
            apiKey: '',
            apiAddress: ''
          }
        ]
      }
    },
    buildEnv: {},
    configUtils: {},
    isReady: true,
    updateConfig: vi.fn()
  })
}))

describe('CustomSkillManagerPage smoke', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcCustomSkill: {
          listCustomSkills: vi.fn(async () => ({ skills: [], categories: [] })),
          batchSaveCustomSkills: vi.fn(async () => ({}))
        },
        svcState: {
          getMcpStatus: vi.fn(async () => ({
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

  it('renders existing custom skills from llm_config without crashing', async () => {
    render(
      <ThemeProvider theme={theme}>
        <CustomSkillManagerPage />
      </ThemeProvider>
    )

    expect(await screen.findByText('Custom Skills')).toBeInTheDocument()
    expect(screen.getAllByText('Art').length).toBeGreaterThan(0)
    expect(screen.queryByText('Unified extension catalog')).toBeNull()
    expect(screen.getByTestId('custom-skill-card-skill-1')).toHaveTextContent('Three-view')
  })
})
