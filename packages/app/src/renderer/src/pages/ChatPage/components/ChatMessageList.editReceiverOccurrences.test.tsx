import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ChatSession } from '../chatStorage'
import ChatMessageList from './ChatMessageList'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }) }))

type Props = React.ComponentProps<typeof ChatMessageList>
const image = (name: string): ChatAttachment => ({ type: 'image', url: `local-media:///${name}`, fileName: name })
const theme = createTheme()

function setup(initial: ChatAttachment[] = []) {
  const session: ChatSession = { id: 'edit-receiver', title: 'fixture', messages: [{ role: 'user', content: 'original', attachments: initial }] }
  const snapshot = structuredClone(session)
  const onSendEditedMessage = vi.fn<Props['onSendEditedMessage']>()
  let receiver: ((attachment: ChatAttachment) => void) | null = null
  const register: NonNullable<Props['onRegisterEditingAttachmentReceiver']> = callback => { receiver = callback }
  const Harness = () => {
    const [index, setIndex] = React.useState<number | null>(null)
    const [content, setContent] = React.useState('')
    const container = React.useRef<HTMLDivElement>(null)
    const end = React.useRef<HTMLDivElement>(null)
    return <ThemeProvider theme={theme}><ChatMessageList currentSession={session} isLoading={false}
      editingMessageIndex={index} editingContent={content} onSetEditingIndex={setIndex} onSetEditingContent={setContent}
      onSendEditedMessage={onSendEditedMessage} onRegisterEditingAttachmentReceiver={register}
      onPreviewImage={vi.fn()} onImageContextMenu={vi.fn()} onDownloadAttachment={vi.fn()} onSendModelToDcc={vi.fn()}
      chatContainerRef={container} messagesEndRef={end} /></ThemeProvider>
  }
  render(<Harness />)
  fireEvent.click(within(screen.getByTestId('user-message-actions')).getByRole('button', { name: 'chat.edit_message' }))
  const receive = (attachment: ChatAttachment) => {
    expect(receiver).not.toBeNull()
    act(() => { receiver!(attachment) })
  }
  const receiveBatch = (attachments: ChatAttachment[]) => {
    expect(receiver).not.toBeNull()
    act(() => { attachments.forEach(attachment => receiver!(attachment)) })
  }
  return { session, snapshot, receive, receiveBatch, onSendEditedMessage }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('real edit form registered attachment receiver', () => {
  it('shows two received occurrences with the same URL and name', () => {
    const f = setup(), same = image('same.png')
    f.receive(same); f.receive({ ...same })
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(2)
  })

  it('submits both received occurrences with the same URL and name', () => {
    const f = setup(), same = image('same.png')
    f.receive(same); f.receive({ ...same })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([same, same])
    expect(f.session).toEqual(f.snapshot)
  })

  it('keeps an incoming occurrence even when the same source was already in the original message', () => {
    const same = image('same.png'), f = setup([same])
    f.receive({ ...same })
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([same, same])
    expect(f.session).toEqual(f.snapshot)
  })

  it('removes only the selected same-source occurrence and submits the other one', () => {
    const f = setup(), same = image('same.png')
    f.receive(same); f.receive({ ...same })
    const buttons = screen.getAllByRole('button', { name: 'Remove same.png' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([same])
    expect(f.session).toEqual(f.snapshot)
  })

  it('counts a same-source arrival as the 51st image and preserves the editing form', () => {
    const same = image('same.png')
    const existing = Array.from({ length: 50 }, (_, i) => i === 0 ? same : image(`existing-${i}.png`))
    const f = setup(existing)
    f.receive({ ...same })
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).not.toHaveBeenCalled()
    expect(screen.getByText('本次图片数量超过限制，请分批发送')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('original')
    expect(f.session).toEqual(f.snapshot)
  })

  it('keeps metadata-distinct occurrences in arrival order and removes only the selected entry', () => {
    const same = image('same.png'), first = { ...same, sourceWidth: 100 }, second = { ...same, sourceWidth: 200 }
    const f = setup()
    f.receive(first); f.receive(second)
    const buttons = screen.getAllByRole('button', { name: 'Remove same.png' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([second])
    expect(f.session).toEqual(f.snapshot)
  })

  it('counts hidden same-source arrivals in the image limit and exposes them when over limit', () => {
    const same = { ...image('same.png'), hiddenFromChatView: true }
    const existing = Array.from({ length: 50 }, (_, i) => i === 0 ? same : image(`existing-${i}.png`))
    const f = setup(existing)
    expect(screen.queryByRole('button', { name: 'Remove same.png' })).not.toBeInTheDocument()
    f.receive({ ...same })
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).not.toHaveBeenCalled()
    expect(screen.getByText('本次图片数量超过限制，请分批发送')).toBeInTheDocument()
    expect(f.session).toEqual(f.snapshot)
  })

  it('ignores received non-image attachments', () => {
    const f = setup()
    f.receive({ type: 'file', url: 'local-media:///document.txt', fileName: 'document.txt' })
    expect(screen.queryByRole('button', { name: 'Remove document.txt' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
    expect(f.onSendEditedMessage.mock.calls[0][1]).toBeUndefined()
    expect(f.session).toEqual(f.snapshot)
  })

  it('preserves a same-tick batch in callback order even for repeated object identity', () => {
    const f = setup(), shared = { ...image('same.png'), sourceWidth: 10 }
    const different = { ...shared, sourceWidth: 20 }
    f.receiveBatch([shared, different, shared])
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([shared, different, shared])
    expect(f.session).toEqual(f.snapshot)
  })

  it('deletes the selected occurrence in a same-tick batch without disturbing the others', () => {
    const f = setup(), shared = { ...image('same.png'), sourceWidth: 10 }
    const different = { ...shared, sourceWidth: 20 }
    f.receiveBatch([shared, different, shared])
    const buttons = screen.getAllByRole('button', { name: 'Remove same.png' })
    expect(buttons).toHaveLength(3)
    fireEvent.click(buttons[1])
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([shared, shared])
    expect(f.session).toEqual(f.snapshot)
  })

  it('submits exactly 50 occurrences including a same-source arrival', () => {
    const same = image('same.png')
    const existing = Array.from({ length: 49 }, (_, i) => i === 0 ? same : image(`existing-${i}.png`))
    const f = setup(existing)
    f.receive({ ...same })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([...existing, same])
    expect(f.session).toEqual(f.snapshot)
  })

  it('allows removing the newest occurrence after exceeding the limit without losing the rest', () => {
    const same = image('same.png')
    const existing = Array.from({ length: 50 }, (_, i) => i === 0 ? same : image(`existing-${i}.png`))
    const f = setup(existing)
    f.receive({ ...same })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).not.toHaveBeenCalled()
    expect(screen.getByText('本次图片数量超过限制，请分批发送')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Remove same.png' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual(existing)
    expect(f.session).toEqual(f.snapshot)
  })

  it('submits both received images with different URLs', () => {
    const f = setup(), first = image('first.png'), second = image('second.png')
    f.receive(first); f.receive(second)
    expect(screen.getByRole('button', { name: 'Remove first.png' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove second.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([first, second])
    expect(f.session).toEqual(f.snapshot)
  })

  it('shows and removes only the clicked item with distinct URLs', () => {
    const f = setup(), first = image('first.png'), second = image('second.png')
    f.receive(first); f.receive(second)
    expect(screen.getByRole('button', { name: 'Remove first.png' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove second.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove first.png' }))
    expect(screen.queryByRole('button', { name: 'Remove first.png' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([second])
    expect(f.session).toEqual(f.snapshot)
  })

  it('rejects submission above 50 and retains the original message and editing form', () => {
    const existing = Array.from({ length: 49 }, (_, i) => image(`existing-${i}.png`))
    const f = setup(existing)
    f.receive(image('new-a.png')); f.receive(image('new-b.png'))
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(f.onSendEditedMessage).not.toHaveBeenCalled()
    expect(screen.getByText('本次图片数量超过限制，请分批发送')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('original')
    expect(f.session).toEqual(f.snapshot)
  })
})
