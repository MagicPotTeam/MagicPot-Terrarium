import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAIResponsesInputMessage } from '../../shared/llm/openaiResponses'
import { resolveCanvasThumbnailSidecarBinary } from '../api/canvasThumbnailSidecarAdapter'
import {
  createChatImagePreparation,
  type ChatImagePreparationOptions
} from './chatImagePreparation'
import type { ChatImageWorkerResult } from './chatImageWorker'

vi.mock('../api/canvasThumbnailSidecarAdapter', () => ({
  resolveCanvasThumbnailSidecarBinary: vi.fn(async () => ({ ok: false, candidates: [] }))
}))

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, bytes: Buffer): Buffer {
  const result = Buffer.alloc(bytes.length + 12)
  result.writeUInt32BE(bytes.length, 0)
  result.write(type, 4, 'ascii')
  bytes.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
  return result
}

// This suite checks factory routing with a fake worker. Modified IHDR dimensions
// below are structurally recognized fixtures, not a proof of successful decoding.
function png(width = 1, orientation = 1): Buffer {
  const image = Buffer.from(tinyPng)
  image.writeUInt32BE(width, 16)
  image.writeUInt32BE(crc32(image.subarray(12, 29)), 29)
  if (orientation === 1) return image
  const exif = Buffer.alloc(26)
  exif.write('II')
  exif.writeUInt16LE(42, 2)
  exif.writeUInt32LE(8, 4)
  exif.writeUInt16LE(1, 8)
  exif.writeUInt16LE(0x112, 10)
  exif.writeUInt16LE(3, 12)
  exif.writeUInt32LE(1, 14)
  exif.writeUInt16LE(orientation, 18)
  return Buffer.concat([image.subarray(0, 33), chunk('eXIf', exif), image.subarray(33)])
}

function paddedPng(length: number): Buffer {
  return Buffer.concat([
    tinyPng.subarray(0, 33),
    chunk('npAd', Buffer.alloc(length - tinyPng.length - 12)),
    tinyPng.subarray(33)
  ])
}

const url = (bytes: Uint8Array, mime = 'png'): string =>
  `data:image/${mime};base64,${Buffer.from(bytes).toString('base64')}`
const projection = (...images: string[]): OpenAIResponsesInputMessage[] => [
  {
    role: 'user',
    content: [
      { type: 'input_text', text: 'Inspect these images' },
      ...images.map((image_url) => ({ type: 'input_image' as const, image_url }))
    ]
  }
]
const result = (bytes: Buffer = tinyPng): ChatImageWorkerResult => ({
  bytes: Buffer.from(bytes),
  mimeType: 'image/png',
  width: 1,
  height: 1
})

