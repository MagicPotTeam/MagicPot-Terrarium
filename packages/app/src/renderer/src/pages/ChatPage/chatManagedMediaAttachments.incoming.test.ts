import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type {
  ImportManagedMediaDataUrlReq,
  ImportManagedMediaFileReq,
  ManagedMediaSvc
} from '@shared/api/svcManagedMedia'
import {
  boundIncomingChatImageSize,
  CHAT_ATTACHMENT_STORAGE,
  ChatImageTooLargeError,
  importChatAttachmentUrl,
  importIncomingChatImageAttachment
} from './chatManagedMediaAttachments'

const reference = (sha: string, mimeType = 'image/jpeg', sizeBytes = 6) => ({
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: `user-output/chat-attachments/originals/${sha.slice(0, 2)}/${sha}.jpg`,
  sha256: sha.repeat(64 / sha.length),
  sizeBytes,
  mimeType,
  originalFileName: 'photo.jpg'
})
const imported = (sha: string, mimeType?: string, sizeBytes?: number) => ({
  reference: reference(sha, mimeType, sizeBytes),
  localMediaUrl: `local-media:///managed/${sha}.jpg`
})

const makeService = () =>
  ({
    importFile: vi.fn(async (_req: ImportManagedMediaFileReq) => imported('aa')),
    importDataUrl: vi.fn(async (_req: ImportManagedMediaDataUrlReq) => imported('bb'))
  }) satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const canvasMetadata = { canvasItemId: 'item-1', note: 'kept' }

