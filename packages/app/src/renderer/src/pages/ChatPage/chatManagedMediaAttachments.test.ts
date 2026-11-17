import { afterEach, describe, expect, it, vi } from 'vitest'
import enUS from '@shared/locales/en-US/renderer.json'
import zhCN from '@shared/locales/zh-CN/renderer.json'
import type { ImportManagedMediaBytesReq, ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import {
  CHAT_ATTACHMENT_STORAGE,
  CHAT_PATHLESS_ATTACHMENT_MAX_BYTES,
  ChatPathlessAttachmentTooLargeError,
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
  readAsArrayBuffer(blob: Blob) {
    // jsdom's Blob has no arrayBuffer(); read its bytes through jsdom's own FileReader.
    const reader = new originalFileReader()
    reader.onload = () => {
      this.result = reader.result
      this.onload?.()
    }
    reader.readAsArrayBuffer(blob)
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
      importBytes: vi.fn()
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>

    const attachment = await importChatAttachment({
      service,
      file,
      fileBridge: {
        getPathForFile: () => '/selected/file.png',
        authorizeLocalMediaFileForImport: async () => '/selected/file.png'
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
    expect(service.importBytes).not.toHaveBeenCalled()
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
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.jpg', { type: 'image/jpeg' })
    const arrayBuffer = vi.fn()
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
    const getPathForFile = vi.fn(() => 'C:\\Users\\artist\\Pictures\\shot.jpg')
    const authorizeLocalMediaFileForImport = vi.fn(
      async () => 'C:\\Users\\Artist\\Pictures\\shot.jpg'
    )
    const authorizeLocalMediaFile = vi.fn()
    const resolveAuthorizedLocalMediaPath = vi.fn()
    vi.stubGlobal('electronFile', {
      getPathForFile,
      authorizeLocalMediaFileForImport,
      authorizeLocalMediaFile,
      resolveAuthorizedLocalMediaPath
    })
    const service = {
      importFile: vi.fn(async () => imported),
      importBytes: vi.fn()
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>

    const attachment = await importChatAttachment({
      service,
      file,
      type: 'image',
      mimeType: 'image/jpeg'
    })

    expect(getPathForFile).toHaveBeenCalledWith(file)
    // A one-use import grant, never the persisted grant canvas boards depend on.
    expect(authorizeLocalMediaFileForImport).toHaveBeenCalledExactlyOnceWith(file, 'image/jpeg')
    expect(authorizeLocalMediaFile).not.toHaveBeenCalled()
    expect(resolveAuthorizedLocalMediaPath).not.toHaveBeenCalled()
    expect(service.importFile).toHaveBeenCalledWith({
      sourcePath: 'C:\\Users\\Artist\\Pictures\\shot.jpg',
      mimeType: 'image/jpeg',
      originalFileName: 'shot.jpg',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(service.importBytes).not.toHaveBeenCalled()
    expect(fileReaderConstructed).not.toHaveBeenCalled()
    expect(readAsDataURL).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(attachment).toMatchObject({ type: 'image', url: imported.localMediaUrl, sizeBytes: 3 })
  })

  it('asks for no grant and reads nothing for a picked file of a type the store refuses', async () => {
    const authorizeLocalMediaFileForImport = vi.fn(async () => '/videos/clip.mp4')
    const authorizeLocalMediaFile = vi.fn(async () => '/videos/clip.mp4')
    // Main refuses the type before it looks at the path or the grants.
    const service = {
      importFile: vi.fn(async () => {
        throw new Error('Unsupported managed media type')
      }),
      importBytes: vi.fn(async () => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>

    for (const [name, mimeType] of [
      ['clip.mp4', 'video/mp4'],
      ['model.glb', 'model/gltf-binary'],
      ['legacy.jpg', 'image/jpg'],
      ['typeless.bin', '']
    ] as const) {
      const file = new File([new Uint8Array([1])], name, { type: mimeType })
      const arrayBuffer = vi.fn()
      Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
      await expect(
        importChatAttachment({
          service,
          file,
          fileBridge: {
            getPathForFile: () => `/videos/${name}`,
            authorizeLocalMediaFileForImport,
            // A bridge from before this change: never used for chat imports.
            ...({ authorizeLocalMediaFile } as object)
          },
          type: 'video',
          mimeType
        })
      ).rejects.toThrow('Unsupported managed media type')
      expect(service.importFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourcePath: `/videos/${name}`, mimeType })
      )
      expect(arrayBuffer).not.toHaveBeenCalled()
    }
    expect(authorizeLocalMediaFileForImport).not.toHaveBeenCalled()
    expect(authorizeLocalMediaFile).not.toHaveBeenCalled()
    expect(service.importBytes).not.toHaveBeenCalled()
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
          authorizeLocalMediaFileForImport: vi.fn()
        }
      },
      { file: forged, bridge: undefined },
      // UNC / device namespace paths are never sent by path (main would contact the host).
      ...['\\\\server\\share\\a.png', '//server/share/a.png', '\\\\?\\C:\\a.png'].map((p) => ({
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => p,
          authorizeLocalMediaFileForImport: vi.fn(async () => p)
        }
      })),
      // Main refuses the grant (other window, mapped network drive, not a regular file).
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => '/picked/a.png',
          authorizeLocalMediaFileForImport: async () => ''
        }
      },
      // Main's canonical form is a UNC path (mapped drive): never sent by path.
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => 'Z:\\a.png',
          authorizeLocalMediaFileForImport: async () => '\\\\nas\\share\\a.png'
        }
      },
      // A bridge without the import grant: the persisted grant is not used instead.
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => '/picked/a.png',
          authorizeLocalMediaFile: async () => '/picked/a.png',
          resolveAuthorizedLocalMediaPath: async (filePath: string) => filePath
        }
      },
      // A guarded bridge answers with a rejected promise.
      {
        file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
        bridge: {
          getPathForFile: () => Promise.reject(new Error('denied')),
          authorizeLocalMediaFileForImport: vi.fn()
        }
      }
    ]
    for (const { file, bridge } of cases) {
      vi.stubGlobal('electronFile', bridge)
      const service = {
        importFile: vi.fn(),
        importBytes: vi.fn(async () => imported)
      } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>
      await importChatAttachment({ service, file, type: 'image', mimeType: 'image/png' })
      expect(service.importFile).not.toHaveBeenCalled()
      expect(service.importBytes).toHaveBeenCalledOnce()
    }
  })

  it('imports pathless clipboard Files as bytes and persists only local-media', async () => {
    globalThis.FileReader = TestFileReader as unknown as typeof FileReader
    const service = {
      importFile: vi.fn(),
      importBytes: vi.fn(async () => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>
    const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })

    const attachment = await importChatAttachment({
      service,
      file,
      type: 'image',
      mimeType: 'image/png'
    })

    expect(service.importFile).not.toHaveBeenCalled()
    expect(service.importBytes).toHaveBeenCalledWith({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      originalFileName: 'paste.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(dataUrlReader).not.toHaveBeenCalled()
    expect(attachment.url).toBe(imported.localMediaUrl)
    expect(attachment.url).not.toMatch(/^(?:blob|data):/)
  })

  it('sends a path-less 2 MB image as one byte array and builds no base64 string', async () => {
    // Only a byte read is allowed (jsdom's Blob has no arrayBuffer(); Chromium's has).
    globalThis.FileReader = TestFileReader as unknown as typeof FileReader
    const btoa = vi.fn()
    vi.stubGlobal('btoa', btoa)
    const payload = new Uint8Array(2 * 1024 * 1024)
    for (let index = 0; index < payload.length; index += 4096) payload[index] = index % 251
    const file = new File([payload], 'generated.png', { type: 'image/png' })
    // Chromium's Blob#arrayBuffer (jsdom has none, and its FileReader is slow for 2 MB).
    const arrayBuffer = vi.fn(async () => payload.slice().buffer)
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
    const service = {
      importFile: vi.fn(),
      importBytes: vi.fn(async (_req: ImportManagedMediaBytesReq) => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>

    await importChatAttachment({ service, file, type: 'image', mimeType: 'image/png' })

    expect(service.importBytes).toHaveBeenCalledOnce()
    const request = service.importBytes.mock.calls[0][0] as { bytes: unknown }
    expect(request.bytes).toBeInstanceOf(Uint8Array)
    expect((request.bytes as Uint8Array).byteLength).toBe(payload.byteLength)
    expect((request.bytes as Uint8Array).every((value, index) => value === payload[index])).toBe(
      true
    )
    // Nothing in the request is a string longer than a file name.
    for (const value of Object.values(request)) {
      if (typeof value === 'string') expect(value.length).toBeLessThan(64)
    }
    expect(arrayBuffer).toHaveBeenCalledOnce()
    expect(dataUrlReader).not.toHaveBeenCalled()
    expect(btoa).not.toHaveBeenCalled()
  })

  it('refuses path-less data above the cap with a short message, before reading it', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'huge-paste.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: CHAT_PATHLESS_ATTACHMENT_MAX_BYTES + 1 })
    const arrayBuffer = vi.fn()
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
    const service = {
      importFile: vi.fn(async () => imported),
      importBytes: vi.fn(async () => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>

    const error = await importChatAttachment({
      service,
      file,
      type: 'image',
      mimeType: 'image/png'
    }).then(
      () => expect.unreachable('a path-less file above the cap must be refused'),
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(ChatPathlessAttachmentTooLargeError)
    expect(error).toMatchObject({
      fileName: 'huge-paste.png',
      sizeBytes: CHAT_PATHLESS_ATTACHMENT_MAX_BYTES + 1,
      maxBytes: CHAT_PATHLESS_ATTACHMENT_MAX_BYTES
    })
    const message = (error as Error).message
    expect(message).toContain('huge-paste.png')
    expect(message).toContain(String(CHAT_PATHLESS_ATTACHMENT_MAX_BYTES / (1024 * 1024)))
    expect(message).not.toContain('chat.pathless_attachment_too_large')
    expect(message.length).toBeLessThan(200)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(service.importBytes).not.toHaveBeenCalled()

    // The localized line in both locales.
    const { default: i18n } = await import('@renderer/i18n')
    for (const [language, locale] of [
      ['zh-CN', zhCN],
      ['en-US', enUS]
    ] as const) {
      await i18n.changeLanguage(language)
      const localized = new ChatPathlessAttachmentTooLargeError('huge-paste.png', 70 * 1024 * 1024)
      expect(localized.message).toBe(
        locale.chat.pathless_attachment_too_large
          .replace('{{fileName}}', 'huge-paste.png')
          .replace('{{size}}', '70 MB')
          .replace('{{maxMB}}', '64')
      )
    }

    // The same file with a path is imported by path whatever its size.
    await importChatAttachment({
      service,
      file,
      fileBridge: {
        getPathForFile: () => '/picked/huge.png',
        authorizeLocalMediaFileForImport: async () => '/picked/huge.png'
      },
      type: 'image',
      mimeType: 'image/png'
    })
    expect(service.importFile).toHaveBeenCalledOnce()
  })

  it('has the refusal message in both locales with the same placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort()
    const en = enUS.chat.pathless_attachment_too_large
    const zh = zhCN.chat.pathless_attachment_too_large
    expect(en).toBeTruthy()
    expect(zh).toBeTruthy()
    expect(placeholders(zh)).toEqual(placeholders(en))
    expect(placeholders(en)).toEqual(['fileName', 'maxMB', 'size'])
  })

  it('sends blob URLs as bytes and data URLs as they are', async () => {
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
    const service = {
      importDataUrl: vi.fn(async () => imported),
      importBytes: vi.fn(async () => imported)
    }

    const attachment = await importChatAttachmentUrl({
      service,
      url: 'blob:preview',
      fileName: 'preview.png',
      dimensions: { sourceWidth: 4, sourceHeight: 5 }
    })

    expect(service.importBytes).toHaveBeenCalledWith({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      originalFileName: 'preview.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(service.importDataUrl).not.toHaveBeenCalled()
    expect(dataUrlReader).not.toHaveBeenCalled()
    expect(attachment).toMatchObject({
      url: imported.localMediaUrl,
      media: reference,
      sourceWidth: 4,
      sourceHeight: 5
    })

    await importChatAttachmentUrl({
      service,
      url: 'data:image/png;base64,AQID',
      fileName: 'inline.png'
    })
    expect(service.importDataUrl).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AQID',
      originalFileName: 'inline.png',
      storage: CHAT_ATTACHMENT_STORAGE
    })
    expect(service.importBytes).toHaveBeenCalledOnce()
  })

  it('passes an explicit lifecycle scope without allowing the helper to rewrite it', async () => {
    const service = {
      importFile: vi.fn(),
      importBytes: vi.fn(async () => imported)
    } satisfies Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>
    const storage = { namespace: 'task' as const, scope: 'run_01' }
    const file = new File([new Uint8Array([1, 2, 3])], 'task.png', { type: 'image/png' })

    await importChatAttachment({ service, file, type: 'image', storage })

    expect(service.importBytes).toHaveBeenCalledWith({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
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
        service: { importFile: vi.fn(), importBytes: vi.fn(async () => Promise.reject(failure)) },
        file,
        type: 'image',
        mimeType: 'image/png'
      })
    ).rejects.toBe(failure)
  })
})
