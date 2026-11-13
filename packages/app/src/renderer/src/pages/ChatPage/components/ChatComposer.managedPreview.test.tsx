import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import { theme } from '@renderer/theme'
import ChatComposer from './ChatComposer'
import { resetChatImageDerivativeCacheForTests } from '../chatImageDerivativeScheduler'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'chat.preview_alt_index'
        ? `Preview ${options?.index}`
        : String(options?.defaultValue ?? key)
  })
}))

const original = 'local-media:///originals/first.png'
const derivative = 'local-media:///derivatives/first.webp'
const reference = {
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'originals/first.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  mimeType: 'image/png',
  originalFileName: 'first.png'
}
const attachment: ChatAttachment = {
  type: 'image',
  url: original,
  fileName: 'first.png',
  media: reference
}
const ready = {
  status: 'ready' as const,
  descriptor: {
    maxEdge: 256 as const,
    relativePath: 'derivatives/first.webp',
    mimeType: 'image/webp' as const,
    sizeBytes: 100,
    width: 80,
    height: 80,
    sha256: 'b'.repeat(64),
    localMediaUrl: derivative
  }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const show = (pendingAttachments: ChatAttachment[], onPreviewImage = vi.fn()) => (
  <ThemeProvider theme={theme}>
    <ChatComposer
      inputValue=""
      onInputChange={vi.fn()}
      onSend={vi.fn()}
      onUploadFile={vi.fn()}
      pendingAttachments={pendingAttachments}
      uploadProgress={{}}
      onRemoveAttachment={vi.fn()}
      isLoading={false}
      onStopGenerating={vi.fn()}
      disabled={false}
      composerInputRef={{ current: null }}
      onPreviewImage={onPreviewImage}
    />
  </ThemeProvider>
)

const ensureDerivative = vi.fn()

beforeEach(() => {
  resetChatImageDerivativeCacheForTests()
  ensureDerivative.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { svcManagedMedia: { ensureDerivative } }
  })
})
afterEach(() => {
  cleanup()
  resetChatImageDerivativeCacheForTests()
  Reflect.deleteProperty(window, 'api')
})