describe('importIncomingChatImageAttachment', () => {
  it('imports a local-media canvas image by its authorised path without reading bytes', async () => {
    const service = makeService()
    const fetchImpl = vi.fn()
    const resolveAuthorizedLocalPath = vi.fn(async (filePath: string) => `${filePath}`)
    const attachment: ChatAttachment = {
      type: 'image',
      url: 'local-media:///home/user/boards/photo%201.jpg',
      mimeType: 'image/jpeg',
      fileName: 'photo 1.jpg',
      sizeBytes: 1234,
      sourceWidth: 1184,
      sourceHeight: 888,
      metadata: canvasMetadata
    }

    const result = await importIncomingChatImageAttachment(attachment, {
      service,
      resolveAuthorizedLocalPath,
      fetchImpl
    })

    expect(resolveAuthorizedLocalPath).toHaveBeenCalledWith('/home/user/boards/photo 1.jpg')
    expect(service.importFile).toHaveBeenCalledWith({
      sourcePath: '/home/user/boards/photo 1.jpg',
      mimeType: 'image/jpeg',
      originalFileName: 'photo 1.jpg',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(service.importDataUrl).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toEqual({
      ...attachment,
      url: 'local-media:///managed/aa.jpg',
      media: reference('aa'),
      mimeType: 'image/jpeg',
      sizeBytes: 6
    })
  })

  it('leaves a local-media URL main does not authorise unchanged and reads nothing', async () => {
    const service = makeService()
    const fetchImpl = vi.fn()
    const attachment: ChatAttachment = {
      type: 'image',
      url: 'local-media:///outside/photo.jpg',
      fileName: 'photo.jpg'
    }
    await expect(
      importIncomingChatImageAttachment(attachment, {
        service,
        resolveAuthorizedLocalPath: async () => '',
        fetchImpl
      })
    ).resolves.toBe(attachment)
    expect(service.importFile).not.toHaveBeenCalled()
    expect(service.importDataUrl).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('imports a blob: canvas image and never keeps the blob or a data URL', async () => {
    const service = makeService()
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    )
    const attachment: ChatAttachment = {
      type: 'image',
      url: 'blob:restored-canvas-item',
      fileName: 'restored.png',
      hiddenFromChatView: true,
      sourceWidth: 10,
      sourceHeight: 20
    }
    const result = await importIncomingChatImageAttachment(attachment, { service, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('blob:restored-canvas-item')
    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AQID',
      originalFileName: 'restored.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(result).toMatchObject({
      url: 'local-media:///managed/bb.jpg',
      media: reference('bb'),
      hiddenFromChatView: true,
      fileName: 'restored.png',
      sourceWidth: 10,
      sourceHeight: 20
    })
    expect(result.url).not.toMatch(/^(?:blob|data):/)
  })

  it('imports a data: image as it is and keeps its metadata', async () => {
    const service = makeService()
    const attachment: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,AQID',
      mimeType: 'image/png',
      fileName: 'canvas-selection.png',
      hiddenFromChatView: true
    }
    const result = await importIncomingChatImageAttachment(attachment, { service })
    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AQID',
      originalFileName: 'canvas-selection.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(result).toMatchObject({ hiddenFromChatView: true, fileName: 'canvas-selection.png' })
    expect(result.url).toBe('local-media:///managed/bb.jpg')
  })

  it('returns managed, remote and non-image attachments unchanged without I/O', async () => {
    const service = makeService()
    const fetchImpl = vi.fn()
    const managed: ChatAttachment = {
      type: 'image',
      url: 'local-media:///managed/aa.jpg',
      media: reference('aa')
    }
    const remote: ChatAttachment = { type: 'image', url: 'https://example.invalid/a.png' }
    const video: ChatAttachment = { type: 'video', url: 'local-media:///clips/a.mp4' }
    for (const item of [managed, remote, video]) {
      await expect(importIncomingChatImageAttachment(item, { service, fetchImpl })).resolves.toBe(
        item
      )
    }
    expect(service.importFile).not.toHaveBeenCalled()
    expect(service.importDataUrl).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps formats the store cannot hold in their previous form, inlining only blob URLs', async () => {
    const service = makeService()
    const bmp: ChatAttachment = {
      type: 'image',
      url: 'local-media:///boards/a.bmp',
      fileName: 'a.bmp'
    }
    await expect(importIncomingChatImageAttachment(bmp, { service })).resolves.toBe(bmp)
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([66, 77]), { headers: { 'content-type': 'image/bmp' } })
    )
    const blobBmp = await importIncomingChatImageAttachment(
      { type: 'image', url: 'blob:bmp', fileName: 'b.bmp' },
      { service, fetchImpl }
    )
    expect(blobBmp.url).toBe('data:image/bmp;base64,Qk0=')
    expect(service.importFile).not.toHaveBeenCalled()
    expect(service.importDataUrl).not.toHaveBeenCalled()
  })

  it('rejects when the source cannot be read or imported, so the caller can report it', async () => {
    const service = makeService()
    await expect(
      importIncomingChatImageAttachment(
        { type: 'image', url: 'blob:revoked', fileName: 'gone.png' },
        { service, fetchImpl: vi.fn(async () => new Response(null, { status: 404 })) }
      )
    ).rejects.toThrow('Failed to read incoming image: 404')

    const failure = new Error('import failed')
    service.importFile.mockRejectedValueOnce(failure)
    await expect(
      importIncomingChatImageAttachment(
        { type: 'image', url: 'local-media:///boards/a.png', fileName: 'a.png' },
        { service, resolveAuthorizedLocalPath: async (p) => p }
      )
    ).rejects.toBe(failure)

    await expect(
      importIncomingChatImageAttachment(
        { type: 'image', url: 'data:image/png;base64,AQID' },
        { service: undefined }
      )
    ).rejects.toThrow('Managed media service is unavailable')
  })

  it('passes a store-safe original file name while keeping the display name', async () => {
    const service = makeService()
    const result = await importIncomingChatImageAttachment(
      { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'a:b/c?.png ' },
      { service }
    )
    expect(service.importDataUrl.mock.calls[0][0].originalFileName).toBe('a_b_c_.png')
    expect(result.fileName).toBe('a:b/c?.png ')
  })
})

describe('importChatAttachmentUrl', () => {
  it('encodes a blob with its own MIME type, which the managed store requires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      )
    )
    const service = makeService()
    await importChatAttachmentUrl({ service, url: 'blob:pasted', fileName: 'pasted.png' })
    expect(service.importDataUrl.mock.calls[0][0].dataUrl).toBe('data:image/png;base64,AQID')
  })
})

