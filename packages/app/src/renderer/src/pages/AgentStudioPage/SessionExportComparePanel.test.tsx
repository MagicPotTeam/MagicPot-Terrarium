import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import { SessionExportComparePanel } from './SessionExportComparePanel'

const platformApi = vi.hoisted(() => ({ exportSession: vi.fn(), diffSessions: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcMagicAgentPlatform: platformApi })
}))

const renderPanel = () =>
  render(
    <ThemeProvider theme={theme}>
      <SessionExportComparePanel />
    </ThemeProvider>
  )

describe('SessionExportComparePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformApi.exportSession.mockResolvedValue({
      format: 'markdown',
      mimeType: 'text/markdown',
      filename: 'session.md',
      body: '# Session',
      availability: {
        messages: { status: 'available' },
        teams: { status: 'unavailable', reason: 'Not recorded.' }
      }
    })
    platformApi.diffSessions.mockResolvedValue({
      schemaVersion: 1,
      leftSessionKey: 'left',
      rightSessionKey: 'right',
      relationship: { relationship: 'right-forked-from-left', commonSourceSessionKey: 'left' },
      dimensions: {
        messages: {
          classification: 'changed',
          leftAvailable: true,
          rightAvailable: true,
          leftCount: 1,
          rightCount: 2
        }
      },
      timeline: [{ side: 'left', at: 1, kind: 'message', left: { content: 'safe' } }],
      sideBySide: [
        {
          index: 0,
          left: { content: '<script>x</script>' },
          right: { content: 'safe' },
          classification: 'changed'
        }
      ]
    })
  })

  it('previews exports, reports unavailable dimensions, and compares timelines/messages as text', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Export preview' }))
    expect(await screen.findByLabelText('Export preview')).toHaveTextContent('# Session')
    expect(screen.getByText('teams: Not recorded.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Compare sessions' }))
    expect(await screen.findByText(/Relationship: right-forked-from-left/)).toBeInTheDocument()
    expect(screen.getByText(/messages: changed/)).toBeInTheDocument()
    expect(screen.getByLabelText('Merged timeline')).toHaveTextContent('safe')
    expect(screen.getByText(/<script>x<\/script>/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    await waitFor(() => expect(platformApi.diffSessions).toHaveBeenCalledTimes(1))
  })
})
