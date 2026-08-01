import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList, {
  ensureCachedChatImageDerivative,
  getChatImageDerivativeCacheSizeForTests,
  getChatImageDerivativeMaxEdge,
  resetChatImageDerivativeCacheForTests
} from './ChatMessageList'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import type {
  ChatAttachment,
  ChatMessage
} from '../../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import type { ChatSession } from '../chatStorage'

const notifySuccessMock = vi.fn()

const chatImageTranslations: Record<string, string> = {
  'chat.attachment_image_alt': 'Attachment image {{index}}',
  'chat.image_alt': 'Image',
  'chat.image_load_failed': 'Image failed to load',
  'chat.image_load_failed_label': '{{name}} failed to load'
}

const translate = (key: string, options?: Record<string, unknown>) => {
  const template =
    chatImageTranslations[key] ?? (options?.defaultValue as string | undefined) ?? key
  return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: notifySuccessMock
  })
}))

type OnSendEditedMessage = (
  content: string,
  attachments: ChatAttachment[] | undefined,
  hiddenContext: string | undefined,
  baseMessages: ChatMessage[]
) => void

type OnDownloadAttachment = (attachment: ChatAttachment) => void

const buildChatMessageList = (
  currentSession: ChatSession,
  options?: {
    active?: boolean
    isLoading?: boolean
    editingMessageIndex?: number | null
    editingContent?: string
    onSendEditedMessage?: OnSendEditedMessage
    onDownloadAttachment?: OnDownloadAttachment
    onSetEditingIndex?: (index: number | null) => void
    onSetEditingContent?: (content: string) => void
    onPreviewImage?: (url: string) => void
    onImageContextMenu?: (event: React.MouseEvent, imageUrl: string) => void
    chatContainerRef?: React.RefObject<HTMLDivElement | null>
    messagesEndRef?: React.RefObject<HTMLDivElement | null>
  }
) => (
  <ThemeProvider theme={createTheme()}>
    <ChatMessageList
      active={options?.active}
      currentSession={currentSession}
      isLoading={options?.isLoading ?? false}
      editingMessageIndex={options?.editingMessageIndex ?? null}
      editingContent={options?.editingContent ?? ''}
      onSetEditingIndex={options?.onSetEditingIndex ?? vi.fn()}
      onSetEditingContent={options?.onSetEditingContent ?? vi.fn()}
      onSendEditedMessage={options?.onSendEditedMessage ?? vi.fn<OnSendEditedMessage>()}
      onPreviewImage={options?.onPreviewImage ?? vi.fn()}
      onImageContextMenu={options?.onImageContextMenu ?? vi.fn()}
      onDownloadAttachment={options?.onDownloadAttachment ?? vi.fn<OnDownloadAttachment>()}
      onSendModelToDcc={vi.fn()}
      chatContainerRef={options?.chatContainerRef ?? React.createRef<HTMLDivElement>()}
      messagesEndRef={options?.messagesEndRef ?? React.createRef<HTMLDivElement>()}
    />
  </ThemeProvider>
)

const renderChatMessageList = (
  currentSession: ChatSession,
  options?: {
    active?: boolean
    isLoading?: boolean
    editingMessageIndex?: number | null
    editingContent?: string
    onSendEditedMessage?: OnSendEditedMessage
    onDownloadAttachment?: OnDownloadAttachment
    onSetEditingIndex?: (index: number | null) => void
    onSetEditingContent?: (content: string) => void
    onPreviewImage?: (url: string) => void
    onImageContextMenu?: (event: React.MouseEvent, imageUrl: string) => void
    chatContainerRef?: React.RefObject<HTMLDivElement | null>
    messagesEndRef?: React.RefObject<HTMLDivElement | null>
  }
) => render(buildChatMessageList(currentSession, options))

