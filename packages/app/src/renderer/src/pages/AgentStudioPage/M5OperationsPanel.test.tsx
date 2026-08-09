import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import M5OperationsPanel from './M5OperationsPanel'

const svc = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  listDrives: vi.fn(),
  enableTrigger: vi.fn(),
  disableTrigger: vi.fn(),
  pauseTrigger: vi.fn(),
  resumeTrigger: vi.fn(),
  retryTrigger: vi.fn(),
  manualFireTrigger: vi.fn(),
  retryDelivery: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcMagicAgentPlatform: svc }) }))

const trigger = (state: Record<string, unknown> = {}) => ({
  id: 'trigger-1',
  revision: 2,
  state: { title: 'Nightly sync', status: 'active', ...state },
  createdAt: 1,
  updatedAt: 2
})
const drive = {
  id: 'drive-1',
  revision: 3,
  state: {
    title: 'Ship M5',
    status: 'active',
    priority: 8,
    delivery: { attemptCount: 2, deadLetteredAt: 100, lastFailure: { reason: 'boom' } }
  },
  createdAt: 1,
  updatedAt: 2
}

beforeEach(() => {
  vi.clearAllMocks()
  svc.listTriggers.mockResolvedValue({ triggers: [trigger()] })
  svc.listDrives.mockResolvedValue({ drives: [drive] })
  for (const method of [
    'enableTrigger',
    'disableTrigger',
    'pauseTrigger',
    'resumeTrigger',
    'retryTrigger',
    'manualFireTrigger'
  ])
    svc[method].mockResolvedValue({})
  svc.retryDelivery.mockResolvedValue({ drive })
})

describe('M5OperationsPanel', () => {
  it('loads and projects triggers and drives', async () => {
    render(<M5OperationsPanel />)
    expect(await screen.findByText('Nightly sync')).toBeInTheDocument()
    expect(screen.getByText(/drive-1 · active · priority 8/)).toBeInTheDocument()
    expect(screen.getByText('dead-lettered')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(svc.listTriggers).toHaveBeenCalledWith({})
    expect(svc.listDrives).toHaveBeenCalledWith({})
  })

  it('retries dead-lettered Drive delivery with the current revision', async () => {
    render(<M5OperationsPanel />)
    await screen.findByText('Ship M5')
    fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' }))
    await waitFor(() =>
      expect(svc.retryDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: 'drive-1',
          expectedRevision: 3,
          retryAt: expect.any(Number),
          idempotencyKey: expect.stringMatching(/^retry-drive:drive-1:/)
        })
      )
    )
  })

  it('refreshes and dispatches trigger controls and manual fire', async () => {
    render(<M5OperationsPanel />)
    await screen.findByText('Nightly sync')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(svc.listTriggers).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'disable' }))
    await waitFor(() =>
      expect(svc.disableTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ triggerId: 'trigger-1', expectedTriggerRevision: 2 })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manual fire' }))
    await waitFor(() =>
      expect(svc.manualFireTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ triggerId: 'trigger-1', occurrenceId: expect.any(String) })
      )
    )
  })
})
