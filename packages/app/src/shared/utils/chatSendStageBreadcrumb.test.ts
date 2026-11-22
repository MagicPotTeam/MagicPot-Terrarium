import { describe, expect, it } from 'vitest'
import {
  chatSendErrorName,
  failedChatSendStage,
  parseChatSendStageBreadcrumb,
  parseChatSendStageReport,
  summarizeChatSendStage,
  withJsHeapNumbers
} from './chatSendStageBreadcrumb'

describe('chat send-stage breadcrumb', () => {
  it('counts images, sizes and inline data: URLs without copying any content', () => {
    const inline = 'data:image/jpeg;base64,' + 'A'.repeat(400)
    const breadcrumb = summarizeChatSendStage(
      'request-built',
      [
        { attachments: [{ type: 'image', url: inline }, { type: 'image', url: 'local-media:///a.png', sizeBytes: 1234 }] },
        { attachments: [{ type: 'file', url: 'data:text/plain;base64,QQ==' }] },
        {}
      ],
      7
    )
    expect(breadcrumb).toEqual({
      stage: 'request-built',
      sendSeq: 7,
      messageCount: 3,
      imageCount: 2,
      imageBytes: 300 + 1234,
      dataUrlCount: 2,
      dataUrlChars: inline.length + 'data:text/plain;base64,QQ=='.length
    })
    expect(parseChatSendStageBreadcrumb(breadcrumb)).toEqual(breadcrumb)
  })

  it('the page reports no JS heap number, and a breadcrumb that claims one is not a breadcrumb', () => {
    const counts = summarizeChatSendStage('request-built', [{}], 1)
    expect(Object.keys(counts).sort()).toEqual(['dataUrlChars', 'dataUrlCount', 'imageBytes', 'imageCount', 'messageCount', 'sendSeq', 'stage'])
    // performance.memory said 26 MB during a real out-of-memory death: never take it from the page.
    expect(parseChatSendStageBreadcrumb({ ...counts, usedJSHeapSize: 26_000_000 })).toBeNull()
    expect(parseChatSendStageBreadcrumb({ ...counts, jsHeapSizeLimit: 2_330_000_000 })).toBeNull()
  })

  it('the report main keeps adds the heap numbers the preload read, and only whole non-negative numbers', () => {
    const counts = summarizeChatSendStage('request-built', [{}], 1)
    const report = withJsHeapNumbers(counts, { usedJSHeapSize: 1_932_642_304, jsHeapSizeLimit: 2_248_146_944 })
    expect(report).toEqual({ ...counts, usedJSHeapSize: 1_932_642_304, jsHeapSizeLimit: 2_248_146_944 })
    expect(parseChatSendStageReport(report)).toEqual(report)
    // Without a reading (or with a broken one) the counts still go through, without a heap number.
    expect(withJsHeapNumbers(counts, null)).toEqual(counts)
    expect(withJsHeapNumbers(counts, { usedJSHeapSize: Number.NaN, jsHeapSizeLimit: -1 })).toEqual(counts)
    expect(withJsHeapNumbers(counts, { usedJSHeapSize: 1.5, jsHeapSizeLimit: 7 })).toEqual({ ...counts, jsHeapSizeLimit: 7 })
    expect(parseChatSendStageReport(counts)).toEqual(counts)
  })

  it.each([
    null,
    'request-built',
    { stage: 'request-built' },
    { stage: 'request-built', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, usedJSHeapSize: '1' },
    { stage: 'request-built', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, jsHeapSizeLimit: -1 }
  ])('the report rejects anything but counts and the two heap numbers: %j', (value) => {
    expect(parseChatSendStageReport(value)).toBeNull()
  })

  // Updated: main used to refuse a report with a key it does not know, by walking every key. It now
  // reads only the keys it knows and leaves any other behind (the preload refuses it from the page).
  it('the report keeps only counts and the two heap numbers, whatever else a report carries', () => {
    const counts = { stage: 'request-built', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 }
    expect(parseChatSendStageReport({ ...counts, usedJSHeapSize: 1, text: 'hello' })).toEqual({ ...counts, usedJSHeapSize: 1 })
    expect(parseChatSendStageBreadcrumb({ ...counts, text: 'hello' })).toBeNull()
  })

  it('knows the stage a failed or aborted request had reached, with that stage\'s counts and the error\'s enumerated name', () => {
    const built = { ...summarizeChatSendStage('request-built', [{}, {}], 5), dataUrlCount: 8, dataUrlChars: 9_300_000 }
    const failed = failedChatSendStage(built, new RangeError('Array buffer allocation failed: C:\\secret.png'))
    expect(failed).toEqual({
      stage: 'reply-failed',
      sendSeq: 5,
      messageCount: 2,
      imageCount: 0,
      imageBytes: 0,
      dataUrlCount: 8,
      dataUrlChars: 9_300_000,
      failedAfter: 'request-built',
      errorName: 'RangeError'
    })
    expect(parseChatSendStageBreadcrumb(failed)).toEqual(failed)
    // A send that had already ended is not failed again.
    expect(failedChatSendStage({ ...built, stage: 'reply-finished' }, new Error('x'))).toBeNull()
  })

  it.each([
    [new DOMException('aborted', 'AbortError'), 'AbortError'],
    [new TypeError('x'), 'TypeError'],
    [new Error('x'), 'Error'],
    [Object.assign(new Error('x'), { name: 'ReportBundleUnavailableError' }), 'other'],
    [Object.assign(new Error('x'), { name: 'C:\\Users\\secret' }), 'other'],
    ['a thrown string', 'other'],
    [undefined, 'other']
  ])('names a thrown value by an enumerated name only: %s', (error, name) => {
    expect(chatSendErrorName(error)).toBe(name)
  })

  it('names a value whose name cannot be read "other"', () => {
    const hostile = {
      get name(): string {
        throw new Error('getter')
      }
    }
    expect(chatSendErrorName(hostile)).toBe('other')
  })

  it.each([
    null,
    [],
    { stage: 'request-built' },
    { stage: 'unknown', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', messageCount: -1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, text: 'hello' },
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, usedJSHeapSize: 1 },
    // The send number is a count and is required.
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', sendSeq: '1', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', sendSeq: 2 ** 60, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    // A failure needs its stage and an enumerated error name; other stages carry neither.
    { stage: 'reply-failed', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'reply-failed', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, failedAfter: 'reply-finished', errorName: 'Error' },
    { stage: 'reply-failed', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, failedAfter: 'request-built', errorName: 'provider said: secret' },
    { stage: 'request-built', sendSeq: 1, messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, failedAfter: 'request-built' }
  ])('rejects anything but the exact shape: %j', (value) => {
    expect(parseChatSendStageBreadcrumb(value)).toBeNull()
  })
})

