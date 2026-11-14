import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MenuItem, ThemeProvider } from '@mui/material'
import { useRef, useState, type ComponentProps } from 'react'
import { theme } from '@renderer/theme'
import enLocale from '@shared/locales/en-US/renderer.json'
import ChatComposer from './ChatComposer'
import { listComposerCommands } from '../composerCommandCatalog'

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

type ComposerProps = ComponentProps<typeof ChatComposer>

function ColumnComposer({
  initialValue = '',
  ...overrides
}: Partial<ComposerProps> & { initialValue?: string }) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  return (
    <ThemeProvider theme={theme}>
      <ChatComposer
        layout="column"
        inputValue={value}
        onInputChange={setValue}
        onSend={vi.fn()}
        onUploadFile={vi.fn()}
        pendingAttachments={[]}
        uploadProgress={{}}
        onRemoveAttachment={vi.fn()}
        isLoading={false}
        onStopGenerating={vi.fn()}
        disabled={false}
        composerInputRef={inputRef}
        onPreviewImage={vi.fn()}
        {...overrides}
      />
    </ThemeProvider>
  )
}

const shell = () => screen.getByTestId('chat-composer-shell')
const input = () => screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
const moreActions = () => screen.getByRole('button', { name: 'More actions' })
const sendButton = () => screen.getByRole('button', { name: 'Send Message' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ChatComposer column shell', () => {
  it('is one row in one shell: "+", mode chip, textarea, compact button, send', () => {
    render(
      <ColumnComposer
        toolbarSlot={<span data-testid="mode-chip">Image</span>}
        statusSlot={<span data-testid="context-ring" />}
        onCompressContext={vi.fn()}
      />
    )

    const root = screen.getByTestId('chat-composer-root')
    expect(root).toHaveAttribute('data-composer-layout', 'column')
    // Nothing but the shell (and its positioning wrapper) while there are no chips.
    expect(root.children).toHaveLength(1)
    expect(root.firstElementChild?.children).toHaveLength(1)
    expect(root.firstElementChild?.firstElementChild).toBe(shell())

    const order = [
      moreActions(),
      screen.getByTestId('mode-chip'),
      input(),
      screen.getByRole('button', { name: 'Compress context' }),
      sendButton()
    ]
    order.reduce((previous, current) => {
      expect(
        previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      return current
    })
    for (const control of order) expect(shell()).toContainElement(control)
    // The Agent column shows the model in its header and passes no model selector.
    expect(screen.queryByTestId('chat-composer-model-selector-slot')).toBeNull()
    expect(screen.queryByTestId('chat-composer-action-bar')).toBeNull()
  })

  it('keeps a model selector it is given inside the row, before Send', () => {
    render(<ColumnComposer modelSelectorSlot={<button type="button">model</button>} />)

    const model = screen.getByRole('button', { name: 'model' })
    expect(shell()).toContainElement(model)
    expect(
      model.compareDocumentPosition(sendButton()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('names the textarea with its one-line placeholder and bounds its height at 26px to 128px', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400)
    render(<ColumnComposer initialValue={'a\nb\nc\nd\ne\nf\ng\nh\ni\nj'} />)

    expect(input()).toHaveAttribute('placeholder', 'Message this conversation')
    expect(input()).toHaveAccessibleName('Message this conversation')
    expect(input()).toHaveAttribute('rows', '1')
    expect(input().style.minHeight).toBe('26px')
    expect(input().style.maxHeight).toBe('128px')
    // Taller content is clamped and scrolls inside the textarea.
    expect(input().style.height).toBe('128px')
    expect(input().style.overflowY).toBe('auto')
  })

  it('keeps one line at 26px', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(26)
    render(<ColumnComposer initialValue="one line" />)
    expect(input().style.height).toBe('26px')
  })

  it('marks the shell active while there is a draft or an attachment', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ColumnComposer />)
    expect(shell()).not.toHaveAttribute('data-active')
    await user.type(input(), 'hi')
    expect(shell()).toHaveAttribute('data-active', 'true')
    await user.clear(input())
    expect(shell()).not.toHaveAttribute('data-active')
    unmount()

    render(
      <ColumnComposer
        pendingAttachments={[{ type: 'file', url: 'file:///notes.txt', fileName: 'notes.txt' }]}
      />
    )
    expect(shell()).toHaveAttribute('data-active', 'true')
  })

  it('opens the existing menu from "More actions" and returns focus to it on Escape', async () => {
    const user = userEvent.setup()
    const upload = vi.fn()
    render(
      <ColumnComposer
        onUploadFile={upload}
        addMenuSlot={() => [<MenuItem key="trace">Start trace</MenuItem>]}
      />
    )

    const button = moreActions()
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).not.toHaveAttribute('aria-controls')

    button.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).toContainElement(
      menu
    )
    // "Add File" first, then the entries of the slot, with no divider between them.
    expect(Array.from(menu.children).map((item) => item.getAttribute('role'))).toEqual([
      'menuitem',
      'menuitem'
    ])
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Add File', 'Start trace'])

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(await screen.findByRole('menuitem', { name: 'Add File' }))
    expect(upload).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('sends with the button or Enter only when there is something to send', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<ColumnComposer onSend={onSend} />)

    expect(sendButton()).toBeDisabled()
    await user.type(input(), '   ')
    expect(sendButton()).toBeDisabled()
    await user.type(input(), 'hello')
    expect(sendButton()).toBeEnabled()
    await user.click(sendButton())
    expect(onSend).toHaveBeenCalledTimes(1)
    await user.type(input(), '{Shift>}{Enter}{/Shift}')
    expect(onSend).toHaveBeenCalledTimes(1)
    await user.type(input(), '{Enter}')
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('shows Stop instead of Send while generating and keeps the textarea usable', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(<ColumnComposer isLoading onStopGenerating={onStop} />)

    expect(screen.queryByRole('button', { name: 'Send Message' })).toBeNull()
    expect(input()).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('offers a separate send for a private command next to Stop', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<ColumnComposer isLoading sideCommandEnabled initialValue="/btw why?" onSend={onSend} />)

    const sideSend = shell().querySelector('[data-chat-side-command-btn]') as HTMLElement
    expect(sideSend).toHaveAccessibleName()
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument()
    await user.click(sideSend)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('compresses the context from the ring button with the mouse and the keyboard', async () => {
    const user = userEvent.setup()
    const onCompress = vi.fn()
    render(
      <ColumnComposer
        statusSlot={<span data-testid="context-ring" />}
        onCompressContext={onCompress}
      />
    )

    const compress = screen.getByRole('button', { name: 'Compress context' })
    expect(compress).toContainElement(screen.getByTestId('context-ring'))
    await user.click(compress)
    compress.focus()
    await user.keyboard('{Enter}')
    expect(onCompress).toHaveBeenCalledTimes(2)
  })

  it('disables the controls but still renders the shell without a conversation', () => {
    render(<ColumnComposer disabled />)
    expect(input()).toBeDisabled()
    expect(moreActions()).toBeDisabled()
    expect(sendButton()).toBeDisabled()
  })

  it('shows the bound-tool help only while a /tool command is being typed', () => {
    const tool = { name: 'lookup', description: 'Look something up' } as NonNullable<
      ComposerProps['toolHelpItems']
    >[number]
    const { unmount } = render(<ColumnComposer toolHelpItems={[tool]} />)
    expect(screen.queryByTestId('chat-composer-tool-help')).toBeNull()
    unmount()

    render(<ColumnComposer toolHelpItems={[tool]} initialValue="/tool lo" />)
    expect(screen.getByTestId('chat-composer-tool-help')).toHaveTextContent('lookup')
  })

  it('keeps the full-page layout when no layout is given', () => {
    render(<ColumnComposer layout={undefined} modelSelectorSlot={<span>model-in-composer</span>} />)

    expect(screen.getByTestId('chat-composer-root')).not.toHaveAttribute('data-composer-layout')
    expect(screen.queryByTestId('chat-composer-shell')).toBeNull()
    expect(screen.getByTestId('chat-composer-action-bar')).toBeInTheDocument()
    expect(screen.getByText('model-in-composer')).toBeInTheDocument()
    expect(input()).toHaveAttribute('placeholder', '')
    fireEvent.focus(input())
    expect(screen.getByTestId('chat-composer-add-menu-button')).not.toHaveAttribute('aria-haspopup')
  })
})

describe('ChatComposer column chips', () => {
  const attachments: ComposerProps['pendingAttachments'] = [
    { type: 'image', url: 'file:///poster.png', fileName: 'poster.png' },
    {
      type: 'file',
      url: 'file:///a-very-long-quarterly-report-name.pdf',
      fileName: 'a-very-long-quarterly-report-name.pdf'
    },
    { type: 'file', url: 'file:///hidden.json', fileName: 'hidden.json', hiddenFromChatView: true },
    { type: 'video', url: 'blob:clip', fileName: 'clip.mp4' }
  ]

  it('shows nothing above the shell without attachments or a skill', () => {
    render(<ColumnComposer />)
    expect(screen.queryByTestId('chat-composer-attachments')).toBeNull()
  })

  it('puts image thumbnails and file chips in one row above the shell', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const onPreview = vi.fn()
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    render(
      <ColumnComposer
        pendingAttachments={attachments}
        uploadProgress={{ 3: 40 }}
        onRemoveAttachment={onRemove}
        onPreviewImage={onPreview}
      />
    )

    const row = screen.getByTestId('chat-composer-attachments')
    expect(screen.getByTestId('chat-composer-root').firstElementChild).toBe(row)
    expect(row.compareDocumentPosition(shell()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(shell()).not.toContainElement(row)
    // The image keeps its thumbnail, the visible files are chips, the hidden one is left out.
    expect(row.children).toHaveLength(3)
    const thumbnail = within(row).getByRole('img')
    await user.click(thumbnail)
    expect(onPreview).toHaveBeenCalledWith('file:///poster.png')

    const chips = within(row).getAllByTestId('chat-composer-file-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'a-very-long-quarterly-report-name.pdf',
      'clip.mp4'
    ])
    expect(chips[0]).toHaveAttribute('title', 'a-very-long-quarterly-report-name.pdf')
    // An upload in progress shows a spinner in place of the file icon.
    expect(within(chips[1]).getByRole('progressbar')).toBeInTheDocument()
    expect(within(chips[0]).queryByRole('progressbar')).toBeNull()

    await user.click(
      within(chips[0]).getByRole('button', { name: 'Remove a-very-long-quarterly-report-name.pdf' })
    )
    expect(onRemove).toHaveBeenLastCalledWith(1)
    await user.click(within(chips[1]).getByRole('button', { name: 'Remove clip.mp4' }))
    expect(onRemove).toHaveBeenLastCalledWith(3)
    expect(revoke).toHaveBeenCalledWith('blob:clip')
    await user.click(within(row).getByRole('button', { name: 'Remove attachment' }))
    expect(onRemove).toHaveBeenLastCalledWith(0)
  })

  it('shows the selected skill as the first chip of that row instead of inside the textarea', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(
      <ColumnComposer
        selectedSkillName="Poster designer"
        onClearSkill={onClear}
        pendingAttachments={[attachments[1]]}
      />
    )

    const row = screen.getByTestId('chat-composer-attachments')
    const skill = screen.getByTestId('chat-composer-skill-chip')
    expect(row.firstElementChild).toBe(skill)
    expect(skill).toHaveTextContent('Poster designer')
    expect(skill).not.toHaveTextContent('[')
    expect(shell()).not.toHaveTextContent('Poster designer')
    await user.click(within(skill).getByRole('button', { name: 'Clear skill Poster designer' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('shows a lone skill chip without a height limit', () => {
    render(<ColumnComposer selectedSkillName="Poster designer" onClearSkill={vi.fn()} />)
    const row = screen.getByTestId('chat-composer-attachments')
    expect(row.children).toHaveLength(1)
    expect(getComputedStyle(row).maxHeight).toBe('')
    // A selected skill alone is not a draft: the shell stays idle.
    expect(shell()).not.toHaveAttribute('data-active')
  })
})

describe('ChatComposer column slash menu', () => {
  const commands = listComposerCommands({
    remote: false,
    canvasThread: true,
    scratchpad: true,
    boundTools: false,
    teamMember: false
  })
  const skills = [
    { id: 'skill-review', name: 'code-review', description: 'Review the working tree diff' },
    { id: 'skill-notes', name: 'release-notes', description: 'Draft release notes' }
  ]
  const openMenu = async (text = '/') => {
    const user = userEvent.setup()
    render(<ColumnComposer suggestionCommands={commands} suggestionSkills={skills} />)
    await user.click(input())
    await user.keyboard(text)
    return user
  }

  it('floats above the shell at the shell width with a themed raised surface', async () => {
    await openMenu()
    const menu = screen.getByRole('listbox', { name: 'Available commands and skills' })
    // Positioned against the wrapper that holds only the menu and the shell.
    expect(menu.parentElement).toBe(shell().parentElement)
    expect(getComputedStyle(menu.parentElement!).position).toBe('relative')
    const style = getComputedStyle(menu)
    expect(style.position).toBe('absolute')
    expect(style.left).toBe('0px')
    expect(style.right).toBe('0px')
    expect(style.bottom).toBe('calc(100% + 8px)')
    expect(style.borderRadius).toBe('12px')
    expect(style.maxHeight).toBe('min(320px, 45vh)')
    expect(style.overflowY).toBe('auto')
    expect(style.padding).toBe('')
    expect(style.display).not.toBe('grid')
    // The raised surface is derived from the theme's paper colour, not a fixed hex value.
    expect(style.backgroundColor).toMatch(/^color-mix\(in srgb, /)
  })

  it('heads the two groups with small uppercase labels', async () => {
    await openMenu()
    const headings = screen.getAllByTestId('chat-composer-suggestion-heading')
    expect(headings.map((heading) => heading.textContent)).toEqual(['Commands', 'Skills'])
    for (const heading of headings) {
      const style = getComputedStyle(heading)
      expect(style.fontSize).toBe('10px')
      expect(style.fontWeight).toBe('600')
      expect(style.textTransform).toBe('uppercase')
      expect(style.letterSpacing).toBe('0.025em')
      expect(style.padding).toBe('4px 12px')
      expect(heading).toHaveAttribute('aria-hidden', 'true')
    }
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Commands',
      'Skills'
    ])
  })

  it('draws each row as a name chip, a muted hint and a description that may wrap to two lines', async () => {
    await openMenu()
    const row = screen.getByRole('option', { name: /\/btw/ })
    const rowStyle = getComputedStyle(row)
    expect(rowStyle.display).toBe('flex')
    expect(rowStyle.padding).toBe('8px 12px')
    expect(rowStyle.gap).toBe('12px')

    const [nameGroup, description] = Array.from(row.children) as HTMLElement[]
    const [name, hint] = Array.from(nameGroup.children) as HTMLElement[]
    expect(name).toHaveTextContent(/^\/btw$/)
    expect(hint).toHaveTextContent('<question>')
    // The name keeps its own width: it is not a column shared with the widest row.
    expect(getComputedStyle(nameGroup).flexGrow).toBe('0')
    expect(getComputedStyle(nameGroup).flexShrink).toBe('0')
    expect(getComputedStyle(nameGroup).fontFamily).toContain('monospace')
    const nameStyle = getComputedStyle(name)
    expect(nameStyle.fontWeight).toBe('600')
    expect(nameStyle.padding).toBe('1px 4px')
    expect(nameStyle.borderRadius).toBe('4px')
    expect(rowStyle.fontSize).toBe('12px')

    expect(description).toHaveTextContent('Ask a private side question')
    expect(description).toHaveAttribute('title', description.textContent)
    const descriptionStyle = getComputedStyle(description)
    expect(descriptionStyle.whiteSpace).not.toBe('nowrap')
    expect(descriptionStyle.overflow).toBe('hidden')
    expect(
      description.style.webkitLineClamp || descriptionStyle.getPropertyValue('-webkit-line-clamp')
    ).toBe('2')
  })

  it('fills the selected row and colours its name, following the arrow keys', async () => {
    const user = await openMenu()
    const options = screen.getAllByRole('option')
    const nameOf = (option: HTMLElement) =>
      option.firstElementChild!.firstElementChild as HTMLElement
    const primary = getComputedStyle(nameOf(options[0])).color
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(getComputedStyle(options[0]).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(options[1]).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(nameOf(options[1])).color).not.toBe(primary)

    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(getComputedStyle(nameOf(options[1])).color).toBe(primary)
    expect(getComputedStyle(options[0]).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(input()).toHaveAttribute('aria-activedescendant', options[1].id)
  })

  it('keeps the selected row in view, with its group heading for the first row of a group', async () => {
    const user = await openMenu()
    const menu = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    const heading = screen.getAllByTestId('chat-composer-suggestion-heading')[1]
    const place = (element: HTMLElement, top: number, height: number) => {
      Object.defineProperty(element, 'offsetTop', { configurable: true, value: top })
      Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height })
    }
    Object.defineProperty(menu, 'clientHeight', { configurable: true, value: 100 })
    // A 24px heading, the command rows, a 24px heading, the skill rows; every row is 36px.
    const skillsTop = 24 + commands.length * 36
    options.forEach((option, index) =>
      place(
        option,
        index < commands.length ? 24 + index * 36 : skillsTop + 24 + (index - commands.length) * 36,
        36
      )
    )
    place(heading, skillsTop, 24)
    const firstSkill = options[commands.length]
    const last = options[options.length - 1]

    // The last row: its bottom edge meets the bottom of the menu, with no extra padding.
    await user.keyboard('{ArrowUp}')
    expect(last).toHaveAttribute('aria-selected', 'true')
    expect(menu.scrollTop).toBe(last.offsetTop + 36 - 100)
    // Up to the first skill while it is above the fold: its heading scrolls into view with it.
    menu.scrollTop = last.offsetTop
    await user.keyboard('{ArrowUp}')
    expect(firstSkill).toHaveAttribute('aria-selected', 'true')
    expect(menu.scrollTop).toBe(heading.offsetTop)
  })
})
