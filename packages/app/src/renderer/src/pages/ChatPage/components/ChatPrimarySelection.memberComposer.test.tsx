import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ChatPrimarySelection from './ChatPrimarySelection'
import type { LLMReasoningEffort } from '@shared/llm'
import enUS from '@shared/locales/en-US/renderer.json'
import zhCN from '@shared/locales/zh-CN/renderer.json'

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
// The rows are one radio group: the row in use is checked for a screen reader and tinted (MUI's
// selected state) on screen, and the two always agree.
const rows = () => screen.getAllByRole('menuitemradio')
const marked = () => {
  for (const row of rows()) expect(['true', 'false']).toContain(row.getAttribute('aria-checked'))
  const checked = rows().filter((row) => row.getAttribute('aria-checked') === 'true')
  expect(rows().filter((row) => row.classList.contains('Mui-selected'))).toEqual(checked)
  expect(screen.queryAllByRole('menuitemradio', { checked: true })).toEqual(checked)
  expect(screen.queryAllByRole('menuitem')).toEqual([])
  return checked.map((row) => row.textContent)
}

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
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other model' }))
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
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other model' }))
    expect(member).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Lead model' })
    )
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
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Lead model' }))
    expect(member).toHaveBeenCalledExactlyOnceWith('lead')
  })

  describe('the inherit-lead row', () => {
    const inheritLead = (onSelect?: () => void) => ({
      profileId: 'lead',
      modelName: 'Lead model',
      ...(onSelect ? { onSelect } : {})
    })
    const inheritRow = () => rows()[0]

    it('comes first with the label and the lead model, marked while the member inherits', () => {
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
            selectableProfileIds: ['lead', 'other'],
            inheritLead: inheritLead()
          }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_inherited' }))
      expect(rows().map((row) => row.textContent)).toEqual([
        'chat.member_model_inheritLead model',
        'Lead model',
        'Other model'
      ])
      expect(within(inheritRow()).getByText('chat.member_model_inherit')).toBeInTheDocument()
      expect(within(inheritRow()).getByText('Lead model')).toBeInTheDocument()
      // The member inherits: the row is the one in use, not the lead's model row.
      expect(marked()).toEqual(['chat.member_model_inheritLead model'])
      expect(inheritRow()).toHaveFocus()
      // Already in use: choosing it changes nothing.
      fireEvent.click(inheritRow())
      expect(member).not.toHaveBeenCalled()
      // The lead's own model row still stores an explicit choice.
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_inherited' }))
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Lead model' }))
      expect(member).toHaveBeenCalledExactlyOnceWith('lead')
    })

    it.each(['selected', 'unavailable'] as const)(
      'clears a %s member choice once and hands no profile id on',
      (state) => {
        const ordinary = vi.fn()
        const member = vi.fn()
        const inherit = vi.fn()
        const effort = vi.fn()
        render(
          <ChatPrimarySelection
            {...base}
            onSelectProfile={ordinary}
            onSelectProfileReasoningEffort={effort}
            memberModel={{
              ...(state === 'selected'
                ? { state, label: 'Other model', profileId: 'other' }
                : { state }),
              onSelectProfile: member,
              selectableProfileIds: ['lead', 'other'],
              inheritLead: inheritLead(inherit)
            }}
          />
        )
        fireEvent.click(screen.getByRole('button', { name: `chat.member_model_${state}` }))
        expect(marked()).toEqual(state === 'selected' ? ['Other model'] : [])
        fireEvent.click(inheritRow())
        expect(inherit).toHaveBeenCalledTimes(1)
        expect(member).not.toHaveBeenCalled()
        expect(ordinary).not.toHaveBeenCalled()
        expect(effort).not.toHaveBeenCalled()
        expect(screen.queryByRole('menu')).toBeNull()
      }
    )

    it('is reached with the arrow keys', () => {
      render(
        <ChatPrimarySelection
          {...base}
          onSelectProfile={vi.fn()}
          memberModel={{
            state: 'selected',
            label: 'Other model',
            profileId: 'other',
            onSelectProfile: vi.fn(),
            selectableProfileIds: ['lead', 'other'],
            inheritLead: inheritLead(vi.fn())
          }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
      const other = screen.getByRole('menuitemradio', { name: 'Other model' })
      expect(other).toHaveFocus()
      fireEvent.keyDown(other, { key: 'ArrowDown' })
      expect(inheritRow()).toHaveFocus()
      fireEvent.keyDown(inheritRow(), { key: 'ArrowDown' })
      expect(screen.getByRole('menuitemradio', { name: 'Lead model' })).toHaveFocus()
      fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Lead model' }), {
        key: 'ArrowUp'
      })
      expect(inheritRow()).toHaveFocus()
    })

    it('cannot be confused with a model whose id looks like the row', () => {
      const member = vi.fn()
      const inherit = vi.fn()
      const lookalikes = [
        { id: 'inherit-lead', model_name: 'Lookalike one' },
        { id: 'profile:inherit-lead', model_name: 'Lookalike two' }
      ]
      render(
        <ChatPrimarySelection
          {...base}
          availableProfiles={[...profiles, ...lookalikes]}
          onSelectProfile={vi.fn()}
          memberModel={{
            state: 'selected',
            label: 'Other model',
            profileId: 'other',
            onSelectProfile: member,
            inheritLead: inheritLead(inherit)
          }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
      expect(rows()).toHaveLength(6)
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Lookalike one' }))
      expect(member).toHaveBeenCalledExactlyOnceWith('inherit-lead')
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Lookalike two' }))
      expect(member).toHaveBeenLastCalledWith('profile:inherit-lead')
      expect(inherit).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
      fireEvent.click(inheritRow())
      expect(inherit).toHaveBeenCalledTimes(1)
      expect(member).toHaveBeenCalledTimes(2)
    })

    it('is absent without the lead model, and the pill texts stay as they were', () => {
      render(
        <ChatPrimarySelection
          {...base}
          onSelectProfile={vi.fn()}
          memberModel={{
            state: 'selected',
            label: 'Other model',
            profileId: 'other',
            onSelectProfile: vi.fn(),
            selectableProfileIds: ['lead', 'other']
          }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'chat.member_model_selected' }))
      expect(rows().map((row) => row.textContent)).toEqual(['Lead model', 'Other model'])
    })

    it('has its label in both languages', () => {
      expect(enUS.chat.member_model_inherit).toBe('Inherit lead')
      expect(zhCN.chat.member_model_inherit).toBe('继承组长')
    })
  })
})
