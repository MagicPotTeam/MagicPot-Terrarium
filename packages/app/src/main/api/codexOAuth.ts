import crypto from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  CodexSharedAuthStatus,
  CodexUsageCredits,
  CodexUsageRateLimit,
  CodexUsageWindow,
  GetCodexUsageResp,
  LogoutCodexResp,
  LoginWithCodexResp
} from '@shared/api/svcCodexAuth'

export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs'

const CODEX_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
const CODEX_OAUTH_REDIRECT_PORT = 1455
const CODEX_DEVICE_VERIFY_URL = `${CODEX_OAUTH_ISSUER}/codex/device`
const CODEX_DEVICE_USERCODE_URL = `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`
const CODEX_DEVICE_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_OAUTH_ISSUER}/deviceauth/callback`
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const CODEX_ACCESS_TOKEN_WINDOW_MS = 55 * 60 * 1000
export const CODEX_BACKEND_BASE_URL = 'https://api.openai.com/v1'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

type PkceCodes = {
  codeChallenge: string
  codeVerifier: string
}

type ExchangedTokens = {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
}

export type CodexDeviceCodeLoginInfo = {
  userCode: string
  verificationUri: string
  expiresAt?: string
}

type CodexAuthFile = Record<string, unknown> & {
  auth_mode?: string
  OPENAI_API_KEY?: string
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

export type CodexResolvedTokens = {
  authFilePath: string
  accessToken: string
  refreshToken: string
  idToken: string
  accountId?: string
  email?: string
  connectedAt: string
}

type FetchFn = typeof fetch

type CodexAuthFileOptions = {
  authFilePath?: string
  codexHome?: string
}

export type CodexAuthSessionOptions = CodexAuthFileOptions & {
  clientId?: string
  fetchFn?: FetchFn
  issuer?: string
}

export type CodexOAuthLoginOptions = CodexAuthSessionOptions & {
  enableBrowserFlow?: boolean
  enableDeviceCodeFlow?: boolean
  forceReauth?: boolean
  onDeviceCode?: (info: CodexDeviceCodeLoginInfo) => Promise<void> | void
  openExternal: (url: string) => Promise<void>
  timeoutMs?: number
}

export type CodexBetterAuthAdapterOptions = CodexAuthSessionOptions & {
  enableBrowserFlow?: boolean
  enableDeviceCodeFlow?: boolean
  onDeviceCode?: (info: CodexDeviceCodeLoginInfo) => Promise<void> | void
  openExternal?: (url: string) => Promise<void>
  timeoutMs?: number
}

export type CodexSessionRequest = {
  forceRefresh?: boolean
}

export type CodexBrowserLoginRequest = {
  forceReauth?: boolean
}

export type CodexBetterAuthAdapter = {
  getStatus(): Promise<CodexSharedAuthStatus>
  getSession(options?: CodexSessionRequest): Promise<CodexResolvedTokens>
  importSharedLogin(): Promise<LoginWithCodexResp>
  loginWithBrowser(options?: CodexBrowserLoginRequest): Promise<LoginWithCodexResp>
  logout(): Promise<LogoutCodexResp>
  getUsage(): Promise<GetCodexUsageResp>
}

type CodexUsageApiWindow = {
  used_percent?: unknown
  limit_window_seconds?: unknown
  reset_after_seconds?: unknown
  reset_at?: unknown
}

type CodexUsageApiRateLimit = {
  allowed?: unknown
  limit_reached?: unknown
  primary_window?: CodexUsageApiWindow | null
  secondary_window?: CodexUsageApiWindow | null
}

type CodexUsageApiCredits = {
  has_credits?: unknown
  unlimited?: unknown
  balance?: unknown
  approx_local_messages?: unknown
  approx_cloud_messages?: unknown
}

type CodexUsageApiPayload = {
  plan_type?: unknown
  rate_limit?: CodexUsageApiRateLimit | null
  credits?: CodexUsageApiCredits | null
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(typeof error === 'string' ? error : 'Unknown Codex OAuth error.')
}

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createPkceCodes(): PkceCodes {
  const codeVerifier = encodeBase64Url(crypto.randomBytes(32))
  const codeChallenge = encodeBase64Url(crypto.createHash('sha256').update(codeVerifier).digest())
  return {
    codeChallenge,
    codeVerifier
  }
}

function createState(): string {
  return encodeBase64Url(crypto.randomBytes(32))
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

export function buildCodexAuthorizeUrl(options: {
  clientId: string
  forceReauth?: boolean
  issuer?: string
  redirectUri: string
  state: string
  pkce: PkceCodes
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: CODEX_OAUTH_SCOPE,
    code_challenge: options.pkce.codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: CODEX_OAUTH_ORIGINATOR,
    state: options.state
  })
  const issuer = (options.issuer || CODEX_OAUTH_ISSUER).replace(/\/+$/g, '')
  return `${issuer}/oauth/authorize?${params.toString()}`
}

function parseTokenEndpointError(body: unknown): string {
  if (typeof body === 'string') {
    return body.trim() || 'Unknown error.'
  }

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error_description === 'string' && record.error_description.trim()) {
      return record.error_description.trim()
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim()
    }
    const nestedError = record.error
    if (nestedError && typeof nestedError === 'object') {
      const nestedRecord = nestedError as Record<string, unknown>
      if (typeof nestedRecord.message === 'string' && nestedRecord.message.trim()) {
        return nestedRecord.message.trim()
      }
    }
  }

  return 'Unknown error.'
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function exchangeCodeForTokens(options: {
  clientId: string
  code: string
  fetchFn: FetchFn
  issuer?: string
  pkce: PkceCodes
  redirectUri: string
  signal?: AbortSignal
}): Promise<ExchangedTokens> {
  const issuer = (options.issuer || CODEX_OAUTH_ISSUER).replace(/\/+$/g, '')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.pkce.codeVerifier
  })

  const response = await options.fetchFn(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'codex-cli'
    },
    body: body.toString(),
    signal: options.signal
  })

  if (!response.ok) {
    const errorBody = await readJsonOrText(response)
    throw new Error(
      `Codex OAuth token exchange failed (${response.status}): ${parseTokenEndpointError(errorBody)}`
    )
  }

  const data = (await response.json()) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
  }

  if (!data.id_token || !data.access_token || !data.refresh_token) {
    throw new Error('Codex OAuth token exchange returned incomplete credentials.')
  }

  const tokens = {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token
  }
  return {
    ...tokens,
    accountId: extractCodexOAuthAccountId(tokens)
  }
}

async function refreshCodexTokens(options: {
  clientId: string
  currentIdToken?: string
  fetchFn: FetchFn
  issuer?: string
  refreshToken: string
}): Promise<ExchangedTokens> {
  const issuer = (options.issuer || CODEX_OAUTH_ISSUER).replace(/\/+$/g, '')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId
  })

  const response = await options.fetchFn(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'codex-cli'
    },
    body: body.toString()
  })

  if (!response.ok) {
    const errorBody = await readJsonOrText(response)
    throw new Error(
      `Codex OAuth refresh failed (${response.status}): ${parseTokenEndpointError(errorBody)}`
    )
  }

  const data = (await response.json()) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
  }

  const idToken = data.id_token || options.currentIdToken
  if (!idToken || !data.access_token) {
    throw new Error('Codex OAuth refresh returned incomplete credentials.')
  }

  const tokens = {
    idToken,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || options.refreshToken
  }
  return {
    ...tokens,
    accountId: extractCodexOAuthAccountId(tokens)
  }
}

type CodexDeviceAuthorization = {
  deviceAuthId: string
  userCode: string
  intervalMs: number
  expiresAtMs: number
}

function parseDeviceAuthorizationExpiresAt(data: Record<string, unknown>): number {
  if (typeof data.expires_at === 'string' && data.expires_at.trim()) {
    const parsed = Date.parse(data.expires_at)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  const expiresIn = parseFiniteNumber(data.expires_in)
  return Date.now() + Math.max(60_000, Math.round((expiresIn ?? 900) * 1000))
}

async function requestCodexDeviceAuthorization(options: {
  clientId: string
  fetchFn: FetchFn
  signal?: AbortSignal
}): Promise<CodexDeviceAuthorization> {
  const response = await options.fetchFn(CODEX_DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'codex-cli'
    },
    body: JSON.stringify({
      client_id: options.clientId
    }),
    signal: options.signal
  })

  const body = await readJsonOrText(response)
  if (!response.ok) {
    throw new Error(
      `Codex device authorization failed (${response.status}): ${parseTokenEndpointError(body)}`
    )
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Codex device authorization returned an invalid response.')
  }

  const data = body as Record<string, unknown>
  const deviceAuthId = typeof data.device_auth_id === 'string' ? data.device_auth_id.trim() : ''
  const userCode = typeof data.user_code === 'string' ? data.user_code.trim() : ''
  if (!deviceAuthId || !userCode) {
    throw new Error('Codex device authorization returned incomplete login details.')
  }

  const intervalSeconds = parseFiniteNumber(data.interval) ?? 5

  return {
    deviceAuthId,
    userCode,
    intervalMs: Math.max(0, Math.round(intervalSeconds * 1000)),
    expiresAtMs: parseDeviceAuthorizationExpiresAt(data)
  }
}

function isDeviceAuthorizationPending(errorBody: unknown): boolean {
  if (!errorBody || typeof errorBody !== 'object') {
    return false
  }

  const rawError = (errorBody as Record<string, unknown>).error
  if (typeof rawError === 'string') {
    return ['authorization_pending', 'pending', 'deviceauth_authorization_unknown'].includes(
      rawError
    )
  }

  if (rawError && typeof rawError === 'object') {
    const record = rawError as Record<string, unknown>
    const code =
      typeof record.code === 'string'
        ? record.code
        : typeof record.type === 'string'
          ? record.type
          : ''
    return ['authorization_pending', 'pending', 'deviceauth_authorization_unknown'].includes(code)
  }

  return false
}

function isDeviceAuthorizationSlowDown(errorBody: unknown): boolean {
  if (!errorBody || typeof errorBody !== 'object') {
    return false
  }

  const rawError = (errorBody as Record<string, unknown>).error
  if (rawError === 'slow_down') {
    return true
  }
  return Boolean(
    rawError &&
    typeof rawError === 'object' &&
    ((rawError as Record<string, unknown>).code === 'slow_down' ||
      (rawError as Record<string, unknown>).type === 'slow_down')
  )
}

async function pollCodexDeviceAuthorization(options: {
  authorization: CodexDeviceAuthorization
  clientId: string
  fetchFn: FetchFn
  signal?: AbortSignal
}): Promise<ExchangedTokens> {
  let intervalMs = options.authorization.intervalMs
  const deadline = Math.min(
    options.authorization.expiresAtMs,
    Date.now() + DEFAULT_DEVICE_LOGIN_TIMEOUT_MS
  )

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error('Codex device login was cancelled.')
    }

    await sleep(intervalMs, undefined, {
      signal: options.signal
    })

    const response = await options.fetchFn(CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'codex-cli'
      },
      body: JSON.stringify({
        device_auth_id: options.authorization.deviceAuthId,
        user_code: options.authorization.userCode
      }),
      signal: options.signal
    })
    const body = await readJsonOrText(response)

    if (response.ok) {
      if (!body || typeof body !== 'object') {
        throw new Error('Codex device login returned an invalid token response.')
      }

      const data = body as Record<string, unknown>
      const authorizationCode =
        typeof data.authorization_code === 'string' ? data.authorization_code.trim() : ''
      const codeVerifier = typeof data.code_verifier === 'string' ? data.code_verifier.trim() : ''

      if (authorizationCode && codeVerifier) {
        return await exchangeCodeForTokens({
          clientId: options.clientId,
          code: authorizationCode,
          fetchFn: options.fetchFn,
          pkce: {
            codeChallenge: '',
            codeVerifier
          },
          redirectUri: CODEX_DEVICE_REDIRECT_URI,
          signal: options.signal
        })
      }

      const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : ''
      const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : ''
      const idToken = typeof data.id_token === 'string' ? data.id_token.trim() : ''
      if (accessToken && refreshToken && idToken) {
        const tokens = {
          idToken,
          accessToken,
          refreshToken
        }
        return {
          ...tokens,
          accountId: extractCodexOAuthAccountId(tokens)
        }
      }

      throw new Error('Codex device login returned incomplete credentials.')
    }

    if (response.status === 400 || response.status === 403 || response.status === 428) {
      if (isDeviceAuthorizationPending(body)) {
        continue
      }
      if (isDeviceAuthorizationSlowDown(body)) {
        intervalMs += 5_000
        continue
      }
    }

    throw new Error(
      `Codex device login failed (${response.status}): ${parseTokenEndpointError(body)}`
    )
  }

  throw new Error('Codex device login timed out.')
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.')
  if (segments.length < 2) {
    return null
  }

  try {
    const payload = segments[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(segments[1].length / 4) * 4, '=')
    const decoded = Buffer.from(payload, 'base64').toString('utf8')
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return null
  }
}

function getJwtExpirationTime(token?: string | null): number | null {
  if (!token?.trim()) {
    return null
  }

  const payload = decodeJwtPayload(token)
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null
}

function isJwtExpired(token?: string | null, skewMs: number = 60_000): boolean {
  const expiresAt = getJwtExpirationTime(token)
  if (expiresAt === null) {
    return false
  }

  return expiresAt <= Date.now() + skewMs
}

function parseIsoTimestamp(value?: string | null): number | null {
  if (!value?.trim()) {
    return null
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

const parseFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }

  return undefined
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

function normalizeCodexUsageWindow(
  value: CodexUsageApiWindow | null | undefined
): CodexUsageWindow | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const usedPercent = clampPercent(parseFiniteNumber(value.used_percent) ?? 0)
  const limitWindowSeconds = Math.max(
    0,
    Math.round(parseFiniteNumber(value.limit_window_seconds) ?? 0)
  )
  const resetAfterSeconds = Math.max(
    0,
    Math.round(parseFiniteNumber(value.reset_after_seconds) ?? 0)
  )
  const resetAtSeconds = parseFiniteNumber(value.reset_at)

  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    limitWindowSeconds,
    resetAfterSeconds,
    ...(typeof resetAtSeconds === 'number' && resetAtSeconds > 0
      ? {
          resetAt: new Date(resetAtSeconds * 1000).toISOString()
        }
      : {})
  }
}

function normalizeCodexUsageRateLimit(
  value: CodexUsageApiRateLimit | null | undefined
): CodexUsageRateLimit | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  return {
    allowed: parseBoolean(value.allowed) ?? false,
    limitReached: parseBoolean(value.limit_reached) ?? false,
    ...(normalizeCodexUsageWindow(value.primary_window)
      ? { primaryWindow: normalizeCodexUsageWindow(value.primary_window) }
      : {}),
    ...(normalizeCodexUsageWindow(value.secondary_window)
      ? { secondaryWindow: normalizeCodexUsageWindow(value.secondary_window) }
      : {})
  }
}

function normalizeCodexUsageCredits(
  value: CodexUsageApiCredits | null | undefined
): CodexUsageCredits | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const balance = parseFiniteNumber(value.balance)
  const approxLocalMessages = parseFiniteNumber(value.approx_local_messages)
  const approxCloudMessages = parseFiniteNumber(value.approx_cloud_messages)

  return {
    hasCredits: parseBoolean(value.has_credits) ?? false,
    unlimited: parseBoolean(value.unlimited) ?? false,
    ...(typeof balance === 'number' ? { balance } : {}),
    ...(typeof approxLocalMessages === 'number' ? { approxLocalMessages } : {}),
    ...(typeof approxCloudMessages === 'number' ? { approxCloudMessages } : {})
  }
}

function isCodexAccessTokenExpired(authFile: CodexAuthFile, skewMs: number = 60_000): boolean {
  const lastRefresh = parseIsoTimestamp(authFile.last_refresh)
  if (lastRefresh === null) {
    return false
  }

  return lastRefresh + CODEX_ACCESS_TOKEN_WINDOW_MS <= Date.now() + skewMs
}

function buildPersistedCodexAuthFile(
  previous: CodexAuthFile | undefined,
  tokens: ExchangedTokens
): CodexAuthFile {
  return {
    ...previous,
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: '',
    tokens: {
      ...previous?.tokens,
      id_token: tokens.idToken.trim(),
      access_token: tokens.accessToken.trim(),
      refresh_token: tokens.refreshToken.trim(),
      ...(tokens.accountId ? { account_id: tokens.accountId } : {})
    },
    last_refresh: new Date().toISOString()
  }
}

async function persistCodexAuthFile(authFilePath: string, authFile: CodexAuthFile): Promise<void> {
  await writeFile(authFilePath, `${JSON.stringify(authFile, null, 2)}\n`, 'utf8')
}

export function extractCodexOAuthEmail(idToken: string): string | undefined {
  const payload = decodeJwtPayload(idToken)
  return typeof payload?.email === 'string' ? payload.email : undefined
}

function extractCodexOAuthAccountIdFromToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token)
  const authClaims = payload?.['https://api.openai.com/auth']
  if (authClaims && typeof authClaims === 'object') {
    const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id
    if (typeof accountId === 'string' && accountId.trim()) {
      return accountId.trim()
    }
  }

  const accountId = payload?.chatgpt_account_id
  return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : undefined
}

function extractCodexOAuthAccountId(
  tokens: Pick<ExchangedTokens, 'accessToken' | 'idToken'>
): string | undefined {
  return (
    extractCodexOAuthAccountIdFromToken(tokens.idToken) ||
    extractCodexOAuthAccountIdFromToken(tokens.accessToken)
  )
}

export function getCodexAuthFilePath(options?: {
  authFilePath?: string
  codexHome?: string
}): string {
  if (options?.authFilePath?.trim()) {
    return options.authFilePath
  }

  const codexHome =
    options?.codexHome?.trim() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'auth.json')
}

export function createCodexOAuthClientOptions(
  session: Pick<CodexResolvedTokens, 'accessToken' | 'accountId'>
): {
  apiKey: string
  baseURL: string
  defaultHeaders?: Record<string, string>
} {
  return {
    apiKey: session.accessToken,
    baseURL: CODEX_BACKEND_BASE_URL,
    ...(session.accountId
      ? {
          defaultHeaders: {
            'ChatGPT-Account-Id': session.accountId
          }
        }
      : {})
  }
}

async function inspectCodexCliAuthStatusInternal(
  options?: CodexAuthFileOptions
): Promise<CodexSharedAuthStatus> {
  const authFilePath = getCodexAuthFilePath(options)

  let authFile: CodexAuthFile
  try {
    const loaded = await loadCodexAuthFile(options)
    authFile = loaded.authFile
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return {
        available: false,
        mode: 'missing',
        authFilePath,
        reason: 'missing_auth_file'
      }
    }

    return {
      available: false,
      mode: 'invalid',
      authFilePath,
      reason: 'invalid_auth_file'
    }
  }

  const apiKey = authFile.OPENAI_API_KEY?.trim()
  const idToken = authFile.tokens?.id_token?.trim()
  const refreshToken = authFile.tokens?.refresh_token?.trim()
  const connectedAt = authFile.last_refresh?.trim() || undefined
  const email = idToken ? extractCodexOAuthEmail(idToken) : undefined

  if (apiKey) {
    return {
      available: false,
      mode: 'api_key',
      authFilePath,
      ...(email ? { email } : {}),
      ...(connectedAt ? { connectedAt } : {}),
      reason: 'api_key_mode'
    }
  }

  if (!authFile.tokens || typeof authFile.tokens !== 'object') {
    return {
      available: false,
      mode: 'invalid',
      authFilePath,
      ...(connectedAt ? { connectedAt } : {}),
      reason: 'missing_tokens'
    }
  }

  if (!refreshToken) {
    return {
      available: false,
      mode: 'invalid',
      authFilePath,
      ...(email ? { email } : {}),
      ...(connectedAt ? { connectedAt } : {}),
      reason: 'missing_refresh_token'
    }
  }

  return {
    available: true,
    mode: 'chatgpt',
    authFilePath,
    ...(email ? { email } : {}),
    ...(connectedAt ? { connectedAt } : {})
  }
}

async function loadCodexAuthFile(options?: {
  authFilePath?: string
  codexHome?: string
}): Promise<{ authFile: CodexAuthFile; authFilePath: string }> {
  const authFilePath = getCodexAuthFilePath(options)
  const raw = await readFile(authFilePath, 'utf8')
  return {
    authFile: JSON.parse(raw) as CodexAuthFile,
    authFilePath
  }
}

function resolveCodexSessionMetadata(
  authFilePath: string,
  authFile: CodexAuthFile,
  fallbackTokens?: Partial<ExchangedTokens>
): CodexResolvedTokens {
  const idToken = authFile.tokens?.id_token?.trim() || fallbackTokens?.idToken?.trim() || ''
  const accessToken =
    authFile.tokens?.access_token?.trim() || fallbackTokens?.accessToken?.trim() || ''
  const refreshToken =
    authFile.tokens?.refresh_token?.trim() || fallbackTokens?.refreshToken?.trim() || ''

  if (!accessToken || !refreshToken || !idToken) {
    throw new Error(`Codex auth at ${authFilePath} is missing reusable OAuth tokens.`)
  }

  return {
    authFilePath,
    accessToken,
    refreshToken,
    idToken,
    accountId: authFile.tokens?.account_id?.trim() || undefined,
    email: extractCodexOAuthEmail(idToken),
    connectedAt: authFile.last_refresh || new Date().toISOString()
  }
}

async function forceRefreshCodexCliAuthTokensInternal(
  options?: CodexAuthSessionOptions
): Promise<CodexResolvedTokens> {
  const { authFile, authFilePath } = await loadCodexAuthFile(options)
  const currentIdToken = authFile.tokens?.id_token?.trim()
  const refreshToken = authFile.tokens?.refresh_token?.trim()
  const fetchFn = options?.fetchFn || globalThis.fetch

  if (!refreshToken) {
    if (authFile.OPENAI_API_KEY?.trim()) {
      throw new Error(
        `Local Codex auth at ${authFilePath} is using API key mode instead of ChatGPT login.`
      )
    }

    throw new Error(`Local Codex login at ${authFilePath} has no refresh token to renew it.`)
  }

  if (typeof fetchFn !== 'function') {
    throw new Error('Codex OAuth requires fetch support in the main process.')
  }

  const refreshedTokens = await refreshCodexTokens({
    clientId: options?.clientId || CODEX_OAUTH_CLIENT_ID,
    currentIdToken,
    fetchFn,
    issuer: options?.issuer || CODEX_OAUTH_ISSUER,
    refreshToken
  })
  const nextAuthFile = buildPersistedCodexAuthFile(authFile, refreshedTokens)
  await persistCodexAuthFile(authFilePath, nextAuthFile)
  return resolveCodexSessionMetadata(authFilePath, nextAuthFile, refreshedTokens)
}

async function ensureCodexCliAuthTokensInternal(
  options?: CodexAuthSessionOptions
): Promise<CodexResolvedTokens> {
  const { authFile, authFilePath } = await loadCodexAuthFile(options)
  const idToken = authFile.tokens?.id_token?.trim()
  const accessToken = authFile.tokens?.access_token?.trim()
  const refreshToken = authFile.tokens?.refresh_token?.trim()

  if (!accessToken && !refreshToken) {
    if (authFile.OPENAI_API_KEY?.trim()) {
      throw new Error(
        `Local Codex auth at ${authFilePath} is using API key mode instead of ChatGPT login.`
      )
    }

    throw new Error(`No reusable Codex ChatGPT login was found in ${authFilePath}.`)
  }

  if (!accessToken || !idToken || isJwtExpired(idToken) || isCodexAccessTokenExpired(authFile)) {
    return await forceRefreshCodexCliAuthTokensInternal(options)
  }

  return resolveCodexSessionMetadata(authFilePath, authFile)
}

async function logoutCodexCliAuthInternal(
  options?: CodexAuthFileOptions
): Promise<LogoutCodexResp> {
  const authFilePath = getCodexAuthFilePath(options)

  let authFile: CodexAuthFile
  try {
    const loaded = await loadCodexAuthFile(options)
    authFile = loaded.authFile
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return {
        cleared: false,
        authFilePath
      }
    }
    throw normalizeError(error)
  }

  const hadSharedLogin = Boolean(
    authFile.auth_mode === 'chatgpt' ||
    authFile.last_refresh?.trim() ||
    authFile.tokens?.id_token?.trim() ||
    authFile.tokens?.access_token?.trim() ||
    authFile.tokens?.refresh_token?.trim()
  )

  if (!hadSharedLogin) {
    return {
      cleared: false,
      authFilePath
    }
  }

  const nextAuthFile: CodexAuthFile = {
    ...authFile,
    ...(authFile.auth_mode === 'chatgpt' ? { auth_mode: undefined } : {}),
    tokens: undefined,
    last_refresh: undefined
  }

  await persistCodexAuthFile(authFilePath, nextAuthFile)

  return {
    cleared: true,
    authFilePath
  }
}

async function fetchCodexUsageWithSession(
  session: CodexResolvedTokens,
  fetchFn: FetchFn
): Promise<GetCodexUsageResp> {
  const response = await fetchFn(CODEX_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      ...(session.accountId
        ? {
            'ChatGPT-Account-Id': session.accountId
          }
        : {}),
      'User-Agent': 'codex-cli'
    }
  })

  if (!response.ok) {
    const errorBody = await readJsonOrText(response)
    throw new Error(
      `Codex usage fetch failed (${response.status}): ${parseTokenEndpointError(errorBody)}`
    )
  }

  const payload = (await response.json()) as CodexUsageApiPayload
  const planType =
    typeof payload.plan_type === 'string' && payload.plan_type.trim()
      ? payload.plan_type.trim()
      : undefined
  const rateLimit = normalizeCodexUsageRateLimit(payload.rate_limit)
  const credits = normalizeCodexUsageCredits(payload.credits)

  return {
    email: session.email,
    fetchedAt: new Date().toISOString(),
    ...(planType ? { planType } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(credits ? { credits } : {})
  }
}

class CodexBetterAuthLifecycleAdapterImpl implements CodexBetterAuthAdapter {
  private activeBrowserLogin: Promise<LoginWithCodexResp> | null = null
  private activeSessionLoad: Promise<CodexResolvedTokens> | null = null
  private activeSessionRefresh: Promise<CodexResolvedTokens> | null = null

  constructor(private readonly options?: CodexBetterAuthAdapterOptions) {}

  async getStatus(): Promise<CodexSharedAuthStatus> {
    return await inspectCodexCliAuthStatusInternal(this.options)
  }

  async getSession(options?: CodexSessionRequest): Promise<CodexResolvedTokens> {
    if (this.activeSessionRefresh) {
      return await this.activeSessionRefresh
    }

    if (options?.forceRefresh) {
      if (!this.activeSessionRefresh) {
        const refreshPromise = forceRefreshCodexCliAuthTokensInternal(this.options).finally(() => {
          if (this.activeSessionRefresh === refreshPromise) {
            this.activeSessionRefresh = null
          }
        })
        this.activeSessionRefresh = refreshPromise
      }

      return await this.activeSessionRefresh
    }

    if (!this.activeSessionLoad) {
      const loadPromise = ensureCodexCliAuthTokensInternal(this.options).finally(() => {
        if (this.activeSessionLoad === loadPromise) {
          this.activeSessionLoad = null
        }
      })
      this.activeSessionLoad = loadPromise
    }

    return await this.activeSessionLoad
  }

  async importSharedLogin(): Promise<LoginWithCodexResp> {
    const session = await this.getSession()
    return {
      email: session.email,
      connectedAt: session.connectedAt
    }
  }

  async loginWithBrowser(options?: CodexBrowserLoginRequest): Promise<LoginWithCodexResp> {
    if (!this.activeBrowserLogin) {
      const openExternal = this.options?.openExternal
      if (typeof openExternal !== 'function') {
        throw new Error('Codex OAuth browser login requires openExternal support.')
      }

      const loginPromise = performCodexOAuthLoginInternal({
        ...this.options,
        forceReauth: options?.forceReauth,
        openExternal
      }).finally(() => {
        if (this.activeBrowserLogin === loginPromise) {
          this.activeBrowserLogin = null
        }
      })
      this.activeBrowserLogin = loginPromise
    }

    return await this.activeBrowserLogin
  }

  async logout(): Promise<LogoutCodexResp> {
    const result = await logoutCodexCliAuthInternal(this.options)
    this.activeSessionLoad = null
    this.activeSessionRefresh = null
    return result
  }

  async getUsage(): Promise<GetCodexUsageResp> {
    const fetchFn = this.options?.fetchFn || globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new Error('Codex usage fetch requires fetch support in the main process.')
    }

    try {
      const session = await this.getSession()
      return await fetchCodexUsageWithSession(session, fetchFn)
    } catch (error) {
      const normalized = normalizeError(error)
      if (
        /401|unauthorized/i.test(normalized.message) ||
        /token expired|refresh/i.test(normalized.message)
      ) {
        const refreshedSession = await this.getSession({
          forceRefresh: true
        })
        return await fetchCodexUsageWithSession(refreshedSession, fetchFn)
      }

      throw normalized
    }
  }
}

const defaultCodexBetterAuthAdapter = new CodexBetterAuthLifecycleAdapterImpl()

function hasCustomCodexBetterAuthOptions(options?: CodexBetterAuthAdapterOptions): boolean {
  if (!options) {
    return false
  }

  return Object.values(options).some((value) => value !== undefined)
}

function resolveCodexBetterAuthAdapter(
  options?: CodexBetterAuthAdapterOptions
): CodexBetterAuthAdapter {
  if (hasCustomCodexBetterAuthOptions(options)) {
    return new CodexBetterAuthLifecycleAdapterImpl(options)
  }

  return defaultCodexBetterAuthAdapter
}

export function createCodexBetterAuthAdapter(
  options?: CodexBetterAuthAdapterOptions
): CodexBetterAuthAdapter {
  return new CodexBetterAuthLifecycleAdapterImpl(options)
}

export async function inspectCodexCliAuthStatus(
  options?: CodexAuthFileOptions
): Promise<CodexSharedAuthStatus> {
  return await resolveCodexBetterAuthAdapter(options).getStatus()
}

export async function forceRefreshCodexCliAuthTokens(
  options?: CodexAuthSessionOptions
): Promise<CodexResolvedTokens> {
  return await resolveCodexBetterAuthAdapter(options).getSession({
    forceRefresh: true
  })
}

async function persistOAuthTokensAsLoginResp(
  options: CodexAuthFileOptions,
  tokens: ExchangedTokens
): Promise<LoginWithCodexResp> {
  const authFilePath = getCodexAuthFilePath(options)
  let previousAuthFile: CodexAuthFile | undefined
  try {
    const loaded = await loadCodexAuthFile(options)
    previousAuthFile = loaded.authFile
  } catch {
    previousAuthFile = undefined
  }

  const nextAuthFile = buildPersistedCodexAuthFile(previousAuthFile, tokens)
  await persistCodexAuthFile(authFilePath, nextAuthFile)

  return {
    email: extractCodexOAuthEmail(tokens.idToken),
    connectedAt: nextAuthFile.last_refresh || new Date().toISOString()
  }
}

async function performCodexDeviceOAuthLoginInternal(
  options: CodexOAuthLoginOptions & { signal?: AbortSignal }
): Promise<LoginWithCodexResp> {
  const clientId = options.clientId || CODEX_OAUTH_CLIENT_ID
  const fetchFn = options.fetchFn || globalThis.fetch

  if (typeof fetchFn !== 'function') {
    throw new Error('Codex device login requires fetch support in the main process.')
  }

  const authorization = await requestCodexDeviceAuthorization({
    clientId,
    fetchFn,
    signal: options.signal
  })

  await options.onDeviceCode?.({
    userCode: authorization.userCode,
    verificationUri: CODEX_DEVICE_VERIFY_URL,
    expiresAt: new Date(authorization.expiresAtMs).toISOString()
  })

  const tokens = await pollCodexDeviceAuthorization({
    authorization,
    clientId,
    fetchFn,
    signal: options.signal
  })

  return await persistOAuthTokensAsLoginResp(options, tokens)
}

function isCancellationError(error: unknown): boolean {
  return /cancelled|aborted/i.test(normalizeError(error).message)
}

async function firstSuccessfulCodexLogin(
  tasks: Array<{
    controller: AbortController
    promise: Promise<LoginWithCodexResp>
  }>
): Promise<LoginWithCodexResp> {
  const pending = new Set(tasks)
  let lastError: Error | null = null

  while (pending.size > 0) {
    const settled = await Promise.race(
      [...pending].map((task) =>
        task.promise.then(
          (result) => ({ task, result }),
          (error: unknown) => ({ task, error })
        )
      )
    )

    pending.delete(settled.task)

    if ('result' in settled) {
      for (const task of pending) {
        task.controller.abort()
      }
      return settled.result
    }

    const normalized = normalizeError(settled.error)
    if (!isCancellationError(normalized)) {
      lastError = normalized
    }
  }

  throw lastError || new Error('Codex OAuth login failed.')
}

async function performCodexOAuthLoginInternal(
  options: CodexOAuthLoginOptions
): Promise<LoginWithCodexResp> {
  const tasks: Array<{
    controller: AbortController
    promise: Promise<LoginWithCodexResp>
  }> = []
  const enableBrowserFlow = options.enableBrowserFlow ?? true
  const enableDeviceCodeFlow = options.enableDeviceCodeFlow ?? Boolean(options.onDeviceCode)

  if (enableBrowserFlow) {
    const controller = new AbortController()
    tasks.push({
      controller,
      promise: performCodexBrowserOAuthLoginInternal({
        ...options,
        signal: controller.signal
      })
    })
  }

  if (enableDeviceCodeFlow) {
    const controller = new AbortController()
    tasks.push({
      controller,
      promise: performCodexDeviceOAuthLoginInternal({
        ...options,
        signal: controller.signal
      })
    })
  }

  if (tasks.length === 0) {
    throw new Error('Codex OAuth login requires at least one enabled login flow.')
  }

  if (tasks.length === 1) {
    return await tasks[0].promise
  }

  return await firstSuccessfulCodexLogin(tasks)
}

/** A review can inspect a saved session but must never join an auth lifecycle task,
 * refresh/persist tokens, or start login. Return only the credentials for this POST. */
export async function readExistingCodexReviewSession(
  options?: CodexAuthFileOptions
): Promise<Pick<CodexResolvedTokens, 'accessToken' | 'accountId'>> {
  // Review never refreshes the sign-in itself; an ordinary message does.
  const unavailable = () => new Error('Codex image review needs a fresh Codex session. Send an ordinary message first (it renews the sign-in), then ask again.')
  try {
    const { authFile } = await loadCodexAuthFile(options)
    const accessToken = authFile.tokens?.access_token?.trim()
    const idExpiry = getJwtExpirationTime(authFile.tokens?.id_token)
    const accessExpiry = getJwtExpirationTime(accessToken)
    const lastRefresh = parseIsoTimestamp(authFile.last_refresh)
    const now = Date.now()
    const freshAfter = now + 60_000
    if ((authFile.auth_mode !== undefined && authFile.auth_mode !== 'chatgpt') ||
        authFile.OPENAI_API_KEY?.trim() || !accessToken ||
        idExpiry === null || !Number.isFinite(idExpiry) || idExpiry <= freshAfter ||
        (lastRefresh !== null && (lastRefresh > now || lastRefresh + CODEX_ACCESS_TOKEN_WINDOW_MS <= freshAfter)) ||
        (accessExpiry !== null ? !Number.isFinite(accessExpiry) || accessExpiry <= freshAfter
          : accessToken.includes('.') || lastRefresh === null)) throw unavailable()
    return { accessToken, accountId: authFile.tokens?.account_id?.trim() || undefined }
  } catch {
    // Do not leak filesystem paths or token/parser details in a chat-facing error.
    throw unavailable()
  }
}

export async function ensureCodexCliAuthTokens(
  options?: CodexAuthSessionOptions
): Promise<CodexResolvedTokens> {
  return await resolveCodexBetterAuthAdapter(options).getSession()
}

export async function importCodexCliAuthLogin(
  options?: CodexAuthSessionOptions
): Promise<LoginWithCodexResp> {
  return await resolveCodexBetterAuthAdapter(options).importSharedLogin()
}

export async function logoutCodexCliAuth(options?: CodexAuthFileOptions): Promise<LogoutCodexResp> {
  return await resolveCodexBetterAuthAdapter(options).logout()
}

export async function fetchCodexUsageStatus(
  options?: CodexAuthSessionOptions
): Promise<GetCodexUsageResp> {
  return await resolveCodexBetterAuthAdapter(options).getUsage()
}

export async function performCodexOAuthLogin(
  options: CodexOAuthLoginOptions
): Promise<LoginWithCodexResp> {
  return await createCodexBetterAuthAdapter(options).loginWithBrowser({
    forceReauth: options.forceReauth
  })
}

function renderHtml(title: string, message: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escape(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #0f1115; color: #f3f5f8; }
      main { max-width: 520px; margin: 72px auto; padding: 32px; background: #171a21; border-radius: 16px; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0; line-height: 1.6; color: #c8d0dc; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escape(title)}</h1>
      <p>${escape(message)}</p>
    </main>
  </body>
</html>`
}

