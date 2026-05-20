import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList from './ChatMessageList'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import type {
  ChatAttachment,
  ChatMessage
} from '../../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import type { ChatSession } from '../chatStorage'

const notifySuccessMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: notifySuccessMock
  })
}))

const buildChatMessageList = (
  currentSession: ChatSession,
  options?: {
    active?: boolean
    isLoading?: boolean
    editingMessageIndex?: number | null
    editingContent?: string
    onSendEditedMessage?: ReturnType<typeof vi.fn>
    onDownloadAttachment?: ReturnType<typeof vi.fn>
  }
) => (
  <ThemeProvider theme={createTheme()}>
    <ChatMessageList
      active={options?.active}
      currentSession={currentSession}
      isLoading={options?.isLoading ?? false}
      editingMessageIndex={options?.editingMessageIndex ?? null}
      editingContent={options?.editingContent ?? ''}
      onSetEditingIndex={vi.fn()}
      onSetEditingContent={vi.fn()}
      onSendEditedMessage={options?.onSendEditedMessage ?? vi.fn()}
      onPreviewImage={vi.fn()}
      onImageContextMenu={vi.fn()}
      onDownloadAttachment={options?.onDownloadAttachment ?? vi.fn()}
      onSendModelToDcc={vi.fn()}
      chatContainerRef={React.createRef<HTMLDivElement>()}
      messagesEndRef={React.createRef<HTMLDivElement>()}
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
    onSendEditedMessage?: ReturnType<typeof vi.fn>
    onDownloadAttachment?: ReturnType<typeof vi.fn>
  }
) => render(buildChatMessageList(currentSession, options))

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

  it('copies the assistant reply from the action bar', () => {
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

    fireEvent.click(screen.getByLabelText('\u590d\u5236\u56de\u7b54'))

    expect(writeTextMock).toHaveBeenCalledWith('Copy this reply.')
    expect(notifySuccessMock).toHaveBeenCalledWith('\u56de\u7b54\u5df2\u590d\u5236')
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

    const submitButton = screen.getByRole('button', { name: '提交' })
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

    const image = screen.getByRole('img', { name: 'Attachment 1' })

    expect(image).toHaveAttribute('src', 'local-media:///C:/demo/reference.png')
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
