import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saveSessionToDBMock = vi.hoisted(() => vi.fn())

vi.mock('./chatStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatStorage')>()),
  saveSessionToDB: saveSessionToDBMock
}))

import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'

const realStructuredClone = globalThis.structuredClone
const imageUrls = Array.from(
  { length: 8 },
  (_, index) => 'data:image/png;base64,' + String.fromCharCode(65 + index).repeat(4096)
)
const sourceCharacters = imageUrls.reduce((total, url) => total + url.length, 0)

const session = (id: string, content: string): ChatSession => ({
  id,
  title: id,
  messages: [
    {
      role: 'user',
      content,
      attachments: imageUrls.map((url, index) => ({
        type: 'image',
        url,
        fileName: 'synthetic-' + index + '.png'
      }))
    }
  ]
})

const urlsOf = (value: ChatSession): string[] =>
  value.messages.flatMap(
    (message) => message.attachments?.map((attachment) => attachment.url) ?? []
  )

const observeClones = () => {
  let projectedUrlCharacters = 0
  const spy = vi
    .spyOn(globalThis, 'structuredClone')
    .mockImplementation(<T>(value: T, options?: StructuredSerializeOptions): T => {
      const candidate = value as Partial<ChatSession> | null
      for (const message of candidate?.messages ?? []) {
        for (const attachment of message.attachments ?? []) {
          projectedUrlCharacters += attachment.url.length
        }
      }
      return realStructuredClone(value, options)
    })
  return { spy, projectedUrlCharacters: () => projectedUrlCharacters }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

beforeEach(() => {
  saveSessionToDBMock.mockReset()
  saveSessionToDBMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ChatSessionSaveBaseline persist payload ownership and clone budget', () => {
  it('keeps the captured eight-image save independent of caller mutation with no baseline', async () => {
    const writer = new ChatSessionSaveBaseline()
    const original = session('new-session', 'before queue')
    const expected = session('new-session', 'before queue')
    expect(urlsOf(original)).toEqual(imageUrls)
    const observation = observeClones()

    const pending = writer.persist('scope', original, () => null)
    original.messages[0].content = 'caller changed after enqueue'
    original.messages[0].attachments![0].url = 'data:image/png;base64,Qg=='
    await pending

    expect(saveSessionToDBMock).toHaveBeenCalledOnce()
    const [payload, scope, options] = saveSessionToDBMock.mock.calls[0]
    expect(scope).toBe('scope')
    expect(payload).toEqual(expected)
    expect(urlsOf(payload)).toEqual(imageUrls)
    expect(payload).not.toBe(original)
    expect(payload.messages).not.toBe(original.messages)
    expect(payload.messages[0].attachments).not.toBe(original.messages[0].attachments)
    expect(options).toEqual({ expectedSession: null, pendingSaveOwner: null })
    expect(original.messages[0].content).toBe('caller changed after enqueue')
    expect(urlsOf(original).slice(1)).toEqual(imageUrls.slice(1))
    expect(writer.isPending('scope', original.id)).toBe(false)

    console.info('persist-clone-observation', {
      baseline: 'absent',
      sourceCharacters,
      cloneCalls: observation.spy.mock.calls.length,
      projectedUrlCharacters: observation.projectedUrlCharacters()
    })
    // Resource assertions follow the behavioral and source-integrity assertions.
    expect(observation.spy).toHaveBeenCalledTimes(1)
    expect(observation.projectedUrlCharacters()).toBe(sourceCharacters)
  })

  it('keeps both eight-image payload and expected baseline defensive on the first save', async () => {
    const writer = new ChatSessionSaveBaseline()
    const baseline = session('existing-session', 'persisted original')
    const original = session('existing-session', 'local change')
    const expectedBaseline = session('existing-session', 'persisted original')
    const expectedPayload = session('existing-session', 'local change')
    expect(urlsOf(baseline)).toEqual(imageUrls)
    expect(urlsOf(original)).toEqual(imageUrls)
    const resolveBaseline = vi.fn(() => baseline)
    const observation = observeClones()

    const pending = writer.persist('scope', original, resolveBaseline)
    baseline.messages[0].content = 'later external observation'
    baseline.messages[0].attachments![0].url = 'data:image/png;base64,Qw=='
    original.messages[0].content = 'later local mutation'
    original.messages[0].attachments![0].url = 'data:image/png;base64,RA=='
    await pending

    expect(resolveBaseline).toHaveBeenCalledOnce()
    expect(saveSessionToDBMock).toHaveBeenCalledOnce()
    const [payload, scope, options] = saveSessionToDBMock.mock.calls[0]
    expect(scope).toBe('scope')
    expect(payload).toEqual(expectedPayload)
    expect(options).toEqual({ expectedSession: expectedBaseline, pendingSaveOwner: null })
    expect(urlsOf(payload)).toEqual(imageUrls)
    expect(urlsOf(options.expectedSession)).toEqual(imageUrls)
    expect(payload).not.toBe(original)
    expect(payload.messages[0].attachments).not.toBe(original.messages[0].attachments)
    expect(options.expectedSession).not.toBe(baseline)
    expect(options.expectedSession.messages).not.toBe(baseline.messages)
    expect(options.expectedSession.messages[0].attachments).not.toBe(
      baseline.messages[0].attachments
    )
    expect(urlsOf(original).slice(1)).toEqual(imageUrls.slice(1))
    expect(urlsOf(baseline).slice(1)).toEqual(imageUrls.slice(1))
    expect(writer.isPending('scope', original.id)).toBe(false)

    console.info('persist-clone-observation', {
      baseline: 'eight-images',
      sourceCharacters,
      cloneCalls: observation.spy.mock.calls.length,
      projectedUrlCharacters: observation.projectedUrlCharacters()
    })
    // Preserve the defensive payload, baseline and CAS copies; remove only the unused copy.
    expect(observation.spy).toHaveBeenCalledTimes(3)
    expect(observation.projectedUrlCharacters()).toBe(sourceCharacters * 3)
  })

  it('joins a pending identical snapshot and keeps the next queued save pending until it completes', async () => {
    const writer = new ChatSessionSaveBaseline()
    const baseline = session('ordered', 'persisted')
    const first = session('ordered', 'first')
    const second = session('ordered', 'second')
    const firstGate = deferred()
    const secondGate = deferred()
    const order: string[] = []
    saveSessionToDBMock.mockImplementation(async (payload: ChatSession) => {
      const content = payload.messages[0].content
      order.push('start:' + content)
      await (content === 'first' ? firstGate.promise : secondGate.promise)
      order.push('end:' + content)
    })

    const pendingFirst = writer.persist('scope', first, () => baseline)
    const joined = writer.persist('scope', first, () => baseline)
    const queuedSecond = writer.persist('scope', second, () => baseline)
    try {
      await vi.waitFor(() => expect(saveSessionToDBMock).toHaveBeenCalledTimes(1))
      expect(order).toEqual(['start:first'])
      expect(writer.isPending('scope', first.id)).toBe(true)

      firstGate.resolve()
      await Promise.all([pendingFirst, joined])
      await vi.waitFor(() => expect(saveSessionToDBMock).toHaveBeenCalledTimes(2))
      expect(order).toEqual(['start:first', 'end:first', 'start:second'])
      expect(writer.isPending('scope', second.id)).toBe(true)

      secondGate.resolve()
      await queuedSecond
      expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
      expect(writer.isPending('scope', second.id)).toBe(false)
      for (const [payload, scope, options] of saveSessionToDBMock.mock.calls) {
        expect(scope).toBe('scope')
        expect(urlsOf(payload)).toEqual(imageUrls)
        expect(options.expectedSession).toEqual(baseline)
        expect(options.pendingSaveOwner).toBeNull()
      }
      expect(urlsOf(first)).toEqual(imageUrls)
      expect(urlsOf(second)).toEqual(imageUrls)
    } finally {
      firstGate.resolve()
      secondGate.resolve()
      await Promise.allSettled([pendingFirst, joined, queuedSecond])
    }
  })

  it('releases failed pending work so the same unchanged snapshot can be retried with its original expectation', async () => {
    const writer = new ChatSessionSaveBaseline()
    const baseline = session('retry', 'persisted')
    const original = session('retry', 'local')
    const failure = new Error('synthetic persistence failure')
    saveSessionToDBMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)

    const first = writer.persist('scope', original, () => baseline)
    const joined = writer.persist('scope', original, () => baseline)
    const outcomes = await Promise.allSettled([first, joined])
    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(saveSessionToDBMock).toHaveBeenCalledOnce()
    expect(writer.isPending('scope', original.id)).toBe(false)

    await writer.persist('scope', original, () => baseline)
    expect(saveSessionToDBMock).toHaveBeenCalledTimes(2)
    expect(writer.isPending('scope', original.id)).toBe(false)
    for (const [payload, scope, options] of saveSessionToDBMock.mock.calls) {
      expect(scope).toBe('scope')
      expect(payload).toEqual(original)
      expect(payload).not.toBe(original)
      expect(urlsOf(payload)).toEqual(imageUrls)
      expect(options.expectedSession).toEqual(baseline)
      expect(options.expectedSession).not.toBe(baseline)
    }
    expect(urlsOf(original)).toEqual(imageUrls)
    expect(urlsOf(baseline)).toEqual(imageUrls)
  })
})
