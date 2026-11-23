import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_MODELS_URL,
  createCodexBackendModelDiscoveryProvider,
  normalizeCodexBackendModels
} from './codexModelDiscovery'
import type { CodexBetterAuthAdapter, CodexResolvedTokens } from './codexOAuth'

const createSession = (accessToken: string): CodexResolvedTokens => ({
  accessToken,
  authFilePath: 'C:/Users/test/.codex/auth.json',
  connectedAt: '2026-04-24T00:00:00.000Z',
  idToken: 'id-token',
  refreshToken: 'refresh-token',
  accountId: 'account-123'
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  })

describe('codexModelDiscovery', () => {
  it('normalizes listed Codex backend models and skips hidden models', () => {
    expect(
      normalizeCodexBackendModels({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list'
          },
          {
            slug: 'codex-auto-review',
            display_name: 'Codex Auto Review',
            visibility: 'hide'
          },
          {
            id: 'gpt-5.4',
            visibility: 'list'
          }
        ]
      })
    ).toEqual([
      {
        label: 'GPT-5.5',
        value: 'gpt-5.5'
      },
      {
        label: 'gpt-5.4',
        value: 'gpt-5.4'
      }
    ])
  })

  it('fetches models from the Codex backend with app client version and shared auth', async () => {
    const authLifecycle: CodexBetterAuthAdapter = {
      getSession: vi.fn().mockResolvedValue(createSession('oauth-access')),
      getStatus: vi.fn(),
      getUsage: vi.fn(),
      importSharedLogin: vi.fn(),
      loginWithBrowser: vi.fn(),
      logout: vi.fn()
    }
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list'
          }
        ]
      })
    )

    const provider = createCodexBackendModelDiscoveryProvider({
      authLifecycle,
      clientVersion: '1.0.103',
      fetchFn
    })

    await expect(provider()).resolves.toMatchObject({
      models: [
        {
          label: 'GPT-5.5',
          value: 'gpt-5.5'
        }
      ]
    })
    expect(fetchFn).toHaveBeenCalledWith(`${CODEX_MODELS_URL}?client_version=1.0.103`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer oauth-access',
        'ChatGPT-Account-Id': 'account-123',
        'User-Agent': 'codex-cli'
      }
    })
  })

  it('refreshes Codex auth and retries once after an unauthorized response', async () => {
    const authLifecycle: CodexBetterAuthAdapter = {
      getSession: vi
        .fn()
        .mockResolvedValueOnce(createSession('oauth-stale'))
        .mockResolvedValueOnce(createSession('oauth-fresh')),
      getStatus: vi.fn(),
      getUsage: vi.fn(),
      importSharedLogin: vi.fn(),
      loginWithBrowser: vi.fn(),
      logout: vi.fn()
    }
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Unauthorized' } }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              slug: 'gpt-5.4',
              display_name: 'gpt-5.4',
              visibility: 'list'
            }
          ]
        })
      )

    const provider = createCodexBackendModelDiscoveryProvider({
      authLifecycle,
      clientVersion: '1.0.103',
      fetchFn
    })

    await expect(provider()).resolves.toMatchObject({
      models: [
        {
          label: 'gpt-5.4',
          value: 'gpt-5.4'
        }
      ]
    })
    expect(authLifecycle.getSession).toHaveBeenNthCalledWith(1)
    expect(authLifecycle.getSession).toHaveBeenNthCalledWith(2, { forceRefresh: true })
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer oauth-fresh'
    })
  })
})
