import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import enUS from '@shared/locales/en-US/renderer.json'
import zhCN from '@shared/locales/zh-CN/renderer.json'
import type { ChatSession } from '../chatStorage'
import ChatMessageList from './ChatMessageList'

// The real list; only translation and notifications are doubles. The translation double
// returns the key, so the caption is asserted by its i18n key.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() })
}))

type Props = React.ComponentProps<typeof ChatMessageList>
const CAPTION_KEY = 'chat.report_unavailable'

const legacyReport: ChatAttachment = {
  type: 'file',
  url: 'local-media:///legacy/report.md',
  fileName: 'legacy-report.md',
  mimeType: 'text/markdown',
  reportBundleId: 'legacy',
  reportBundleManifestUrl: 'local-media:///legacy/manifest.json',
  reportBundleRole: 'primary-report'
}
const boundReport: ChatAttachment = {
  ...legacyReport,
  url: 'local-media:///bound/report.md',
  fileName: 'bound-report.md',
  reportBundleId: 'bound',
  reportBundleManifestUrl: 'local-media:///bound/manifest.json',
  reportBundleBinding: `rb1.${'C'.repeat(43)}`
}
const malformedReport: ChatAttachment = {
  ...legacyReport,
  url: 'local-media:///malformed/report.md',
  fileName: 'malformed-report.md',
  reportBundleBinding: `rb1.${'C'.repeat(42)}`
}
const ordinaryFile: ChatAttachment = {
  type: 'file',
  url: 'local-media:///notes/notes.md',
  fileName: 'notes.md',
  mimeType: 'text/markdown'
}
const reportOcr: ChatAttachment = {
  type: 'file',
  url: 'local-media:///legacy/ocr.json',
  fileName: 'legacy-ocr.json',
  mimeType: 'application/json',
  reportBundleId: 'legacy',
  reportBundleRole: 'report-ocr'
}

const renderList = (session: ChatSession, mode: 'light' | 'dark' = 'light') => {
  const onDownloadAttachment = vi.fn<Props['onDownloadAttachment']>()
  const Harness = () => {
    const container = React.useRef<HTMLDivElement>(null)
    const end = React.useRef<HTMLDivElement>(null)
    return (
      <ThemeProvider theme={createTheme({ palette: { mode } })}>
        <ChatMessageList
          currentSession={session}
          isLoading={false}
          editingMessageIndex={null}
          editingContent=""
          onSetEditingIndex={vi.fn()}
          onSetEditingContent={vi.fn()}
          onSendEditedMessage={vi.fn()}
          onPreviewImage={vi.fn()}
          onImageContextMenu={vi.fn()}
          onDownloadAttachment={onDownloadAttachment}
          onSendModelToDcc={vi.fn()}
          chatContainerRef={container}
          messagesEndRef={end}
        />
      </ThemeProvider>
    )
  }
  render(<Harness />)
  return { onDownloadAttachment }
}

/** The file card (the draggable folder box) that shows this file name. */
const cardOf = (fileName: string): HTMLElement => {
  const card = screen.getByText(fileName).closest('[draggable]')
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${fileName}`)
  return card
}

const expectUnavailable = (card: HTMLElement) => {
  expect(card).toHaveAttribute('aria-disabled', 'true')
  expect(card).toHaveStyle({ opacity: '0.55' })
  expect(within(card).getByText((text) => text.startsWith(CAPTION_KEY))).toBeInTheDocument()
}

const expectAvailable = (card: HTMLElement) => {
  expect(card).not.toHaveAttribute('aria-disabled')
  expect(card).not.toHaveStyle({ opacity: '0.55' })
  expect(within(card).queryByText((text) => text.includes(CAPTION_KEY))).not.toBeInTheDocument()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChatMessageList unavailable report chip', () => {
  it.each(['light', 'dark'] as const)(
    'mutes a legacy primary report and captions it; a bound report and ordinary files stay as they are (%s)',
    (mode) => {
      const session: ChatSession = {
        id: 'reports',
        title: 'fixture',
        messages: [
          { role: 'user', content: 'mine', attachments: [boundReport, ordinaryFile] },
          // Canvas reports are posted as assistant messages and never carry a binding.
          { role: 'assistant', content: 'report', attachments: [legacyReport, reportOcr] },
          { role: 'assistant', content: 'odd', attachments: [malformedReport] }
        ]
      }
      renderList(session, mode)

      expectUnavailable(cardOf('legacy-report.md'))
      expectUnavailable(cardOf('malformed-report.md'))
      expectAvailable(cardOf('bound-report.md'))
      expectAvailable(cardOf('notes.md'))
      expectAvailable(cardOf('legacy-ocr.json'))
      expect(screen.getAllByText((text) => text.startsWith(CAPTION_KEY))).toHaveLength(2)
    }
  )

  it('keeps the file meta label and the download of an unavailable report', () => {
    const session: ChatSession = {
      id: 'legacy',
      title: 'fixture',
      messages: [
        { role: 'user', content: 'mine', attachments: [{ ...legacyReport, sizeBytes: 2048 }] }
      ]
    }
    const { onDownloadAttachment } = renderList(session)
    const card = cardOf('legacy-report.md')
    const caption = within(card).getByText((text) => text.startsWith(CAPTION_KEY))
    expect(caption.textContent).toMatch(/^chat\.report_unavailable · .+/)
    expect(card).toHaveAttribute('draggable', 'true')
    fireEvent.click(within(card).getByRole('button', { name: 'chat.download_attachment' }))
    expect(onDownloadAttachment).toHaveBeenCalledWith(expect.objectContaining(legacyReport))
  })

  it('has the caption in every renderer locale file', () => {
    for (const locale of [enUS, zhCN] as Array<{ chat: Record<string, unknown> }>) {
      const caption = locale.chat.report_unavailable
      expect(typeof caption).toBe('string')
      expect((caption as string).length).toBeGreaterThan(0)
      expect((caption as string).length).toBeLessThanOrEqual(40)
    }
  })
})
