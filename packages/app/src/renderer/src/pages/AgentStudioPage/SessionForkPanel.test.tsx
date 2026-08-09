import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionForkPanel } from './SessionForkPanel'

const forkSessionAtEvent = vi.hoisted(() => vi.fn())
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcMagicAgentPlatform: { forkSessionAtEvent } })
}))

describe('SessionForkPanel', () => {
  it('warns, submits parsed routes, and renders counts without session content', async () => {
    forkSessionAtEvent.mockResolvedValue({
      targetSessionKey: 'generic:dm:target:thread',
      lineage: {
        sourceSessionKey: 'generic:dm:source',
        sourceEventId: 'event-2',
        sourceRunId: 'run-1',
        forkedAt: 123
      },
      warning: 'External side effects are not rolled back.',
      counts: { messages: 2, runs: 1, events: 3, artifacts: 1 }
    })
    render(<SessionForkPanel />)

    expect(
      screen.getByText(/External side effects performed before the selected event/)
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Source route'), {
      target: { value: 'generic:dm:source' }
    })
    fireEvent.change(screen.getByLabelText('Source event ID'), { target: { value: 'event-2' } })
    fireEvent.change(screen.getByLabelText('Target route'), {
      target: { value: 'generic:dm:target:thread' }
    })
    fireEvent.change(screen.getByLabelText('Idempotency key'), { target: { value: 'fork-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fork session' }))

    await waitFor(() =>
      expect(forkSessionAtEvent).toHaveBeenCalledWith({
        sourceRoute: { channel: 'generic', scopeType: 'dm', scopeId: 'source' },
        sourceEventId: 'event-2',
        targetRoute: { channel: 'generic', scopeType: 'dm', scopeId: 'target:thread' },
        idempotencyKey: 'fork-1'
      })
    )
    expect(
      await screen.findByText(/Messages: 2; runs: 1; events: 3; artifacts: 1/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/secret session content/i)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('sourceRunId')
  })
})
