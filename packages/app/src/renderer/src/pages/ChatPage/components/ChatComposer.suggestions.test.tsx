import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { useRef, useState } from 'react'
import { theme } from '@renderer/theme'
import enLocale from '@shared/locales/en-US/renderer.json'
import ChatComposer from './ChatComposer'
import { listComposerCommands, type ComposerCommand } from '../composerCommandCatalog'
import type { ComposerSkillSuggestion } from '../composerSuggestions'

// Real English strings, so the test reads what a user reads.
const translate = (key: string, options?: Record<string, unknown>) => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      enLocale
    )
  return typeof value === 'string' ? value : ((options?.defaultValue as string | undefined) ?? key)
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))

const threadCommands = listComposerCommands({
  remote: false,
  canvasThread: true,
  scratchpad: true,
  boundTools: false,
  teamMember: false
})
function Harness({
  initialValue = '',
  commands,
  skills,
  onSelectSkill,
  onSend = vi.fn(),
  disabled = false
}: {
  initialValue?: string
  commands?: readonly ComposerCommand[]
  skills?: readonly ComposerSkillSuggestion[]
  onSelectSkill?: (skillId: string) => void
  onSend?: () => void
  disabled?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  return (
    <ThemeProvider theme={theme}>
      <ChatComposer
        inputValue={value}
        onInputChange={setValue}
        onSend={onSend}
        onUploadFile={vi.fn()}
        pendingAttachments={[]}
        uploadProgress={{}}
        onRemoveAttachment={vi.fn()}
        isLoading={false}
        onStopGenerating={vi.fn()}
        disabled={disabled}
        composerInputRef={inputRef}
        onPreviewImage={vi.fn()}
        suggestionCommands={commands}
        suggestionSkills={skills}
        onSelectSuggestedSkill={onSelectSkill}
      />
      <button type="button">elsewhere</button>
    </ThemeProvider>
  )
}

const input = () => screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
const list = () => screen.queryByRole('listbox')
const optionLabels = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent)
const activeOption = () =>
  document.getElementById(input().getAttribute('aria-activedescendant') ?? '')

