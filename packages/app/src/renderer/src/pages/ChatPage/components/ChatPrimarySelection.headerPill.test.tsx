import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import type { ComponentProps } from 'react'
import { theme } from '@renderer/theme'
import enLocale from '@shared/locales/en-US/renderer.json'
import zhLocale from '@shared/locales/zh-CN/renderer.json'
import type { LLMReasoningEffort } from '@shared/llm'
import ChatPrimarySelection from './ChatPrimarySelection'

// Real English strings, so the test reads what a user reads.
const translate = (key: string, options?: Record<string, unknown>) => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      enLocale
    )
  const template =
    typeof value === 'string' ? value : ((options?.defaultValue as string | undefined) ?? key)
  return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))

type Props = ComponentProps<typeof ChatPrimarySelection>
const profiles = [
  { id: 'sonnet', model_name: 'anthropic/claude-sonnet' },
  { id: 'gpt', model_name: 'openai/gpt-5.5' }
]
const efforts: LLMReasoningEffort[] = ['medium', 'high']

const renderPill = (overrides: Partial<Props> = {}) => {
  const props: Props = {
    compact: true,
    headerPill: true,
    isAgentSkillSelected: false,
    selectedProfileId: 'sonnet',
    availableProfiles: profiles,
    selectedSkillLabel: '',
    onSelectProfile: vi.fn(),
    ...overrides
  }
  const view = render(
    <ThemeProvider theme={theme}>
      <button type="button">before</button>
      <ChatPrimarySelection {...props} />
      <button type="button">after</button>
    </ThemeProvider>
  )
  return { ...view, props }
}
const pill = () => screen.getByTestId('chat-model-pill')

