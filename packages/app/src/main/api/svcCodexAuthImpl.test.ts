import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexBetterAuthAdapter } from './codexOAuth'

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn()
  }
}))

import { CodexAuthSvcImpl } from './svcCodexAuthImpl'

function createAuthLifecycleMock(): CodexBetterAuthAdapter {
  return {
    getStatus: vi.fn(),
    getSession: vi.fn(),
    importSharedLogin: vi.fn(),
    loginWithBrowser: vi.fn(),
    logout: vi.fn(),
    getUsage: vi.fn()
  }
}

describe('CodexAuthSvcImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates local login to shared-session import', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.importSharedLogin).mockResolvedValue({
      email: 'coder@example.com',
      connectedAt: '2026-04-22T10:00:00.000Z'
    })

    const svc = new CodexAuthSvcImpl(authLifecycle)
    const result = await svc.login({
      mode: 'local'
    })

    expect(authLifecycle.importSharedLogin).toHaveBeenCalledTimes(1)
    expect(authLifecycle.loginWithBrowser).not.toHaveBeenCalled()
    expect(result).toEqual(
      expect.objectContaining({
        email: 'coder@example.com'
      })
    )
  })

  it('delegates browser login requests to the auth lifecycle adapter', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.loginWithBrowser).mockResolvedValue({
      email: 'coder@example.com',
      connectedAt: '2026-04-22T10:00:00.000Z'
    })

    const svc = new CodexAuthSvcImpl(authLifecycle)
    const result = await svc.login({
      mode: 'browser'
    })

    expect(authLifecycle.importSharedLogin).not.toHaveBeenCalled()
    expect(authLifecycle.loginWithBrowser).toHaveBeenCalledWith({})
    expect(result.email).toBe('coder@example.com')
  })

  it('passes forceReauth through the adapter when browser reauthentication is requested', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.loginWithBrowser).mockResolvedValue({
      email: 'coder@example.com',
      connectedAt: '2026-04-22T10:00:00.000Z'
    })

    const svc = new CodexAuthSvcImpl(authLifecycle)
    await svc.login({
      forceReauth: true
    })

    expect(authLifecycle.importSharedLogin).not.toHaveBeenCalled()
    expect(authLifecycle.loginWithBrowser).toHaveBeenCalledWith({
      forceReauth: true
    })
  })

  it('does not fall back to browser login when shared-session import fails', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.importSharedLogin).mockRejectedValue(new Error('missing auth.json'))

    const svc = new CodexAuthSvcImpl(authLifecycle)

    await expect(
      svc.login({
        mode: 'local'
      })
    ).rejects.toThrow('missing auth.json')
    expect(authLifecycle.importSharedLogin).toHaveBeenCalledTimes(1)
    expect(authLifecycle.loginWithBrowser).not.toHaveBeenCalled()
  })

  it('returns the current Codex usage snapshot from the adapter', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.getUsage).mockResolvedValue({
      email: 'coder@example.com',
      fetchedAt: '2026-04-22T15:00:00.000Z',
      planType: 'plus',
      rateLimit: {
        allowed: true,
        limitReached: false,
        primaryWindow: {
          usedPercent: 12,
          remainingPercent: 88,
          limitWindowSeconds: 18_000,
          resetAfterSeconds: 1_200,
          resetAt: '2026-04-22T15:20:00.000Z'
        }
      }
    })

    const svc = new CodexAuthSvcImpl(authLifecycle)
    const result = await svc.getUsage({})

    expect(authLifecycle.getUsage).toHaveBeenCalledTimes(1)
    expect(result).toEqual(
      expect.objectContaining({
        planType: 'plus',
        email: 'coder@example.com'
      })
    )
  })

  it('returns the current shared auth status from the adapter', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.getStatus).mockResolvedValue({
      available: true,
      mode: 'chatgpt',
      authFilePath: 'C:/Users/test/.codex/auth.json',
      email: 'coder@example.com',
      connectedAt: '2026-04-22T15:00:00.000Z'
    })

    const svc = new CodexAuthSvcImpl(authLifecycle)
    const result = await svc.status({})

    expect(authLifecycle.getStatus).toHaveBeenCalledTimes(1)
    expect(result).toEqual(
      expect.objectContaining({
        available: true,
        mode: 'chatgpt',
        email: 'coder@example.com'
      })
    )
  })

  it('delegates shared logout to the adapter', async () => {
    const authLifecycle = createAuthLifecycleMock()
    vi.mocked(authLifecycle.logout).mockResolvedValue({
      cleared: true,
      authFilePath: 'C:/Users/test/.codex/auth.json'
    })

    const svc = new CodexAuthSvcImpl(authLifecycle)
    const result = await svc.logout({
      scope: 'shared'
    })

    expect(authLifecycle.logout).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      cleared: true,
      authFilePath: 'C:/Users/test/.codex/auth.json'
    })
  })
})
