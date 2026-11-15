import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>() }))
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => h.listeners.set(channel, listener)) }
}))

import {
  getLastChatSendStage,
  recordChatSendStage,
  registerChatSendStageIpc,
  resetChatSendStagesForTests
} from './chatSendStageBreadcrumbs'

const crumb = (stage: string, imageCount = 8) => ({ stage, messageCount: 2, imageCount, imageBytes: 7_000_000, dataUrlCount: 8, dataUrlChars: 9_300_000 })
const sender = (id: number, destroyed = false) => ({ id, isDestroyed: () => destroyed, mainFrame: { frame: id } })
type Sender = ReturnType<typeof sender>
/** A message from the top frame of that page. */
const from = (source: Sender) => ({ sender: source, senderFrame: source.mainFrame })
const windowOf = (source: Sender, destroyed = false) => ({ isDestroyed: () => destroyed, webContents: source })

describe('chat send-stage breadcrumbs in main', () => {
  afterEach(() => {
    resetChatSendStagesForTests()
    h.listeners.clear()
  })

  it('keeps the last breadcrumb per renderer and ignores anything that is not exactly one', () => {
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

    expect(getLastChatSendStage(1)).toMatchObject(crumb('request-built'))
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
    // A heap number of the wrong kind, or any other extra key, makes the whole message invalid.
    expect(recordChatSendStage(1, { ...crumb('reply-finished'), usedJSHeapSize: 'much' })).toBe(false)
    expect(recordChatSendStage(1, { ...crumb('reply-finished'), usedJSHeapSize: 1, heapDump: 'secret' })).toBe(false)
    expect(getLastChatSendStage(1)).toMatchObject({ stage: 'request-built' })
  })

  it('answers the latest breadcrumb of any renderer for child-process deaths and stays bounded', () => {
    for (let id = 1; id <= 40; id += 1) recordChatSendStage(id, crumb('request-start', id))
    expect(getLastChatSendStage()?.imageCount).toBe(40)
    expect(getLastChatSendStage(1)).toBeNull()
    expect(getLastChatSendStage(25)?.imageCount).toBe(25)
    recordChatSendStage(25, crumb('request-built', 1))
    expect(getLastChatSendStage()).toMatchObject({ stage: 'request-built', imageCount: 1 })
  })
})
