import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList, { resetChatImageDerivativeCacheForTests } from './ChatMessageList'
import { appendAssistantDeltaToSession } from '../chatSessionUtils'
import type { ChatSession } from '../chatStorage'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import type { MediaReference } from '@shared/mediaReference'

const translate = (key: string, options?: Record<string, unknown>): string => {
  const template = (options?.defaultValue as string | undefined) ?? key
  return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: vi.fn() })
}))

type ListProps = React.ComponentProps<typeof ChatMessageList>
type ObservedIntersection = {
  callback: IntersectionObserverCallback
  target: Element | null
  disconnected: boolean
}
type ObservedResize = {
  callback: ResizeObserverCallback
  target: Element | null
  disconnected: boolean
}

const theme = createTheme()
const ensureDerivative = vi.fn()
let intersections: ObservedIntersection[]
let resizes: ObservedResize[]

const makeListBuilder = (defaults: Partial<ListProps> = {}) => {
  const props = {
    isLoading: false,
    editingMessageIndex: null,
    editingContent: '',
    onSetEditingIndex: vi.fn(),
    onSetEditingContent: vi.fn(),
    onSendEditedMessage: vi.fn(),
    onPreviewImage: vi.fn(),
    onImageContextMenu: vi.fn(),
    onDownloadAttachment: vi.fn(),
    onSendModelToDcc: vi.fn(),
    chatContainerRef: React.createRef<HTMLDivElement>(),
    messagesEndRef: React.createRef<HTMLDivElement>(),
    ...defaults
  }
  return (currentSession: ChatSession, overrides: Partial<ListProps> = {}) => (
    <ThemeProvider theme={theme}>
      <ChatMessageList {...props} currentSession={currentSession} {...overrides} />
    </ThemeProvider>
  )
}

const makeSession = (messages: ChatMessage[], id = 'stable-session'): ChatSession => ({
  id,
  title: id,
  messages
})

const getRow = (index: number): HTMLElement => {
  const row = document.querySelector(`[data-chat-message-index="${index}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`Message row ${index} is not mounted`)
  return row
}

const markImagesVisible = () =>
  act(() => {
    for (const observer of intersections) {
      if (observer.disconnected || !observer.target?.isConnected) continue
      observer.callback(
        [{ target: observer.target, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    }
  })

const managedReference: MediaReference = {
  version: 1,
  kind: 'managed',
  relativePath: 'assets/stability.png',
  sha256: 'a'.repeat(64),
  mimeType: 'image/png',
  sizeBytes: 4096,
  originalFileName: 'stability.png'
}

const managedAttachment = (): ChatAttachment => ({
  type: 'image',
  url: 'local-media:///stability.png',
  fileName: 'stability.png',
  media: { ...managedReference },
  sourceWidth: 400,
  sourceHeight: 200
})

beforeEach(() => {
  intersections = []
  resizes = []
  ensureDerivative.mockReset().mockImplementation(async ({ reference }) => ({
    status: 'ready',
    descriptor: { localMediaUrl: `local-media:///preview-${reference.sha256.slice(0, 3)}.webp` }
  }))
  resetChatImageDerivativeCacheForTests()
  vi.stubGlobal('api', { svcManagedMedia: { ensureDerivative } })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      record: ObservedIntersection
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, target: null, disconnected: false }
        intersections.push(this.record)
      }
      observe(target: Element) {
        this.record.target = target
      }
      disconnect() {
        this.record.disconnected = true
      }
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      record: ObservedResize
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, target: null, disconnected: false }
        resizes.push(this.record)
      }
      observe(target: Element) {
        this.record.target = target
      }
      disconnect() {
        this.record.disconnected = true
      }
    }
  )
})

