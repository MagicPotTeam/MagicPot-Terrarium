import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import type {
  EnsureManagedMediaDerivativeReq,
  EnsureManagedMediaDerivativeResp
} from '@shared/api/svcManagedMedia'
import {
  downscaleHistoryImagesForRequest,
  HISTORY_IMAGE_REQUEST_MAX_EDGE,
  HISTORY_IMAGE_SMALL_BYTES
} from './chatManagedMediaAttachments'

const BIG = 8 * 1024 * 1024

const managedImage = (
  index: number,
  overrides: { sizeBytes?: number; width?: number; height?: number; fileName?: string } = {}
): ChatAttachment => {
  const hash = index.toString(16).repeat(64)
  const fileName = 'fileName' in overrides ? overrides.fileName : `fixture-${index}.png`
  return {
    type: 'image',
    url: `local-media:///fixture/${index}.png`,
    ...(fileName ? { fileName } : {}),
    media: {
      version: 1,
      kind: 'managed',
      relativePath: `originals/${hash.slice(0, 2)}/${hash}.png`,
      sha256: hash,
      sizeBytes: overrides.sizeBytes ?? BIG,
      mimeType: 'image/png',
      originalFileName: `original-${index}.png`,
      ...(overrides.width ? { width: overrides.width } : {}),
      ...(overrides.height ? { height: overrides.height } : {})
    }
  }
}

