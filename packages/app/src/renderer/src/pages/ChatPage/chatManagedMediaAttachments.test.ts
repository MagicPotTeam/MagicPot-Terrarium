import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import { importChatAttachment, importChatAttachmentUrl } from './chatManagedMediaAttachments'

const reference = {
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'originals/ab/file.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 3,
  mimeType: 'image/png',
  originalFileName: 'file.png'
}
const imported = {
  reference,
  localMediaUrl: 'local-media:///managed/originals/ab/file.png'
}

const dataUrlReader = vi.fn()
class TestFileReader {
  result: string | ArrayBuffer | null = null
  error: DOMException | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob) {
    dataUrlReader(blob)
    this.result = 'data:image/png;base64,AQID'
    this.onload?.()
  }
}

const originalFileReader = globalThis.FileReader

afterEach(() => {
  vi.restoreAllMocks()
  dataUrlReader.mockClear()
  globalThis.FileReader = originalFileReader
})

describe('chatManagedMediaAttachments', () => {
  it('imports a selected File path and preserves attachment metadata without blob/data persistence', async () => {
    const file = Object.assign(
      new File([new Uint8Array([1, 2, 3])], 'file.png', { type: 'image/png' }),
      {
        path: '/selected/file.png'
      }
    )
    const service = {
      importFile: vi.fn(async () => imported),
      importDataUrl: vi.fn()
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>

    const attachment = await importChatAttachment({
      service,
      file,
      type: 'image',
      mimeType: 'image/png',
      relativePath: 'folder/file.png',
      dimensions: { sourceWidth: 10, sourceHeight: 20 }
    })

    expect(service.importFile).toHaveBeenCalledWith({
      sourcePath: '/selected/file.png',
      mimeType: 'image/png',
      originalFileName: 'file.png'
    })
    expect(service.importDataUrl).not.toHaveBeenCalled()
    expect(attachment).toMatchObject({
      url: imported.localMediaUrl,
      media: reference,
      fileName: 'file.png',
      relativePath: 'folder/file.png',
      sizeBytes: 3,
      sourceWidth: 10,
      sourceHeight: 20
    })
    expect(attachment.url).not.toMatch(/^(?:blob|data):/)
  })

  it('imports pathless clipboard Files as data URLs and persists only local-media', async () => {
    globalThis.FileReader = TestFileReader as unknown as typeof FileReader
    const service = {
      importFile: vi.fn(),
      importDataUrl: vi.fn(async () => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>
    const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })

    const attachment = await importChatAttachment({
      service,
      file,
      type: 'image',
      mimeType: 'image/png'
    })

    expect(service.importFile).not.toHaveBeenCalled()
    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AQID',
      originalFileName: 'paste.png'
    })
    expect(attachment.url).toBe(imported.localMediaUrl)
    expect(attachment.url).not.toMatch(/^(?:blob|data):/)
  })

  it('materializes data/blob URLs through managed media', async () => {
    globalThis.FileReader = TestFileReader as unknown as typeof FileReader
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
      )
    )
    const service = { importDataUrl: vi.fn(async () => imported) }

    const attachment = await importChatAttachmentUrl({
      service,
      url: 'blob:preview',
      fileName: 'preview.png',
      dimensions: { sourceWidth: 4, sourceHeight: 5 }
    })

    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AQID',
      originalFileName: 'preview.png'
    })
    expect(attachment).toMatchObject({
      url: imported.localMediaUrl,
      media: reference,
      sourceWidth: 4,
      sourceHeight: 5
    })
  })

  it('fails explicitly when the service is absent or import fails', async () => {
    const file = new File([new Uint8Array([1])], 'file.png', { type: 'image/png' })
    await expect(
      importChatAttachment({
        service: undefined,
        file,
        type: 'image',
        mimeType: 'image/png'
      })
    ).rejects.toThrow('Managed media service is unavailable')

    const failure = new Error('import failed')
    await expect(
      importChatAttachment({
        service: { importFile: vi.fn(), importDataUrl: vi.fn(async () => Promise.reject(failure)) },
        file,
        type: 'image',
        mimeType: 'image/png'
      })
    ).rejects.toBe(failure)
  })
})
