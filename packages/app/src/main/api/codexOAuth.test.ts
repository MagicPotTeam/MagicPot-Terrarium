import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import {
  buildCodexAuthorizeUrl,
  CODEX_OAUTH_CLIENT_ID,
  createCodexBetterAuthAdapter,
  ensureCodexCliAuthTokens,
  readExistingCodexReviewSession,
  extractCodexOAuthEmail,
  fetchCodexUsageStatus,
  importCodexCliAuthLogin,
  inspectCodexCliAuthStatus,
  logoutCodexCliAuth,
  performCodexOAuthLogin
} from './codexOAuth'

function encodeBase64Url(value: Buffer | string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createIdToken(payload: Record<string, unknown>): string {
  return [
    encodeBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    encodeBase64Url(JSON.stringify(payload)),
    'signature'
  ].join('.')
}

async function createAuthTestDir(label: string): Promise<string> {
  return createNodeTestArtifactDir('codex-oauth', `${label}-`)
}

describe('codexOAuth', () => {
  it('reads an existing review session without refreshing, writing, or joining login', async () => {
    const dir = await createAuthTestDir('review-session')
    const authFilePath = path.join(dir, 'auth.json')
    const network = vi.fn(() => { throw new Error('network not allowed') })
    vi.stubGlobal('fetch', network)
    try {
      const read = () => readExistingCodexReviewSession({ authFilePath })
      await expect(read()).rejects.toThrow(/fresh Codex session/i)
      const fresh = createIdToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
      const expired = createIdToken({ exp: 1 })
      const tokens = { access_token: fresh, id_token: fresh, refresh_token: 'must-not-be-used', account_id: 'fixture' }
      const saved = { auth_mode: 'chatgpt', last_refresh: new Date().toISOString(), tokens }
      await mkdir(dir, { recursive: true })
      await writeFile(authFilePath, JSON.stringify(saved))
      await expect(read()).resolves.toEqual({ accessToken: fresh, accountId: 'fixture' })
      for (const rejected of [
        { ...saved, auth_mode: 'api_key' },
        { ...saved, tokens: { ...tokens, access_token: '' } },
        { ...saved, tokens: { ...tokens, id_token: expired } },
        { ...saved, tokens: { ...tokens, access_token: expired } },
        { ...saved, tokens: { ...tokens, access_token: 'opaque' }, last_refresh: '1970-01-01T00:00:00Z' },
        { ...saved, tokens: { ...tokens, access_token: 'opaque' }, last_refresh: undefined }
      ]) {
        await writeFile(authFilePath, JSON.stringify(rejected))
        await expect(read()).rejects.toThrow(/fresh Codex session/i)
        expect(await readFile(authFilePath, 'utf8')).toBe(JSON.stringify(rejected))
      }
      expect(network).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('builds the official authorize URL shape', () => {
    const url = new URL(
      buildCodexAuthorizeUrl({
        clientId: CODEX_OAUTH_CLIENT_ID,
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 'state-123',
        pkce: {
          codeChallenge: 'challenge-123',
          codeVerifier: 'verifier-123'
        }
      })
    )

    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
  })

  it('keeps the authorize URL aligned with the Codex CLI flow when forceReauth is requested', () => {
    const url = new URL(
      buildCodexAuthorizeUrl({
        clientId: CODEX_OAUTH_CLIENT_ID,
        forceReauth: true,
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 'state-123',
        pkce: {
          codeChallenge: 'challenge-123',
          codeVerifier: 'verifier-123'
        }
      })
    )

    expect(url.searchParams.get('prompt')).toBeNull()
    expect(url.searchParams.get('max_age')).toBeNull()
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs')
  })

  it('extracts the email claim from a Codex id token', () => {
    const token = createIdToken({
      email: 'coder@example.com'
    })

    expect(extractCodexOAuthEmail(token)).toBe('coder@example.com')
  })

  it('reports missing shared auth when the local auth file does not exist', async () => {
    const tempDir = await createAuthTestDir('missing')
    const authFilePath = path.join(tempDir, 'auth.json')

    const result = await inspectCodexCliAuthStatus({
      authFilePath
    })

    expect(result).toEqual({
      available: false,
      mode: 'missing',
      authFilePath,
      reason: 'missing_auth_file'
    })
  })

  it('reports API key mode as unavailable for reusable shared login', async () => {
    const tempDir = await createAuthTestDir('api-key')
    const authFilePath = path.join(tempDir, 'auth.json')

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'api_key',
        OPENAI_API_KEY: 'sk-test'
      }),
      'utf8'
    )

    try {
      const result = await inspectCodexCliAuthStatus({
        authFilePath
      })

      expect(result).toEqual({
        available: false,
        mode: 'api_key',
        authFilePath,
        reason: 'api_key_mode'
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('reports reusable shared auth details when a ChatGPT login exists locally', async () => {
    const tempDir = await createAuthTestDir('status')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com'
    })

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          refresh_token: 'oauth-refresh'
        },
        last_refresh: '2026-04-22T12:00:00.000Z'
      }),
      'utf8'
    )

    try {
      const result = await inspectCodexCliAuthStatus({
        authFilePath
      })

      expect(result).toEqual({
        available: true,
        mode: 'chatgpt',
        authFilePath,
        email: 'coder@example.com',
        connectedAt: '2026-04-22T12:00:00.000Z'
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('reuses the local Codex CLI auth file when a ChatGPT login already exists', async () => {
    const tempDir = await createAuthTestDir('import')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com'
    })

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken,
          access_token: 'oauth-access',
          refresh_token: 'oauth-refresh',
          account_id: 'acct-123'
        },
        last_refresh: new Date().toISOString()
      }),
      'utf8'
    )

    try {
      const result = await importCodexCliAuthLogin({
        authFilePath
      })

      expect(result).toEqual(
        expect.objectContaining({
          email: 'coder@example.com'
        })
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('refreshes expired local Codex tokens before exchanging them for an API key', async () => {
    const tempDir = await createAuthTestDir('refresh')
    const authFilePath = path.join(tempDir, 'auth.json')
    const expiredIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 1_700_000_000
    })
    const refreshedIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_000
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'oauth-access-fresh',
            refresh_token: 'oauth-refresh-fresh',
            id_token: refreshedIdToken
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'sk-imported-after-refresh'
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify(
        {
          auth_mode: 'chatgpt',
          tokens: {
            id_token: expiredIdToken,
            access_token: 'oauth-access-old',
            refresh_token: 'oauth-refresh-old',
            account_id: 'acct-123'
          },
          last_refresh: '2026-04-01T00:00:00.000Z'
        },
        null,
        2
      ),
      'utf8'
    )

    try {
      const result = await importCodexCliAuthLogin({
        authFilePath,
        fetchFn: fetchMock
      })

      expect(result).toEqual(
        expect.objectContaining({
          email: 'coder@example.com'
        })
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[1]?.body || '')).toContain('grant_type=refresh_token')

      const persisted = JSON.parse(await readFile(authFilePath, 'utf8'))
      expect(persisted.tokens.id_token).toBe(refreshedIdToken)
      expect(persisted.tokens.refresh_token).toBe('oauth-refresh-fresh')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('refreshes stale local access tokens based on last_refresh before use', async () => {
    const tempDir = await createAuthTestDir('stale-access')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_000
    })
    const refreshedIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_100
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'oauth-access-fresh',
          refresh_token: 'oauth-refresh-fresh',
          id_token: refreshedIdToken
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    )

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: 'oauth-access-old',
          refresh_token: 'oauth-refresh',
          account_id: 'acct-123'
        },
        last_refresh: '2026-04-20T12:00:00.000Z'
      }),
      'utf8'
    )

    try {
      const session = await ensureCodexCliAuthTokens({
        authFilePath,
        fetchFn: fetchMock
      })
      expect(session.accessToken).toBe('oauth-access-fresh')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent forced refresh requests inside the Better Auth adapter boundary', async () => {
    const tempDir = await createAuthTestDir('adapter-refresh')
    const authFilePath = path.join(tempDir, 'auth.json')
    const currentIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_000
    })
    const refreshedIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_100
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'oauth-access-fresh',
          refresh_token: 'oauth-refresh-fresh',
          id_token: refreshedIdToken
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    )

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: currentIdToken,
          access_token: 'oauth-access-old',
          refresh_token: 'oauth-refresh',
          account_id: 'acct-123'
        },
        last_refresh: new Date().toISOString()
      }),
      'utf8'
    )

    try {
      const adapter = createCodexBetterAuthAdapter({
        authFilePath,
        fetchFn: fetchMock
      })

      const [first, second] = await Promise.all([
        adapter.getSession({
          forceRefresh: true
        }),
        adapter.getSession({
          forceRefresh: true
        })
      ])

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(first.accessToken).toBe('oauth-access-fresh')
      expect(second.refreshToken).toBe('oauth-refresh-fresh')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('completes the browser login flow and persists the OAuth session locally', async () => {
    const tempDir = await createAuthTestDir('browser')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com'
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: idToken,
          access_token: 'oauth-access',
          refresh_token: 'oauth-refresh'
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    )

    const openExternalMock = vi.fn(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const callbackUrl = new URL(parsed.searchParams.get('redirect_uri') || '')
      callbackUrl.searchParams.set('code', 'authorization-code-123')
      callbackUrl.searchParams.set('state', parsed.searchParams.get('state') || '')

      await new Promise<void>((resolve, reject) => {
        const req = http.get(callbackUrl, (response) => {
          response.resume()
          response.on('end', resolve)
        })
        req.on('error', reject)
      })
    })

    await mkdir(tempDir, { recursive: true })

    try {
      const result = await performCodexOAuthLogin({
        authFilePath,
        fetchFn: fetchMock,
        openExternal: openExternalMock,
        timeoutMs: 2_000
      })

      expect(openExternalMock).toHaveBeenCalledTimes(1)
      expect(result).toEqual(
        expect.objectContaining({
          email: 'coder@example.com'
        })
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auth.openai.com/oauth/token')
      expect(String(fetchMock.mock.calls[0]?.[1]?.body || '')).toContain(
        'grant_type=authorization_code'
      )

      const persisted = JSON.parse(await readFile(authFilePath, 'utf8'))
      expect(persisted.auth_mode).toBe('chatgpt')
      expect(persisted.tokens.access_token).toBe('oauth-access')
      expect(persisted.tokens.refresh_token).toBe('oauth-refresh')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('does not persist or succeed when cancellation finishes during token exchange', async () => {
    const tempDir = await createAuthTestDir('browser-cancel-during-exchange')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({ email: 'coder@example.com' })
    let resolveExchange!: (response: Response) => void
    let callbackComplete: Promise<void> | undefined
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      return await new Promise<Response>((resolve) => {
        resolveExchange = resolve
      })
    })
    const openExternalMock = vi.fn(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const callbackUrl = new URL(parsed.searchParams.get('redirect_uri') || '')
      callbackUrl.searchParams.set('code', 'authorization-code-123')
      callbackUrl.searchParams.set('state', parsed.searchParams.get('state') || '')
      callbackComplete = new Promise<void>((resolve, reject) => {
        const req = http.get(callbackUrl, { headers: { Connection: 'close' } }, (response) => {
          response.resume()
          response.on('end', resolve)
        })
        req.on('error', reject)
      })
      await callbackComplete
    })
    await mkdir(tempDir, { recursive: true })
    try {
      const login = performCodexOAuthLogin({
        authFilePath,
        fetchFn: fetchMock,
        openExternal: openExternalMock,
        timeoutMs: 50
      })
      const loginResult = login.catch((error: unknown) => error)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 75))
      await expect(loginResult).resolves.toMatchObject({
        message: expect.stringContaining('timed out')
      })

      resolveExchange(
        new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: 'oauth-access',
            refresh_token: 'oauth-refresh'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      await callbackComplete
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await expect(readFile(authFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('completes the device-code login flow and persists the OAuth session locally', async () => {
    const tempDir = await createAuthTestDir('device')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-device'
      }
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_auth_id: 'device-auth-123',
            user_code: 'ABCD-EFGH',
            interval: 0,
            expires_in: 60
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_code: 'authorization-code-123',
            code_verifier: 'verifier-123'
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: 'oauth-access',
            refresh_token: 'oauth-refresh'
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
    const onDeviceCodeMock = vi.fn()
    const openExternalMock = vi.fn(async () => {})

    await mkdir(tempDir, { recursive: true })

    try {
      const result = await performCodexOAuthLogin({
        authFilePath,
        enableBrowserFlow: false,
        enableDeviceCodeFlow: true,
        fetchFn: fetchMock,
        onDeviceCode: onDeviceCodeMock,
        openExternal: openExternalMock,
        timeoutMs: 2_000
      })

      expect(onDeviceCodeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://auth.openai.com/codex/device'
        })
      )
      expect(openExternalMock).not.toHaveBeenCalled()
      expect(result).toEqual(
        expect.objectContaining({
          email: 'coder@example.com'
        })
      )
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://auth.openai.com/api/accounts/deviceauth/usercode'
      )
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        'https://auth.openai.com/api/accounts/deviceauth/token'
      )
      expect(fetchMock.mock.calls[2]?.[0]).toBe('https://auth.openai.com/oauth/token')
      expect(String(fetchMock.mock.calls[2]?.[1]?.body || '')).toContain(
        'redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback'
      )

      const persisted = JSON.parse(await readFile(authFilePath, 'utf8'))
      expect(persisted.auth_mode).toBe('chatgpt')
      expect(persisted.tokens.access_token).toBe('oauth-access')
      expect(persisted.tokens.refresh_token).toBe('oauth-refresh')
      expect(persisted.tokens.account_id).toBe('acct-device')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('does not add non-Codex-CLI reauthentication parameters to the browser login URL', async () => {
    const tempDir = await createAuthTestDir('browser-force-reauth')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com'
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: idToken,
          access_token: 'oauth-access',
          refresh_token: 'oauth-refresh'
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    )

    const openExternalMock = vi.fn(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      expect(parsed.searchParams.get('prompt')).toBeNull()
      expect(parsed.searchParams.get('max_age')).toBeNull()
      expect(parsed.searchParams.get('originator')).toBe('codex_cli_rs')

      const callbackUrl = new URL(parsed.searchParams.get('redirect_uri') || '')
      callbackUrl.searchParams.set('code', 'authorization-code-123')
      callbackUrl.searchParams.set('state', parsed.searchParams.get('state') || '')

      await new Promise<void>((resolve, reject) => {
        const req = http.get(callbackUrl, (response) => {
          response.resume()
          response.on('end', resolve)
        })
        req.on('error', reject)
      })
    })

    await mkdir(tempDir, { recursive: true })

    try {
      await performCodexOAuthLogin({
        authFilePath,
        fetchFn: fetchMock,
        forceReauth: true,
        openExternal: openExternalMock,
        timeoutMs: 2_000
      })

      expect(openExternalMock).toHaveBeenCalledTimes(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('clears reusable shared auth without dropping unrelated auth file fields', async () => {
    const tempDir = await createAuthTestDir('logout')
    const authFilePath = path.join(tempDir, 'auth.json')

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify(
        {
          auth_mode: 'chatgpt',
          tokens: {
            id_token: 'oauth-id',
            access_token: 'oauth-access',
            refresh_token: 'oauth-refresh'
          },
          last_refresh: '2026-04-22T14:00:00.000Z',
          some_other_field: {
            keep: true
          }
        },
        null,
        2
      ),
      'utf8'
    )

    try {
      const result = await logoutCodexCliAuth({
        authFilePath
      })

      expect(result).toEqual({
        cleared: true,
        authFilePath
      })

      const persisted = JSON.parse(await readFile(authFilePath, 'utf8'))
      expect(persisted.tokens).toBeUndefined()
      expect(persisted.last_refresh).toBeUndefined()
      expect(persisted.auth_mode).toBeUndefined()
      expect(persisted.some_other_field).toEqual({
        keep: true
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('fetches the Codex usage snapshot from the official usage endpoint', async () => {
    const tempDir = await createAuthTestDir('usage')
    const authFilePath = path.join(tempDir, 'auth.json')
    const idToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_000
    })

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 23,
              limit_window_seconds: 18_000,
              reset_after_seconds: 3_600,
              reset_at: 1_777_777_777
            },
            secondary_window: {
              used_percent: 41,
              limit_window_seconds: 604_800,
              reset_after_seconds: 86_400,
              reset_at: 1_777_888_888
            }
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: 250,
            approx_local_messages: 55,
            approx_cloud_messages: 12
          }
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    )

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: 'oauth-access',
          refresh_token: 'oauth-refresh',
          account_id: 'acct-123'
        },
        last_refresh: new Date().toISOString()
      }),
      'utf8'
    )

    try {
      const result = await fetchCodexUsageStatus({
        authFilePath,
        fetchFn: fetchMock
      })

      expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer oauth-access',
          'ChatGPT-Account-Id': 'acct-123',
          'User-Agent': 'codex-cli'
        }
      })
      expect(result).toEqual(
        expect.objectContaining({
          email: 'coder@example.com',
          planType: 'plus',
          rateLimit: expect.objectContaining({
            allowed: true,
            limitReached: false,
            primaryWindow: expect.objectContaining({
              usedPercent: 23,
              remainingPercent: 77,
              limitWindowSeconds: 18_000,
              resetAfterSeconds: 3_600
            }),
            secondaryWindow: expect.objectContaining({
              usedPercent: 41,
              remainingPercent: 59,
              limitWindowSeconds: 604_800
            })
          }),
          credits: expect.objectContaining({
            hasCredits: true,
            unlimited: false,
            balance: 250,
            approxLocalMessages: 55,
            approxCloudMessages: 12
          })
        })
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('refreshes through the adapter and retries usage after a 401 response', async () => {
    const tempDir = await createAuthTestDir('usage-refresh')
    const authFilePath = path.join(tempDir, 'auth.json')
    const currentIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_000
    })
    const refreshedIdToken = createIdToken({
      email: 'coder@example.com',
      exp: 4_000_000_100
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'expired access token'
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'oauth-access-fresh',
            refresh_token: 'oauth-refresh-fresh',
            id_token: refreshedIdToken
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            plan_type: 'plus',
            rate_limit: {
              allowed: true,
              limit_reached: false
            }
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )

    await mkdir(tempDir, { recursive: true })
    await writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: currentIdToken,
          access_token: 'oauth-access-stale',
          refresh_token: 'oauth-refresh',
          account_id: 'acct-123'
        },
        last_refresh: new Date().toISOString()
      }),
      'utf8'
    )

    try {
      const adapter = createCodexBetterAuthAdapter({
        authFilePath,
        fetchFn: fetchMock
      })

      const result = await adapter.getUsage()

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
      expect(String(fetchMock.mock.calls[1]?.[1]?.body || '')).toContain('grant_type=refresh_token')
      expect(fetchMock.mock.calls[2]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
      expect(result).toEqual(
        expect.objectContaining({
          email: 'coder@example.com',
          planType: 'plus'
        })
      )

      const persisted = JSON.parse(await readFile(authFilePath, 'utf8'))
      expect(persisted.tokens.access_token).toBe('oauth-access-fresh')
      expect(persisted.tokens.refresh_token).toBe('oauth-refresh-fresh')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