function respondWithHtml(
  response: http.ServerResponse,
  statusCode: number,
  title: string,
  message: string
): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(renderHtml(title, message))
}

async function performCodexBrowserOAuthLoginInternal(
  options: CodexOAuthLoginOptions & { signal?: AbortSignal }
): Promise<LoginWithCodexResp> {
  const clientId = options.clientId || CODEX_OAUTH_CLIENT_ID
  const issuer = options.issuer || CODEX_OAUTH_ISSUER
  const fetchFn = options.fetchFn || globalThis.fetch

  if (typeof fetchFn !== 'function') {
    throw new Error('Codex OAuth requires fetch support in the main process.')
  }

  const pkce = createPkceCodes()
  const state = createState()
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS

  return new Promise<LoginWithCodexResp>((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | null = null
    let server: http.Server | null = null
    let finished = false
    let abortLogin: (() => void) | null = null

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      if (abortLogin) {
        options.signal?.removeEventListener('abort', abortLogin)
        abortLogin = null
      }
      if (server) {
        server.close()
        server = null
      }
    }

    const fail = (error: unknown) => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      reject(normalizeError(error))
    }

    const succeed = (result: LoginWithCodexResp) => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      resolve(result)
    }

    if (options.signal?.aborted) {
      fail(new Error('Codex OAuth browser login was cancelled.'))
      return
    }

    abortLogin = () => {
      fail(new Error('Codex OAuth browser login was cancelled.'))
    }
    options.signal?.addEventListener('abort', abortLogin, { once: true })

    server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
        if (requestUrl.pathname === '/cancel') {
          respondWithHtml(
            response,
            200,
            'Codex Sign-In Cancelled',
            'The previous login was cancelled.'
          )
          fail(new Error('Codex OAuth browser login was cancelled.'))
          return
        }

        if (requestUrl.pathname !== '/auth/callback') {
          respondWithHtml(
            response,
            404,
            'Not Found',
            'This login endpoint only handles /auth/callback.'
          )
          return
        }

        const returnedState = requestUrl.searchParams.get('state')
        if (returnedState !== state) {
          respondWithHtml(
            response,
            400,
            'Codex Sign-In Failed',
            'The login response could not be verified. Please try again.'
          )
          fail(new Error('Codex OAuth state mismatch.'))
          return
        }

        const errorCode = requestUrl.searchParams.get('error')
        if (errorCode) {
          const description = requestUrl.searchParams.get('error_description')
          respondWithHtml(
            response,
            400,
            'Codex Sign-In Failed',
            description || 'The login was cancelled or denied.'
          )
          fail(new Error(description ? `${errorCode}: ${description}` : errorCode))
          return
        }

        const code = requestUrl.searchParams.get('code')
        if (!code) {
          respondWithHtml(
            response,
            400,
            'Codex Sign-In Failed',
            'The login response did not contain an authorization code.'
          )
          fail(new Error('Codex OAuth callback did not include an authorization code.'))
          return
        }

        const address = server?.address() as AddressInfo | null
        if (!address?.port) {
          respondWithHtml(
            response,
            500,
            'Codex Sign-In Failed',
            'The local login server port could not be determined.'
          )
          fail(new Error('Codex OAuth login server port is unavailable.'))
          return
        }

        const redirectUri = `http://localhost:${address.port}/auth/callback`
        const tokens = await exchangeCodeForTokens({
          clientId,
          code,
          fetchFn,
          issuer,
          pkce,
          redirectUri,
          signal: options.signal
        })
        // The token exchange can outlive the local callback request. A timeout, cancellation, or
        // competing login may finish the outer operation while the provider promise is pending;
        // never persist credentials or report success after that boundary has finished.
        if (finished || options.signal?.aborted) {
          throw new Error('Codex OAuth browser login was cancelled.')
        }
        const authFilePath = getCodexAuthFilePath(options)
        let previousAuthFile: CodexAuthFile | undefined
        try {
          const loaded = await loadCodexAuthFile(options)
          previousAuthFile = loaded.authFile
        } catch {
          previousAuthFile = undefined
        }
        const nextAuthFile = buildPersistedCodexAuthFile(previousAuthFile, tokens)
        if (finished || options.signal?.aborted) {
          throw new Error('Codex OAuth browser login was cancelled.')
        }
        await persistCodexAuthFile(authFilePath, nextAuthFile)

        if (finished || options.signal?.aborted) {
          throw new Error('Codex OAuth browser login was cancelled.')
        }
        respondWithHtml(response, 200, 'Codex Sign-In Complete', 'You can return to MagicPot now.')

        succeed({
          email: extractCodexOAuthEmail(tokens.idToken),
          connectedAt: nextAuthFile.last_refresh || new Date().toISOString()
        })
      } catch (error) {
        const normalized = normalizeError(error)
        if (!response.headersSent) {
          respondWithHtml(response, 500, 'Codex Sign-In Failed', normalized.message)
        }
        fail(normalized)
      }
    })

    server.on('error', fail)
    server.listen(CODEX_OAUTH_REDIRECT_PORT, '127.0.0.1', async () => {
      const address = server?.address() as AddressInfo | null
      if (!address?.port) {
        fail(new Error('Codex OAuth login server failed to bind a local port.'))
        return
      }

      const redirectUri = `http://localhost:${address.port}/auth/callback`
      const authUrl = buildCodexAuthorizeUrl({
        clientId,
        forceReauth: options.forceReauth,
        issuer,
        redirectUri,
        state,
        pkce
      })

      timeoutHandle = setTimeout(() => {
        fail(new Error('Codex OAuth login timed out.'))
      }, timeoutMs)

      try {
        await options.openExternal(authUrl)
      } catch (error) {
        fail(
          new Error(
            `Unable to open the browser for Codex sign-in: ${normalizeError(error).message}`
          )
        )
      }
    })
  })
}
