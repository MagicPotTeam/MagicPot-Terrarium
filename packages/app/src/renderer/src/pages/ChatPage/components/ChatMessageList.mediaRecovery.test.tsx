import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList, { resetChatImageDerivativeCacheForTests } from './ChatMessageList'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      ((options?.defaultValue as string | undefined) ?? key).replace(
        /{{(\w+)}}/g,
        (_match, name: string) => String(options?.[name] ?? '')
      )
  })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() })
}))

const ensureDerivative = vi.fn()
const theme = createTheme()
const originalUrl = 'local-media:///assets/recovery.png'
const brokenUrl = 'local-media:///derivatives/missing.webp'
const recoveredUrl = 'local-media:///derivatives/recovered.webp'
const attachment: ChatAttachment = {
  type: 'image',
  url: originalUrl,
  fileName: 'recovery.png',
  media: {
    version: 1,
    kind: 'managed',
    relativePath: 'assets/recovery.png',
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 4096,
    originalFileName: 'recovery.png'
  },
  sourceWidth: 400,
  sourceHeight: 200
}

type Observation = {
  callback: IntersectionObserverCallback
  target?: Element
  disconnected: boolean
}
let observations: Observation[]

const renderList = (imageAttachment = attachment) =>
  render(
    <ThemeProvider theme={theme}>
      <ChatMessageList
        currentSession={{
          id: 'media-recovery',
          title: 'Media recovery',
          messages: [{ role: 'assistant', content: '', attachments: [imageAttachment] }]
        }}
        isLoading={false}
        editingMessageIndex={null}
        editingContent=""
        onSetEditingIndex={vi.fn()}
        onSetEditingContent={vi.fn()}
        onSendEditedMessage={vi.fn()}
        onPreviewImage={vi.fn()}
        onImageContextMenu={vi.fn()}
        onDownloadAttachment={vi.fn()}
        onSendModelToDcc={vi.fn()}
        chatContainerRef={React.createRef<HTMLDivElement>()}
        messagesEndRef={React.createRef<HTMLDivElement>()}
      />
    </ThemeProvider>
  )

const markVisible = () =>
  act(() => {
    for (const observation of observations) {
      if (observation.disconnected || !observation.target?.isConnected) continue
      observation.callback(
        [{ target: observation.target, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    }
  })

beforeEach(() => {
  resetChatImageDerivativeCacheForTests()
  observations = []
  ensureDerivative
    .mockReset()
    .mockResolvedValueOnce({ status: 'ready', descriptor: { localMediaUrl: brokenUrl } })
    .mockResolvedValue({ status: 'ready', descriptor: { localMediaUrl: recoveredUrl } })
  vi.stubGlobal('api', { svcManagedMedia: { ensureDerivative } })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observation: Observation
      constructor(callback: IntersectionObserverCallback) {
        this.observation = { callback, disconnected: false }
        observations.push(this.observation)
      }
      observe(target: Element) {
        this.observation.target = target
      }
      disconnect() {
        this.observation.disconnected = true
      }
    }
  )
  vi.stubGlobal('ResizeObserver', undefined)
})

afterEach(() => {
  cleanup()
  resetChatImageDerivativeCacheForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ChatMessageList derivative recovery', () => {
  it('invalidates a broken shared preview without automatically retrying the current image', async () => {
    const first = renderList()
    markVisible()
    const image = await screen.findByRole('img', { name: 'Attachment image 1' })
    await waitFor(() => expect(image).toHaveAttribute('src', brokenUrl))

    fireEvent.error(image)
    expect(image).toHaveAttribute('src', originalUrl)
    expect(ensureDerivative).toHaveBeenCalledOnce()

    fireEvent.error(image)
    expect(
      screen.getByRole('img', { name: 'Attachment image 1 failed to load' })
    ).toBeInTheDocument()
    expect(ensureDerivative).toHaveBeenCalledOnce()
    first.unmount()

    renderList()
    markVisible()

    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('img', { name: 'Attachment image 1' })).toHaveAttribute(
      'src',
      recoveredUrl
    )
  })

  it('does not mark an in-flight larger preview as broken when the displayed smaller one fails', async () => {
    let finishLarger!: (value: unknown) => void
    ensureDerivative
      .mockReset()
      .mockResolvedValueOnce({ status: 'ready', descriptor: { localMediaUrl: brokenUrl } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishLarger = resolve
          })
      )
    renderList({ ...attachment, sourceWidth: 1600, sourceHeight: 800 })
    const frame = screen.getByTestId('chat-image-frame')
    const measure = vi
      .spyOn(frame, 'getBoundingClientRect')
      .mockReturnValue({ width: 400, height: 200 } as DOMRect)
    markVisible()
    const image = await screen.findByRole('img', { name: 'Attachment image 1' })
    await waitFor(() => expect(image).toHaveAttribute('src', brokenUrl))
    expect(ensureDerivative.mock.calls[0][0].maxEdge).toBe(512)

    measure.mockReturnValue({ width: 800, height: 400 } as DOMRect)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledTimes(2))
    expect(ensureDerivative.mock.calls[1][0].maxEdge).toBe(1024)

    fireEvent.error(image)
    await act(async () => {
      finishLarger({ status: 'ready', descriptor: { localMediaUrl: recoveredUrl } })
    })

    await waitFor(() => expect(image).toHaveAttribute('src', recoveredUrl))
    expect(ensureDerivative).toHaveBeenCalledTimes(2)
  })
})