async function typeInto(text: string) {
  const user = userEvent.setup()
  await user.click(input())
  if (text) await user.keyboard(text)
  return user
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ChatComposer slash-command suggestions', () => {
  it('lists the available commands above the composer when "/" is typed and keeps focus in the textarea', async () => {
    render(<Harness commands={threadCommands} />)
    expect(list()).toBeNull()
    expect(input()).not.toHaveAttribute('aria-expanded')
    await typeInto('/')

    const listbox = screen.getByRole('listbox', { name: 'Commands' })
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(threadCommands.length)
    expect(options[0]).toHaveTextContent('/goal')
    expect(options[0]).toHaveTextContent('Set, show or clear the current goal')
    expect(options[1]).toHaveTextContent('/status')
    expect(options[1]).toHaveTextContent('Show conversation status')
    expect(within(listbox).getByRole('option', { name: /\/btw/ })).toHaveTextContent(
      '/btw<question>Ask a private side question'
    )
    expect(within(listbox).getByRole('option', { name: /\/edit/ })).toHaveTextContent(
      '<number> <text>'
    )
    // The list is a sibling placed above the input card, never inside the typed text.
    expect(listbox.compareDocumentPosition(input()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(listbox.contains(input())).toBe(false)

    expect(document.activeElement).toBe(input())
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    expect(input()).toHaveAttribute('aria-controls', listbox.id)
    expect(input()).toHaveAttribute('aria-autocomplete', 'list')
    expect(activeOption()).toBe(options[0])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('filters by the typed prefix without regard to case and shows an alias only for its own prefix', async () => {
    render(<Harness commands={threadCommands} />)
    const user = await typeInto('/CO')
    expect(optionLabels()).toEqual(['/compactCompress the context'])
    await user.keyboard('{Backspace}{Backspace}pa')
    expect(optionLabels()).toEqual(['/padView working notes'])
    await user.keyboard('{Backspace}{Backspace}zzz')
    expect(list()).toBeNull()
    expect(input()).not.toHaveAttribute('aria-activedescendant')
  })

  it('moves the highlight with the arrow keys, wraps, and scrolls the highlighted option into view', async () => {
    const rowHeight = 28
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute('role') === 'option'
        ? 4 + rowHeight * Array.from(this.parentElement!.children).indexOf(this)
        : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute('role') === 'option' ? rowHeight : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute('role') === 'listbox' ? 100 : 0
    })
    render(<Harness commands={threadCommands} />)
    const user = await typeInto('/')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(screen.getByRole('listbox').scrollTop).toBe(0)

    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toBe(options[1])
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('listbox').scrollTop).toBe(0)
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(activeOption()).toBe(options[4])
    // Option 4 ends at 4 + 5 * 28 = 144 (+4 padding); the 100 px list must scroll to show it.
    expect(screen.getByRole('listbox').scrollTop).toBe(48)
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}')
    expect(activeOption()).toBe(options[0])
    expect(screen.getByRole('listbox').scrollTop).toBe(0)
    await user.keyboard('{ArrowUp}')
    expect(activeOption()).toBe(options[options.length - 1])
    expect(screen.getByRole('listbox').scrollTop).toBe(4 + rowHeight * options.length + 4 - 100)
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toBe(options[0])
    // Arrow keys never move the caret out of the token while the list is open.
    expect(input().value).toBe('/')
  })

  it('starts again at the first option when the query changes or the list reopens', async () => {
    render(<Harness commands={threadCommands} />)
    const user = await typeInto('/')
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(activeOption()).toHaveTextContent('/compact')
    await user.keyboard('s')
    expect(activeOption()).toHaveTextContent('/status')
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toHaveTextContent('/skill')
    await user.keyboard('{Backspace}')
    expect(activeOption()).toHaveTextContent('/goal')
    // Hovering highlights an option; closing and reopening the same query forgets it.
    fireEvent.mouseMove(
      within(screen.getByRole('listbox')).getByRole('option', { name: /\/regen/ })
    )
    expect(activeOption()).toHaveTextContent('/regen')
    await user.keyboard('{Escape}x{Backspace}')
    expect(activeOption()).toHaveTextContent('/goal')
  })

  it('accepts with Enter without sending, then sends on the next Enter', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('/co')
    await user.keyboard('{Enter}')
    expect(input().value).toBe('/compact')
    expect(onSend).not.toHaveBeenCalled()
    expect(list()).toBeNull()
    expect(input()).not.toHaveAttribute('aria-expanded')
    expect(document.activeElement).toBe(input())
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('/compact')
  })

  it('accepts the highlighted command with Tab and adds a space when it takes arguments', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('/')
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Tab}')
    expect(input().value).toBe('/btw ')
    expect(input().selectionStart).toBe(5)
    expect(document.activeElement).toBe(input())
    expect(list()).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
    await user.keyboard('why')
    expect(input().value).toBe('/btw why')
    expect(list()).toBeNull()
  })

  it('accepts on click without moving focus out of the textarea', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('/')
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: /\/jobs/ })
    // A real mouse press must not blur the textarea.
    expect(fireEvent.mouseDown(option)).toBe(false)
    await user.click(option)
    expect(input().value).toBe('/jobs')
    expect(document.activeElement).toBe(input())
    expect(list()).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('closes on Escape without clearing the text, restores plain Enter, and reopens on the next edit', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('/st')
    expect(optionLabels()).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(list()).toBeNull()
    expect(input().value).toBe('/st')
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('/st')
    await user.keyboard('a')
    expect(optionLabels()).toEqual(['/statusShow conversation status'])
  })

  it('still runs a command typed in full with a single Enter', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('/status')
    expect(optionLabels()).toEqual(['/statusShow conversation status'])
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('/status')
  })

  it('never accepts or sends while an IME composition is active', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    await typeInto('/co')
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input(), { key: 'Tab', keyCode: 229 })
    fireEvent.compositionStart(input())
    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input().value).toBe('/co')
    expect(onSend).not.toHaveBeenCalled()
    expect(optionLabels()).toHaveLength(1)
    fireEvent.compositionEnd(input())
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('/compact')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('leaves Enter exactly as before when there is nothing to suggest', async () => {
    const onSend = vi.fn()
    const { unmount } = render(<Harness commands={threadCommands} onSend={onSend} />)
    let user = await typeInto('/zzz')
    expect(list()).toBeNull()
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    await user.keyboard('{Backspace}{Backspace}{Backspace}btw why')
    expect(list()).toBeNull()
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(2)
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onSend).toHaveBeenCalledTimes(2)
    unmount()

    // A composer that is given no commands (other pages, unloaded conversation) suggests nothing.
    render(<Harness onSend={onSend} />)
    user = await typeInto('/')
    expect(list()).toBeNull()
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(3)
    expect(input().value).toBe('/')
  })

  it('hides the list when the textarea loses focus or the composer is disabled', async () => {
    const { rerender } = render(<Harness initialValue="/co" commands={threadCommands} />)
    // A restored draft does not pop the list open before the user is in the field.
    expect(list()).toBeNull()
    const user = await typeInto('')
    expect(optionLabels()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(list()).toBeNull()
    expect(input().value).toBe('/co')
    await user.click(input())
    expect(optionLabels()).toHaveLength(1)
    rerender(<Harness initialValue="/co" commands={threadCommands} disabled />)
    expect(list()).toBeNull()
  })
})

