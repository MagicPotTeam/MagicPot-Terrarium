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
const sender = (id: number, destroyed = false) => ({ id, isDestroyed: () => destroyed })

describe('chat send-stage breadcrumbs in main', () => {
  afterEach(() => {
    resetChatSendStagesForTests()
    h.listeners.clear()
  })

  it('keeps the last breadcrumb per renderer and ignores anything that is not exactly one', () => {
    registerChatSendStageIpc()
    const listener = h.listeners.get('app:chat-send-stage')!
    listener({ sender: sender(1) }, crumb('request-start'))
    listener({ sender: sender(1) }, crumb('request-built'))
    listener({ sender: sender(1) }, { ...crumb('reply-finished'), prompt: 'secret' })
    listener({ sender: sender(1) }, 'request-built')
    listener({ sender: sender(2, true) }, crumb('request-start'))

    expect(getLastChatSendStage(1)).toMatchObject(crumb('request-built'))
    expect(getLastChatSendStage(1)).not.toHaveProperty('prompt')
    expect(getLastChatSendStage(1)?.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(getLastChatSendStage(2)).toBeNull()
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