describe('ChatMessageList context compression summary', () => {
  it('renders compressed context as a collapsed expandable row', () => {
    renderChatMessageList({
      id: 'compressed-session',
      title: 'Compressed session',
      messages: [],
      contextCompression: {
        summary: '### Current Goal\nKeep the user goal and key facts available.',
        coveredMessageCount: 6,
        sourceHash: 'source-hash',
        estimatedSourceTokens: 1200,
        estimatedSummaryTokens: 64,
        updatedAt: 1_700_000,
        manual: false
      }
    })

    expect(screen.getByTestId('chat-context-summary-card')).toBeInTheDocument()
    expect(screen.getByTestId('chat-context-summary-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('chat-context-summary-content')).toBeNull()
    expect(screen.queryByText('chat.welcome_message')).toBeNull()

    fireEvent.click(screen.getByTestId('chat-context-summary-toggle'))

    expect(screen.getByTestId('chat-context-summary-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('chat-context-summary-content')).toBeInTheDocument()
    expect(screen.getByText('Keep the user goal and key facts available.')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('chat-context-summary-toggle'))

    expect(screen.getByTestId('chat-context-summary-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('chat-context-summary-content')).toBeNull()
  })
})

describe('ChatMessageList 3D export gating', () => {
  it('keeps Unity/Unreal actions enabled for supported model formats', () => {
    const attachment: ChatAttachment = {
      type: 'model3d',
      url: 'local-media://scene.glb',
      fileName: 'scene.glb'
    }
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        attachments: [attachment]
      }
    ]

    renderChatMessageList({
      id: 'session-supported',
      title: 'Supported model',
      messages
    })

    expect(screen.getByRole('button', { name: 'Unity' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unreal' })).not.toBeDisabled()
  })

  it('disables Unity/Unreal actions for unsupported model formats and surfaces a hint', () => {
    const attachment: ChatAttachment = {
      type: 'model3d',
      url: 'local-media://scene.usdz',
      fileName: 'scene.usdz'
    }
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        attachments: [attachment]
      }
    ]

    renderChatMessageList({
      id: 'session-unsupported',
      title: 'Unsupported model',
      messages
    })

    const unityButton = screen.getByRole('button', { name: 'Unity' })
    const unrealButton = screen.getByRole('button', { name: 'Unreal' })

    expect(unityButton).toBeDisabled()
    expect(unrealButton).toBeDisabled()
    expect(unityButton).toHaveAttribute('title', 'Unsupported model format: scene.usdz')
    expect(unrealButton).toHaveAttribute('title', 'Unsupported model format: scene.usdz')
  })
})

describe('ChatMessageList text selection and reply actions', () => {
  beforeEach(() => {
    notifySuccessMock.mockReset()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn()
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps assistant reply text selectable and renders reply actions below the answer', () => {
    renderChatMessageList({
      id: 'session-reply',
      title: 'Reply',
      messages: [
        {
          role: 'assistant',
          content: 'This reply stays selectable.'
        }
      ]
    })

    const content = screen.getByTestId('assistant-markdown-content')
    const text = screen.getByText('This reply stays selectable.')
    const actions = screen.getByTestId('assistant-reply-actions')
    const dragHandle = screen.getByLabelText('\u62d6\u62fd\u56de\u7b54\u5230\u753b\u677f')

    expect(content).not.toHaveAttribute('draggable', 'true')
    expect(dragHandle).toHaveAttribute('draggable', 'true')
    expect(text.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not render the assistant model above the reply body', () => {
    renderChatMessageList({
      id: 'session-reply-model',
      title: 'Reply model',
      messages: [
        {
          role: 'assistant',
          content: 'This reply has a model label.',
          modelName: 'GPT-4o'
        }
      ]
    })

    expect(screen.queryByTestId('assistant-model-label')).toBeNull()
    expect(screen.getByText('This reply has a model label.')).toBeInTheDocument()
  })

  it('copies the assistant reply from the action bar and shows copied feedback', () => {
    renderChatMessageList({
      id: 'session-copy-reply',
      title: 'Reply copy',
      messages: [
        {
          role: 'assistant',
          content: 'Copy this reply.'
        }
      ]
    })

    const writeTextMock = vi.mocked(navigator.clipboard.writeText)

    fireEvent.click(screen.getByLabelText('Copy reply'))

    expect(writeTextMock).toHaveBeenCalledWith('Copy this reply.')
    expect(notifySuccessMock).toHaveBeenCalledWith('Reply copied')
    expect(screen.getByLabelText('Reply copied')).toBeInTheDocument()
    expect(screen.getByTestId('copy-done-icon')).toBeInTheDocument()
  })

  it('keeps the Agent thread scrollbar fixed when clicking edit on a long prompt', () => {
    const content = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join(
      String.fromCharCode(10)
    )
    const session: ChatSession = {
      id: 'agent-thread-edit-scroll',
      title: 'Agent thread edit scroll',
      messages: [{ role: 'user', content }]
    }
    const chatContainerRef = React.createRef<HTMLDivElement>()
    const messagesEndRef = React.createRef<HTMLDivElement>()

    const Harness = () => {
      const [editingMessageIndex, setEditingMessageIndex] = React.useState<number | null>(null)
      const [editingContent, setEditingContent] = React.useState('')

      return buildChatMessageList(session, {
        active: true,
        editingMessageIndex,
        editingContent,
        onSetEditingIndex: setEditingMessageIndex,
        onSetEditingContent: setEditingContent,
        chatContainerRef,
        messagesEndRef
      })
    }

    const focusSpy = vi.spyOn(window.HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement
    ) {
      const scrollContainer = this.closest(
        '[data-chat-scroll-container="true"]'
      ) as HTMLElement | null
      if (!scrollContainer) return
      scrollContainer.scrollTop = 0
      scrollContainer.scrollLeft = 0
    })

    try {
      render(<Harness />)
      const scrollContainer = screen.getByTestId('chat-message-list')
      Object.defineProperties(scrollContainer, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 400 }
      })
      scrollContainer.scrollTop = 720
      scrollContainer.scrollLeft = 9
      const initialBottomOffset =
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop

      fireEvent.click(screen.getByRole('button', { name: 'chat.edit_message' }))

      expect(screen.getByRole('textbox')).toBeInTheDocument()
      expect(focusSpy).toHaveBeenCalled()
      expect(
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop
      ).toBe(initialBottomOffset)
      expect(scrollContainer.scrollLeft).toBe(9)
    } finally {
      focusSpy.mockRestore()
    }
  })

  it('keeps a manually moved caret and scroll position while typing near the start', async () => {
    const user = userEvent.setup()
    const content = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}`).join(
      String.fromCharCode(10)
    )
    const session: ChatSession = {
      id: 'session-edit-caret',
      title: 'Edit caret',
      messages: [{ role: 'user', content }]
    }
    const chatContainerRef = React.createRef<HTMLDivElement>()
    const messagesEndRef = React.createRef<HTMLDivElement>()
    const onSetEditingContent = vi.fn()

    const { rerender } = renderChatMessageList(session, {
      editingMessageIndex: 0,
      editingContent: content,
      onSetEditingContent,
      chatContainerRef,
      messagesEndRef
    })

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement
    const scrollContainer = editor.closest('[data-chat-scroll-container="true"]') as HTMLDivElement
    expect(editor.selectionStart).toBe(content.length)
    expect(editor.selectionEnd).toBe(content.length)

    editor.setSelectionRange(0, 0)
    editor.scrollTop = 0
    scrollContainer.scrollTop = 320

    await user.type(editor, 'X', { skipClick: true })
    expect(onSetEditingContent).toHaveBeenLastCalledWith(`X${content}`)

    rerender(
      buildChatMessageList(session, {
        editingMessageIndex: 0,
        editingContent: `X${content}`,
        onSetEditingContent,
        chatContainerRef,
        messagesEndRef
      })
    )

    expect(editor.value).toBe(`X${content}`)
    expect(editor.selectionStart).toBe(1)
    expect(editor.selectionEnd).toBe(1)
    expect(editor.scrollTop).toBe(0)
    expect(scrollContainer.scrollTop).toBe(320)
  })

  it('allows resubmitting an edited user message without changing its text', () => {
    const onSendEditedMessage = vi.fn()
    const attachment: ChatAttachment = {
      type: 'image',
      url: 'local-media:///demo/reference.png',
      fileName: 'reference.png'
    }
    const session: ChatSession = {
      id: 'session-resubmit-unchanged-edit',
      title: 'Resubmit unchanged edit',
      messages: [
        {
          role: 'user',
          content: 'Try the same prompt again.',
          attachments: [attachment],
          hiddenContext: 'canvas context'
        },
        {
          role: 'assistant',
          content: 'First reply.'
        }
      ]
    }

    renderChatMessageList(session, {
      editingMessageIndex: 0,
      editingContent: 'Try the same prompt again.',
      onSendEditedMessage
    })

    const submitButton = screen.getByRole('button', { name: 'Save & Rerun' })
    expect(submitButton).not.toBeDisabled()

    fireEvent.click(submitButton)

    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'Try the same prompt again.',
      [attachment],
      'canvas context',
      []
    )
  })

  it('downloads assistant replies from the icon menu using the previous user context', () => {
    const originalCreateElement = document.createElement.bind(document)
    const clickedDownloads: string[] = []
    const createObjectURLMock = vi.fn(() => 'blob:reply-download')
    const revokeObjectURLMock = vi.fn()

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURLMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURLMock
    })

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName)
      if (tagName.toLowerCase() === 'a') {
        ;(element as HTMLAnchorElement).click = vi.fn(() => {
          clickedDownloads.push((element as HTMLAnchorElement).download)
        })
      }
      return element
    }) as typeof document.createElement)

    renderChatMessageList({
      id: 'session-download-reply',
      title: 'Reply download',
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,HIDDEN',
              fileName: 'canvas-selection.png',
              hiddenFromChatView: true
            },
            {
              type: 'image',
              url: 'local-media:///demo/reference.png',
              fileName: 'reference.png'
            }
          ]
        },
        {
          role: 'assistant',
          content: '# Tag Result'
        }
      ]
    })

    fireEvent.click(screen.getByLabelText('\u4e0b\u8f7d\u56de\u7b54'))
    fireEvent.click(screen.getByLabelText('Markdown (.md)'))
    fireEvent.click(screen.getByLabelText('\u4e0b\u8f7d\u56de\u7b54'))
    fireEvent.click(screen.getByLabelText('Text (.txt)'))

    expect(clickedDownloads).toEqual(['reference.md', 'reference.txt'])
    expect(createObjectURLMock).toHaveBeenCalledTimes(2)
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2)
  })

  it('does not leave the assistant reply download menu open while inactive', () => {
    const session: ChatSession = {
      id: 'session-inactive-download-menu',
      title: 'Inactive reply download',
      messages: [
        {
          role: 'assistant',
          content: 'Hidden thread reply.'
        }
      ]
    }

    const view = renderChatMessageList(session, { active: false })

    fireEvent.click(screen.getByLabelText('\u4e0b\u8f7d\u56de\u7b54'))
    view.rerender(buildChatMessageList(session, { active: true }))

    expect(screen.queryByLabelText('Markdown (.md)')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Text (.txt)')).not.toBeInTheDocument()
  })

  it('offers direct image download options for attachment-only assistant replies', () => {
    const onDownloadAttachment = vi.fn()
    const imageAttachment: ChatAttachment = {
      type: 'image',
      url: 'local-media:///demo/render.webp',
      fileName: 'render.webp',
      mimeType: 'image/webp'
    }

    renderChatMessageList(
      {
        id: 'session-image-only-download',
        title: 'Image only',
        messages: [
          {
            role: 'assistant',
            content: '',
            attachments: [imageAttachment]
          }
        ]
      },
      { onDownloadAttachment }
    )

    fireEvent.click(screen.getByLabelText('下载附件'))
    fireEvent.click(screen.getByLabelText('Image: render.webp'))

    expect(onDownloadAttachment).toHaveBeenCalledWith(imageAttachment)
    expect(notifySuccessMock).toHaveBeenCalledWith('render.webp downloaded')
  })

  it('keeps attachment and text downloads together for mixed assistant replies', () => {
    const originalCreateElement = document.createElement.bind(document)
    const clickedDownloads: string[] = []
    const onDownloadAttachment = vi.fn()
    const createObjectURLMock = vi.fn(() => 'blob:mixed-download')
    const revokeObjectURLMock = vi.fn()

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURLMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURLMock
    })

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName)
      if (tagName.toLowerCase() === 'a') {
        ;(element as HTMLAnchorElement).click = vi.fn(() => {
          clickedDownloads.push((element as HTMLAnchorElement).download)
        })
      }
      return element
    }) as typeof document.createElement)

    const imageAttachment: ChatAttachment = {
      type: 'image',
      url: 'local-media:///demo/hero-shot.png',
      fileName: 'hero-shot.png',
      mimeType: 'image/png'
    }

    renderChatMessageList(
      {
        id: 'session-mixed-download',
        title: 'Mixed reply',
        messages: [
          {
            role: 'user',
            content: 'describe and render'
          },
          {
            role: 'assistant',
            content: 'Here is the render.',
            attachments: [imageAttachment]
          }
        ]
      },
      { onDownloadAttachment }
    )

    fireEvent.click(screen.getByLabelText('\u4e0b\u8f7d\u56de\u7b54'))
    expect(screen.getByLabelText('Image: hero-shot.png')).toBeInTheDocument()
    expect(screen.getByLabelText('Markdown (.md)')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Image: hero-shot.png'))
    fireEvent.click(screen.getByLabelText('\u4e0b\u8f7d\u56de\u7b54'))
    fireEvent.click(screen.getByLabelText('Markdown (.md)'))

    expect(onDownloadAttachment).toHaveBeenCalledWith(imageAttachment)
    expect(clickedDownloads).toEqual(['describe and render.md'])
    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1)
  })

  it('treats built-in tagging replies as sidecar exports instead of generic reply downloads', () => {
    const originalCreateElement = document.createElement.bind(document)
    const clickedDownloads: string[] = []
    const createObjectURLMock = vi.fn(() => 'blob:sidecar-download')
    const revokeObjectURLMock = vi.fn()

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURLMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURLMock
    })

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName)
      if (tagName.toLowerCase() === 'a') {
        ;(element as HTMLAnchorElement).click = vi.fn(() => {
          clickedDownloads.push((element as HTMLAnchorElement).download)
        })
      }
      return element
    }) as typeof document.createElement)

    renderChatMessageList({
      id: 'session-tagging-sidecar',
      title: 'Tagging',
      skillId: 'builtin-tagging',
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'local-media:///demo/sprite.png',
              fileName: 'sprite.png'
            }
          ]
        },
        {
          role: 'assistant',
          content: 'tag_a, tag_b'
        }
      ]
    })

    fireEvent.click(screen.getByLabelText('导出 sidecar'))
    fireEvent.click(screen.getByLabelText('Sidecar (.txt)'))
    fireEvent.click(screen.getByLabelText('导出 sidecar'))
    fireEvent.click(screen.getByLabelText('Markdown record (.md)'))

    expect(clickedDownloads).toEqual(['sprite.txt', 'sprite.md'])
    expect(notifySuccessMock).toHaveBeenCalledWith('sprite.txt exported as sidecar')
    expect(createObjectURLMock).toHaveBeenCalledTimes(2)
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2)
  })

  it('offers batch sidecar export on the last sidecar reply and deduplicates repeated base names', () => {
    const originalCreateElement = document.createElement.bind(document)
    const clickedDownloads: string[] = []
    const createObjectURLMock = vi.fn(() => 'blob:sidecar-batch-download')
    const revokeObjectURLMock = vi.fn()

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURLMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURLMock
    })

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName)
      if (tagName.toLowerCase() === 'a') {
        ;(element as HTMLAnchorElement).click = vi.fn(() => {
          clickedDownloads.push((element as HTMLAnchorElement).download)
        })
      }
      return element
    }) as typeof document.createElement)

    renderChatMessageList({
      id: 'session-tagging-sidecar-batch',
      title: 'Tagging batch',
      skillId: 'builtin-tagging',
      messages: [
        {
          role: 'assistant',
          content: 'tag_a',
          preferredDownloadBaseName: 'sprite'
        },
        {
          role: 'assistant',
          content: 'tag_b',
          preferredDownloadBaseName: 'sprite'
        }
      ]
    })

    fireEvent.click(screen.getAllByLabelText(/sidecar/)[1] as HTMLElement)
    fireEvent.click(screen.getByLabelText('All sidecars (.txt)'))

    expect(clickedDownloads).toEqual(['sprite.txt', 'sprite_2.txt'])
    expect(notifySuccessMock).toHaveBeenCalledWith('2 sidecar files exported')
    expect(createObjectURLMock).toHaveBeenCalledTimes(2)
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2)
  })

  it('does not render backend-only hidden attachments inside chat bubbles', () => {
    const { container } = renderChatMessageList({
      id: 'session-hidden-attachments',
      title: 'Hidden attachments',
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,VISIBLE',
              fileName: 'visible.png'
            },
            {
              type: 'image',
              url: 'data:image/png;base64,HIDDEN',
              fileName: 'canvas-selection.png',
              hiddenFromChatView: true
            }
          ]
        }
      ]
    })

    const renderedImages = Array.from(container.querySelectorAll('img'))

    expect(renderedImages).toHaveLength(1)
    expect(renderedImages[0]?.getAttribute('src')).toContain('VISIBLE')
    expect(renderedImages[0]?.getAttribute('src')).not.toContain('HIDDEN')
  })

  it('keeps user prompt text selectable and exposes a dedicated drag handle', () => {
    const setData = vi.fn()
    const dataTransfer = {
      setData,
      effectAllowed: 'all'
    }

    const { container } = renderChatMessageList({
      id: 'session-user',
      title: 'Prompt',
      messages: [
        {
          role: 'user',
          content: 'This is a user prompt.'
        }
      ]
    })

    const userPrompt = screen.getByText('This is a user prompt.')
    const handles = Array.from(container.querySelectorAll('[draggable="true"]'))
    const textHandle = handles.find((element) => element.getAttribute('aria-label'))

    expect(userPrompt.closest('[draggable="true"]')).toBeNull()
    expect(textHandle).toBeTruthy()

    fireEvent.dragStart(textHandle as Element, {
      dataTransfer
    })

    expect(setData).toHaveBeenCalledWith('text/plain', 'This is a user prompt.')
  })

  it('renders local user image attachments through the local-media protocol', () => {
    renderChatMessageList({
      id: 'session-user-image',
      title: 'User image',
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'file:///C:/demo/reference.png',
              fileName: 'reference.png'
            }
          ]
        }
      ]
    })

    const image = screen.getByRole('img', { name: 'Attachment image 1' })

    expect(image).toHaveAttribute('src', 'local-media:///C:/demo/reference.png')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
    expect(image).toHaveAttribute('width', '320')
    expect(image).toHaveAttribute('height', '240')

    fireEvent.error(image)
    expect(
      screen.getByRole('img', { name: 'Attachment image 1 failed to load' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Attachment image 1' })).not.toBeInTheDocument()
  })

  it('keeps generation feedback inside the assistant placeholder instead of the latest user bubble', () => {
    renderChatMessageList(
      {
        id: 'session-running',
        title: 'Running',
        messages: [
          {
            role: 'user',
            content: 'First prompt'
          },
          {
            role: 'assistant',
            content: 'First reply'
          },
          {
            role: 'user',
            content: 'Latest prompt'
          },
          {
            role: 'assistant',
            content: ''
          }
        ]
      },
      { isLoading: true }
    )

    expect(screen.queryByTestId('user-message-running-indicator')).toBeNull()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('lets users remove an existing image before rerunning an edited message', async () => {
    const onSendEditedMessage = vi.fn<OnSendEditedMessage>()
    const keptAttachment: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,kept',
      fileName: 'kept.png'
    }
    const removedAttachment: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,removed',
      fileName: 'removed.png'
    }

    renderChatMessageList(
      {
        id: 'session-edit-attachments',
        title: 'Edit attachments',
        messages: [
          {
            role: 'user',
            content: 'Describe these images',
            attachments: [keptAttachment, removedAttachment]
          }
        ]
      },
      {
        editingMessageIndex: 0,
        editingContent: 'Describe the remaining image',
        onSendEditedMessage
      }
    )

    expect(screen.getByText('kept.png')).toBeInTheDocument()
    expect(screen.getByText('removed.png')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove removed.png' }))
    expect(screen.queryByText('removed.png')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))

    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'Describe the remaining image',
      [keptAttachment],
      undefined,
      []
    )
  })

  it('submits no attachments after removing every image from an edited message', async () => {
    const onSendEditedMessage = vi.fn<OnSendEditedMessage>()
    const attachment: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,only',
      fileName: 'only.png'
    }

    renderChatMessageList(
      {
        id: 'session-edit-remove-all',
        title: 'Remove all attachments',
        messages: [{ role: 'user', content: 'Describe it', attachments: [attachment] }]
      },
      {
        editingMessageIndex: 0,
        editingContent: 'Text only now',
        onSendEditedMessage
      }
    )

    await userEvent.click(screen.getByRole('button', { name: 'Remove only.png' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))

    expect(onSendEditedMessage).toHaveBeenCalledWith('Text only now', undefined, undefined, [])
  })

  it('makes assistant file attachments draggable for canvas drops', () => {
    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => {
        data.set(type, value)
      },
      effectAllowed: 'all'
    }

    const { container } = renderChatMessageList({
      id: 'session-file',
      title: 'File attachment',
      messages: [
        {
          role: 'assistant',
          content: 'OCR finished.',
          attachments: [
            {
              type: 'file',
              url: 'file:///C:/demo/result.xlsx',
              fileName: 'result.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }
          ]
        }
      ]
    })

    const draggable = Array.from(container.querySelectorAll('[draggable="true"]')).find((element) =>
      element.textContent?.includes('result.xlsx')
    )

    expect(draggable).toBeTruthy()

    fireEvent.dragStart(draggable as Element, {
      dataTransfer
    })

    expect(data.get(QAPP_IMAGE_DRAG_MIME)).toBeTruthy()
    expect(dataTransfer.effectAllowed).toBe('copy')
  })

  it('uses the dragged attachment OCR bundle instead of the whole message fallback', () => {
    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => {
        data.set(type, value)
      },
      effectAllowed: 'all'
    }

    const { container } = renderChatMessageList({
      id: 'session-file-ocr',
      title: 'File attachment OCR',
      messages: [
        {
          role: 'assistant',
          content: 'Two OCR exports are ready.',
          ocrResult: {
            kind: 'table',
            text: 'legacy fallback'
          },
          attachments: [
            {
              type: 'file',
              url: 'file:///C:/demo/result-a.csv',
              fileName: 'result-a.csv',
              mimeType: 'text/csv',
              ocrResult: {
                kind: 'table',
                text: 'Alpha'
              }
            },
            {
              type: 'file',
              url: 'file:///C:/demo/result-b.csv',
              fileName: 'result-b.csv',
              mimeType: 'text/csv',
              ocrResult: {
                kind: 'table',
                text: 'Beta'
              }
            }
          ]
        }
      ]
    })

    const draggable = Array.from(container.querySelectorAll('[draggable="true"]')).find((element) =>
      element.textContent?.includes('result-b.csv')
    )

    fireEvent.dragStart(draggable as Element, {
      dataTransfer
    })

    const payload = JSON.parse(data.get(QAPP_IMAGE_DRAG_MIME) || '{}')

    expect(payload.attachments?.[0]?.ocrResult).toEqual({
      kind: 'table',
      text: 'Beta'
    })
    expect(payload.ocrResult).toEqual({
      kind: 'table',
      text: 'Beta'
    })
  })
})

describe('ChatMessageList managed image derivatives', () => {
  const reference = {
    version: 1 as const,
    kind: 'managed' as const,
    relativePath: 'assets/original.png',
    sha256: 'a'.repeat(64),
    sizeBytes: 4096,
    mimeType: 'image/png',
    originalFileName: 'original.png'
  }
  let intersectionCallbacks: IntersectionObserverCallback[]
  let intersectionOptions: IntersectionObserverInit[]
  let resizeCallback: ResizeObserverCallback | null = null
  const ensureDerivative = vi.fn()

  beforeEach(() => {
    ensureDerivative.mockReset()
    resetChatImageDerivativeCacheForTests()
    intersectionCallbacks = []
    intersectionOptions = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { svcManagedMedia: { ensureDerivative } }
    })
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        callback: IntersectionObserverCallback
        readonly root: Element | Document | null
        readonly rootMargin: string
        readonly thresholds: readonly number[]
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.callback = callback
          this.root = options?.root ?? null
          this.rootMargin = options?.rootMargin ?? '0px'
          this.thresholds = Array.isArray(options?.threshold)
            ? options.threshold
            : [options?.threshold ?? 0]
          intersectionCallbacks.push(callback)
          intersectionOptions.push(options ?? {})
        }
        observe(target: Element) {
          void target
        }
        disconnect() {
          intersectionCallbacks = intersectionCallbacks.filter(
            (callback) => callback !== this.callback
          )
        }
        unobserve(target: Element) {
          void target
        }
        takeRecords(): IntersectionObserverEntry[] {
          return []
        }
      }
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly callback: ResizeObserverCallback
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
          resizeCallback = callback
        }
        observe(target: Element) {
          void target
        }
        disconnect() {
          resizeCallback = null
        }
        unobserve(target: Element) {
          void target
        }
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const session = (attachments: ChatAttachment[]): ChatSession => ({
    id: 'managed-images',
    title: 'Managed images',
    messages: [{ role: 'assistant', content: '', attachments }]
  })

  const managedAttachment = (url = 'C:/demo/original.png'): ChatAttachment => ({
    type: 'image',
    url,
    media: reference,
    sourceWidth: 400,
    sourceHeight: 200
  })

  const markIntersection = (isIntersecting: boolean) =>
    intersectionCallbacks.forEach((callback) =>
      callback([{ isIntersecting } as unknown as IntersectionObserverEntry], {} as never)
    )
  const markNear = () => markIntersection(true)

  it('maps CSS dimensions and clamped DPR to derivative buckets', () => {
    expect(getChatImageDerivativeMaxEdge(100, 0.5)).toBe(256)
    expect(getChatImageDerivativeMaxEdge(200, 2)).toBe(512)
    expect(getChatImageDerivativeMaxEdge(400, 3)).toBe(2048)
  })

  it.each([
    ['legacy path', 'C:/demo/legacy.png', 'local-media:///C:/demo/legacy.png'],
    ['data URL', 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['blob URL', 'blob:https://example.com/image-id', 'blob:https://example.com/image-id'],
    ['file URL', 'file:///C:/demo/file.png', 'local-media:///C:/demo/file.png'],
    ['remote URL', 'https://example.com/remote.png', 'https://example.com/remote.png']
  ])(
    'releases and restores an unmanaged %s image around the viewport',
    (_label, url, expectedSrc) => {
      renderChatMessageList(
        session([
          {
            type: 'image',
            url,
            sourceWidth: 400,
            sourceHeight: 200
          }
        ])
      )

      expect(screen.queryByRole('img', { name: 'Attachment image 1' })).not.toBeInTheDocument()
      expect(intersectionCallbacks).toHaveLength(1)

      act(() => markNear())
      const image = screen.getByRole('img', { name: 'Attachment image 1' })
      expect(image).toHaveAttribute('src', expectedSrc)

      act(() => markIntersection(false))
      expect(screen.queryByRole('img', { name: 'Attachment image 1' })).not.toBeInTheDocument()

      act(() => markNear())
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        expectedSrc
      )
      expect(ensureDerivative).not.toHaveBeenCalled()
    }
  )

  it('keeps a stable placeholder and performs no image IO without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    renderChatMessageList(session([managedAttachment()]))

    expect(screen.getByTestId('chat-image-frame')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Attachment image 1' })).not.toBeInTheDocument()
    expect(ensureDerivative).not.toHaveBeenCalled()
  })

  it('uses the nearest chat scroller as the observer root', () => {
    renderChatMessageList(session([managedAttachment()]))

    const scroller = screen.getByTestId('chat-message-list')
    expect(scroller).toHaveAttribute('data-chat-scroll-root')
    expect(intersectionOptions[0]?.root).toBe(scroller)
    expect(intersectionOptions[0]?.rootMargin).toBe('800px 0px')
  })

  it('bounds resolved cache entries and expires them after 30 minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    ensureDerivative.mockImplementation(({ reference: requestReference }) =>
      Promise.resolve({
        status: 'fallbackOriginal',
        reason: 'animated-gif',
        localMediaUrl: `local-media:///${requestReference.relativePath}`
      })
    )

    for (let index = 0; index < 257; index += 1) {
      await ensureCachedChatImageDerivative(
        { ensureDerivative } as never,
        {
          ...reference,
          relativePath: `assets/${index}.png`,
          sha256: index.toString(16).padStart(64, '0')
        },
        512
      )
    }
    expect(getChatImageDerivativeCacheSizeForTests()).toBe(256)

    const newestReference = {
      ...reference,
      relativePath: 'assets/256.png',
      sha256: (256).toString(16).padStart(64, '0')
    }
    await ensureCachedChatImageDerivative({ ensureDerivative } as never, newestReference, 512)
    expect(ensureDerivative).toHaveBeenCalledTimes(257)

    vi.advanceTimersByTime(30 * 60 * 1000 + 1)
    await ensureCachedChatImageDerivative({ ensureDerivative } as never, newestReference, 512)
    expect(ensureDerivative).toHaveBeenCalledTimes(258)
    vi.useRealTimers()
  })

  it('bounds pending cache entries at 64 and times them out after 30 seconds', async () => {
    vi.useFakeTimers()
    const neverSettles = vi.fn(() => new Promise(() => undefined))
    const observedPromises: Promise<{ status: 'rejected'; error: unknown }>[] = []

    for (let index = 0; index < 65; index += 1) {
      const pending = ensureCachedChatImageDerivative(
        { ensureDerivative: neverSettles } as never,
        {
          ...reference,
          relativePath: `assets/pending-${index}.png`,
          sha256: index.toString(16).padStart(64, '0')
        },
        512
      )
      observedPromises.push(
        pending.then(
          () => {
            throw new Error('Expected pending derivative request to reject')
          },
          (error) => ({ status: 'rejected' as const, error })
        )
      )
    }

    await expect(observedPromises[0]).resolves.toMatchObject({
      status: 'rejected',
      error: new Error('Managed media derivative request evicted')
    })
    expect(getChatImageDerivativeCacheSizeForTests()).toBeLessThanOrEqual(64)

    vi.advanceTimersByTime(29_999)
    expect(getChatImageDerivativeCacheSizeForTests()).toBe(64)
    vi.advanceTimersByTime(1)

    const timedOut = await Promise.all(observedPromises.slice(1))
    expect(timedOut).toHaveLength(64)
    expect(timedOut.every(({ error }) => String(error).includes('timed out'))).toBe(true)
    expect(getChatImageDerivativeCacheSizeForTests()).toBe(0)
  })

  it('waits until near viewport, then displays ready derivative while callbacks keep original', async () => {
    ensureDerivative.mockResolvedValue({
      status: 'ready',
      descriptor: {
        maxEdge: 512,
        relativePath: 'derivatives/preview.webp',
        mimeType: 'image/webp',
        sizeBytes: 1024,
        width: 400,
        height: 200,
        sha256: 'b'.repeat(64),
        localMediaUrl: 'local-media:///derivatives/preview.webp'
      }
    })
    const onPreviewImage = vi.fn()
    const onImageContextMenu = vi.fn()
    renderChatMessageList(session([managedAttachment()]), { onPreviewImage, onImageContextMenu })
    expect(screen.queryByRole('img', { name: 'Attachment image 1' })).not.toBeInTheDocument()
    const frame = screen.getByTestId('chat-image-frame')
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 100
    } as DOMRect)

    expect(ensureDerivative).not.toHaveBeenCalled()
    markNear()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledWith({ reference, maxEdge: 512 }))
    const image = await screen.findByRole('img', { name: 'Attachment image 1' })
    expect(image).toHaveAttribute('src', 'local-media:///derivatives/preview.webp')

    markIntersection(false)
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: 'Attachment image 1' })).not.toBeInTheDocument()
    )
    markNear()
    const cachedImage = await screen.findByRole('img', { name: 'Attachment image 1' })
    expect(ensureDerivative).toHaveBeenCalledTimes(1)

    fireEvent.click(cachedImage)
    fireEvent.contextMenu(cachedImage)
    expect(onPreviewImage).toHaveBeenCalledWith('C:/demo/original.png')
    expect(onImageContextMenu).toHaveBeenCalledWith(expect.anything(), 'C:/demo/original.png')
  })

  it('keeps original on fallback/failure and reverts a broken derivative before final error', async () => {
    ensureDerivative
      .mockResolvedValueOnce({
        status: 'fallbackOriginal',
        reason: 'animated-gif',
        localMediaUrl: 'local-media:///assets/original.png'
      })
      .mockResolvedValueOnce({
        status: 'ready',
        descriptor: {
          maxEdge: 512,
          relativePath: 'derivatives/broken.webp',
          mimeType: 'image/webp',
          sizeBytes: 1024,
          width: 400,
          height: 200,
          sha256: 'c'.repeat(64),
          localMediaUrl: 'local-media:///derivatives/broken.webp'
        }
      })
    const first = renderChatMessageList(session([managedAttachment()]))
    markNear()
    let image = await screen.findByRole('img', { name: 'Attachment image 1' })
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(1))
    expect(image).toHaveAttribute('src', 'local-media:///assets/original.png')
    first.unmount()

    renderChatMessageList(
      session([
        {
          ...managedAttachment('C:/demo/second.png'),
          media: {
            ...reference,
            relativePath: 'assets/second.png',
            sha256: 'd'.repeat(64),
            originalFileName: 'second.png'
          }
        }
      ])
    )
    markNear()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
        'src',
        'local-media:///derivatives/broken.webp'
      )
    )
    image = screen.getByRole('img', { name: 'Attachment image 1' })
    fireEvent.error(image)
    await waitFor(() => expect(image).toHaveAttribute('src', 'local-media:///C:/demo/second.png'))
    fireEvent.error(image)
    expect(
      screen.getByRole('img', { name: 'Attachment image 1 failed to load' })
    ).toBeInTheDocument()
  })

  it('keeps original when the service is missing or rejects', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    const missing = renderChatMessageList(session([managedAttachment()]))
    markNear()
    expect(await screen.findByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
      'src',
      'local-media:///C:/demo/original.png'
    )
    missing.unmount()

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { svcManagedMedia: { ensureDerivative } }
    })
    ensureDerivative.mockRejectedValue(new Error('serialized service failure'))
    renderChatMessageList(session([managedAttachment()]))
    markNear()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
      'src',
      'local-media:///C:/demo/original.png'
    )
  })

  it('ignores markdown/project assets and handles image requests independently', async () => {
    ensureDerivative.mockResolvedValue({
      status: 'fallbackOriginal',
      reason: 'animated-gif',
      localMediaUrl: 'local-media:///assets/original.png'
    })
    renderChatMessageList({
      id: 'mixed',
      title: 'Mixed',
      messages: [
        { role: 'assistant', content: '![markdown](https://example.com/a.png)' },
        {
          role: 'assistant',
          content: '',
          attachments: [
            managedAttachment('C:/demo/one.png'),
            managedAttachment('C:/demo/two.png'),
            {
              type: 'image',
              url: 'C:/demo/project.png',
              media: { version: 1, kind: 'project-asset', relativePath: 'project.png' }
            }
          ]
        }
      ]
    })
    markNear()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(1))
    expect(
      ensureDerivative.mock.calls.every(([request]) => request.reference.kind === 'managed')
    ).toBe(true)
  })

  it('requests a larger bucket after resize and ignores stale/unmounted responses', async () => {
    let resolveFirst!: (value: unknown) => void
    ensureDerivative
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({
        status: 'fallbackOriginal',
        reason: 'animated-gif',
        localMediaUrl: 'local-media:///assets/original.png'
      })
    const rendered = renderChatMessageList(session([managedAttachment()]))
    const frame = screen.getByTestId('chat-image-frame')
    vi.spyOn(frame, 'getBoundingClientRect')
      .mockReturnValueOnce({ width: 200, height: 100 } as DOMRect)
      .mockReturnValue({ width: 600, height: 300 } as DOMRect)
    markNear()
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledWith({ reference, maxEdge: 512 }))
    resizeCallback?.([], {} as never)
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledWith({ reference, maxEdge: 512 }))
    rendered.unmount()
    resolveFirst({
      status: 'ready',
      descriptor: { localMediaUrl: 'local-media:///derivatives/stale.webp' }
    })
    await Promise.resolve()
  })

  it('does not let a stale 512 response overwrite a newer 1024 display', async () => {
    let resolve512!: (value: unknown) => void
    let resolve1024!: (value: unknown) => void
    ensureDerivative.mockImplementation(({ maxEdge }) => {
      return new Promise((resolve) => {
        if (maxEdge === 512) resolve512 = resolve
        if (maxEdge === 1024) resolve1024 = resolve
      })
    })
    renderChatMessageList(
      session([
        {
          ...managedAttachment(),
          sourceWidth: 1200,
          sourceHeight: 600
        }
      ])
    )
    const frame = screen.getByTestId('chat-image-frame')
    let frameWidth = 200
    vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(
      () => ({ width: frameWidth, height: frameWidth / 2 }) as DOMRect
    )

    act(() => markNear())
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledWith({ reference, maxEdge: 512 }))

    frameWidth = 500
    act(() => resizeCallback?.([], {} as never))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledWith({ reference, maxEdge: 1024 }))

    await act(async () => {
      resolve1024({
        status: 'ready',
        descriptor: { localMediaUrl: 'local-media:///derivatives/1024.webp' }
      })
    })
    const image = await screen.findByRole('img', { name: 'Attachment image 1' })
    expect(image).toHaveAttribute('src', 'local-media:///derivatives/1024.webp')

    await act(async () => {
      resolve512({
        status: 'ready',
        descriptor: { localMediaUrl: 'local-media:///derivatives/512.webp' }
      })
    })
    expect(image).toHaveAttribute('src', 'local-media:///derivatives/1024.webp')
  })
})

