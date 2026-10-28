import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  authorize: vi.fn(),
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
  getDroppedLocalImageFiles,
  INTERNAL_IMAGE_DRAG_PREFIX
} from './droppedImageUtils'

const first =
  'file:///C:/Users/Owner/AppData/Roaming/Lark%20Shell/sdk_storage/cache/resources/images/first.jpg'
const second =
  'file:///C:/Users/Owner/AppData/Roaming/Lark%20Shell/sdk_storage/cache/resources/images/second.png'
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
const originalElectronFile = window.electronFile
const readFileBytes = (file: File): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
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
  mocks.read.mockImplementation(async ({ fullPath }: { fullPath: string }) => ({
    image: bytes,
    filename: fullPath.split('/').at(-1)!
  }))
  Object.defineProperty(window, 'electronFile', {
    configurable: true,
    value: {
      authorizeDroppedLocalImage: mocks.authorize,
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

  it('reads distinct originals only after exact drop authorization, with a main-side byte ceiling', async () => {
    const content = getDroppedLocalImageContent(
      transfer({
        'text/uri-list': `# from Feishu\r\n${first}\r\n${second}\r\n${first}`
      })
    )
    const result = await getDroppedLocalImageFiles(content)
    expect(mocks.authorize.mock.calls).toEqual([[first], [second]])
    expect(mocks.read.mock.calls).toEqual([
      [{ fullPath: 'C:/cache/first.jpg', maxBytes: 5 * 1024 * 1024 }],
      [{ fullPath: 'C:/cache/second.png', maxBytes: 5 * 1024 * 1024 }]
    ])
    expect(result.failedUrls).toEqual([])
    expect(result.files.map((file) => [file.name, file.type, file.size])).toEqual([
      ['first.jpg', 'image/jpeg', bytes.length],
      ['second.png', 'image/png', bytes.length]
    ])
    expect(new Uint8Array(await readFileBytes(result.files[0]))).toEqual(bytes)
    expect(result.files.every((file) => !Object.hasOwn(file, 'path'))).toBe(true)
  })

  it('consumes all short drop leases before the first potentially slow image read', async () => {
    const pending = deferred<{ image: Uint8Array; filename: string }>()
    mocks.read.mockReturnValueOnce(pending.promise)
    const running = getDroppedLocalImageFiles({ fileUrls: [first, second], text: '' })
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    expect(mocks.authorize).toHaveBeenCalledTimes(2)
    pending.resolve({ image: bytes, filename: 'first.jpg' })
    expect((await running).files).toHaveLength(2)
  })

  it('keeps readable images when another exact source has expired', async () => {
    mocks.read.mockRejectedValueOnce(new Error('ENOENT'))
    const result = await getDroppedLocalImageFiles({ fileUrls: [first, second], text: 'caption' })
    expect(result.failedUrls).toEqual([first])
    expect(result.files.map((file) => file.name)).toEqual(['second.png'])
  })

  it('does not read or fetch an ungranted renderer path', async () => {
    mocks.authorize.mockResolvedValue('')
    const result = await getDroppedLocalImageFiles({ fileUrls: [first], text: '' })
    expect(result).toEqual({ files: [], failedUrls: [first] })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not reacquire a rejected drop lease through its late path-grant side effect', async () => {
    mocks.authorize.mockImplementation(async () => {
      mocks.resolve.mockResolvedValue('C:/cache/first.jpg')
      return ''
    })
    expect(await getDroppedLocalImageFiles({ fileUrls: [first], text: '' })).toEqual({
      files: [],
      failedUrls: [first]
    })
    expect(mocks.resolve).toHaveBeenCalledOnce()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('retains compatibility with an already scoped local image without expanding the grant', async () => {
    mocks.authorize.mockResolvedValue('')
    mocks.resolve.mockResolvedValue('C:/cache/first.jpg')
    expect((await getDroppedLocalImageFiles({ fileUrls: [first], text: '' })).files).toHaveLength(1)
    expect(mocks.resolve).toHaveBeenCalledWith(
      'C:/Users/Owner/AppData/Roaming/Lark Shell/sdk_storage/cache/resources/images/first.jpg'
    )
  })

  it('rejects empty and oversized reads defensively even if a mock service ignores its ceiling', async () => {
    mocks.read.mockResolvedValueOnce({ image: new Uint8Array(0), filename: 'first.jpg' })
    mocks.read.mockResolvedValueOnce({
      image: new Uint8Array(5 * 1024 * 1024 + 1),
      filename: 'second.png'
    })
    expect(await getDroppedLocalImageFiles({ fileUrls: [first, second], text: '' })).toEqual({
      files: [],
      failedUrls: [first, second]
    })
  })

  it('does no work for an already stale destination', async () => {
    expect(
      await getDroppedLocalImageFiles({ fileUrls: [first], text: '' }, { isCurrent: () => false })
    ).toEqual({ files: [], failedUrls: [] })
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not request a new drop grant after the destination changes during scoped-path lookup', async () => {
    let current = true
    const lookup = deferred<string>()
    mocks.resolve.mockReturnValue(lookup.promise)
    const running = getDroppedLocalImageFiles(
      { fileUrls: [first], text: '' },
      { isCurrent: () => current }
    )
    current = false
    lookup.resolve('')
    expect(await running).toEqual({ files: [], failedUrls: [] })
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not read a late granted path after the destination changes', async () => {
    let current = true
    const grant = deferred<string>()
    mocks.authorize.mockReturnValue(grant.promise)
    const running = getDroppedLocalImageFiles(
      { fileUrls: [first], text: '' },
      { isCurrent: () => current }
    )
    await vi.waitFor(() => expect(mocks.authorize).toHaveBeenCalledOnce())
    current = false
    grant.resolve('C:/cache/first.jpg')
    expect(await running).toEqual({ files: [], failedUrls: [] })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('discards a late read without starting a second source after destination change', async () => {
    let current = true
    const pending = deferred<{ image: Uint8Array; filename: string }>()
    mocks.read.mockReturnValueOnce(pending.promise)
    const running = getDroppedLocalImageFiles(
      { fileUrls: [first, second], text: '' },
      { isCurrent: () => current }
    )
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    current = false
    pending.resolve({ image: bytes, filename: 'first.jpg' })
    expect(await running).toEqual({ files: [], failedUrls: [] })
    expect(mocks.read).toHaveBeenCalledOnce()
  })

  it('prefers an actual native File over accompanying URI text', async () => {
    const file = new File([bytes], 'native.jpg', { type: 'image/jpeg' })
    expect(await getDroppedImageFile(transfer({ 'text/plain': first }, [file]))).toBe(file)
    expect(mocks.nativeFile).toHaveBeenCalledWith(file)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
