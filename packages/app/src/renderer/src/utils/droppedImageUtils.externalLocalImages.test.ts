import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  authorize: vi.fn(),
  importGrant: vi.fn(),
  resolve: vi.fn(),
  nativeFile: vi.fn()
}))
vi.mock('./windowUtils', () => ({
  api: () => ({ svcFs: { readImageFromPath: mocks.read } })
}))
vi.mock('@renderer/pages/ProjectCanvasPage/canvasAssetIntakeHelpers', () => ({
  loadImageFromSrc: vi.fn()
}))

import {
  getDroppedImageFile,
  getDroppedImageUrl,
  getDroppedLocalImageContent,
  getDroppedLocalImages,
  INTERNAL_IMAGE_DRAG_PREFIX
} from './droppedImageUtils'

const first =
  'file:///C:/Users/Owner/AppData/Roaming/Lark%20Shell/sdk_storage/cache/resources/images/first.jpg'
const second =
  'file:///C:/Users/Owner/AppData/Roaming/Lark%20Shell/sdk_storage/cache/resources/images/second.png'
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
const originalElectronFile = window.electronFile
const transfer = (data: Record<string, string>, files: File[] = []): DataTransfer =>
  ({ getData: (key: string) => data[key] || '', files }) as unknown as DataTransfer
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.resolve.mockResolvedValue('')
  mocks.authorize.mockImplementation(async (url: string) =>
    url === first ? 'C:/cache/first.jpg' : url === second ? 'C:/cache/second.png' : ''
  )
  mocks.importGrant.mockImplementation(async (url: string) =>
    url === first
      ? { path: 'C:\\cache\\first.jpg', sizeBytes: 1000 }
      : url === second
        ? { path: 'C:\\cache\\second.png', sizeBytes: 2000 }
        : null
  )
  mocks.read.mockImplementation(async ({ fullPath }: { fullPath: string }) => ({
    image: bytes,
    filename: fullPath.split('/').at(-1)!
  }))
  Object.defineProperty(window, 'electronFile', {
    configurable: true,
    value: {
      authorizeDroppedLocalImage: mocks.authorize,
      authorizeDroppedLocalImageForImport: mocks.importGrant,
      authorizeLocalMediaFile: mocks.nativeFile,
      resolveAuthorizedLocalMediaPath: mocks.resolve
    }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    })
  )
})
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  Object.defineProperty(window, 'electronFile', {
    configurable: true,
    value: originalElectronFile
  })
  vi.unstubAllGlobals()
})

describe('external local image drop intake', () => {
  it('separates the Feishu original file URI from the surrounding draft text', () => {
    const raw = first.replace('Lark%20Shell', 'Lark Shell')
    const content = getDroppedLocalImageContent(
      transfer({ 'text/plain': `Keep this caption\n${raw}` })
    )
    expect(content).toEqual({ fileUrls: [first], text: 'Keep this caption' })
    expect(getDroppedImageUrl(transfer({ 'text/plain': `Caption\n${raw}` }))).toBe(first)
  })

  it('recognizes an HTML original without loading HTML, thumbnails or remote URLs', () => {
    const content = getDroppedLocalImageContent(
      transfer({
        'text/html': `<p>Actual image</p><img src="${first}"><img src="https://example.invalid/thumbnail.png">`
      })
    )
    expect(content.fileUrls).toEqual([first])
    expect(content.text).toContain('Actual image')
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not reinterpret an internal canvas text payload as an external file read', () => {
    const content = getDroppedLocalImageContent(
      transfer({
        'text/plain': `${INTERNAL_IMAGE_DRAG_PREFIX}${JSON.stringify({
          itemTypes: ['text'],
          textContent: first
        })}`
      })
    )
    expect(content).toEqual({ fileUrls: [], text: '' })
  })

  it('asks for one-use import grants of distinct originals and reads no bytes', async () => {
    const content = getDroppedLocalImageContent(
      transfer({
        'text/uri-list': `# from Feishu\r\n${first}\r\n${second}\r\n${first}`
      })
    )
    const result = await getDroppedLocalImages(content)
    expect(mocks.importGrant.mock.calls).toEqual([
      [first, 'image/jpeg'],
      [second, 'image/png']
    ])
    expect(result).toEqual({
      images: [
        {
          url: first,
          fileName: 'first.jpg',
          sourcePath: 'C:\\cache\\first.jpg',
          sizeBytes: 1000,
          mimeType: 'image/jpeg'
        },
        {
          url: second,
          fileName: 'second.png',
          sourcePath: 'C:\\cache\\second.png',
          sizeBytes: 2000,
          mimeType: 'image/png'
        }
      ],
      failedUrls: []
    })
    // No persisted grant, no lookup of an older grant, no bytes through the renderer.
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('uses every short drop lease at once', async () => {
    const pending = deferred<{ path: string; sizeBytes: number }>()
    mocks.importGrant.mockReturnValueOnce(pending.promise)
    const running = getDroppedLocalImages({ fileUrls: [first, second], text: '' })
    await vi.waitFor(() => expect(mocks.importGrant).toHaveBeenCalledTimes(2))
    pending.resolve({ path: 'C:\\cache\\first.jpg', sizeBytes: 1000 })
    expect((await running).images).toHaveLength(2)
  })

  it('keeps granted images when another source is not granted', async () => {
    mocks.importGrant.mockResolvedValueOnce(null)
    const result = await getDroppedLocalImages({ fileUrls: [first, second], text: 'caption' })
    expect(result.failedUrls).toEqual([first])
    expect(result.images.map((image) => image.fileName)).toEqual(['second.png'])
  })

  it('reports a source that is empty or above the image limit before any import', async () => {
    mocks.importGrant.mockResolvedValueOnce({ path: 'C:\\cache\\first.jpg', sizeBytes: 0 })
    mocks.importGrant.mockResolvedValueOnce({
      path: 'C:\\cache\\second.png',
      sizeBytes: 5 * 1024 * 1024 + 1
    })
    expect(await getDroppedLocalImages({ fileUrls: [first, second], text: '' })).toEqual({
      images: [],
      failedUrls: [first, second]
    })
  })

  it('treats a bridge failure as an ungranted source', async () => {
    mocks.importGrant.mockRejectedValueOnce(new Error('bridge gone'))
    expect(await getDroppedLocalImages({ fileUrls: [first], text: '' })).toEqual({
      images: [],
      failedUrls: [first]
    })
  })

  it('does no work for an already stale destination', async () => {
    expect(
      await getDroppedLocalImages({ fileUrls: [first], text: '' }, { isCurrent: () => false })
    ).toEqual({ images: [], failedUrls: [] })
    expect(mocks.importGrant).not.toHaveBeenCalled()
  })

  it('discards late grants after the destination changes', async () => {
    let current = true
    const grant = deferred<{ path: string; sizeBytes: number }>()
    mocks.importGrant.mockReturnValue(grant.promise)
    const running = getDroppedLocalImages(
      { fileUrls: [first], text: '' },
      { isCurrent: () => current }
    )
    await vi.waitFor(() => expect(mocks.importGrant).toHaveBeenCalledOnce())
    current = false
    grant.resolve({ path: 'C:\\cache\\first.jpg', sizeBytes: 1000 })
    expect(await running).toEqual({ images: [], failedUrls: [] })
  })

  it('prefers an actual native File over accompanying URI text', async () => {
    const file = new File([bytes], 'native.jpg', { type: 'image/jpeg' })
    expect(await getDroppedImageFile(transfer({ 'text/plain': first }, [file]))).toBe(file)
    expect(mocks.nativeFile).toHaveBeenCalledWith(file)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
