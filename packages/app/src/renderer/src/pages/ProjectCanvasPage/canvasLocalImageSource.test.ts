import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCanvasLocalImageObjectUrl,
  readCanvasLocalImageBlobFromSource,
  resolveCanvasLocalFilePathFromSource
} from './canvasLocalImageSource'

const originalApi = window.api
const originalElectronFile = window.electronFile
const originalCreateObjectURL = URL.createObjectURL
const originalFetch = globalThis.fetch

describe('canvasLocalImageSource', () => {
  afterEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalApi
    })
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: originalElectronFile
    })
    URL.createObjectURL = originalCreateObjectURL
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('resolves canonical and browser-normalized local media URLs to file paths', () => {
    expect(resolveCanvasLocalFilePathFromSource('local-media:///C:/Users/me/image.png')).toBe(
      'C:/Users/me/image.png'
    )
    expect(resolveCanvasLocalFilePathFromSource('local-media://c/Users/me/image.png')).toBe(
      'c:/Users/me/image.png'
    )
    expect(resolveCanvasLocalFilePathFromSource('file:///C:/Users/me/image.png')).toBe(
      'C:/Users/me/image.png'
    )
  })

  it('streams an authorized local image through the local-media protocol without svcFs bytes', async () => {
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath }
    })
    const readImageFromPath = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { svcFs: { readImageFromPath } }
    })

    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])))
    globalThis.fetch = fetchMock as typeof fetch
    const createObjectUrl = vi.fn((_blob: Blob) => 'blob:local-image')
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL

    const sourceUrl =
      'local-media://c/Users/17290/Desktop/%E6%96%B0%E5%BB%BA%E6%96%87%E4%BB%B6%E5%A4%B9/%E6%97%A0%E6%A0%87%E9%A2%98(95).png'
    const objectUrl = await createCanvasLocalImageObjectUrl(sourceUrl, '无标题(95).png')

    expect(objectUrl).toBe('blob:local-image')
    expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith(
      'c:/Users/17290/Desktop/新建文件夹/无标题(95).png'
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'local-media:///c:/Users/17290/Desktop/%E6%96%B0%E5%BB%BA%E6%96%87%E4%BB%B6%E5%A4%B9/%E6%97%A0%E6%A0%87%E9%A2%98(95).png',
      { signal: undefined }
    )
    expect(readImageFromPath).not.toHaveBeenCalled()
    expect((createObjectUrl.mock.calls[0]?.[0] as Blob | undefined)?.type).toBe('image/png')
  })

  it('aborts an authorized local image fetch without swallowing the abort', async () => {
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath: vi.fn(async (filePath: string) => filePath) }
    })
    let observedSignal: AbortSignal | undefined
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined
          observedSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        })
    )
    globalThis.fetch = fetchMock as typeof fetch
    const controller = new AbortController()

    const pending = readCanvasLocalImageBlobFromSource(
      'local-media:///C:/Users/me/large.png',
      undefined,
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(observedSignal).toBe(controller.signal)
    expect(controller.signal.aborted).toBe(true)
  })

  it('rejects an unapproved local path before fetching it', async () => {
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath: vi.fn(async () => '') }
    })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as typeof fetch

    await expect(
      readCanvasLocalImageBlobFromSource('local-media:///C:/Users/me/private.png')
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
