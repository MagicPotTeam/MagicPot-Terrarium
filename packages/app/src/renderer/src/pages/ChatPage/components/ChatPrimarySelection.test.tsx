import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ChatPrimarySelection from './ChatPrimarySelection'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

describe('ChatPrimarySelection', () => {
  it('keeps the normal model selector for regular skills', () => {
    const onSelectProfile = vi.fn()

    render(
      <ChatPrimarySelection
        compact={false}
        isAgentSkillSelected={false}
        selectedProfileId="gpt-4o"
        availableProfiles={[
          { id: 'gpt-4o', model_name: 'GPT-4o' },
          { id: 'claude-sonnet', model_name: 'Claude Sonnet' }
        ]}
        selectedSkillLabel="unused"
        onSelectProfile={onSelectProfile}
      />
    )

    expect(screen.getByText('chat.model:')).toBeTruthy()
    const selector = screen.getByRole('button', { name: 'GPT-4o' })
    expect(selector).toBeTruthy()
    expect(screen.queryByText('chat.agent_skill_active:')).toBeNull()
    expect(screen.queryByText('chat.agent_skill_active_desc')).toBeNull()

    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Sonnet' }))

    expect(onSelectProfile).toHaveBeenCalledWith('claude-sonnet')
  }, 15000)

  it('shows a reasoning selector when the model supports multiple effort levels', () => {
    const onSelectReasoningEffort = vi.fn()

    render(
      <ChatPrimarySelection
        compact
        isAgentSkillSelected={false}
        selectedProfileId="gpt-5.4"
        availableProfiles={[{ id: 'gpt-5.4', model_name: 'GPT-5.4' }]}
        selectedReasoningEffort="high"
        availableReasoningEfforts={['low', 'medium', 'high']}
        selectedSkillLabel="unused"
        onSelectProfile={vi.fn()}
        onSelectReasoningEffort={onSelectReasoningEffort}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Medium' }))

    expect(onSelectReasoningEffort).toHaveBeenCalledWith('medium')
  })

  it('shows a read-only external-skill indicator when an agent skill is selected', () => {
    render(
      <ChatPrimarySelection
        compact={false}
        isAgentSkillSelected
        selectedProfileId="gpt-4o"
        availableProfiles={[
          { id: 'gpt-4o', model_name: 'GPT-4o' },
          { id: 'claude-sonnet', model_name: 'Claude Sonnet' }
        ]}
        selectedSkillLabel="Renderer Agent"
        onSelectProfile={vi.fn()}
      />
    )

    expect(screen.getByText('chat.agent_skill_active:')).toBeTruthy()
    expect(screen.getByText('Renderer Agent')).toBeTruthy()
    expect(screen.getByText('chat.agent_skill_active_desc')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'GPT-4o' })).toBeNull()
  })
})
