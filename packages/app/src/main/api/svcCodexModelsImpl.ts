import { createHash } from 'node:crypto'
import type {
  CodexModelCatalogEntry,
  CodexModelsCacheSnapshot,
  CodexModelsSvc,
  GetCodexModelsReq,
  GetCodexModelsResp
} from '@shared/api/svcCodexModels'
import {
  buildCodexModelCatalog,
  type ModelCatalogOption
} from '@shared/extensions/codexModelCatalog'
import { normalizeOpenAIBaseUrl, validateProviderBaseUrl } from '@shared/llm'
import type { LLMAPIProfile } from '@shared/config/config'

export const DEFAULT_CODEX_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_CLIPROXY_MODEL_CACHE_TTL_MS = 5 * 60 * 1000
const CLIPROXY_MODEL_DISCOVERY_TIMEOUT_MS = 15_000
const CLIPROXY_MODEL_DISCOVERY_MAX_BYTES = 1024 * 1024
const CLIPROXY_MODEL_ID_MAX_LENGTH = 200

export type CodexModelDiscoveryResult = {
  models: readonly (string | ModelCatalogOption)[]
  fetchedAt?: string
}

export type CodexModelDiscoveryProvider = () => Promise<CodexModelDiscoveryResult>

export interface CodexModelsCacheStore {
  read(): Promise<CodexModelsCacheSnapshot | null>
  write(snapshot: CodexModelsCacheSnapshot): Promise<void>
}

export class InMemoryCodexModelsCacheStore implements CodexModelsCacheStore {
  private snapshot: CodexModelsCacheSnapshot | null = null

  async read(): Promise<CodexModelsCacheSnapshot | null> {
    return this.snapshot
  }

  async write(snapshot: CodexModelsCacheSnapshot): Promise<void> {
    this.snapshot = snapshot
  }
}

type CodexModelsSvcImplOptions = {
  cacheStore?: CodexModelsCacheStore
  discoveryProvider?: CodexModelDiscoveryProvider
  fetchImpl?: typeof fetch
  resolveCLIProxyProfile?: (profileId: string) => LLMAPIProfile | undefined
  now?: () => Date
  ttlMs?: number
}

const normalizeModelName = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : ''

type CLIProxyModelCacheEntry = {
  models: string[]
  fetchedAt: string
  expiresAt: string
  stale?: boolean
}

const cliProxyModelCache = new Map<string, CLIProxyModelCacheEntry>()
type CLIProxyModelInflight = {
  promise: Promise<CLIProxyModelCacheEntry>
}

const cliProxyModelInflight = new Map<string, CLIProxyModelInflight>()

const createAbortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error('CLIProxyAPI/Codex model discovery was aborted.')
  error.name = 'AbortError'
  return error
}

const awaitWithAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) throw createAbortError(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(createAbortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) onAbort()
  })
}

const buildCLIProxyCacheKey = (profile: Pick<LLMAPIProfile, 'base_url' | 'api_key'>): string => {
  const baseUrl = normalizeOpenAIBaseUrl(profile.base_url)
  const keyFingerprint = createHash('sha256').update(profile.api_key).digest('hex')
  return `${baseUrl}\u0000${keyFingerprint}`
}

const validateCLIProxyBaseUrl = (value: string): string => {
  const normalized = normalizeOpenAIBaseUrl(value)
  try {
    // Keep CLIProxy's LAN/loopback HTTP support, while applying the shared
    // provider boundary so public HTTP, credentials, queries and fragments
    // cannot turn model discovery into an unprotected credential transport.
    return validateProviderBaseUrl(normalized)
  } catch (error) {
    throw new Error(
      `CLIProxyAPI/Codex base URL is not allowed: ${
        error instanceof Error ? error.message : 'invalid provider endpoint'
      }`,
      { cause: error }
    )
  }
}

const readBoundedResponseText = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > CLIPROXY_MODEL_DISCOVERY_MAX_BYTES) {
    throw new Error('CLIProxyAPI/Codex model catalog response is too large.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > CLIPROXY_MODEL_DISCOVERY_MAX_BYTES) {
    throw new Error('CLIProxyAPI/Codex model catalog response is too large.')
  }
  return text
}

const parseCLIProxyModels = (payload: unknown): string[] => {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    return []
  }
  const seen = new Set<string>()
  const models: string[] = []
  for (const entry of (payload as { data: unknown[] }).data) {
    const modelName =
      entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
        ? (entry as { id: string }).id.trim()
        : ''
    const key = modelName
    if (!modelName || modelName.length > CLIPROXY_MODEL_ID_MAX_LENGTH || seen.has(key)) {
      continue
    }
    seen.add(key)
    models.push(modelName)
  }
  return models
}

