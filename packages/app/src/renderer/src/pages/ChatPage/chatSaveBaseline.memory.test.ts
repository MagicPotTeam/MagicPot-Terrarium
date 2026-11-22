import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saveSessionToDBMock = vi.hoisted(() => vi.fn())

vi.mock('./chatStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatStorage')>()),
  saveSessionToDB: saveSessionToDBMock
}))

import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'

const realStructuredClone = globalThis.structuredClone
const MARK_COUNT = 100
const imageUrls = Array.from(
  { length: 8 },
  (_, index) => 'data:image/png;base64,' + String.fromCharCode(65 + index).repeat(4096)
)

const session = (id: string, content: string): ChatSession => ({
  id,
  title: id,
  messages: [
    {
      role: 'user',
      content,
      attachments: imageUrls.map((url) => ({ type: 'image', url }))
    }
  ]
})

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

describe('ChatSessionSaveBaseline no-result dirty marking', () => {
  beforeEach(() => {
    saveSessionToDBMock.mockReset()
    saveSessionToDBMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the old snapshot-returning API as a measured control', () => {
    const writer = new ChatSessionSaveBaseline()
    const original = session('control', 'original')
    const observation = observeClones()

    for (let index = 0; index < MARK_COUNT; index++) writer.freeze('scope', original.id, original)

    expect(observation.spy).toHaveBeenCalledTimes(MARK_COUNT + 1)
    expect(observation.projectedUrlCharacters()).toBe(
      imageUrls.reduce((total, url) => total + url.length, 0) * (MARK_COUNT + 1)
    )
  })

  it('dirty marking clones the image-bearing baseline only on first touch', () => {
    const writer = new ChatSessionSaveBaseline()
    const original = session('dirty', 'original')
    const observation = observeClones()

    for (let index = 0; index < MARK_COUNT; index++)
      writer.ensureFrozen('scope', original.id, original)

    console.info('dirty-mark-clone-observation', {
      marks: MARK_COUNT,
      cloneCalls: observation.spy.mock.calls.length,
      projectedUrlCharacters: observation.projectedUrlCharacters()
    })
    expect(observation.spy).toHaveBeenCalledTimes(1)
    expect(observation.projectedUrlCharacters()).toBe(
      imageUrls.reduce((total, url) => total + url.length, 0)
    )
    expect(original.messages[0].attachments?.map((attachment) => attachment.url)).toEqual(imageUrls)
  })

  it('keeps the first authority and isolates source mutation', async () => {
    const writer = new ChatSessionSaveBaseline()
    const original = session('authority', 'original')
    expect(writer.ensureFrozen('scope', original.id, original)).toBeUndefined()

    original.messages[0].content = 'mutated caller'
    original.messages[0].attachments![0].url = 'data:image/png;base64,Qg=='
    writer.ensureFrozen('scope', original.id, session(original.id, 'newer external snapshot'))

    const next = session(original.id, 'local next')
    await writer.persistLatest(
      'scope',
      next.id,
      () => next,
      () => original
    )
    expect(saveSessionToDBMock.mock.calls[0][2].expectedSession).toEqual(
      session(original.id, 'original')
    )
    expect(writer.isAcknowledgementCurrent('scope', next)).toBe(true)
  })

  it('freezes null as an expected absent record without cloning or adopting a later value', async () => {
    const writer = new ChatSessionSaveBaseline()
    const observation = observeClones()
    writer.ensureFrozen('scope', 'new', null)
    writer.ensureFrozen('scope', 'new', session('new', 'external'))

    expect(writer.hasBaseline('scope', 'new')).toBe(true)
    expect(observation.spy).not.toHaveBeenCalled()
    const next = session('new', 'local')
    await writer.persistLatest(
      'scope',
      next.id,
      () => next,
      () => session('new', 'external')
    )
    expect(saveSessionToDBMock.mock.calls[0][2].expectedSession).toBeNull()
  })

  it('keeps the same session ID independent across scopes', () => {
    const writer = new ChatSessionSaveBaseline()
    writer.ensureFrozen('scope-a', 'same', session('same', 'a'))
    writer.ensureFrozen('scope-b', 'same', session('same', 'b'))
    writer.ensureFrozen('scope-a', 'same', session('same', 'replacement'))

    expect(writer.freeze('scope-a', 'same', null)?.messages[0].content).toBe('a')
    expect(writer.freeze('scope-b', 'same', null)?.messages[0].content).toBe('b')
  })

  it('preserves an explicitly advanced baseline until release or reset', () => {
    const writer = new ChatSessionSaveBaseline()
    writer.ensureFrozen('scope', 's', session('s', 'first'))
    writer.advance('scope', 's', session('s', 'committed'))
    writer.ensureFrozen('scope', 's', session('s', 'stale'))
    expect(writer.freeze('scope', 's', null)?.messages[0].content).toBe('committed')

    writer.release('scope', 's')
    expect(writer.hasBaseline('scope', 's')).toBe(false)
    writer.ensureFrozen('scope', 's', session('s', 'after release'))
    expect(writer.freeze('scope', 's', null)?.messages[0].content).toBe('after release')

    writer.reset()
    expect(writer.hasBaseline('scope', 's')).toBe(false)
    writer.ensureFrozen('scope', 's', session('s', 'after reset'))
    expect(writer.freeze('scope', 's', null)?.messages[0].content).toBe('after reset')
  })

  it('keeps freeze return values defensive after a no-result freeze', async () => {
    const writer = new ChatSessionSaveBaseline()
    const original = session('returned-copy', 'original')
    writer.ensureFrozen('scope', original.id, original)
    const returned = writer.freeze('scope', original.id, null)!
    returned.messages[0].content = 'mutated returned object'
    returned.messages[0].attachments![0].url = 'data:image/png;base64,Qg=='

    const next = session(original.id, 'next')
    await writer.persistLatest(
      'scope',
      next.id,
      () => next,
      () => null
    )
    expect(saveSessionToDBMock.mock.calls[0][2].expectedSession).toEqual(
      session(original.id, 'original')
    )
  })
})
