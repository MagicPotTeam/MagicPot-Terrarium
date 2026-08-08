import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MagicAgentApprovalCenter from './MagicAgentApprovalCenter'

const listPendingApprovals = vi.fn()
const resolvePendingApproval = vi.fn()

vi.mock('../utils/windowUtils', () => ({
  api: () => ({
    svcMagicAgentPlatform: { listPendingApprovals, resolvePendingApproval }
  })
}))

describe('MagicAgentApprovalCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listPendingApprovals.mockResolvedValue({ approvals: [] })
    resolvePendingApproval.mockResolvedValue({})
  })

  it('renders redacted pending data and approves by id and revision', async () => {
    listPendingApprovals.mockResolvedValue({
      approvals: [
        {
          approvalId: 'approval-1',
          revision: 3,
          createdAt: 1,
          expiresAt: 2,
          request: { command: 'node', environment: { token: '[REDACTED]' } }
        }
      ]
    })

    render(<MagicAgentApprovalCenter />)

    expect(await screen.findByText('Agent action requires approval')).toBeInTheDocument()
    expect(screen.getByText(/\[REDACTED\]/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.queryByText('Agent action requires approval')).not.toBeInTheDocument()

    await waitFor(() =>
      expect(resolvePendingApproval).toHaveBeenCalledWith({
        approvalId: 'approval-1',
        expectedRevision: 3,
        approved: true
      })
    )
  })

  it('submits denial without exposing grant or permit fields', async () => {
    listPendingApprovals.mockResolvedValue({
      approvals: [
        { approvalId: 'approval-2', revision: 0, createdAt: 1, expiresAt: 2, request: {} }
      ]
    })

    render(<MagicAgentApprovalCenter />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() =>
      expect(resolvePendingApproval).toHaveBeenCalledWith({
        approvalId: 'approval-2',
        expectedRevision: 0,
        approved: false
      })
    )
    expect(JSON.stringify(resolvePendingApproval.mock.calls)).not.toMatch(/grant|permit|approver/i)
  })
})