describe('ChatMessageList dynamic-height virtualization', () => {
  let resizeObservers: Array<{
    callback: ResizeObserverCallback
    target?: Element
  }>

  beforeEach(() => {
    resizeObservers = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly record: { callback: ResizeObserverCallback; target?: Element }
        constructor(callback: ResizeObserverCallback) {
          this.record = { callback }
          resizeObservers.push(this.record)
        }
        observe(target: Element) {
          this.record.target = target
        }
        disconnect() {
          this.record.target = undefined
        }
        unobserve(target: Element) {
          if (this.record.target === target) this.record.target = undefined
        }
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const virtualSession: ChatSession = {
    id: 'virtualized-session',
    title: 'Virtualized session',
    messages: Array.from({ length: 100 }, (_, index) => ({
      role: 'assistant' as const,
      content: `Virtual message ${index}`
    }))
  }

  it('unmounts rows outside the viewport plus overscan', () => {
    const chatContainerRef = React.createRef<HTMLDivElement>()
    renderChatMessageList(virtualSession, { chatContainerRef })
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(screen.getByText('Virtual message 0')).toBeInTheDocument()
    expect(screen.queryByText('Virtual message 99')).toBeNull()
    expect(scroller.querySelectorAll('[data-chat-message-index]').length).toBeLessThan(100)

    act(() => {
      scroller.scrollTop = 10_800
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(screen.queryByText('Virtual message 0')).toBeNull()
    expect(screen.getByText('Virtual message 99')).toBeInTheDocument()
  })

  it('updates spacer height after a non-bottom row changes height', () => {
    const chatContainerRef = React.createRef<HTMLDivElement>()
    renderChatMessageList(virtualSession, { chatContainerRef })
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    const bottomSpacer = screen.getByTestId('chat-virtual-bottom-spacer')
    const initialHeight = Number.parseFloat(bottomSpacer.style.height)
    const firstObserver = resizeObservers.find(
      ({ target }) => target?.getAttribute('data-chat-message-index') === '0'
    )
    expect(firstObserver?.target).toBeTruthy()

    act(() => {
      firstObserver?.callback(
        [
          {
            target: firstObserver.target,
            contentRect: { height: 300 }
          } as unknown as ResizeObserverEntry
        ],
        {} as ResizeObserver
      )
    })

    const resizedBottomSpacer = screen.getByTestId('chat-virtual-bottom-spacer')
    expect(Number.parseFloat(resizedBottomSpacer.style.height)).toBeGreaterThan(initialHeight)
  })

  it('updates the bottom spacer when a below-viewport overscan row changes height', () => {
    const chatContainerRef = React.createRef<HTMLDivElement>()
    renderChatMessageList(virtualSession, { chatContainerRef })
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    const bottomSpacer = screen.getByTestId('chat-virtual-bottom-spacer')
    const initialHeight = Number.parseFloat(bottomSpacer.style.height)
    const belowViewportObserver = resizeObservers.find(
      ({ target }) => target?.getAttribute('data-chat-message-index') === '10'
    )
    expect(belowViewportObserver?.target).toBeTruthy()
    expect(screen.queryByText('Virtual message 10')).toBeInTheDocument()

    act(() => {
      belowViewportObserver?.callback(
        [
          {
            target: belowViewportObserver.target,
            contentRect: { height: 500 }
          } as unknown as ResizeObserverEntry
        ],
        {} as ResizeObserver
      )
    })

    expect(
      Number.parseFloat(screen.getByTestId('chat-virtual-bottom-spacer').style.height)
    ).toBeGreaterThan(initialHeight)
  })

  it('restores scroll positions independently when switching sessions', () => {
    const firstSession = {
      id: 'scroll-session-a',
      title: 'Session A',
      messages: [{ role: 'assistant' as const, content: 'A' }],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const secondSession = {
      ...firstSession,
      id: 'scroll-session-b',
      title: 'Session B',
      messages: [{ role: 'assistant' as const, content: 'B' }]
    }
    const { rerender } = renderChatMessageList(firstSession)
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 })

    act(() => {
      scroller.scrollTop = 175
      fireEvent.scroll(scroller)
    })

    rerender(buildChatMessageList(secondSession))
    expect(scroller.scrollTop).toBe(800)

    act(() => {
      scroller.scrollTop = 525
      fireEvent.scroll(scroller)
    })

    rerender(buildChatMessageList(firstSession))
    expect(scroller.scrollTop).toBe(175)

    rerender(buildChatMessageList(secondSession))
    expect(scroller.scrollTop).toBe(525)
  })

  it('preserves no-id row identity when messages are prepended', () => {
    const chatContainerRef = React.createRef<HTMLDivElement>()
    const originalMessages = virtualSession.messages
    const rendered = renderChatMessageList(virtualSession, { chatContainerRef })
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })

    act(() => fireEvent.scroll(scroller))
    const originalIdentity = screen
      .getByText('Virtual message 0')
      .closest('[data-chat-message-identity]')
      ?.getAttribute('data-chat-message-identity')

    rendered.rerender(
      buildChatMessageList(
        {
          ...virtualSession,
          messages: [{ role: 'assistant', content: 'Prepended message' }, ...originalMessages]
        },
        { chatContainerRef }
      )
    )

    expect(
      screen
        .getByText('Virtual message 0')
        .closest('[data-chat-message-identity]')
        ?.getAttribute('data-chat-message-identity')
    ).toBe(originalIdentity)
  })

  it('keeps virtualization active when context compression is present', () => {
    const chatContainerRef = React.createRef<HTMLDivElement>()
    renderChatMessageList(
      {
        ...virtualSession,
        contextCompression: {
          summary: 'Compressed history',
          coveredMessageCount: 20,
          sourceHash: 'virtual-source',
          estimatedSourceTokens: 2_000,
          estimatedSummaryTokens: 50,
          updatedAt: 1_700_000,
          manual: false
        }
      },
      { chatContainerRef }
    )
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })

    act(() => {
      scroller.scrollTop = 3_000
      fireEvent.scroll(scroller)
    })

    expect(screen.getByTestId('chat-context-summary-card')).toBeInTheDocument()
    expect(screen.getByTestId('chat-virtual-top-spacer')).toBeInTheDocument()
    expect(scroller.querySelectorAll('[data-chat-message-index]').length).toBeLessThan(100)
  })

  it('keeps virtualization active while loading so the streaming bottom row stays mounted', () => {
    const chatContainerRef = React.createRef<HTMLDivElement>()
    renderChatMessageList(virtualSession, { isLoading: true, chatContainerRef })
    const scroller = screen.getByTestId('chat-message-list')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })

    act(() => {
      scroller.scrollTop = 3_000
      fireEvent.scroll(scroller)
    })

    expect(screen.getByTestId('chat-virtual-top-spacer')).toBeInTheDocument()
    expect(screen.getByTestId('chat-virtual-loading-gap')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-virtual-bottom-spacer')).toBeNull()
    expect(scroller.querySelectorAll('[data-chat-message-index]').length).toBeLessThan(100)
    expect(screen.getByText('Virtual message 99')).toBeInTheDocument()
  })
})

describe('ChatMessageList layout', () => {
  it('allows long replies to scroll instead of pushing the composer out', () => {
    renderChatMessageList({
      id: 'session-long-reply',
      title: 'Long reply',
      messages: [
        {
          role: 'assistant',
          content: Array.from({ length: 60 }, (_, index) => `${index + 1}. long reply line`).join(
            '\n'
          )
        }
      ]
    })

    expect(screen.getByTestId('chat-message-list')).toHaveStyle({
      flex: '1',
      minHeight: '0',
      overflow: 'auto'
    })
  })
})