afterEach(() => {
  cleanup()
  resetChatImageDerivativeCacheForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ChatMessageList render stability', () => {
  it('preserves streamed rows, Markdown, images and progress when callback props also change', () => {
    const firstPreview = vi.fn()
    const nextPreview = vi.fn()
    const nextContextMenu = vi.fn()
    let session = makeSession([
      { role: 'user', content: 'Describe these images' },
      {
        role: 'assistant',
        content:
          'Opening paragraph.\n\n![Inline preview](local-media:///inline.png)\n\n```ts\nconst count = 1\n```\n\nAnswer:',
        attachments: [{ type: 'image', url: 'local-media:///attachment.png' }]
      }
    ])
    const buildList = makeListBuilder({
      isLoading: true,
      loadingStatus: { label: 'Receiving output' },
      onPreviewImage: firstPreview
    })
    const view = render(buildList(session))
    markImagesVisible()

    const row = getRow(1)
    const paragraph = screen.getByText('Opening paragraph.')
    const markdown = screen.getByTestId('assistant-markdown-content')
    const progress = screen.getByRole('progressbar')
    const copyCode = screen.getByRole('button', { name: 'Copy code' })
    const attachmentImage = screen.getByRole('img', { name: 'Attachment image 1' })
    const inlineImage = screen.getByRole('img', { name: 'Inline preview' })
    const originalObservers = [...intersections]

    for (const delta of [' first', ' second', ' third']) {
      session = appendAssistantDeltaToSession([session], { sessionId: session.id, delta })[0]
      view.rerender(
        buildList(session, {
          onPreviewImage: nextPreview,
          onImageContextMenu: nextContextMenu,
          onDownloadAttachment: vi.fn()
        })
      )

      expect(getRow(1)).toBe(row)
      expect(screen.getByText('Opening paragraph.')).toBe(paragraph)
      expect(screen.getByTestId('assistant-markdown-content')).toBe(markdown)
      expect(screen.getByRole('progressbar')).toBe(progress)
      expect(screen.getByRole('button', { name: 'Copy code' })).toBe(copyCode)
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toBe(attachmentImage)
      expect(screen.getByRole('img', { name: 'Inline preview' })).toBe(inlineImage)
      expect(intersections).toEqual(originalObservers)
      expect(originalObservers.every((observer) => !observer.disconnected)).toBe(true)
    }

    fireEvent.click(inlineImage)
    fireEvent.contextMenu(inlineImage)
    expect(firstPreview).not.toHaveBeenCalled()
    expect(nextPreview).toHaveBeenCalledExactlyOnceWith('local-media:///inline.png')
    expect(nextContextMenu).toHaveBeenCalledWith(expect.anything(), 'local-media:///inline.png')
  })

  it('keeps attachment image instances paired with their source when attachments reorder', async () => {
    const first: ChatAttachment = {
      type: 'image',
      url: 'local-media:///first.png',
      fileName: 'first.png'
    }
    const second: ChatAttachment = {
      type: 'image',
      url: 'local-media:///second.png',
      fileName: 'second.png'
    }
    let session = makeSession([{ role: 'assistant', content: '', attachments: [first, second] }])
    const buildList = makeListBuilder()
    const view = render(buildList(session))
    markImagesVisible()
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))

    const initialImages = screen.getAllByRole('img')
    expect(initialImages[0]).toHaveAttribute('src', first.url)
    expect(initialImages[1]).toHaveAttribute('src', second.url)

    session = makeSession([{ role: 'assistant', content: '', attachments: [second, first] }])
    view.rerender(buildList(session))

    const reorderedImages = screen.getAllByRole('img')
    expect(reorderedImages[0]).toBe(initialImages[1])
    expect(reorderedImages[1]).toBe(initialImages[0])
    expect(reorderedImages[0]).toHaveAttribute('src', second.url)
    expect(reorderedImages[1]).toHaveAttribute('src', first.url)
  })

  it('does not let a detached image error mark a replacement attachment as failed', async () => {
    const original: ChatAttachment = {
      type: 'image',
      url: 'local-media:///original.png',
      fileName: 'original.png'
    }
    const replacement: ChatAttachment = {
      type: 'image',
      url: 'local-media:///replacement.png',
      fileName: 'replacement.png'
    }
    let session = makeSession([{ role: 'assistant', content: '', attachments: [original] }])
    const buildList = makeListBuilder()
    const view = render(buildList(session))
    markImagesVisible()
    const originalImage = await screen.findByRole('img', { name: 'Attachment image 1' })
    await waitFor(() => expect(originalImage).toHaveAttribute('src', original.url))

    session = makeSession([{ role: 'assistant', content: '', attachments: [replacement] }])
    view.rerender(buildList(session))
    markImagesVisible()
    const replacementImage = await screen.findByRole('img', { name: 'Attachment image 1' })
    await waitFor(() => expect(replacementImage).toHaveAttribute('src', replacement.url))
    expect(replacementImage).not.toBe(originalImage)

    fireEvent.error(originalImage)
    expect(screen.queryByRole('img', { name: 'Attachment image 1 failed to load' })).toBeNull()
    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toBe(replacementImage)
  })

  it('keeps managed images and derivative IO stable across cloned storage and metadata updates', async () => {
    let session = makeSession([
      { role: 'user', content: 'Reference', attachments: [managedAttachment()] },
      { role: 'assistant', content: 'Reply' }
    ])
    const buildList = makeListBuilder()
    const view = render(buildList(session))
    markImagesVisible()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(1))
    const image = await screen.findByRole('img', { name: 'Attachment image 1' })
    const row = getRow(0)
    const originalObservers = [...intersections]

    session = JSON.parse(JSON.stringify(session)) as ChatSession
    view.rerender(buildList(session))
    expect(getRow(0)).toBe(row)
    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toBe(image)
    expect(image).toHaveAttribute('src', 'local-media:///preview-aaa.webp')

    const attachment = session.messages[0].attachments![0]
    session = {
      ...session,
      messages: [
        {
          ...session.messages[0],
          attachments: [
            {
              ...attachment,
              media: { ...attachment.media!, status: 'ready', derivatives: [] }
            }
          ]
        },
        session.messages[1]
      ]
    }
    view.rerender(buildList(session))
    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toBe(image)
    expect(intersections).toEqual(originalObservers)
    expect(originalObservers.every((observer) => !observer.disconnected)).toBe(true)
    expect(ensureDerivative).toHaveBeenCalledTimes(1)
  })

  it('loads a new descriptor when the managed content hash actually changes', async () => {
    const attachment = managedAttachment()
    const session = makeSession([{ role: 'assistant', content: '', attachments: [attachment] }])
    const buildList = makeListBuilder()
    const view = render(buildList(session))
    markImagesVisible()
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///preview-aaa.webp'
      )
    )
    const row = getRow(0)
    view.rerender(
      buildList({
        ...session,
        messages: [
          {
            ...session.messages[0],
            attachments: [
              { ...attachment, media: { ...attachment.media!, sha256: 'b'.repeat(64) } }
            ]
          }
        ]
      })
    )

    expect(getRow(0)).toBe(row)
    expect(screen.queryByRole('img', { name: 'Attachment image 1' })).toBeNull()
    markImagesVisible()
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///preview-bbb.webp'
      )
    )
    expect(ensureDerivative).toHaveBeenCalledTimes(2)
    expect(ensureDerivative.mock.calls[1][0].reference.sha256).toBe('b'.repeat(64))
  })

  it('keeps a pending preview valid across repeated visible intersection notifications', async () => {
    let finish!: (value: unknown) => void
    ensureDerivative.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const buildList = makeListBuilder()
    render(
      buildList(
        makeSession([{ role: 'assistant', content: '', attachments: [managedAttachment()] }])
      )
    )
    markImagesVisible()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledOnce())

    markImagesVisible()
    await act(async () => {
      finish({
        status: 'ready',
        descriptor: { localMediaUrl: 'local-media:///repeated-visible.webp' }
      })
    })

    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
      'src',
      'local-media:///repeated-visible.webp'
    )
    expect(ensureDerivative).toHaveBeenCalledOnce()
  })

  it('restores the preview when hide and show notifications are batched together', async () => {
    const buildList = makeListBuilder()
    render(
      buildList(
        makeSession([{ role: 'assistant', content: '', attachments: [managedAttachment()] }])
      )
    )
    markImagesVisible()
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///preview-aaa.webp'
      )
    )
    const observer = intersections.find((entry) => !entry.disconnected)!
    act(() => {
      for (const isIntersecting of [false, true]) {
        observer.callback(
          [{ target: observer.target, isIntersecting } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      }
    })

    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///preview-aaa.webp'
      )
    )
    expect(ensureDerivative).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'uses the latest visibility record in a single callback (visible: %s)',
    async (visible) => {
      const buildList = makeListBuilder()
      render(
        buildList(
          makeSession([{ role: 'assistant', content: '', attachments: [managedAttachment()] }])
        )
      )
      markImagesVisible()
      await waitFor(() =>
        expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
          'src',
          'local-media:///preview-aaa.webp'
        )
      )
      const observer = intersections.find((entry) => !entry.disconnected)!
      act(() =>
        observer.callback(
          [!visible, visible].map(
            (isIntersecting) =>
              ({ target: observer.target, isIntersecting }) as IntersectionObserverEntry
          ),
          {} as IntersectionObserver
        )
      )

      if (visible) {
        expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
          'src',
          'local-media:///preview-aaa.webp'
        )
      } else {
        expect(screen.queryByRole('img', { name: 'Attachment image 1' })).toBeNull()
      }
    }
  )

  it('ignores notifications from a disconnected observer after the image source changes', async () => {
    const first = managedAttachment()
    const session = makeSession([{ role: 'assistant', content: '', attachments: [first] }])
    const buildList = makeListBuilder()
    const view = render(buildList(session))
    markImagesVisible()
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///preview-aaa.webp'
      )
    )
    const staleObserver = intersections.find((entry) => !entry.disconnected)!
    view.rerender(
      buildList({
        ...session,
        messages: [
          {
            ...session.messages[0],
            attachments: [{ ...first, media: { ...first.media!, sha256: 'b'.repeat(64) } }]
          }
        ]
      })
    )
    markImagesVisible()
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///preview-bbb.webp'
      )
    )
    expect(staleObserver.disconnected).toBe(true)

    act(() =>
      staleObserver.callback(
        [{ target: staleObserver.target, isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    )
    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
      'src',
      'local-media:///preview-bbb.webp'
    )
  })

  it('uses corrected source metadata without clearing the displayed image or visibility observer', async () => {
    ensureDerivative.mockRejectedValueOnce(new Error('Invalid source metadata'))
    const attachment = managedAttachment()
    const session = makeSession([{ role: 'assistant', content: '', attachments: [attachment] }])
    const buildList = makeListBuilder()
    const view = render(buildList(session))
    markImagesVisible()
    const image = await screen.findByRole('img', { name: 'Attachment image 1' })
    await waitFor(() => expect(image).toHaveAttribute('src', attachment.url))
    const originalObservers = [...intersections]
    const corrected = {
      ...attachment.media!,
      sizeBytes: 8192,
      mimeType: 'image/webp',
      originalFileName: 'corrected.webp',
      originalUrl: 'https://example.test/corrected.webp'
    }

    view.rerender(
      buildList({
        ...session,
        messages: [{ ...session.messages[0], attachments: [{ ...attachment, media: corrected }] }]
      })
    )

    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toBe(image)
    expect(intersections).toEqual(originalObservers)
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(2))
    expect(ensureDerivative.mock.calls[1][0].reference).toEqual(corrected)
    await waitFor(() => expect(image).toHaveAttribute('src', 'local-media:///preview-aaa.webp'))
  })

  it('preserves local edit attachments during a cloned storage refresh', () => {
    let receiver: ((attachment: ChatAttachment) => void) | null = null
    const onSendEditedMessage = vi.fn()
    const session = makeSession([
      { role: 'user', content: 'Prompt', attachments: [{ type: 'image', url: 'first.png' }] }
    ])
    const buildList = makeListBuilder({
      editingMessageIndex: 0,
      editingContent: 'Edited prompt',
      onSendEditedMessage,
      onRegisterEditingAttachmentReceiver: (next) => {
        receiver = next
      }
    })
    const view = render(buildList(session))
    const editor = screen.getByRole('textbox')
    const addedImage: ChatAttachment = {
      type: 'image',
      url: 'added.png',
      fileName: 'added.png'
    }
    act(() => receiver?.(addedImage))
    view.rerender(buildList(JSON.parse(JSON.stringify(session)) as ChatSession))
    expect(screen.getByRole('textbox')).toBe(editor)
    expect(screen.getByRole('button', { name: 'Remove added.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'Edited prompt',
      [session.messages[0].attachments![0], addedImage],
      undefined,
      []
    )
  })

  it.each([false, true])('isolates edit state across sessions (supplied id: %s)', (hasId) => {
    let receiver: ((attachment: ChatAttachment) => void) | null = null
    const sharedMessage = {
      ...(hasId ? { id: 'reused-message-id' } : {}),
      role: 'user' as const,
      content: 'Same message',
      attachments: [{ type: 'image' as const, url: 'original.png', fileName: 'original.png' }]
    }
    const buildList = makeListBuilder({
      editingMessageIndex: 0,
      editingContent: 'Edited prompt',
      onRegisterEditingAttachmentReceiver: (next) => {
        receiver = next
      }
    })
    const view = render(buildList(makeSession([sharedMessage], 'edit-session-a')))
    const editor = screen.getByRole('textbox')
    const identity = getRow(0).dataset.chatMessageIdentity
    fireEvent.click(screen.getByRole('button', { name: 'Remove original.png' }))
    act(() => receiver?.({ type: 'image', url: 'only-in-a.png', fileName: 'only-in-a.png' }))
    expect(screen.getByRole('button', { name: 'Remove only-in-a.png' })).toBeInTheDocument()

    view.rerender(buildList(makeSession([sharedMessage], 'edit-session-b')))
    expect(screen.getByRole('textbox')).not.toBe(editor)
    expect(getRow(0).dataset.chatMessageIdentity).not.toBe(identity)
    expect(screen.getByRole('button', { name: 'Remove original.png' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove only-in-a.png' })).toBeNull()
  })

  it('keeps duplicate supplied IDs unique and stable when immutable messages update', () => {
    const messages = [
      { id: 'duplicate', role: 'assistant' as const, content: 'First duplicate' },
      { id: 'duplicate', role: 'assistant' as const, content: 'Second duplicate' }
    ]
    const buildList = makeListBuilder()
    const view = render(buildList(makeSession(messages)))
    const first = getRow(0)
    const second = getRow(1)
    expect(first.dataset.chatMessageIdentity).not.toBe(second.dataset.chatMessageIdentity)
    view.rerender(
      buildList(
        makeSession(messages.map((message) => ({ ...message, content: `${message.content}!` })))
      )
    )
    expect(getRow(0)).toBe(first)
    expect(getRow(1)).toBe(second)
    expect(first).toHaveTextContent('First duplicate!')
    expect(second).toHaveTextContent('Second duplicate!')
  })

  it('keeps moved object identities and does not assign their keys to inserted messages', () => {
    const first: ChatMessage = { role: 'assistant', content: 'First row' }
    const second: ChatMessage = { role: 'assistant', content: 'Second row' }
    const buildList = makeListBuilder()
    const view = render(buildList(makeSession([first, second])))
    const firstRow = getRow(0)
    const secondRow = getRow(1)
    view.rerender(
      buildList(makeSession([{ role: 'assistant', content: 'Prepended row' }, first, second]))
    )
    expect(getRow(0)).not.toBe(firstRow)
    expect(getRow(0)).not.toBe(secondRow)
    expect(getRow(1)).toBe(firstRow)
    expect(getRow(2)).toBe(secondRow)
    view.rerender(buildList(makeSession([second, first])))
    expect(getRow(0)).toBe(secondRow)
    expect(getRow(1)).toBe(firstRow)
  })

  it('preserves cloned row identities through reorders even when their text matches', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'Same text', attachments: [{ type: 'image', url: 'a.png' }] },
      { role: 'assistant', content: 'Same text', attachments: [{ type: 'image', url: 'b.png' }] }
    ]
    const buildList = makeListBuilder()
    const view = render(buildList(makeSession(messages)))
    const first = getRow(0)
    const second = getRow(1)
    const reordered = JSON.parse(JSON.stringify([messages[1], messages[0]])) as ChatMessage[]

    view.rerender(buildList(makeSession(reordered)))

    expect(getRow(0)).toBe(second)
    expect(getRow(1)).toBe(first)
  })

  it('does not lend edit attachment state to prepended messages in a cloned history', () => {
    let receiver: ((attachment: ChatAttachment) => void) | null = null
    const session = makeSession([
      { role: 'user', content: 'Original', attachments: [{ type: 'image', url: 'original.png' }] },
      { role: 'assistant', content: 'Original answer' }
    ])
    const buildList = makeListBuilder({
      editingMessageIndex: 0,
      editingContent: 'Draft',
      onRegisterEditingAttachmentReceiver: (next) => {
        receiver = next
      }
    })
    const view = render(buildList(session))
    const userRow = getRow(0)
    const assistantRow = getRow(1)
    const editor = screen.getByRole('textbox')
    act(() => receiver?.({ type: 'image', url: 'draft.png', fileName: 'draft.png' }))
    const cloned = JSON.parse(JSON.stringify(session.messages)) as ChatMessage[]

    view.rerender(
      buildList(
        makeSession([
          {
            role: 'user',
            content: 'Prepended',
            attachments: [{ type: 'image', url: 'new.png', fileName: 'new.png' }]
          },
          { role: 'assistant', content: 'Prepended answer' },
          ...cloned
        ])
      )
    )

    expect(getRow(0)).not.toBe(userRow)
    expect(getRow(1)).not.toBe(assistantRow)
    expect(getRow(2)).toBe(userRow)
    expect(getRow(3)).toBe(assistantRow)
    expect(screen.getByRole('textbox')).not.toBe(editor)
    expect(screen.getByRole('button', { name: 'Remove new.png' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove draft.png' })).toBeNull()
  })

  it('retains measured virtual heights and scroll anchors across immutable streaming snapshots', () => {
    const session = makeSession(
      Array.from({ length: 60 }, (_, index) => ({
        role: 'assistant',
        content: `Virtual row ${index}`
      }))
    )
    const buildList = makeListBuilder({ isLoading: true })
    const view = render(buildList(session))
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 7000 }
    })
    act(() => fireEvent.scroll(scroller))
    const firstResize = resizes.find((observer) => observer.target === getRow(0))!
    act(() => {
      firstResize.callback(
        [{ target: firstResize.target, contentRect: { height: 500 } } as ResizeObserverEntry],
        {} as ResizeObserver
      )
    })
    act(() => {
      scroller.scrollTop = 1600
      fireEvent.scroll(scroller)
    })
    const top = screen.getByTestId('chat-virtual-top-spacer').style.height
    const streamingRow = getRow(59)
    const streamingResize = resizes.find((observer) => observer.target === streamingRow)!
    const clonedSession = JSON.parse(JSON.stringify(session)) as ChatSession
    const updated = appendAssistantDeltaToSession([clonedSession], {
      sessionId: session.id,
      delta: ' more output'
    })[0]
    view.rerender(buildList(updated))

    expect(getRow(59)).toBe(streamingRow)
    expect(streamingResize.disconnected).toBe(false)
    expect(screen.getByTestId('chat-virtual-top-spacer')).toHaveStyle({ height: top })
    expect(scroller.scrollTop).toBe(1600)
  })
})
