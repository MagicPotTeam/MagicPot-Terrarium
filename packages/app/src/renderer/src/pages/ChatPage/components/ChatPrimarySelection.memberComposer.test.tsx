import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ChatPrimarySelection from './ChatPrimarySelection'
import type { LLMReasoningEffort } from '@shared/llm'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

// The member model selector as members get it in the product: inside the composer.
const profiles = [
  { id: 'lead', model_name: 'Lead model' },
  { id: 'blocked', model_name: 'Blocked model' },
  { id: 'other', model_name: 'Other model' }
]
const base = {
  compact: true,
  composerStyle: true,
  isAgentSkillSelected: false,
  selectedProfileId: 'lead',
  availableProfiles: profiles,
  selectedSkillLabel: ''
}
const rows = () => screen.getAllByRole('menuitem')
const marked = () =>
  rows()
    .filter((row) => row.classList.contains('Mui-selected'))
    .map((row) => row.textContent)

describe('ChatPrimarySelection member model in the composer', () => {
  it('lets a member whose model can no longer be used pick one of the offered models', () => {
    const ordinary = vi.fn()
    const member = vi.fn()
    render(
      <ChatPrimarySelection
        {...base}
        onSelectProfile={ordinary}
        memberModel={{
          state: 'unavailable',
          onSelectProfile: member,
          selectableProfileIds: ['lead', 'other']
        }}
      />
    )
    const button = screen.getByRole('button', { name: 'chat.member_model_unavailable' })
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('chat.member_model_unavailable')
    fireEvent.click(button)
    expect(rows().map((row) => row.textContent)).toEqual(['Lead model', 'Other model'])
    // Nothing is in use, so nothing is marked and nothing is picked for the person.
    expect(marked()).toEqual([])
    expect(member).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other model' }))
    expect(member).toHaveBeenCalledExactlyOnceWith('other')
    expect(ordinary).not.toHaveBeenCalled()
  })

  it.each([
    ['without the callback', {}],
    ['while disabled', { disabled: true }],
    ['while a pick is pending', { pending: true }]
  ])('keeps an unavailable member model read-only %s', (_case, extra) => {
    const member = vi.fn()
    render(
      <ChatPrimarySelection
        {...base}
        onSelectProfile={vi.fn()}
        memberModel={{
          state: 'unavailable',
          ...('disabled' in extra || 'pending' in extra ? { onSelectProfile: member } : {}),
          ...extra
        }}
      />
    )
    const button = screen.getByRole('button', { name: 'chat.member_model_unavailable' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(member).not.toHaveBeenCalled()
  })

  it('keeps an unavailable member model read-only in an inactive pane', () => {
    const member = vi.fn()
    render(
      <ChatPrimarySelection
        {...base}
        active={false}
        onSelectProfile={vi.fn()}
        memberModel={{ state: 'unavailable', onSelectProfile: member }}
      />
    )
    expect(screen.getByRole('button', { name: 'chat.member_model_unavailable' })).toBeDisabled()
  })

  it('offers no reasoning effort for a member whose model can no longer be used', () => {
    render(
      <ChatPrimarySelection
        {...base}
        onSelectProfile={vi.fn()}
        memberReasoningEffort={null}
        memberAvailableReasoningEfforts={['low', 'high'] as LLMReasoningEffort[]}
        onSelectMemberReasoningEffort={vi.fn()}
        memberModel={{ state: 'unavailable', onSelectProfile: vi.fn() }}
      />
    )
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toBeDisabled()
  })

  it('marks the model in use and does not store the own choice again', () => {
    const member = vi.fn()
    render(
      <ChatPrimarySelection
        {...base}
        onSelectProfile={vi.fn()}
        memberModel={{
          state: 'selected',
          label: 'Other model',
          profileId: 'other',
          onSelectProfile: member,
          selectableProfileIds: ['lead', 'other']
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
    expect(marked()).toEqual(['Other model'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other model' }))
    expect(member).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Lead model' }))
    expect(member).toHaveBeenCalledExactlyOnceWith('lead')
  })

  it("marks the lead's model of an inheriting member; picking it stores an explicit choice", () => {
    const member = vi.fn()
    render(
      <ChatPrimarySelection
        {...base}
        onSelectProfile={vi.fn()}
        memberModel={{
          state: 'inherited',
          label: 'Lead model',
          profileId: 'lead',
          onSelectProfile: member,
          selectableProfileIds: ['lead', 'other']
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_inherited' }))
    expect(marked()).toEqual(['Lead model'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lead model' }))
    expect(member).toHaveBeenCalledExactlyOnceWith('lead')
  })
})