describe('ChatComposer skill suggestions in the Agent column', () => {
  const skills: ComposerSkillSuggestion[] = [
    { id: 'skill-poster', name: '海报设计', description: '设计活动海报' },
    { id: 'skill-review', name: 'code-review', description: 'Review the diff' }
  ]
  const headings = () =>
    screen.getAllByTestId('chat-composer-suggestion-heading').map((heading) => heading.textContent)

  it('lists commands then skills under two non-selectable headings', async () => {
    render(<Harness commands={threadCommands} skills={skills} />)
    await typeInto('/')
    const listbox = screen.getByRole('listbox', { name: 'Available commands and skills' })
    expect(headings()).toEqual(['Commands', 'Skills'])
    for (const heading of screen.getAllByTestId('chat-composer-suggestion-heading')) {
      expect(heading).not.toHaveAttribute('role')
      expect(heading).toHaveAttribute('aria-hidden', 'true')
      const style = getComputedStyle(heading)
      expect([style.fontSize, style.fontWeight, style.textTransform]).toEqual([
        '10px',
        '600',
        'uppercase'
      ])
    }
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(threadCommands.length + skills.length)
    expect(options.slice(-2).map((option) => option.textContent)).toEqual([
      '/海报设计设计活动海报',
      '/code-reviewReview the diff'
    ])
    // Headings sit between the groups, in document order.
    const [commandsHeading, skillsHeading] = screen.getAllByTestId(
      'chat-composer-suggestion-heading'
    )
    expect(
      commandsHeading.compareDocumentPosition(options[0]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      options[threadCommands.length - 1].compareDocumentPosition(skillsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      skillsHeading.compareDocumentPosition(options[threadCommands.length]) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(listbox).getByRole('group', { name: 'Skills' })).toBeInTheDocument()
  })

  it('drops the heading of a group that has no match and moves through both groups with the arrows', async () => {
    render(<Harness commands={threadCommands} skills={skills} />)
    const user = await typeInto('/海')
    expect(headings()).toEqual(['Skills'])
    expect(optionLabels()).toEqual(['/海报设计设计活动海报'])
    await user.keyboard('{Backspace}re')
    expect(headings()).toEqual(['Commands', 'Skills'])
    expect(optionLabels()).toEqual([
      '/regenResend last message in a copy',
      '/repair-imagesFind missing local images',
      '/code-reviewReview the diff'
    ])
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(activeOption()).toHaveTextContent('/code-review')
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toHaveTextContent('/regen')
  })

  it('selects the skill and clears the typed token when a skill row is accepted with Enter or a click', async () => {
    const onSelectSkill = vi.fn()
    const onSend = vi.fn()
    render(
      <Harness
        commands={threadCommands}
        skills={skills}
        onSelectSkill={onSelectSkill}
        onSend={onSend}
      />
    )
    const user = await typeInto('/海')
    await user.keyboard('{Enter}')
    expect(onSelectSkill).toHaveBeenCalledTimes(1)
    expect(onSelectSkill).toHaveBeenCalledWith('skill-poster')
    expect(input().value).toBe('')
    expect(onSend).not.toHaveBeenCalled()
    expect(list()).toBeNull()
    expect(document.activeElement).toBe(input())

    await user.keyboard('/code')
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /code-review/ }))
    expect(onSelectSkill).toHaveBeenCalledTimes(2)
    expect(onSelectSkill).toHaveBeenLastCalledWith('skill-review')
    expect(input().value).toBe('')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('still runs a command typed in full on Enter while skills are listed below it', async () => {
    const onSelectSkill = vi.fn()
    const onSend = vi.fn()
    render(
      <Harness
        commands={threadCommands}
        skills={[{ id: 'skill-status', name: 'status-report' }]}
        onSelectSkill={onSelectSkill}
        onSend={onSend}
      />
    )
    const user = await typeInto('/status')
    expect(optionLabels()).toEqual(['/statusShow conversation status', '/status-report'])
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSelectSkill).not.toHaveBeenCalled()
    expect(input().value).toBe('/status')
  })

  it('keeps the plain list without headings where no skills prop is given', async () => {
    render(<Harness commands={threadCommands} />)
    await typeInto('/')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
    expect(screen.queryByTestId('chat-composer-suggestion-heading')).toBeNull()
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('ChatComposer "@" drafts', () => {
  it('opens no list for "@" and leaves the arrow keys to the textarea', async () => {
    render(<Harness commands={threadCommands} />)
    const user = await typeInto('@')
    expect(list()).toBeNull()
    expect(input()).not.toHaveAttribute('aria-expanded')
    expect(input()).not.toHaveAttribute('aria-activedescendant')
    await user.keyboard('设计')
    expect(list()).toBeNull()

    const arrowDown = fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const arrowUp = fireEvent.keyDown(input(), { key: 'ArrowUp' })
    // fireEvent returns false when a handler called preventDefault.
    expect([arrowDown, arrowUp]).toEqual([true, true])
    expect(input().value).toBe('@设计')
  })

  it('sends a finished "@name task" draft once on Enter and leaves its text unchanged', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('@设计 画一张海报')
    expect(list()).toBeNull()
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('@设计 画一张海报')

    // Also with the caret back inside the name, where the old "@" list used to take Enter.
    input().setSelectionRange(2, 2)
    fireEvent.select(input())
    expect(list()).toBeNull()
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(2)
    expect(input().value).toBe('@设计 画一张海报')
  })

  it('sends a bare "@name" on Enter instead of completing it to another name', async () => {
    const onSend = vi.fn()
    render(<Harness commands={threadCommands} onSend={onSend} />)
    const user = await typeInto('@设计')
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('@设计')
    await user.keyboard('{Tab}')
    expect(input().value).toBe('@设计')
  })
})
