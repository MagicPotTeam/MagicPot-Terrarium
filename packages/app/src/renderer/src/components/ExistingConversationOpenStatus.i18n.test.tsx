import { render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import type { OpenFailure, OpenSnapshot } from '../utils/existingConversationOpen'
import ExistingConversationOpenStatus from './ExistingConversationOpenStatus'

const h = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('../utils/existingConversationOpenStore', () => ({
  existingConversationOpenStore: { getSnapshot: () => h.snapshot, cancel: vi.fn() },
  useExistingConversationOpenSnapshot: () => h.snapshot
}))

const handle = { requestId: 'r', generation: 1, target: { projectId: 'project-a', paneId: 'pane-b', storageScope: 's', sessionId: 'session-c' } }
const pending = (): OpenSnapshot => ({ request: { handle, phase: 'validating' as never, visit: { projectId: 'project-a', token: {} }, deadlineAt: 0 }, visits: [], result: null })
const finished = (status: 'succeeded' | 'rejected', reason?: OpenFailure): OpenSnapshot => ({ request: null, visits: [], result: { handle, status, reason } })
const reasons: Array<OpenFailure | undefined> = ['cancelled', 'expired', 'membership-unavailable', 'load-failed', 'destination-lost', 'superseded', undefined]

async function renderIn(language: 'en-US' | 'zh-CN', snapshot: OpenSnapshot) {
  const i18n = createInstance()
  await i18n.use(initReactI18next).init({ lng: language, fallbackLng: 'en-US', resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } }, interpolation: { escapeValue: false } })
  h.snapshot = snapshot
  return render(<I18nextProvider i18n={i18n}><ExistingConversationOpenStatus /></I18nextProvider>)
}

describe('ExistingConversationOpenStatus copy', () => {
  beforeEach(() => { h.snapshot = null })

  it('shows English copy in en-US without Chinese text or raw keys', async () => {
    const texts: string[] = []
    for (const snapshot of [pending(), finished('succeeded'), ...reasons.map((reason) => finished('rejected', reason))]) {
      const view = await renderIn('en-US', snapshot)
      expect(screen.getByRole('region', { name: 'Existing conversation Open' })).toBeInTheDocument()
      expect(screen.getByText('Project: project-a · Pane: pane-b · ID: session-c')).toBeInTheDocument()
      texts.push(view.container.textContent ?? '')
      view.unmount()
    }
    const shown = texts.join('\n')
    for (const text of ['Opening existing conversation', 'Cancel Open', 'Existing conversation opened', 'Dismiss Open result', 'Existing conversation could not be opened', 'Open cancelled', 'Open timed out', 'Current ownership or persisted conversation unavailable', 'Conversation load unavailable', 'Existing destination tab, pane or presentation changed or unavailable', 'Replaced by another Open request', 'Open unavailable']) {
      expect(shown).toContain(text)
    }
    expect(shown).not.toMatch(/[㐀-鿿]/)
    expect(shown).not.toMatch(/app_shell\./)
  })

  it('keeps the zh-CN copy of the base build', async () => {
    const view = await renderIn('zh-CN', pending())
    expect(screen.getByRole('region', { name: '打开已有会话状态' })).toHaveTextContent('正在打开已有会话项目: project-a · 面板: pane-b · ID: session-c取消打开')
    view.unmount()
    await renderIn('zh-CN', finished('rejected', 'destination-lost'))
    expect(screen.getByRole('region', { name: '打开已有会话状态' })).toHaveTextContent('未能打开已有会话已有目标标签页、面板或可见状态已变化或不可用项目: project-a · 面板: pane-b · ID: session-c关闭打开结果')
  })
})