function dependencies() {
  return {
    resolveWorker: vi.fn<NonNullable<ChatImagePreparationOptions['resolveWorker']>>(async () =>
      process.platform === 'win32' ? 'C:/owned/image-worker.exe' : '/owned/image-worker'
    ),
    runWorker: vi.fn<NonNullable<ChatImagePreparationOptions['runWorker']>>(async () => result())
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MAIN chat image preparation factory', () => {
  it('does not resolve or start a worker for text, HTTP URLs, or a budgeted GIF', async () => {
    const runWorker = dependencies().runWorker
    const preparation = createChatImagePreparation({ runWorker })
    const gif = url(Buffer.from('GIF89a'), 'gif')
    const input = projection('https://fixture.invalid/image.png', gif)
    const before = structuredClone(input)
    expect(await preparation.prepareResponsesInput(input)).toEqual(before)
    expect(await preparation.prepareResponsesInput(projection())).toEqual(projection())
    expect(resolveCanvasThumbnailSidecarBinary).not.toHaveBeenCalled()
    expect(runWorker).not.toHaveBeenCalled()
    expect(input).toEqual(before)
    preparation.clear()
  })

  it('preserves already fitting PNG and structurally recognized JPEG bytes without a worker', async () => {
    const deps = dependencies()
    const preparation = createChatImagePreparation(deps)
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9
    ])
    const input = projection(url(png()), url(jpeg, 'jpeg'))
    expect(await preparation.prepareResponsesInput(input)).toEqual(input)
    expect(deps.resolveWorker).not.toHaveBeenCalled()
    expect(deps.runWorker).not.toHaveBeenCalled()
    preparation.clear()
  })

  it('requires the codec for excessive dimensions, excessive bytes, or orientation', async () => {
    const deps = dependencies()
    const preparation = createChatImagePreparation(deps)
    const sources = [png(2001), paddedPng(512_001), png(1, 6)]
    const input = projection(...sources.map((source) => url(source)))
    const before = structuredClone(input)
    const output = await preparation.prepareResponsesInput(input)
    expect(deps.resolveWorker).toHaveBeenCalledOnce()
    expect(deps.runWorker).toHaveBeenCalledTimes(3)
    expect(deps.runWorker.mock.calls.map(([request]) => Buffer.from(request.source))).toEqual(
      sources
    )
    for (const [request] of deps.runWorker.mock.calls) {
      expect(request).toMatchObject({ targetBytes: 512_000, maxEdge: 2000 })
      expect(request.signal).toBeInstanceOf(AbortSignal)
    }
    expect(output).toEqual(projection(url(tinyPng), url(tinyPng), url(tinyPng)))
    expect(input).toEqual(before)
    preparation.clear()
  })

  it('uses the default MAIN resolver only when an image actually needs the codec', async () => {
    const deps = dependencies()
    const preparation = createChatImagePreparation({ runWorker: deps.runWorker })
    await expect(
      preparation.prepareResponsesInput(projection(url(png(2001))))
    ).rejects.toMatchObject({
      code: 'CHAT_IMAGE_WORKER_UNAVAILABLE',
      message: '图片处理组件不可用，请重新构建或更新应用。'
    })
    expect(resolveCanvasThumbnailSidecarBinary).toHaveBeenCalledOnce()
    expect(deps.runWorker).not.toHaveBeenCalled()
    preparation.clear()
  })

  it.each(['missing', 'resolver rejection', 'unsupported', 'worker failure'])(
    'fails clearly on %s without returning original images or leaking details',
    async (kind) => {
      const deps = dependencies()
      if (kind === 'missing') deps.resolveWorker.mockResolvedValue(undefined)
      if (kind === 'resolver rejection') {
        deps.resolveWorker.mockRejectedValue(new Error('C:/private/path'))
      }
      if (kind === 'unsupported') {
        deps.runWorker.mockRejectedValue(
          Object.assign(new Error('private stderr'), {
            code: 'CHAT_IMAGE_WORKER_PROTOCOL_UNSUPPORTED'
          })
        )
      }
      if (kind === 'worker failure')
        deps.runWorker.mockRejectedValue(new Error('private bytes/path'))
      const preparation = createChatImagePreparation(deps)
      const input = projection(url(png(2001)))
      const before = structuredClone(input)
      const error = await preparation.prepareResponsesInput(input).then(
        () => null,
        (failure: Error & { code: string }) => failure
      )
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).not.toMatch(/private|C:\//)
      expect(error?.code).toBe(
        kind === 'unsupported'
          ? 'CHAT_IMAGE_WORKER_PROTOCOL_UNSUPPORTED'
          : kind === 'worker failure'
            ? 'CHAT_IMAGE_PREPARATION_FAILED'
            : 'CHAT_IMAGE_WORKER_UNAVAILABLE'
      )
      expect(input).toEqual(before)
      preparation.clear()
    }
  )

  it('keeps a GIF unchanged while still preparing a large PNG in the same request', async () => {
    const deps = dependencies()
    const preparation = createChatImagePreparation(deps)
    const gif = url(Buffer.from('GIF89a'), 'gif')
    const output = await preparation.prepareResponsesInput(projection(gif, url(png(2001))))
    expect(output).toEqual(projection(gif, url(tinyPng)))
    expect(deps.runWorker).toHaveBeenCalledOnce()
    preparation.clear()
  })

  it('fits all 50 prepared outputs in the fixed 18 MiB binary budget', async () => {
    const deps = dependencies()
    deps.runWorker.mockImplementation(async (request) => result(paddedPng(request.targetBytes!)))
    const preparation = createChatImagePreparation(deps)
    const input = projection(...Array.from({ length: 50 }, (_, index) => url(png(2001 + index))))
    const output = await preparation.prepareResponsesInput(input)
    const images = output[0].content.filter((part) => part.type === 'input_image')
    const total = images.reduce(
      (sum, image) => sum + Buffer.from(image.image_url.split(',')[1], 'base64').byteLength,
      0
    )
    expect(images).toHaveLength(50)
    expect(total).toBe(18 * 1024 * 1024)
    expect(deps.runWorker.mock.calls[0][0].targetBytes).toBe(Math.floor((18 * 1024 * 1024) / 50))
    expect(deps.runWorker.mock.calls.every(([request]) => request.targetBytes! <= 512_000)).toBe(
      true
    )
    preparation.clear()
  }, 30_000)

  it('clear removes this request cache and resolved path for the next use', async () => {
    const deps = dependencies()
    const preparation = createChatImagePreparation(deps)
    const input = projection(url(png(2001)))
    await preparation.prepareResponsesInput(input)
    await preparation.prepareResponsesInput(input)
    expect(deps.resolveWorker).toHaveBeenCalledOnce()
    expect(deps.runWorker).toHaveBeenCalledOnce()
    preparation.clear()
    await preparation.prepareResponsesInput(input)
    expect(deps.resolveWorker).toHaveBeenCalledTimes(2)
    expect(deps.runWorker).toHaveBeenCalledTimes(2)
    preparation.clear()
  })

  it('honors pre-cancellation without worker resolution', async () => {
    const deps = dependencies()
    const preparation = createChatImagePreparation(deps)
    const controller = new AbortController()
    controller.abort('user cancelled')
    await expect(
      preparation.prepareResponsesInput(projection(url(png(2001))), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(deps.resolveWorker).not.toHaveBeenCalled()
    expect(deps.runWorker).not.toHaveBeenCalled()
    preparation.clear()
  })

  it('clear during delayed resolution prevents the retired request from starting a worker', async () => {
    const deps = dependencies()
    let release!: (path: string) => void
    deps.resolveWorker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const preparation = createChatImagePreparation(deps)
    const pending = preparation.prepareResponsesInput(projection(url(png(2001))))
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await vi.waitFor(() => expect(release).toBeDefined())
      preparation.clear()
      release(process.platform === 'win32' ? 'C:/owned/late.exe' : '/owned/late')
      await rejection
      // A small successful follow-up also waits for the retired queue slot to leave.
      await preparation.prepareResponsesInput(projection(url(tinyPng)))
      expect(deps.runWorker).not.toHaveBeenCalled()
    } finally {
      release?.(process.platform === 'win32' ? 'C:/owned/late.exe' : '/owned/late')
      preparation.clear()
      await pending.catch(() => undefined)
    }
  })

  it('aborts an in-flight encode without starting the next image or returning late results', async () => {
    const deps = dependencies()
    let release!: (result: ChatImageWorkerResult) => void
    deps.runWorker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const preparation = createChatImagePreparation(deps)
    const controller = new AbortController()
    const pending = preparation.prepareResponsesInput(
      projection(url(png(2001)), url(png(2002))),
      controller.signal
    )
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await vi.waitFor(() => expect(release).toBeDefined())
      controller.abort('user cancelled')
      await rejection
      expect(deps.runWorker.mock.calls[0][0].signal?.aborted).toBe(true)
      release(result())
      await preparation.prepareResponsesInput(projection(url(tinyPng)))
      expect(deps.runWorker).toHaveBeenCalledOnce()
    } finally {
      release?.(result())
      preparation.clear()
      await pending.catch(() => undefined)
    }
  })
})
