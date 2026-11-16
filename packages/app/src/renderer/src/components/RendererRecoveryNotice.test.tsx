import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import type { RendererRecoveredEvent } from '@shared/utils/rendererRecoveryEvent'
import RendererRecoveryNotice from './RendererRecoveryNotice'

type Listener = (event: RendererRecoveredEvent) => void

async function renderNotice(language: 'zh-CN' | 'en-US') {
  const i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false }
  })
  const listeners: Listener[] = []
  const unsubscribe = vi.fn()
  const onRendererRecovered = vi.fn((cb: Listener) => {
    listeners.push(cb)
    return unsubscribe
  })
  ;(window as unknown as { appEvents: unknown }).appEvents = {
    onCloseActiveTab: vi.fn(() => () => undefined),
    onQAppDirectoryChanged: vi.fn(() => () => undefined),
    onRendererRecovered
  }
  const view = render(
    <I18nextProvider i18n={i18n}>
      <RendererRecoveryNotice />
    </I18nextProvider>
  )
  return { view, listeners, unsubscribe, onRendererRecovered }
}

describe('RendererRecoveryNotice', () => {
  afterEach(() => {
    delete (window as unknown as { appEvents?: unknown }).appEvents
  })

  it('shows nothing on an ordinary start', async () => {
    const { onRendererRecovered } = await renderNotice('zh-CN')
    expect(onRendererRecovered).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('renderer-recovery-notice')).toBeNull()
  })

  it.each([
    ['zh-CN', '窗口已重新启动', '没有任何内容被自动重新发送', '知道了'],
    ['en-US', 'The window was restarted', 'nothing was resent', 'Dismiss']
  ] as const)(
    'stays visible after a recovery until dismissed (%s)',
    async (language, title, notResent, dismiss) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
      try {
        const { listeners, view, unsubscribe } = await renderNotice(language)
        act(() => listeners[0]?.({ reason: 'crashed', exitCode: 5, diedAt: Date.now() }))

        const notice = screen.getByTestId('renderer-recovery-notice')
        expect(notice).toHaveTextContent(title)
        expect(notice).toHaveTextContent(notResent)
        expect(notice).toHaveTextContent('crashed')
        expect(notice).toHaveTextContent('5')

        // Persistent: time and clicks elsewhere do not hide it.
        act(() => vi.advanceTimersByTime(10 * 60_000))
        fireEvent.click(document.body)
        expect(screen.getByTestId('renderer-recovery-notice')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: dismiss }))
        expect(screen.queryByTestId('renderer-recovery-notice')).toBeNull()

        view.unmount()
        expect(unsubscribe).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each([
    ['zh-CN', '请确认你最后发送的消息仍在对话中', '意外停止', '按你的选择', /草稿/],
    ['en-US', 'check that your last message is in the conversation', 'stopped unexpectedly', 'as you asked', /draft/i]
  ] as const)(
    'asks the user to check the last message and never claims drafts are kept; a hang reload is not called unexpected (%s)',
    async (language, checkLastMessage, unexpected, asYouAsked, draftClaim) => {
      const crashed = await renderNotice(language)
      act(() => crashed.listeners[0]?.({ reason: 'oom', exitCode: -536870904, diedAt: Date.now() }))
      const notice = screen.getByTestId('renderer-recovery-notice')
      expect(notice).toHaveTextContent(checkLastMessage)
      expect(notice).toHaveTextContent(unexpected)
      expect(notice.textContent).not.toMatch(draftClaim)
      crashed.view.unmount()

      const hung = await renderNotice(language)
      act(() => hung.listeners[0]?.({ reason: 'unresponsive', exitCode: 0, diedAt: Date.now() }))
      const hangNotice = screen.getByTestId('renderer-recovery-notice')
      expect(hangNotice).toHaveTextContent(asYouAsked)
      expect(hangNotice).toHaveTextContent(checkLastMessage)
      expect(hangNotice).not.toHaveTextContent(unexpected)
      expect(hangNotice.textContent).not.toMatch(draftClaim)
    }
  )

  it('keeps both texts short in both languages: at most two sentences each', () => {
    for (const locale of [zh, en]) {
      const texts = locale.app_shell.renderer_recovery
      for (const text of [texts.body, texts.body_unresponsive]) {
        expect(text.split(/[。.!?！？]/).filter((part) => part.trim()).length).toBeLessThanOrEqual(2)
        expect(text.length).toBeLessThanOrEqual(locale === zh ? 60 : 150)
      }
    }
  })

  it('is a no-drag region, so its close button is clickable next to the title bar\'s drag strip', async () => {
    // jsdom ignores -webkit-app-region, so look at the rule Emotion generated for the notice's
    // classes; that the real drag region lets the click through is checked in the running app.
    const { listeners } = await renderNotice('en-US')
    act(() => listeners[0]?.({ reason: 'crashed', exitCode: 5, diedAt: Date.now() }))
    const notice = screen.getByTestId('renderer-recovery-notice')
    const css = Array.from(document.querySelectorAll('style'), (style) => style.textContent ?? '').join('\n')
    const noDragClasses = Array.from(notice.classList).filter((name) =>
      new RegExp(`\\.${name}\\{[^}]*-webkit-app-region:\\s*no-drag`).test(css)
    )
    expect(noDragClasses).not.toHaveLength(0)
  })

  it('renders without the bridge (tests, browser preview)', () => {
    delete (window as unknown as { appEvents?: unknown }).appEvents
    expect(() => render(<RendererRecoveryNotice />)).not.toThrow()
  })
})
