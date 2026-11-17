import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>() }))
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => h.listeners.set(channel, listener)) }
}))

import {
  forgetChatSendStageOnPageChange,
  getLastChatSendStage,
  getOpenChatSends,
  recordChatSendStage,
  registerChatSendStageIpc,
  resetChatSendStagesForTests
} from './chatSendStageBreadcrumbs'

const crumb = (stage: string, imageCount = 8, sendSeq = 1) => ({
  stage,
  sendSeq,
  messageCount: 2,
  imageCount,
  imageBytes: 7_000_000,
  dataUrlCount: 8,
  dataUrlChars: 9_300_000,
  ...(stage === 'reply-failed' ? { failedAfter: 'request-built', errorName: 'Error' } : {})
})
const sender = (id: number, destroyed = false) => ({ id, isDestroyed: () => destroyed, mainFrame: { frame: id }, on: vi.fn(), once: vi.fn() })
type Sender = ReturnType<typeof sender>
/** A message from the top frame of that page. */
const from = (source: Sender) => ({ sender: source, senderFrame: source.mainFrame })
const windowOf = (source: Sender, destroyed = false) => ({ isDestroyed: () => destroyed, webContents: source })

describe('chat send-stage breadcrumbs in main', () => {
  afterEach(() => {
    resetChatSendStagesForTests()
    h.listeners.clear()
  })

  // Updated: a report with a key main does not know used to be dropped whole; main no longer walks
  // the keys (that costs as much as the deserialization), it keeps the known ones and nothing else.
  it('keeps the last breadcrumb per renderer, ignores anything that is not one and keeps no other key', () => {
    const main = sender(1)
    const gone = sender(2, true)
    let mainWindow: unknown = windowOf(main)
    registerChatSendStageIpc(() => mainWindow as never)
    const listener = h.listeners.get('app:chat-send-stage')!
    listener(from(main), crumb('request-start'))
    listener(from(main), crumb('request-built'))
    listener(from(main), { ...crumb('reply-finished'), prompt: 'secret' })
    listener(from(main), 'request-built')
    mainWindow = windowOf(gone)
    listener(from(gone), crumb('request-start'))

    expect(getLastChatSendStage(1)).toMatchObject(crumb('reply-finished'))
    expect(getLastChatSendStage(1)).not.toHaveProperty('prompt')
    expect(getLastChatSendStage(1)?.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(getLastChatSendStage(2)).toBeNull()
  })

  it('accepts a breadcrumb only from the top frame of the main window\'s page', () => {
    const main = sender(1)
    const other = sender(2)
    let mainWindow: unknown = windowOf(main)
    registerChatSendStageIpc(() => mainWindow as never)
    const listener = h.listeners.get('app:chat-send-stage')!

    // Another window's page, a sub-frame of the main page, a frame that is already gone.
    listener(from(other), crumb('request-start'))
    listener({ sender: main, senderFrame: { frame: 'child' } }, crumb('request-start'))
    listener({ sender: main, senderFrame: null }, crumb('request-start'))
    listener({ sender: main }, crumb('request-start'))
    expect(getLastChatSendStage()).toBeNull()

    // No main window (yet, or any more), or a destroyed one.
    mainWindow = null
    listener(from(main), crumb('request-start'))
    mainWindow = windowOf(main, true)
    listener(from(main), crumb('request-start'))
    expect(getLastChatSendStage()).toBeNull()

    // A listener that throws while a window goes away must not take the main process down.
    mainWindow = { isDestroyed: () => { throw new Error('Object has been destroyed') } }
    expect(() => listener(from(main), crumb('request-start'))).not.toThrow()

    mainWindow = windowOf(main)
    listener(from(main), crumb('request-built'))
    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'request-built' })
    expect(getLastChatSendStage(2)).toBeNull()
  })

  it('keeps the JS heap numbers the preload attached and nothing else', () => {
    expect(recordChatSendStage(1, { ...crumb('request-built'), usedJSHeapSize: 1_932_642_304, jsHeapSizeLimit: 2_248_146_944 })).toBe(true)
    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'request-built', usedJSHeapSize: 1_932_642_304, jsHeapSizeLimit: 2_248_146_944 })
    // A heap number of the wrong kind makes the whole message invalid.
    expect(recordChatSendStage(1, { ...crumb('reply-finished'), usedJSHeapSize: 'much' })).toBe(false)
    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'request-built' })
    // Updated: an extra key used to make the message invalid; it is now left behind, never stored.
    expect(recordChatSendStage(1, { ...crumb('reply-finished'), usedJSHeapSize: 1, heapDump: 'secret' })).toBe(true)
    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'reply-finished', usedJSHeapSize: 1 })
    expect(getLastChatSendStage(1)).not.toHaveProperty('heapDump')
  })

  it('answers the latest breadcrumb of any renderer for child-process deaths and stays bounded', () => {
    for (let id = 1; id <= 40; id += 1) recordChatSendStage(id, crumb('request-start', id))
    expect(getLastChatSendStage()?.imageCount).toBe(40)
    expect(getLastChatSendStage(1)).toBeNull()
    expect(getLastChatSendStage(25)?.imageCount).toBe(25)
    recordChatSendStage(25, crumb('request-built', 1))
    expect(getLastChatSendStage()).toMatchObject({ stage: 'request-built', imageCount: 1 })
  })

  it('keeps every send that has not ended, so a background request that ends cannot hide a running image send', () => {
    recordChatSendStage(1, crumb('request-start', 40, 1))
    recordChatSendStage(1, crumb('images-checked', 40, 1))
    recordChatSendStage(1, crumb('request-built', 40, 1))
    // A text-only request (e.g. the context compaction) overlaps and ends.
    recordChatSendStage(1, crumb('request-start', 0, 2))
    recordChatSendStage(1, crumb('request-built', 0, 2))
    recordChatSendStage(1, crumb('reply-finished', 0, 2))

    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'reply-finished', sendSeq: 2, imageCount: 0 })
    expect(getOpenChatSends(1)).toEqual([expect.objectContaining({ stage: 'request-built', sendSeq: 1, imageCount: 40 })])

    // Its own end closes it; a failure of an unknown send closes nothing.
    recordChatSendStage(1, crumb('reply-failed', 0, 9))
    expect(getOpenChatSends(1)).toHaveLength(1)
    recordChatSendStage(1, crumb('reply-failed', 40, 1))
    expect(getOpenChatSends(1)).toEqual([])
    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'reply-failed', sendSeq: 1, failedAfter: 'request-built', errorName: 'Error' })
  })

  it('keeps at most eight unfinished sends per renderer, dropping the oldest', () => {
    for (let seq = 1; seq <= 12; seq += 1) recordChatSendStage(1, crumb('request-start', seq, seq))
    expect(getOpenChatSends(1).map((stage) => stage.sendSeq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12])
    // A later stage of a kept send keeps its place.
    recordChatSendStage(1, crumb('request-built', 5, 5))
    expect(getOpenChatSends(1).map((stage) => [stage.sendSeq, stage.stage])[0]).toEqual([5, 'request-built'])
  })

  it('a report that arrives out of order neither reopens an ended send nor moves a send back', () => {
    recordChatSendStage(1, crumb('request-start', 3, 1))
    recordChatSendStage(1, crumb('request-built', 3, 1))
    recordChatSendStage(1, crumb('images-checked', 3, 1))
    expect(getOpenChatSends(1)).toEqual([expect.objectContaining({ sendSeq: 1, stage: 'request-built' })])
    recordChatSendStage(1, crumb('reply-finished', 3, 1))
    recordChatSendStage(1, crumb('request-built', 3, 1))
    expect(getOpenChatSends(1)).toEqual([])
  })

  it('a late report never moves the last report backwards', () => {
    recordChatSendStage(1, crumb('request-start', 3, 1))
    recordChatSendStage(1, crumb('request-built', 3, 1))
    recordChatSendStage(1, crumb('images-checked', 3, 1))
    expect(getLastChatSendStage(1)).toMatchObject({ sendSeq: 1, stage: 'request-built' })
    recordChatSendStage(1, crumb('reply-finished', 3, 1))
    recordChatSendStage(1, crumb('request-built', 3, 1))
    recordChatSendStage(1, crumb('reply-finished', 3, 1))
    expect(getLastChatSendStage(1)).toMatchObject({ sendSeq: 1, stage: 'reply-finished' })
    // A newer send still moves it on.
    recordChatSendStage(1, crumb('request-start', 0, 2))
    expect(getLastChatSendStage(1)).toMatchObject({ sendSeq: 2, stage: 'request-start' })
  })

  it('starts over when the page restarted its numbers without a process death', () => {
    recordChatSendStage(1, crumb('request-start', 40, 1))
    recordChatSendStage(1, crumb('request-built', 40, 1))
    recordChatSendStage(1, crumb('request-start', 0, 2))
    // A new page: its first request is number 1 again.
    recordChatSendStage(1, crumb('request-start', 2, 1))
    expect(getOpenChatSends(1)).toEqual([expect.objectContaining({ sendSeq: 1, imageCount: 2, stage: 'request-start' })])
  })

  // Updated: it used to forget already when a main-frame navigation started, also one that the
  // window then blocks (an untrusted link, a stray file drop) while the page keeps sending.
  it('forgets a page\'s sends when a new document commits (navigation or reload), not when a navigation only starts', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const webContents = {
      id: 1,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener))
    }
    forgetChatSendStageOnPageChange(webContents as never)
    forgetChatSendStageOnPageChange(webContents as never)
    // Attached once per page, whatever the number of reports.
    expect(webContents.on).toHaveBeenCalledTimes(1)
    expect(webContents.once).toHaveBeenCalledTimes(1)
    // A navigation that only starts (and may be blocked) leaves the running sends alone.
    expect(listeners.has('did-start-navigation')).toBe(false)
    const fill = () => recordChatSendStage(1, crumb('request-built', 8, 4))

    fill()
    expect(getOpenChatSends(1)).toHaveLength(1)
    listeners.get('did-navigate')!()
    expect(getOpenChatSends(1)).toEqual([])
    expect(getLastChatSendStage(1)).toBeNull()
    fill()
    listeners.get('destroyed')!()
    expect(getLastChatSendStage(1)).toBeNull()
  })

  it('watches the reporting page for navigations once it reports', () => {
    const main = sender(1)
    registerChatSendStageIpc(() => windowOf(main) as never)
    const listener = h.listeners.get('app:chat-send-stage')!
    listener(from(main), crumb('request-start'))
    listener(from(main), crumb('request-built'))
    expect(main.on.mock.calls.map(([event]) => event)).toEqual(['did-navigate'])
    expect(main.once.mock.calls.map(([event]) => event)).toEqual(['destroyed'])
  })
})