describe('main-side report parser: shape first, nothing copied before it', () => {
  const valid = { stage: 'request-built', sendSeq: 2, messageCount: 1, imageCount: 8, imageBytes: 10, dataUrlCount: 8, dataUrlChars: 99 }

  it('accepts a plain object, also one without a prototype (as structured clone may deliver it)', () => {
    expect(parseChatSendStageReport({ ...valid, usedJSHeapSize: 5, jsHeapSizeLimit: 9 })).toEqual({ ...valid, usedJSHeapSize: 5, jsHeapSizeLimit: 9 })
    expect(parseChatSendStageReport(Object.assign(Object.create(null), valid))).toEqual(valid)
  })

  it('rejects a typed array, an array, a map or a class instance by its prototype, without walking it', () => {
    const huge = new Uint8Array(10_000_000)
    const started = performance.now()
    expect(parseChatSendStageReport(huge)).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
    expect(parseChatSendStageReport([valid])).toBeNull()
    expect(parseChatSendStageReport(new Map(Object.entries(valid)))).toBeNull()
    class Breadcrumb { constructor() { Object.assign(this, valid) } }
    expect(parseChatSendStageReport(new Breadcrumb())).toBeNull()
    expect(parseChatSendStageReport(Object.assign(Object.create({ inherited: true }), valid))).toBeNull()
  })

  // Moved: the symbol-key refusal was pinned on the main parser. A symbol key cannot cross IPC, so
  // it is refused where the page's own object can arrive: in the preload's strict walk.
  it('refuses a symbol key in the preload parser; main, which IPC never hands one, leaves it unread', () => {
    const withSymbol = { ...valid, [Symbol('x')]: 'secret' }
    expect(parseChatSendStageBreadcrumb(withSymbol)).toBeNull()
    expect(parseChatSendStageBreadcrumb(Object.assign(Object.create(null), withSymbol))).toBeNull()
    expect(parseChatSendStageBreadcrumb({ ...valid, [Symbol.iterator]: () => undefined })).toBeNull()
    const report = parseChatSendStageReport(withSymbol)
    expect(report).toEqual(valid)
    expect(Object.getOwnPropertySymbols(report as object)).toEqual([])
  })

  // Updated: this pinned a key walk that stopped at the first unknown key. V8's for-in lists every
  // key before its first step, so that walk cost as much as the deserialization; main no longer walks.
  it('never walks the keys: it looks at the known keys only, once each, and leaves any other unread', () => {
    const read: string[] = []
    const looked: string[] = []
    let listed = 0
    const record: Record<string, unknown> = { ...valid, content: 'secret' }
    for (let index = 0; index < 1000; index += 1) record[`k${index}`] = index
    const probe = new Proxy(record, {
      get: (target, key, receiver) => {
        if (typeof key === 'string') read.push(key)
        return Reflect.get(target, key, receiver)
      },
      getOwnPropertyDescriptor: (target, key) => {
        if (typeof key === 'string') looked.push(key)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      // Listing the keys, string or symbol (Object.keys, for-in, Object.getOwnPropertySymbols).
      ownKeys: (target) => {
        listed += 1
        return Reflect.ownKeys(target)
      },
      getPrototypeOf: () => Object.prototype
    })
    expect(parseChatSendStageReport(probe)).toEqual(valid)
    expect(listed).toBe(0)
    const known = [...Object.keys(valid), 'failedAfter', 'errorName', 'usedJSHeapSize', 'jsHeapSizeLimit']
    expect(looked.filter((key) => !known.includes(key))).toEqual([])
    expect(read.filter((key) => !known.includes(key))).toEqual([])
    // One read of each key that is there.
    expect(read.slice().sort()).toEqual(Object.keys(valid).sort())
  })

  it('never takes a value inherited from Object.prototype for a missing key', () => {
    const { stage: _stage, ...withoutStage } = valid
    const prototype = Object.prototype as Record<string, unknown>
    prototype.stage = 'request-built'
    try {
      expect(parseChatSendStageReport(withoutStage)).toBeNull()
      expect(parseChatSendStageBreadcrumb(withoutStage)).toBeNull()
    } finally {
      delete prototype.stage
    }
  })
})
