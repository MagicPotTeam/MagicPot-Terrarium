/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import ChatSkillPicker from './ChatSkillPicker'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      resolvedLanguage: 'zh-CN',
      language: 'zh-CN'
    }
  })
}))

describe('ChatSkillPicker', () => {
  it('uses the compact inline layout with labeled rows and clearer none states', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatSkillPicker
          compact
          skillCategories={['图标']}
          selectedSkillCategory="图标"
          selectedSkillId="icon-1"
          skillsForSelectedCategory={[
            {
              id: 'icon-1',
              skillName: '图标f2',
              type: 'normal'
            } as any
          ]}
          onSelectSkillCategory={vi.fn()}
          onSelectSkill={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(screen.queryByText('chat.skill')).toBeNull()
    expect(screen.queryByText('chat.skill_prompt_bound')).toBeNull()
    expect(screen.getByTestId('chat-skill-picker-compact')).toBeInTheDocument()
    expect(screen.getByText('分类')).toBeInTheDocument()
    expect(screen.getByText('技能')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '不使用' })).toBeInTheDocument()
  })
})
