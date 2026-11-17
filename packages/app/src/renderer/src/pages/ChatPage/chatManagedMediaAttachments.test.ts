import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import {
  CHAT_ATTACHMENT_STORAGE,
  importChatAttachment,
  importChatAttachmentUrl
} from './chatManagedMediaAttachments'

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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  dataUrlReader.mockClear()
  globalThis.FileReader = originalFileReader
})

describe('chatManagedMediaAttachments', () => {
  it('imports a selected File path and preserves attachment metadata without blob/data persistence', async () => {
    // Electron 42 has no File.path: the path comes from the preload's getPathForFile.
    const file = new File([new Uint8Array([1, 2, 3])], 'file.png', { type: 'image/png' })
    const service = {
      importFile: vi.fn(async () => imported),
      importDataUrl: vi.fn()
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>

    const attachment = await importChatAttachment({
      service,
      file,
      fileBridge: {
        getPathForFile: () => '/selected/file.png',
        authorizeLocalMediaFile: async () => '/selected/file.png',
        resolveAuthorizedLocalMediaPath: async (filePath) => filePath
      },
      type: 'image',
      mimeType: 'image/png',
      relativePath: 'folder/file.png',
      dimensions: { sourceWidth: 10, sourceHeight: 20 }
    })

    expect(service.importFile).toHaveBeenCalledWith({
      sourcePath: '/selected/file.png',
      mimeType: 'image/png',
      originalFileName: 'file.png',
      storage: CHAT_ATTACHMENT_STORAGE
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

  it('imports a picked file by its canonical path through window.electronFile and never reads it', async () => {
    const readAsDataURL = vi.fn()
    const fileReaderConstructed = vi.fn()
    globalThis.FileReader = class {
      constructor() {
        fileReaderConstructed()
      }
      readAsDataURL = readAsDataURL
    } as unknown as typeof FileReader
    const file = new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' })
    const arrayBuffer = vi.fn()
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
    const getPathForFile = vi.fn(() => 'C:\\Users\\artist\\Videos\\clip.mp4')
    const authorizeLocalMediaFile = vi.fn(async () => 'C:\\Users\\artist\\Videos\\clip.mp4')
    const resolveAuthorizedLocalMediaPath = vi.fn(async () => 'C:\\Users\\Artist\\Videos\\clip.mp4')
    vi.stubGlobal('electronFile', {
      getPathForFile,
      authorizeLocalMediaFile,
      resolveAuthorizedLocalMediaPath
    })
    const service = {
      importFile: vi.fn(async () => imported),
      importDataUrl: vi.fn()
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>

    const attachment = await importChatAttachment({
      service,
      file,
      type: 'video',
      mimeType: 'video/mp4'
    })

    expect(getPathForFile).toHaveBeenCalledWith(file)
    expect(authorizeLocalMediaFile).toHaveBeenCalledWith(file)
    expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith(
      'C:\\Users\\artist\\Videos\\clip.mp4'
    )
    expect(service.importFile).toHaveBeenCalledWith({
      sourcePath: 'C:\\Users\\Artist\\Videos\\clip.mp4',
      mimeType: 'video/mp4',
      originalFileName: 'clip.mp4',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(service.importDataUrl).not.toHaveBeenCalled()
    expect(fileReaderConstructed).not.toHaveBeenCalled()
    expect(readAsDataURL).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(attachment).toMatchObject({ type: 'video', url: imported.localMediaUrl, sizeBytes: 3 })
  })

  it('never imports from a File.path property, a UNC path or a path main does not authorise', async () => {
    globalThis.FileReader = TestFileReader as unknown as typeof FileReader
    const forged = Object.assign(
      new File([new Uint8Array([1, 2, 3])], 'forged.png', { type: 'image/png' }),
      { path: '/etc/shadow' }
    )
    const cases: Array<{ file: File; bridge: Record<string, unknown> | undefined }> = [
      // No bridge path: a renderer-set File.path is ignored.
      {
        file: forged,
        bridge: {
          getPathForFile: () => '',
          authorizeLocalMediaFile: vi.fn(),
          resolveAuthorizedLocalMediaPath: vi.fn()
        }
      },
      { file: forged, bridge: undefined },
      // UNC / device namespace paths are never sent by path (main would contact the host).
      ...['\\\\server\\share\\a.png', '//server/share/a.png', '\\\\?\\C:\\a.png'].map((p) => ({
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => p,
          authorizeLocalMediaFile: vi.fn(async () => p),
          resolveAuthorizedLocalMediaPath: vi.fn(async () => p)
        }
      })),
      // Main refuses the grant or the scoped resolution.
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => '/picked/a.png',
          authorizeLocalMediaFile: async () => '',
          resolveAuthorizedLocalMediaPath: vi.fn()
        }
      },
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => '/picked/a.png',
          authorizeLocalMediaFile: async () => '/picked/a.png',
          resolveAuthorizedLocalMediaPath: async () => ''
        }
      },
      // A guarded bridge answers with a rejected promise.
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => Promise.reject(new Error('denied')),
          authorizeLocalMediaFile: vi.fn(),
          resolveAuthorizedLocalMediaPath: vi.fn()
        }
      }
    ]
    for (const { file, bridge } of cases) {
      vi.stubGlobal('electronFile', bridge)
      const service = {
        importFile: vi.fn(),
        importDataUrl: vi.fn(async () => imported)
      } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>
      await importChatAttachment({ service, file, type: 'image', mimeType: 'image/png' })
      expect(service.importFile).not.toHaveBeenCalled()
      expect(service.importDataUrl).toHaveBeenCalledOnce()
    }
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
      originalFileName: 'paste.png',
      storage: CHAT_ATTACHMENT_STORAGE
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
      originalFileName: 'preview.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(attachment).toMatchObject({
      url: imported.localMediaUrl,
      media: reference,
      sourceWidth: 4,
      sourceHeight: 5
    })
  })

  it('passes an explicit lifecycle scope without allowing the helper to rewrite it', async () => {
    globalThis.FileReader = TestFileReader as unknown as typeof FileReader
    const service = {
      importFile: vi.fn(),
      importDataUrl: vi.fn(async () => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>
    const storage = { namespace: 'task' as const, scope: 'run_01' }
    const file = new File([new Uint8Array([1, 2, 3])], 'task.png', { type: 'image/png' })

    await importChatAttachment({ service, file, type: 'image', storage })

    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AQID',
      originalFileName: 'task.png',
      storage
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