describe('ChatPrimarySelection header pill', () => {
  it('is one button with the model name, the effort and a chevron', () => {
    renderPill({
      selectedReasoningEffort: 'high',
      availableReasoningEfforts: efforts,
      onSelectReasoningEffort: vi.fn()
    })

    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(pill()).toHaveTextContent(/^anthropic\/claude-sonnetHigh$/)
    expect(pill()).toHaveAccessibleName('Model: anthropic/claude-sonnet, reasoning effort: High')
    expect(pill()).toHaveAttribute('aria-haspopup', 'menu')
    expect(pill()).toHaveAttribute('aria-expanded', 'false')
    expect(pill()).toHaveAttribute('title', 'anthropic/claude-sonnet')
    const [name, effort] = Array.from(pill().querySelectorAll('span'))
    expect(getComputedStyle(name).fontSize).toBe('11px')
    expect(getComputedStyle(name).fontFamily).toContain('monospace')
    expect(getComputedStyle(name).textOverflow).toBe('ellipsis')
    expect(getComputedStyle(effort).fontSize).toBe('10px')
    expect(getComputedStyle(pill()).minHeight).toBe('28px')
    expect(getComputedStyle(pill()).borderRadius).toBe('6px')
    expect(getComputedStyle(pill()).maxWidth).toBe('100%')
  })

  it('shows only the model when the profile has no reasoning efforts', () => {
    renderPill()
    expect(pill()).toHaveTextContent(/^anthropic\/claude-sonnet$/)
    expect(pill()).toHaveAccessibleName('Model: anthropic/claude-sonnet')
    expect(screen.queryByTestId('chat-model-pill-effort')).toBeNull()
  })

  it('is reached with Tab, opens its menu with Enter on the current model and gives focus back on Escape', async () => {
    const user = userEvent.setup()
    const onSelectProfile = vi.fn()
    renderPill({
      onSelectProfile,
      selectedReasoningEffort: 'high',
      availableReasoningEfforts: efforts,
      onSelectReasoningEffort: vi.fn()
    })

    await user.tab()
    await user.tab()
    expect(pill()).toHaveFocus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(pill()).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(pill().getAttribute('aria-controls') ?? '')).toContainElement(
      menu
    )
    const options = within(menu).getAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-5.5',
      'Default',
      'Medium',
      'High'
    ])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'true'
    ])
    // Two group headings that the keyboard skips.
    expect(within(menu).getByText('Model')).toBeInTheDocument()
    expect(within(menu).getByText('Reasoning effort')).toBeInTheDocument()
    await waitFor(() => expect(options[0]).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(options[2]).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(pill()).toHaveFocus()
    expect(pill()).toHaveAttribute('aria-expanded', 'false')
    expect(onSelectProfile).not.toHaveBeenCalled()

    await user.keyboard(' ')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('switches the model and the effort from the one menu', async () => {
    const user = userEvent.setup()
    const onSelectProfile = vi.fn()
    const onSelectReasoningEffort = vi.fn()
    renderPill({
      onSelectProfile,
      selectedReasoningEffort: 'high',
      availableReasoningEfforts: efforts,
      onSelectReasoningEffort
    })

    await user.click(pill())
    await user.click(await screen.findByRole('menuitemradio', { name: 'openai/gpt-5.5' }))
    expect(onSelectProfile).toHaveBeenCalledExactlyOnceWith('gpt')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(pill())
    await user.click(await screen.findByRole('menuitemradio', { name: 'Medium' }))
    expect(onSelectReasoningEffort).toHaveBeenLastCalledWith('medium')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await user.click(pill())
    await user.click(await screen.findByRole('menuitemradio', { name: 'Default' }))
    expect(onSelectReasoningEffort).toHaveBeenLastCalledWith(undefined)
    expect(onSelectProfile).toHaveBeenCalledTimes(1)
  })

  it('is disabled without a model to choose and closes when the conversation stops being active', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPill({ availableProfiles: [], selectedProfileId: null })
    expect(pill()).toBeDisabled()
    expect(pill()).toHaveTextContent('No model')
    unmount()

    const { rerender, props } = renderPill()
    await user.click(pill())
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    rerender(
      <ThemeProvider theme={theme}>
        <ChatPrimarySelection {...props} active={false} />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('reads "Inherits lead: <model>" for a member and stays read-only until the owner opts in', () => {
    const onSelectProfile = vi.fn()
    renderPill({ onSelectProfile, memberModel: { state: 'inherited', label: 'Lead model' } })

    expect(pill()).toHaveTextContent(/^Inherits lead: Lead model$/)
    expect(pill()).toHaveAccessibleName('Inherits lead: Lead model')
    expect(pill()).toBeDisabled()
    expect(screen.queryByText('anthropic/claude-sonnet')).toBeNull()
    expect(zhLocale.chat.member_model_inherited).toBe('继承组长：{{model}}')
  })

  it('lets a member choose among its selectable models and its own effort', async () => {
    const user = userEvent.setup()
    const ordinary = vi.fn()
    const member = vi.fn()
    const memberEffort = vi.fn()
    const { rerender, props } = renderPill({
      onSelectProfile: ordinary,
      availableProfiles: [...profiles, { id: 'blocked', model_name: 'Blocked' }],
      memberModel: {
        state: 'selected',
        label: 'openai/gpt-5.5',
        onSelectProfile: member,
        selectableProfileIds: ['sonnet', 'gpt']
      },
      memberReasoningEffort: null,
      memberAvailableReasoningEfforts: efforts,
      onSelectMemberReasoningEffort: memberEffort
    })

    expect(pill()).toHaveTextContent(/^Member model: openai\/gpt-5\.5Default$/)
    expect(pill()).toHaveAccessibleName('Member model: openai/gpt-5.5, reasoning effort: Default')
    await user.click(pill())
    const options = within(await screen.findByRole('menu')).getAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-5.5',
      'Default',
      'Medium',
      'High'
    ])
    expect(options[1]).toHaveAttribute('aria-checked', 'true')
    await user.click(options[0])
    expect(member).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(ordinary).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await user.click(pill())
    await user.click(await screen.findByRole('menuitemradio', { name: 'High' }))
    expect(memberEffort).toHaveBeenCalledExactlyOnceWith('high')

    // A pending save disables the pill and announces that it is busy.
    rerender(
      <ThemeProvider theme={theme}>
        <ChatPrimarySelection
          {...props}
          memberModel={{ state: 'selected', label: 'openai/gpt-5.5', pending: true }}
        />
      </ThemeProvider>
    )
    expect(pill()).toBeDisabled()
    expect(pill()).toHaveAttribute('aria-busy', 'true')
  })

  it('shows nothing for an agent skill, which brings its own model', () => {
    const { container } = renderPill({ isAgentSkillSelected: true, selectedSkillLabel: 'Poster' })
    expect(screen.queryByTestId('chat-model-pill')).toBeNull()
    expect(container).not.toHaveTextContent('Poster')
  })
})
