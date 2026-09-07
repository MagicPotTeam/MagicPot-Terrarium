import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ChatPrimarySelection from './ChatPrimarySelection'
import { resolveChatProfileCapabilities, type LLMReasoningEffort } from '@shared/llm'

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

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Medium' }))

    expect(onSelectReasoningEffort).toHaveBeenCalledWith('medium')
  })

  it.each([true, false])(
    'shows selectable reasoning for an opaque model in compact=%s',
    (compact) => {
      const profile = {
        id: 'channel::codex-model::team%2FAlias',
        model_name: 'team/Alias',
        call_type: 'cliproxyapi'
      }
      const capabilities = resolveChatProfileCapabilities(profile)
      const onSelect = vi.fn()
      const Harness = () => {
        const [effort, setEffort] = React.useState<LLMReasoningEffort>()
        return (
          <ChatPrimarySelection
            compact={compact}
            isAgentSkillSelected={false}
            selectedProfileId={profile.id}
            availableProfiles={[profile]}
            selectedReasoningEffort={effort}
            availableReasoningEfforts={capabilities.reasoningEfforts}
            selectedSkillLabel="unused"
            onSelectProfile={vi.fn()}
            onSelectReasoningEffort={(value) => {
              onSelect(value)
              setEffort(value)
            }}
          />
        )
      }
      render(<Harness />)
      for (const [label, value] of [
        ['Low', 'low'],
        ['Medium', 'medium'],
        ['High', 'high'],
        ['X-High', 'xhigh'],
        ['Max', 'max'],
        ['Default', undefined]
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }))
        expect(screen.queryByRole('menuitem', { name: 'Ultra' })).toBeNull()
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
          'Default',
          'Low',
          'Medium',
          'High',
          'X-High',
          'Max'
        ])
        fireEvent.click(screen.getByRole('menuitem', { name: label }))
        expect(onSelect).toHaveBeenLastCalledWith(value)
        expect(screen.getByRole('button', { name: 'Reasoning effort' }).textContent).toBe(label)
      }
    }
  )

  it('does not render Ultra from legacy selections or capability lists', () => {
    render(
      <ChatPrimarySelection
        compact
        isAgentSkillSelected={false}
        selectedProfileId="channel"
        availableProfiles={[{ id: 'channel', model_name: 'opaque-alias' }]}
        selectedReasoningEffort={'ultra' as LLMReasoningEffort}
        availableReasoningEfforts={['high', 'max', 'ultra'] as LLMReasoningEffort[]}
        selectedSkillLabel="unused"
        onSelectProfile={vi.fn()}
        onSelectReasoningEffort={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Reasoning effort' }).textContent).toBe('Max')
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Default',
      'High',
      'Max'
    ])
    expect(screen.queryByText('Ultra')).toBeNull()
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
