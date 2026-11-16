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
  { id: 'sonnet', model_name: 'anthropic/claude-sonnet', provider: 'claude' as const },
  { id: 'gpt', model_name: 'openai/gpt-5.5', provider: 'openai' as const }
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
    expect(pill()).toHaveAttribute('aria-haspopup', 'dialog')
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

  it('is reached with Tab, opens the model switcher with Enter and gives focus back on Escape', async () => {
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
    const sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    expect(pill()).toHaveAttribute('aria-expanded', 'true')
    // Search first, then the models as two-line rows (name, provider) with the one in use chosen.
    const search = within(sheet).getByRole('searchbox', { name: 'Search models…' })
    await waitFor(() => expect(search).toHaveFocus())
    const rows = within(sheet).getAllByRole('radio')
    expect(rows.map((row) => row.textContent)).toEqual([
      'anthropic/claude-sonnetclaude',
      'openai/gpt-5.5openai'
    ])
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    // The efforts of the chosen model as pill chips, the one in use pressed.
    const chips = within(
      within(sheet).getByRole('group', { name: 'Reasoning effort' })
    ).getAllByRole('button')
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
      ['Medium', 'false'],
      ['High', 'true']
    ])
    // Cancel and a Switch that waits for a change.
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(within(sheet).getByRole('button', { name: 'Switch' })).toBeDisabled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(pill()).toHaveFocus()
    expect(pill()).toHaveAttribute('aria-expanded', 'false')
    expect(onSelectProfile).not.toHaveBeenCalled()

    await user.keyboard(' ')
    expect(await screen.findByRole('dialog', { name: 'Switch model' })).toBeInTheDocument()
  })

  it('filters the models by name or provider and says when none matches', async () => {
    const user = userEvent.setup()
    renderPill()
    await user.click(pill())
    const sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    const search = within(sheet).getByRole('searchbox')
    await user.type(search, 'GPT')
    expect(
      within(sheet)
        .getAllByRole('radio')
        .map((row) => row.textContent)
    ).toEqual(['openai/gpt-5.5openai'])
    await user.clear(search)
    await user.type(search, 'nothing')
    expect(within(sheet).queryAllByRole('radio')).toHaveLength(0)
    expect(within(sheet).getByText('No matching models.')).toBeInTheDocument()
  })

  it('never shows or searches the random profile id; the second line says where the model runs', async () => {
    const user = userEvent.setup()
    const uuid = '3f2a9c1e-5b7d-4c1a-9e2f-0a1b2c3d4e5f'
    renderPill({
      selectedProfileId: uuid,
      availableProfiles: [
        { id: uuid, model_name: 'gpt-5.5', provider: 'openai' },
        { id: 'local-one', model_name: 'llama3', call_type: 'local' },
        { id: 'proxy', model_name: 'qwen-max', base_url: 'https://llm.example.test/v1' }
      ]
    })
    await user.click(pill())
    const sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    const rows = within(sheet).getAllByRole('radio')
    expect(rows.map((row) => Array.from(row.children).map((line) => line.textContent))).toEqual([
      ['gpt-5.5', 'openai'],
      ['llama3', 'local'],
      ['qwen-max', 'llm.example.test']
    ])
    expect(sheet).not.toHaveTextContent(uuid)
    const search = within(sheet).getByRole('searchbox')
    await user.type(search, '3f2a9c1e')
    expect(within(sheet).queryAllByRole('radio')).toHaveLength(0)
    await user.clear(search)
    await user.type(search, 'example')
    expect(within(sheet).getAllByRole('radio').map((row) => row.textContent)).toEqual([
      'qwen-maxllm.example.test'
    ])
  })

  it('makes the model list one Tab stop whose arrow keys choose a row', async () => {
    const user = userEvent.setup()
    renderPill({
      availableProfiles: [...profiles, { id: 'third', model_name: 'third-model', provider: 'gemini' }]
    })
    await user.click(pill())
    const sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await waitFor(() => expect(within(sheet).getByRole('searchbox')).toHaveFocus())
    const rows = () => within(sheet).getAllByRole('radio')
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1])
    await user.tab()
    expect(rows()[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(rows()[1]).toHaveFocus()
    expect(rows().map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(within(sheet).getByRole('button', { name: 'Switch' })).toBeEnabled()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(rows()[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(rows()[0]).toHaveFocus()
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1])
    // Tab leaves the list for the footer.
    await user.tab()
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('switches the model, the effort, or both, with Switch', async () => {
    const user = userEvent.setup()
    const onSelectProfile = vi.fn()
    const onSelectReasoningEffort = vi.fn()
    const onSelectProfileReasoningEffort = vi.fn()
    renderPill({
      onSelectProfile,
      selectedReasoningEffort: 'high',
      availableReasoningEfforts: efforts,
      onSelectReasoningEffort,
      onSelectProfileReasoningEffort,
      getProfileReasoning: (id) =>
        id === 'gpt' ? { efforts: ['low', 'high'], effort: 'low' } : null
    })

    // Only the effort of the model in use.
    await user.click(pill())
    let sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await user.click(within(sheet).getByRole('button', { name: 'Medium' }))
    await user.click(within(sheet).getByRole('button', { name: 'Switch' }))
    expect(onSelectReasoningEffort).toHaveBeenLastCalledWith('medium')
    expect(onSelectProfile).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Pressing the chosen effort again goes back to the default.
    await user.click(pill())
    sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await user.click(within(sheet).getByRole('button', { name: 'High' }))
    expect(within(sheet).getByRole('button', { name: 'High' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await user.click(within(sheet).getByRole('button', { name: 'Switch' }))
    expect(onSelectReasoningEffort).toHaveBeenLastCalledWith(undefined)

    // Another model shows its own efforts; its stored effort alone changes nothing extra.
    await user.click(pill())
    sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await user.click(within(sheet).getByRole('radio', { name: /openai\/gpt-5\.5/ }))
    const chips = within(within(sheet).getByRole('group')).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Low', 'High'])
    expect(within(sheet).getByRole('button', { name: 'Low' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(within(sheet).getByRole('button', { name: 'Switch' }))
    expect(onSelectProfile).toHaveBeenCalledExactlyOnceWith('gpt')
    expect(onSelectProfileReasoningEffort).not.toHaveBeenCalled()

    // Model and effort together: the effort is stored for the new model.
    await user.click(pill())
    sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await user.click(within(sheet).getByRole('radio', { name: /openai\/gpt-5\.5/ }))
    await user.click(within(sheet).getByRole('button', { name: 'High' }))
    await user.click(within(sheet).getByRole('button', { name: 'Switch' }))
    expect(onSelectProfile).toHaveBeenLastCalledWith('gpt')
    expect(onSelectProfileReasoningEffort).toHaveBeenCalledExactlyOnceWith('gpt', 'high')
    expect(onSelectReasoningEffort).toHaveBeenCalledTimes(2)
  })

  it('Cancel drops the choice', async () => {
    const user = userEvent.setup()
    const onSelectProfile = vi.fn()
    renderPill({ onSelectProfile })
    await user.click(pill())
    const sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await user.click(within(sheet).getByRole('radio', { name: /openai\/gpt-5\.5/ }))
    expect(within(sheet).getByRole('button', { name: 'Switch' })).toBeEnabled()
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pill()).toHaveFocus()
    expect(onSelectProfile).not.toHaveBeenCalled()
    // Opening again starts from the model in use.
    await user.click(pill())
    const rows = within(await screen.findByRole('dialog')).getAllByRole('radio')
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  })

  it('draws the switcher into the column overlay layer', async () => {
    const user = userEvent.setup()
    const host = document.createElement('div')
    document.body.append(host)
    try {
      renderPill({ overlayHost: host })
      await user.click(pill())
      expect(host).toContainElement(await screen.findByRole('dialog', { name: 'Switch model' }))
    } finally {
      host.remove()
    }
  })

  it('is disabled without a model to choose and closes when the conversation stops being active', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPill({ availableProfiles: [], selectedProfileId: null })
    expect(pill()).toBeDisabled()
    expect(pill()).toHaveTextContent('No model')
    unmount()

    const { rerender, props } = renderPill()
    await user.click(pill())
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    rerender(
      <ThemeProvider theme={theme}>
        <ChatPrimarySelection {...props} active={false} />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
        profileId: 'gpt',
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
    let sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    const rows = within(sheet).getAllByRole('radio')
    // No way back to inheriting: the stored member choice cannot be cleared.
    expect(rows.map((row) => row.textContent)).toEqual([
      'anthropic/claude-sonnetclaude',
      'openai/gpt-5.5openai'
    ])
    expect(rows[1]).toHaveAttribute('aria-checked', 'true')
    await user.click(rows[0])
    await user.click(within(sheet).getByRole('button', { name: 'Switch' }))
    expect(member).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(ordinary).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(pill())
    sheet = await screen.findByRole('dialog', { name: 'Switch model' })
    await user.click(within(sheet).getByRole('button', { name: 'High' }))
    await user.click(within(sheet).getByRole('button', { name: 'Switch' }))
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