describe('boundIncomingChatImageSize', () => {
  const MAX = 5 * 1024 * 1024
  const big = (seed: string) => ({
    type: 'image' as const,
    url: `local-media:///managed/${seed}.png`,
    fileName: 'huge.png',
    sourceWidth: 6000,
    sourceHeight: 4000,
    hiddenFromChatView: true,
    media: reference(seed, 'image/png', 9 * 1024 * 1024)
  })
  const descriptor = (maxEdge: 256 | 512 | 1024 | 2048, sizeBytes: number) => ({
    status: 'ready' as const,
    descriptor: {
      maxEdge,
      relativePath: `derivatives/${maxEdge}.webp`,
      mimeType: 'image/webp' as const,
      sizeBytes,
      width: maxEdge,
      height: Math.round((maxEdge * 2) / 3),
      sha256: 'c'.repeat(64),
      localMediaUrl: `local-media:///managed/derivatives/${maxEdge}.webp`
    }
  })

  it('leaves an image within the limit untouched', async () => {
    const service = { ensureDerivative: vi.fn(), importDataUrl: vi.fn() }
    const small = { ...big('aa'), media: reference('aa', 'image/png', MAX) }
    await expect(boundIncomingChatImageSize(small, { service, maxBytes: MAX })).resolves.toEqual({
      attachment: small
    })
    expect(service.ensureDerivative).not.toHaveBeenCalled()
  })

  it('replaces an image above the limit by the first bounded derivative that fits', async () => {
    const service = {
      ensureDerivative: vi.fn(async ({ maxEdge }: { maxEdge: 256 | 512 | 1024 | 2048 }) =>
        descriptor(maxEdge, maxEdge === 2048 ? MAX + 1 : 700_000)
      ),
      importDataUrl: vi.fn(async (_req: ImportManagedMediaDataUrlReq) =>
        imported('dd', 'image/webp', 700_000)
      )
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
    )
    const source = big('aa')
    const result = await boundIncomingChatImageSize(source, { service, maxBytes: MAX, fetchImpl })

    expect(service.ensureDerivative.mock.calls.map(([req]) => req.maxEdge)).toEqual([2048, 1024])
    expect(fetchImpl).toHaveBeenCalledWith('local-media:///managed/derivatives/1024.webp')
    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/webp;base64,AQID',
      originalFileName: 'huge.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(result.downscaled).toEqual({
      width: 1024,
      height: 683,
      originalSizeBytes: 9 * 1024 * 1024
    })
    expect(result.attachment).toMatchObject({
      url: 'local-media:///managed/dd.jpg',
      media: reference('dd', 'image/webp', 700_000),
      fileName: 'huge.png',
      hiddenFromChatView: true,
      sizeBytes: 700_000,
      sourceWidth: 1024,
      sourceHeight: 683
    })
  })

  it('refuses an image above the limit that cannot be reduced', async () => {
    const gif = {
      ensureDerivative: vi.fn(async () => ({
        status: 'fallbackOriginal' as const,
        reason: 'animated-gif' as const,
        localMediaUrl: 'local-media:///managed/a.gif'
      })),
      importDataUrl: vi.fn()
    }
    await expect(
      boundIncomingChatImageSize(big('aa'), { service: gif, maxBytes: MAX })
    ).rejects.toBeInstanceOf(ChatImageTooLargeError)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = {
      ensureDerivative: vi.fn(async () => Promise.reject(new Error('sidecar missing'))),
      importDataUrl: vi.fn()
    }
    await expect(
      boundIncomingChatImageSize(big('aa'), { service: failing, maxBytes: MAX })
    ).rejects.toMatchObject({ fileName: 'huge.png', maxBytes: MAX })

    const unmanaged = {
      type: 'image' as const,
      url: 'https://example.invalid/a.bmp',
      sizeBytes: MAX + 1
    }
    await expect(
      boundIncomingChatImageSize(unmanaged, { service: gif, maxBytes: MAX })
    ).rejects.toBeInstanceOf(ChatImageTooLargeError)
    expect(gif.importDataUrl).not.toHaveBeenCalled()
  })
})