export const discoverCLIProxyModels = async (
  profile: Pick<LLMAPIProfile, 'base_url' | 'api_key'>,
  options: {
    fetchImpl?: typeof fetch
    forceRefresh?: boolean
    signal?: AbortSignal
    now?: () => Date
  } = {}
): Promise<CLIProxyModelCacheEntry> => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? (() => new Date())
  if (options.signal?.aborted) throw createAbortError(options.signal)
  const baseUrl = validateCLIProxyBaseUrl(profile.base_url)
  const cacheKey = buildCLIProxyCacheKey(profile)
  const cached = cliProxyModelCache.get(cacheKey)
  if (!options.forceRefresh && cached && Date.parse(cached.expiresAt) > now().getTime()) {
    return cached
  }
  const existing = cliProxyModelInflight.get(cacheKey)
  if (existing) return awaitWithAbort(existing.promise, options.signal)

  const request = (async () => {
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), CLIPROXY_MODEL_DISCOVERY_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${profile.api_key}` },
        redirect: 'error',
        signal: timeoutController.signal
      })
      if (!response.ok) {
        throw new Error(`CLIProxyAPI/Codex model discovery failed with HTTP ${response.status}.`)
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBoundedResponseText(response))
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('CLIProxyAPI/Codex returned an invalid model catalog response.')
        }
        throw error
      }
      const models = parseCLIProxyModels(payload)
      if (models.length === 0) {
        throw new Error('CLIProxyAPI/Codex did not return any models.')
      }
      const fetchedAt = now().toISOString()
      const entry = {
        models,
        fetchedAt,
        expiresAt: new Date(
          Date.parse(fetchedAt) + DEFAULT_CLIPROXY_MODEL_CACHE_TTL_MS
        ).toISOString()
      }
      cliProxyModelCache.set(cacheKey, entry)
      return entry
    } catch (error) {
      if (cached) return { ...cached, stale: true }
      throw error
    } finally {
      clearTimeout(timeout)
      cliProxyModelInflight.delete(cacheKey)
    }
  })()
  cliProxyModelInflight.set(cacheKey, { promise: request })
  return awaitWithAbort(request, options.signal)
}

const resolveTimestamp = (value: string | undefined, fallback: Date): number => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback.getTime()
}

const isExpired = (snapshot: CodexModelsCacheSnapshot, now: Date): boolean => {
  if (!snapshot.expiresAt) {
    return false
  }
  return resolveTimestamp(snapshot.expiresAt, now) <= now.getTime()
}

const toCatalogEntries = (
  values: readonly (string | ModelCatalogOption | null | undefined)[],
  source: CodexModelCatalogEntry['source'],
  recommended = false
): CodexModelCatalogEntry[] =>
  values
    .map((model) => {
      const value = normalizeModelName(typeof model === 'string' ? model : model?.value)
      if (!value) {
        return null
      }

      const label = typeof model === 'string' ? value : normalizeModelName(model?.label) || value
      return {
        label,
        value,
        source,
        ...(recommended ? { recommended: true } : {})
      }
    })
    .filter((entry): entry is CodexModelCatalogEntry => Boolean(entry))

const dedupeCatalogEntries = (
  entries: readonly CodexModelCatalogEntry[]
): CodexModelCatalogEntry[] => {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = entry.value
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const normalizeDiscoveredModels = (
  models: readonly (string | ModelCatalogOption)[]
): ModelCatalogOption[] =>
  models
    .map((model) => {
      const value = normalizeModelName(typeof model === 'string' ? model : model.value)
      if (!value) {
        return null
      }

      return {
        label: typeof model === 'string' ? value : normalizeModelName(model.label) || value,
        value
      }
    })
    .filter((model): model is ModelCatalogOption => Boolean(model))

export class CodexModelsSvcImpl implements CodexModelsSvc {
  private readonly cacheStore: CodexModelsCacheStore
  private readonly discoveryProvider?: CodexModelDiscoveryProvider
  private readonly fetchImpl: typeof fetch
  private readonly resolveCLIProxyProfile: (profileId: string) => LLMAPIProfile | undefined
  private readonly now: () => Date
  private readonly ttlMs: number

  constructor(options: CodexModelsSvcImplOptions = {}) {
    this.cacheStore = options.cacheStore ?? new InMemoryCodexModelsCacheStore()
    this.discoveryProvider = options.discoveryProvider
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.resolveCLIProxyProfile = options.resolveCLIProxyProfile ?? (() => undefined)
    this.now = options.now ?? (() => new Date())
    this.ttlMs = options.ttlMs ?? DEFAULT_CODEX_MODEL_CACHE_TTL_MS
  }

  async list(req: GetCodexModelsReq): Promise<GetCodexModelsResp> {
    const now = this.now()
    if (req.cliProxyProfileId?.trim()) {
      const profile = this.resolveCLIProxyProfile(req.cliProxyProfileId.trim())
      if (
        !profile ||
        profile.call_type !== 'cliproxyapi' ||
        !profile.base_url?.trim() ||
        !profile.api_key?.trim()
      ) {
        throw new Error('CLIProxyAPI/Codex profile is unavailable or incomplete.')
      }
      const discovered = await discoverCLIProxyModels(profile, {
        fetchImpl: this.fetchImpl,
        forceRefresh: req.forceRefresh,
        now: this.now
      })
      return {
        models: toCatalogEntries(discovered.models, 'remote'),
        source: 'cache',
        stale: discovered.stale ?? false,
        fetchedAt: discovered.fetchedAt,
        expiresAt: discovered.expiresAt
      }
    }

    const cachedSnapshot = await this.cacheStore.read()

    if (cachedSnapshot && !req.forceRefresh && !isExpired(cachedSnapshot, now)) {
      return this.buildResponse({
        source: 'cache',
        stale: false,
        fetchedAt: cachedSnapshot.fetchedAt,
        expiresAt: cachedSnapshot.expiresAt,
        currentModelName: req.currentModelName,
        discoveredModels: cachedSnapshot.models
      })
    }

    if (this.discoveryProvider) {
      try {
        const discovered = await this.discoveryProvider()
        const fetchedAt = new Date(resolveTimestamp(discovered.fetchedAt, now)).toISOString()
        const discoveredModels = normalizeDiscoveredModels(discovered.models)
        const expiresAt = new Date(resolveTimestamp(fetchedAt, now) + this.ttlMs).toISOString()
        await this.cacheStore.write({
          models: discoveredModels,
          fetchedAt,
          expiresAt
        })
        return this.buildResponse({
          source: 'remote',
          stale: false,
          fetchedAt,
          expiresAt,
          currentModelName: req.currentModelName,
          discoveredModels
        })
      } catch (error) {
        if (cachedSnapshot) {
          return this.buildResponse({
            source: 'cache',
            stale: true,
            fetchedAt: cachedSnapshot.fetchedAt,
            expiresAt: cachedSnapshot.expiresAt,
            currentModelName: req.currentModelName,
            discoveredModels: cachedSnapshot.models
          })
        }
        throw error
      }
    }

    if (cachedSnapshot) {
      return this.buildResponse({
        source: 'cache',
        stale: isExpired(cachedSnapshot, now),
        fetchedAt: cachedSnapshot.fetchedAt,
        expiresAt: cachedSnapshot.expiresAt,
        currentModelName: req.currentModelName,
        discoveredModels: cachedSnapshot.models
      })
    }

    return this.buildResponse({
      source: 'fallback',
      stale: false,
      fetchedAt: now.toISOString(),
      currentModelName: req.currentModelName
    })
  }

  private buildResponse(input: {
    source: GetCodexModelsResp['source']
    stale: boolean
    fetchedAt: string
    expiresAt?: string
    currentModelName?: string
    discoveredModels?: readonly (string | ModelCatalogOption)[]
  }): GetCodexModelsResp {
    const mergedOptions = buildCodexModelCatalog({
      currentModelName: input.currentModelName,
      discoveredModelNames: input.discoveredModels
    })

    const currentEntries = toCatalogEntries(
      input.currentModelName ? [input.currentModelName] : [],
      'current'
    )
    const discoveredEntries = toCatalogEntries(input.discoveredModels ?? [], 'remote')
    const entryByKey = new Map<string, CodexModelCatalogEntry>()
    for (const entry of dedupeCatalogEntries([...currentEntries, ...discoveredEntries])) {
      entryByKey.set(entry.value, entry)
    }

    const models = mergedOptions.map((option) => {
      const entry = entryByKey.get(option.value)
      return (
        entry ?? {
          label: option.label,
          value: option.value,
          source: 'fallback' as const
        }
      )
    })

    return {
      models,
      source: input.source,
      stale: input.stale,
      fetchedAt: input.fetchedAt,
      expiresAt: input.expiresAt
    }
  }
}
