import { describe, expect, it, vi } from 'vitest'
import { createTerminalPolicyRequest } from '../../shared/magicAgentPlatform2'
import { TerminalApprovalCoordinator } from './terminalApprovalCoordinator'

const request = () =>
  createTerminalPolicyRequest({
    requestId: 'request-1',
    actor: { kind: 'agent', id: 'agent-1' },
    target: { kind: 'tool', id: 'terminal.run' },
    command: 'node',
    args: ['--version'],
    cwd: '/workspace'
  })

const service = () => ({
  authorize: vi.fn(() => ({ status: 'awaiting-approval' as const }))
})

describe('TerminalApprovalCoordinator', () => {
  it('production terminal rules use the canonical terminal action, target, and effects', () => {
    const rule = {
      ruleId: 'assistant-terminal-requires-approval',
      priority: 1000,
      effect: 'require-approval' as const,
      match: {
        origin: ['assistant'],
        action: ['terminal.execute'],
        targetKind: ['tool'],
        targetIds: ['terminal.run'],
        effectKinds: ['process.execute', 'filesystem.read']
      },
      approval: { requirementId: 'assistant-terminal-approval' }
    }
    expect(rule.match).toEqual({
      origin: ['assistant'],
      action: ['terminal.execute'],
      targetKind: ['tool'],
      targetIds: ['terminal.run'],
      effectKinds: ['process.execute', 'filesystem.read']
    })
  })

  it('preserves the awaiting authorization id and exposes only redacted pending data', async () => {
    const authorization = service()
    const coordinator = new TerminalApprovalCoordinator(authorization as never, () => ({
      grantId: 'grant-1',
      expectedGrantUseCount: 0
    }))
    const pending = coordinator.request(request())
    const [approval] = coordinator.list()

    expect(approval.request.request.requestId).toBe('request-1')
    expect('grantId' in approval).toBe(false)
    expect(
      coordinator.resolve({ approvalId: approval.approvalId, expectedRevision: 0, approved: true })
    ).toMatchObject({ status: 'approved', revision: 1 })
    await expect(pending).resolves.toEqual({
      authorizationId: approval.approvalId,
      grantId: 'grant-1',
      expectedGrantUseCount: 0
    })
    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationId: approval.approvalId })
    )
  })

  it('rejects denial, revision conflicts, and shutdown', async () => {
    const coordinator = new TerminalApprovalCoordinator(service() as never, () => ({
      grantId: 'grant-1',
      expectedGrantUseCount: 0
    }))
    const denied = coordinator.request(request())
    const [first] = coordinator.list()
    expect(() =>
      coordinator.resolve({ approvalId: first.approvalId, expectedRevision: 1, approved: true })
    ).toThrow('not found or has changed')
    coordinator.resolve({ approvalId: first.approvalId, expectedRevision: 0, approved: false })
    await expect(denied).rejects.toThrow('denied by the user')

    const shuttingDown = coordinator.request(request())
    coordinator.shutdown()
    await expect(shuttingDown).rejects.toThrow('shutting down')
  })
})
