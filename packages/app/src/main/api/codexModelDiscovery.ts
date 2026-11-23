import type { ModelCatalogOption } from '@shared/llm/modelCatalog'
import {
  createCodexBetterAuthAdapter,
  type CodexBetterAuthAdapter,
  type CodexResolvedTokens
} from './codexOAuth'
import type { CodexModelDiscoveryProvider, CodexModelDiscoveryResult } from './svcCodexModelsImpl'

export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
export const DEFAULT_CODEX_CLIENT_VERSION = '1.0.0'

type FetchFn = typeof fetch

type CodexBackendModel = {
  display_name?: unknown
  id?: unknown
  priority?: unknown
  slug?: unknown
  visibility?: unknown
}

type CodexBackendModelsPayload = {
  models?: unknown
}

type CreateCodexBackendModelDiscoveryProviderOptions = {
  authLifecycle?: CodexBetterAuthAdapter
  clientVersion?: string
  fetchFn?: FetchFn
}

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const normalizeClientVersion = (value: string | undefined): string => {
  const normalized = normalizeString(value)
  return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : DEFAULT_CODEX_CLIENT_VERSION
}

const parseErrorMessage = (body: unknown): string => {
  if (typeof body === 'string') {
    return body.trim() || 'Unknown error.'
  }

  if (!body || typeof body !== 'object') {
    return 'Unknown error.'
  }

  const record = body as Record<string, unknown>
  const direct = normalizeString(record.detail) || normalizeString(record.message)
  if (direct) {
    return direct
  }

  const error = record.error
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>
    return (
      normalizeString(errorRecord.message) ||
      normalizeString(errorRecord.detail) ||
      normalizeString(errorRecord.type) ||
      'Unknown error.'
    )
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

const modelToCatalogOption = (model: CodexBackendModel): ModelCatalogOption | null => {
  if (normalizeString(model.visibility).toLowerCase() === 'hide') {
    return null
  }

  const value = normalizeString(model.slug) || normalizeString(model.id)
  if (!value) {
    return null
  }

  return {
    label: normalizeString(model.display_name) || value,
    value
  }
}

export function normalizeCodexBackendModels(payload: unknown): ModelCatalogOption[] {
  const models =
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as CodexBackendModelsPayload).models)
      ? ((payload as CodexBackendModelsPayload).models as unknown[])
      : []

  return models
    .map((model) =>
      model && typeof model === 'object' ? modelToCatalogOption(model as CodexBackendModel) : null
    )
    .filter((model): model is ModelCatalogOption => Boolean(model))
}

function buildCodexModelsUrl(clientVersion: string): string {
  const url = new URL(CODEX_MODELS_URL)
  url.searchParams.set('client_version', normalizeClientVersion(clientVersion))
  return url.toString()
}

function buildCodexModelsHeaders(session: CodexResolvedTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    ...(session.accountId ? { 'ChatGPT-Account-Id': session.accountId } : {}),
    'User-Agent': 'codex-cli'
  }
}

async function fetchCodexBackendModels(options: {
  clientVersion: string
  fetchFn: FetchFn
  session: CodexResolvedTokens
}): Promise<CodexModelDiscoveryResult> {
  const response = await options.fetchFn(buildCodexModelsUrl(options.clientVersion), {
    method: 'GET',
    headers: buildCodexModelsHeaders(options.session)
  })
  const body = await readJsonOrText(response)

  if (!response.ok) {
    throw new Error(`Codex model discovery failed (${response.status}): ${parseErrorMessage(body)}`)
  }

  const models = normalizeCodexBackendModels(body)
  if (models.length === 0) {
    throw new Error('Codex model discovery returned an empty model list.')
  }

  return {
    models,
    fetchedAt: new Date().toISOString()
  }
}

const shouldRefreshAfterError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /401|unauthorized|token expired|refresh/i.test(message)
}

export function createCodexBackendModelDiscoveryProvider(
  options: CreateCodexBackendModelDiscoveryProviderOptions = {}
): CodexModelDiscoveryProvider {
  const authLifecycle = options.authLifecycle ?? createCodexBetterAuthAdapter()
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const clientVersion = normalizeClientVersion(options.clientVersion)

  return async () => {
    if (typeof fetchFn !== 'function') {
      throw new Error('Codex model discovery requires fetch support in the main process.')
    }

    try {
      return await fetchCodexBackendModels({
        clientVersion,
        fetchFn,
        session: await authLifecycle.getSession()
      })
    } catch (error) {
      if (!shouldRefreshAfterError(error)) {
        throw error
      }

      return await fetchCodexBackendModels({
        clientVersion,
        fetchFn,
        session: await authLifecycle.getSession({ forceRefresh: true })
      })
    }
  }
}
