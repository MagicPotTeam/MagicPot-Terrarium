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
  it('shows an inherited member model read-only and never calls either selector', () => {
    const onSelectProfile = vi.fn(), onSelectReasoningEffort = vi.fn()
    const props = { compact: true, composerStyle: true, isAgentSkillSelected: false, selectedProfileId: 'member-stale', availableProfiles: [{ id: 'member-stale', model_name: 'Stale member model' }], selectedSkillLabel: '', onSelectProfile, onSelectReasoningEffort, availableReasoningEfforts: ['low', 'high'] as LLMReasoningEffort[] }
    const view = render(<ChatPrimarySelection {...props} memberModel={{ state: 'inherited', label: 'Lead model' }} />)
    const inherited = screen.getByRole('button', { name: 'chat.member_model_inherited' })
    expect(inherited).toBeDisabled()
    expect(screen.queryByText('Stale member model')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reasoning effort' })).toBeNull()
    fireEvent.click(inherited)
    expect(onSelectProfile).not.toHaveBeenCalled()
    expect(onSelectReasoningEffort).not.toHaveBeenCalled()
    view.rerender(<ChatPrimarySelection {...props} memberModel={{ state: 'unavailable' }} />)
    expect(screen.getByRole('button', { name: 'chat.member_model_unavailable' })).toBeDisabled()
    expect(screen.queryByText('Lead model')).toBeNull()
  })
  it('only delegates member selection through explicit opt-in and disables pending updates', () => {
    const ordinary = vi.fn(), member = vi.fn()
    const props = { compact: true, isAgentSkillSelected: false, selectedProfileId: 'base', availableProfiles: [{ id: 'base', model_name: 'Base' }, { id: 'other', model_name: 'Other' }], selectedSkillLabel: '', onSelectProfile: ordinary }
    const view = render(<ChatPrimarySelection {...props} memberModel={{ state: 'inherited', label: 'Base', onSelectProfile: member }} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_inherited' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    expect(member).toHaveBeenCalledWith('other')
    expect(ordinary).not.toHaveBeenCalled()
    view.rerender(<ChatPrimarySelection {...props} memberModel={{ state: 'selected', label: 'Other', onSelectProfile: member, pending: true }} />)
    expect(screen.getByRole('button', { name: 'chat.member_model_selected' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'chat.member_model_selected' })).toHaveAttribute('aria-busy', 'true')
  })

  it('omits caller-ineligible member models without changing ordinary profile order or delegation', () => {
    const ordinary = vi.fn(), member = vi.fn()
    const props = {
      compact: true, isAgentSkillSelected: false, selectedProfileId: 'base', selectedSkillLabel: '', onSelectProfile: ordinary,
      availableProfiles: [{ id: 'base', model_name: 'Base' }, { id: 'blocked', model_name: 'Blocked' }, { id: 'other', model_name: 'Other' }]
    }
    const view = render(<ChatPrimarySelection {...props} memberModel={{ state: 'inherited', label: 'Base', onSelectProfile: member, selectableProfileIds: ['base', 'other'] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_inherited' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Base', 'Other'])
    expect(screen.queryByRole('menuitem', { name: 'Blocked' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    expect(member).toHaveBeenCalledExactlyOnceWith('other')
    expect(ordinary).not.toHaveBeenCalled()
    view.rerender(<ChatPrimarySelection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Base' }))
    expect(screen.getByRole('menuitem', { name: 'Blocked' })).toBeInTheDocument()
  })

  it('renders member effort only with effective inputs and delegates normalized options', () => {
    const onMemberEffort = vi.fn(), ordinary = vi.fn()
    const props = { compact: true, composerStyle: true, isAgentSkillSelected: false, selectedProfileId: 'lead', availableProfiles: [{ id: 'lead', model_name: 'Lead' }], selectedSkillLabel: '', onSelectProfile: vi.fn(), onSelectReasoningEffort: ordinary }
    const memberModel = { state: 'selected' as const, label: 'Member', onSelectProfile: vi.fn() }
    const view = render(<ChatPrimarySelection {...props} memberModel={memberModel} />)
    expect(screen.getByTestId('member-model-arrow')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reasoning effort' })).toBeNull()
    const effective = { memberReasoningEffort: 'low' as LLMReasoningEffort, memberAvailableReasoningEfforts: ['low', 'high'] as LLMReasoningEffort[], onSelectMemberReasoningEffort: onMemberEffort }
    view.rerender(<ChatPrimarySelection {...props} {...effective} memberModel={memberModel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))
    expect(onMemberEffort).toHaveBeenCalledWith('high')
    expect(ordinary).not.toHaveBeenCalled()
    view.rerender(<ChatPrimarySelection {...props} {...effective} memberModel={{ ...memberModel, pending: true }} />)
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toBeDisabled()
    view.rerender(<ChatPrimarySelection {...props} {...effective} memberModel={{ state: 'unavailable' }} />)
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toBeDisabled()
  })

  it('closes a previously opened model menu when selection becomes a member', () => {
    const onSelectProfile = vi.fn()
    const props = { compact: true, isAgentSkillSelected: false, selectedProfileId: 'base', availableProfiles: [{ id: 'base', model_name: 'Base' }, { id: 'other', model_name: 'Other' }], selectedSkillLabel: '', onSelectProfile }
    const view = render(<ChatPrimarySelection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Base' }))
    expect(screen.getByRole('menuitem', { name: 'Other' })).toBeInTheDocument()
    view.rerender(<ChatPrimarySelection {...props} memberModel={{ state: 'inherited', label: 'Base' }} />)
    expect(screen.queryByRole('menuitem', { name: 'Other' })).not.toBeInTheDocument()
    view.rerender(<ChatPrimarySelection {...props} />)
    expect(screen.queryByRole('menuitem', { name: 'Other' })).not.toBeInTheDocument()
    expect(onSelectProfile).not.toHaveBeenCalled()
  })

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