const ready = (req: EnsureManagedMediaDerivativeReq): EnsureManagedMediaDerivativeResp => ({
  status: 'ready',
  descriptor: {
    maxEdge: req.maxEdge,
    relativePath: `derivatives/${req.reference.sha256}-${req.maxEdge}.webp`,
    mimeType: 'image/webp',
    sizeBytes: 12_345,
    width: req.maxEdge,
    height: 768,
    sha256: 'f'.repeat(64),
    localMediaUrl: `local-media:///derivatives/${req.reference.sha256}-${req.maxEdge}.webp`
  }
})

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('downscaleHistoryImagesForRequest', () => {
  it('replaces earlier images with the 1024 px derivative and keeps the latest user turn', async () => {
    const latest = managedImage(3)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first', attachments: [managedImage(1)] },
      { role: 'assistant', content: 'generated', attachments: [managedImage(2)] },
      { role: 'user', content: 'now', attachments: [latest] }
    ]
    const snapshot = structuredClone(messages)
    const ensureDerivative = vi.fn(async (req: EnsureManagedMediaDerivativeReq) => ready(req))

    const result = await downscaleHistoryImagesForRequest(messages, {
      ensureDerivative,
      canSendDerivative: true
    })

    expect(ensureDerivative).toHaveBeenCalledTimes(2)
    for (const [req] of ensureDerivative.mock.calls) {
      expect(req.maxEdge).toBe(HISTORY_IMAGE_REQUEST_MAX_EDGE)
    }
    for (const index of [0, 1]) {
      const image = result[index].attachments![0]
      expect(image.media).toBeUndefined()
      expect(image.url).toMatch(/^local-media:\/\/\/derivatives\/.+-1024\.webp$/)
      expect(image).toMatchObject({
        mimeType: 'image/webp',
        sizeBytes: 12_345,
        sourceWidth: 1024,
        sourceHeight: 768
      })
      expect(result[index].content).toBe(messages[index].content)
    }
    // The latest turn is the very same object: not downscaled, not copied.
    expect(result[2]).toBe(messages[2])
    expect(result[2].attachments![0]).toBe(latest)
    expect(messages).toEqual(snapshot)
  })

  it('treats every image on the last user message as the latest turn, including a resend', async () => {
    // A resend (or an edited resend) of an earlier message carries the same image again:
    // the copy on the last user message stays original, the earlier copy is history.
    const resent = managedImage(1)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'original send', attachments: [managedImage(1)] },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'edited resend', attachments: [resent, managedImage(4)] }
    ]
    const ensureDerivative = vi.fn(async (req: EnsureManagedMediaDerivativeReq) => ready(req))

    const result = await downscaleHistoryImagesForRequest(messages, {
      ensureDerivative,
      canSendDerivative: true
    })

    expect(ensureDerivative).toHaveBeenCalledOnce()
    expect(result[0].attachments![0].media).toBeUndefined()
    expect(result[2]).toBe(messages[2])
    expect(result[2].attachments).toEqual([resent, managedImage(4)])
  })

  it('treats assistant images after the last user message as history', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'draw', attachments: [managedImage(1)] },
      { role: 'assistant', content: 'tool step', attachments: [managedImage(2)] }
    ]
    const ensureDerivative = vi.fn(async (req: EnsureManagedMediaDerivativeReq) => ready(req))
    const result = await downscaleHistoryImagesForRequest(messages, {
      ensureDerivative,
      canSendDerivative: true
    })
    expect(result[0]).toBe(messages[0])
    expect(result[1].attachments![0].media).toBeUndefined()
  })

  it('asks for one derivative per image even when it appears in several earlier turns', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a', attachments: [managedImage(1)] },
      { role: 'assistant', content: 'b', attachments: [managedImage(1)] },
      { role: 'user', content: 'c' }
    ]
    const ensureDerivative = vi.fn(async (req: EnsureManagedMediaDerivativeReq) => ready(req))
    await downscaleHistoryImagesForRequest(messages, { ensureDerivative, canSendDerivative: true })
    expect(ensureDerivative).toHaveBeenCalledOnce()
  })

  it('sends small earlier images unchanged without asking for a derivative', async () => {
    const byEdge = managedImage(1, { width: 1024, height: 600 })
    const bySize = managedImage(2, { sizeBytes: HISTORY_IMAGE_SMALL_BYTES })
    const dataUrl: ChatAttachment = { type: 'image', url: 'data:image/png;base64,YWJjZA==' }
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a', attachments: [byEdge, bySize, dataUrl] },
      { role: 'user', content: 'b' }
    ]
    const ensureDerivative = vi.fn(async (req: EnsureManagedMediaDerivativeReq) => ready(req))
    const result = await downscaleHistoryImagesForRequest(messages, {
      ensureDerivative,
      canSendDerivative: true
    })
    expect(ensureDerivative).not.toHaveBeenCalled()
    expect(result[0]).toBe(messages[0])
  })

  it('leaves remote URLs of unknown size and report-bundle images untouched', async () => {
    const remote: ChatAttachment = { type: 'image', url: 'https://images.invalid/a.png' }
    const bundle: ChatAttachment = {
      ...managedImage(1),
      reportBundleId: 'fixture-bundle',
      reportBundleRole: 'primary-report'
    } as ChatAttachment
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a', attachments: [remote, bundle] },
      { role: 'user', content: 'b' }
    ]
    const ensureDerivative = vi.fn(async (req: EnsureManagedMediaDerivativeReq) => ready(req))
    const result = await downscaleHistoryImagesForRequest(messages, {
      ensureDerivative,
      canSendDerivative: true
    })
    expect(ensureDerivative).not.toHaveBeenCalled()
    expect(result[0]).toBe(messages[0])
  })

  describe('fallback: a large earlier image that cannot be downscaled is left out with a note', () => {
    const omittedNote = (name: string) =>
      `[An earlier image (${name}) could not be downscaled and was not sent this time]`

    const failures: Array<
      [
        string,
        { ensureDerivative?: () => Promise<EnsureManagedMediaDerivativeResp>; canSend?: boolean }
      ]
    > = [
      ['the derivative service is missing (e.g. no thumbnail program)', {}],
      [
        'the derivative fails',
        { ensureDerivative: async () => Promise.reject(new Error('fixture derivative failure')) }
      ],
      [
        'the image is an animated GIF',
        {
          ensureDerivative: async () => ({
            status: 'fallbackOriginal',
            reason: 'animated-gif',
            localMediaUrl: 'local-media:///fixture/1.gif'
          })
        }
      ],
      [
        'the route cannot carry a request data URL',
        {
          ensureDerivative: async () => Promise.reject(new Error('must not be asked')),
          canSend: false
        }
      ]
    ]

    it.each(failures)('when %s', async (_label, setup) => {
      const keptFile: ChatAttachment = { type: 'file', url: 'local-media:///fixture/notes.txt' }
      const messages: ChatMessage[] = [
        { role: 'user', content: 'look at this', attachments: [managedImage(1), keptFile] },
        { role: 'user', content: 'and now?', attachments: [managedImage(2)] }
      ]
      const ensureDerivative = setup.ensureDerivative ? vi.fn(setup.ensureDerivative) : undefined

      const result = await downscaleHistoryImagesForRequest(messages, {
        ensureDerivative,
        canSendDerivative: setup.canSend ?? true
      })

      if (setup.canSend === false) expect(ensureDerivative).not.toHaveBeenCalled()
      expect(result[0].attachments).toEqual([keptFile])
      expect(result[0].content).toBe(`look at this\n\n${omittedNote('fixture-1.png')}`)
      expect(result[1]).toBe(messages[1])
      expect(warn).toHaveBeenCalled()
    })

    it('names an image without any file name by its position in the message', async () => {
      const big = 'A'.repeat(Math.ceil((HISTORY_IMAGE_SMALL_BYTES + 3) / 3) * 4)
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          attachments: [
            managedImage(1, { sizeBytes: 10 }),
            managedImage(2, { fileName: undefined }),
            { type: 'image', url: `data:image/png;base64,${big}` }
          ]
        },
        { role: 'user', content: 'next' }
      ]
      const result = await downscaleHistoryImagesForRequest(messages, { canSendDerivative: true })
      expect(result[0].attachments).toEqual([messages[0].attachments![0]])
      // The managed copy falls back to its stored original name, never to an internal id.
      expect(result[0].content).toBe(`${omittedNote('original-2.png')}\n${omittedNote('image 3')}`)
      expect(result[0].content).not.toMatch(/[a-f0-9]{64}/)
    })

    it('drops a large non-managed data URL and removes an empty attachment list', async () => {
      const big = 'A'.repeat(Math.ceil((HISTORY_IMAGE_SMALL_BYTES + 3) / 3) * 4)
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: 'old',
          attachments: [{ type: 'image', url: `data:image/png;base64,${big}`, fileName: 'old.png' }]
        },
        { role: 'user', content: 'new' }
      ]
      const result = await downscaleHistoryImagesForRequest(messages, { canSendDerivative: true })
      expect(result[0].attachments).toBeUndefined()
      expect(result[0].content).toBe(`old\n\n${omittedNote('old.png')}`)
    })
  })

  it('rethrows an abort instead of falling back', async () => {
    const controller = new AbortController()
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const ensureDerivative = vi.fn(async () => {
      controller.abort(abortError)
      throw abortError
    })
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a', attachments: [managedImage(1)] },
      { role: 'user', content: 'b' }
    ]
    await expect(
      downscaleHistoryImagesForRequest(messages, {
        ensureDerivative,
        canSendDerivative: true,
        signal: controller.signal
      })
    ).rejects.toBe(abortError)
  })
})