describe('composer managed-image display only', () => {
  it('waits for the small display derivative; preview and input keep the original', async () => {
    const gate = deferred<typeof ready>()
    ensureDerivative.mockReturnValue(gate.promise)
    const onPreviewImage = vi.fn()
    const before = structuredClone(attachment)
    render(show([attachment], onPreviewImage))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledWith({ reference, maxEdge: 256 }))
    expect(screen.queryByRole('img', { name: 'Preview 1' })).not.toBeInTheDocument()
    expect(document.querySelector(`img[src="${original}"]`)).toBeNull()
    const pendingPreview = screen.getByRole('button', { name: 'Preview 1' })
    expect(pendingPreview).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(pendingPreview)
    expect(onPreviewImage).toHaveBeenCalledExactlyOnceWith(original)
    await act(async () => {
      gate.resolve(ready)
      await gate.promise
    })
    const image = await screen.findByRole('img', { name: 'Preview 1' })
    expect(image).toHaveAttribute('src', derivative)
    fireEvent.click(image)
    expect(onPreviewImage).toHaveBeenCalledTimes(2)
    expect(onPreviewImage).toHaveBeenLastCalledWith(original)
    expect(attachment).toEqual(before)
  })

  it('retains the original for a non-managed attachment without asking the service', () => {
    const onPreviewImage = vi.fn()
    render(show([{ type: 'image', url: 'blob:plain' }], onPreviewImage))
    const image = screen.getByRole('img', { name: 'Preview 1' })
    expect(image).toHaveAttribute('src', 'blob:plain')
    fireEvent.click(image)
    expect(onPreviewImage).toHaveBeenCalledExactlyOnceWith('blob:plain')
    expect(ensureDerivative).not.toHaveBeenCalled()
  })

  it('falls back to the original when derivative generation fails', async () => {
    ensureDerivative.mockRejectedValue(new Error('derivative unavailable'))
    render(show([attachment]))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledOnce())
    expect(await screen.findByRole('img', { name: 'Preview 1' })).toHaveAttribute('src', original)
  })

  it('falls back for animated GIF', async () => {
    const gif = {
      ...attachment,
      url: 'local-media:///originals/first.gif',
      media: { ...reference, mimeType: 'image/gif', originalFileName: 'first.gif' }
    }
    ensureDerivative.mockResolvedValue({
      status: 'fallbackOriginal',
      reason: 'animated-gif',
      localMediaUrl: gif.url
    })
    render(show([gif]))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledOnce())
    expect(await screen.findByRole('img', { name: 'Preview 1' })).toHaveAttribute('src', gif.url)
  })

  it('falls back to the original if the derivative cannot load', async () => {
    ensureDerivative.mockResolvedValue(ready)
    render(show([attachment]))
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Preview 1' })).toHaveAttribute('src', derivative)
    )
    fireEvent.error(screen.getByRole('img', { name: 'Preview 1' }))
    expect(screen.getByRole('img', { name: 'Preview 1' })).toHaveAttribute('src', original)
    fireEvent.error(screen.getByRole('img', { name: 'Preview 1' }))
    expect(screen.getByText('Image unavailable')).toBeInTheDocument()
  })

  it('uses the original if the service is unavailable', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    render(show([attachment]))
    expect(screen.getByRole('img', { name: 'Preview 1' })).toHaveAttribute('src', original)
  })

  it('does not restart a pending preview for a cloned equivalent attachment', async () => {
    const gate = deferred<typeof ready>()
    ensureDerivative.mockReturnValue(gate.promise)
    const { rerender } = render(show([attachment]))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledOnce())
    rerender(show([structuredClone(attachment)]))
    try {
      // Let the replacement effect and scheduler pump run before resolving the old IPC.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(ensureDerivative).toHaveBeenCalledOnce()
    } finally {
      await act(async () => {
        gate.resolve(ready)
        await gate.promise
      })
    }
    expect(screen.getByRole('img', { name: 'Preview 1' })).toHaveAttribute('src', derivative)
    expect(ensureDerivative).toHaveBeenCalledOnce()
  })

  it('keeps a shared derivative request alive for a surviving duplicate', async () => {
    const gate = deferred<typeof ready>()
    ensureDerivative.mockReturnValue(gate.promise)
    const preview = vi.fn()
    const { rerender } = render(show([attachment, structuredClone(attachment)], preview))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Preview 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview 2' })).toBeInTheDocument()
    rerender(show([structuredClone(attachment)], preview))
    await act(async () => {
      gate.resolve(ready)
      await gate.promise
    })
    const image = screen.getByRole('img', { name: 'Preview 1' })
    expect(image).toHaveAttribute('src', derivative)
    expect(ensureDerivative).toHaveBeenCalledOnce()
    fireEvent.click(image)
    expect(preview).toHaveBeenCalledExactlyOnceWith(original)
  })

  it('does not put a late removed derivative into a replacement attachment', async () => {
    const gate = deferred<typeof ready>()
    ensureDerivative.mockReturnValue(gate.promise)
    const preview = vi.fn()
    const { rerender } = render(show([attachment], preview))
    await waitFor(() => expect(ensureDerivative).toHaveBeenCalledOnce())
    rerender(show([{ type: 'image', url: 'blob:replacement' }], preview))
    expect(screen.getByRole('img', { name: 'Preview 1' })).toHaveAttribute(
      'src',
      'blob:replacement'
    )
    await act(async () => {
      gate.resolve(ready)
      await gate.promise
    })
    const image = screen.getByRole('img', { name: 'Preview 1' })
    expect(image).toHaveAttribute('src', 'blob:replacement')
    fireEvent.click(image)
    expect(preview).toHaveBeenCalledExactlyOnceWith('blob:replacement')
  })

  it('keeps eight small inline preview nodes paired with their sources through clones and reorder', () => {
    const attachments: ChatAttachment[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'image',
      url: 'data:image/png;base64,' + String.fromCharCode(65 + index).repeat(4096),
      fileName: 'inline-' + index + '.png'
    }))
    const originalUrls = attachments.map((item) => item.url)
    const preview = vi.fn()
    const view = render(show(attachments, preview))
    const initialNodes = screen.getAllByRole('img')
    expect(initialNodes).toHaveLength(8)
    view.rerender(
      show(
        attachments.map((item) => ({ ...item })),
        preview
      )
    )
    screen.getAllByRole('img').forEach((node, index) => expect(node).toBe(initialNodes[index]))

    const reversed = [...attachments].reverse().map((item) => ({ ...item }))
    view.rerender(show(reversed, preview))
    const reorderedNodes = screen.getAllByRole('img')
    reorderedNodes.forEach((node, index) => {
      expect(node).toBe(initialNodes[7 - index])
      expect(node).toHaveAttribute('src', reversed[index].url)
    })
    fireEvent.click(reorderedNodes[0])
    expect(preview).toHaveBeenCalledExactlyOnceWith(attachments[7].url)
    expect(ensureDerivative).not.toHaveBeenCalled()
    expect(attachments.map((item) => item.url)).toEqual(originalUrls)
  })

  it('keeps eight inline preview nodes and original preview URLs stable through local textbox input', () => {
    const attachments: ChatAttachment[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'image',
      url: 'data:image/png;base64,' + String.fromCharCode(65 + index).repeat(4096),
      fileName: 'typing-' + index + '.png'
    }))
    const before = structuredClone(attachments)
    const originalUrls = attachments.map((item) => item.url)
    const preview = vi.fn()
    const onInputChange = vi.fn()
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={onInputChange}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={attachments}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={preview}
        />
      </ThemeProvider>
    )
    const textbox = screen.getByRole('textbox')
    const initialNodes = screen.getAllByRole('img')
    const inputs = Array.from({ length: 25 }, (_, index) => 'Draft text ' + (index + 1))
    let observedInputEvents = 0
    const recordInput = () => {
      observedInputEvents += 1
    }
    textbox.addEventListener('input', recordInput)
    try {
      expect(initialNodes).toHaveLength(8)
      for (const value of inputs) {
        // Exercise the native input path and Composer local state without a parent prop rerender.
        fireEvent.input(textbox, { target: { value } })
        expect(screen.getByRole('textbox')).toBe(textbox)
        expect(textbox).toHaveValue(value)
        expect(onInputChange).toHaveBeenLastCalledWith(value)
        const currentNodes = screen.getAllByRole('img')
        expect(currentNodes).toHaveLength(8)
        currentNodes.forEach((node, index) => {
          expect(node).toBe(initialNodes[index])
          expect(node).toHaveAttribute('src', originalUrls[index])
        })
      }
      expect(observedInputEvents).toBe(inputs.length)
      expect(onInputChange.mock.calls).toEqual(inputs.map((value) => [value]))
      initialNodes.forEach((node) => fireEvent.click(node))
      expect(preview.mock.calls).toEqual(originalUrls.map((url) => [url]))
      expect(ensureDerivative).not.toHaveBeenCalled()
      expect(attachments).toEqual(before)
      console.info('composer-input-observation', {
        inputEvents: observedInputEvents,
        inputChanges: onInputChange.mock.calls.length,
        stableImageNodes: initialNodes.length
      })
    } finally {
      textbox.removeEventListener('input', recordInput)
    }
  })
})
