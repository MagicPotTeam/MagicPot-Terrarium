import { ProviderFileIdCache, type ProviderFileIdCacheKey } from '../providerFileIdCache'
import type { FetchImpl } from './clients'
import type { ChatAttachment, ChatMessage } from './types'

const FILE_SEARCH_READY_TIMEOUT_MS = 30_000
const FILE_SEARCH_POLL_INTERVAL_MS = 1_000
const FILE_SEARCH_CLEANUP_TIMEOUT_MS = 5_000
const FILE_SEARCH_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const providerFileIdCache = new ProviderFileIdCache()

type BoundedOperationSignal = {
  signal: AbortSignal
  cleanup: () => void
}

const createBoundedOperationSignal = (
  parent: AbortSignal | undefined,
  timeoutMs: number
): BoundedOperationSignal => {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const abortFromParent = () => {
    if (controller.signal.aborted) return
    if (parent?.reason !== undefined) controller.abort(parent.reason)
    else controller.abort()
  }

  if (parent?.aborted) {
    abortFromParent()
  } else {
    parent?.addEventListener('abort', abortFromParent, { once: true })
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) return
      const error = new Error('OpenAI file search setup timed out.')
      error.name = 'TimeoutError'
      controller.abort(error)
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      parent?.removeEventListener('abort', abortFromParent)
    }
  }
}

const abortReason = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason.trim()
      ? signal.reason
      : 'The operation was aborted.'
  )
  error.name = 'AbortError'
  return error
}

const awaitWithAbort = <T>(
  value: PromiseLike<T> | T,
  signal?: AbortSignal,
  abortTransport?: () => void
): Promise<T> => {
  const promise = Promise.resolve(value)
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => undefined)
    try {
      abortTransport?.()
    } catch {
      // Transport cleanup must not replace the authoritative abort reason.
    }
    return Promise.reject(abortReason(signal))
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      finishReject(abortReason(signal))
      try {
        abortTransport?.()
      } catch {
        // Injected transports may throw while cancelling; the operation still settles.
      }
    }
    const onAbortCleanup = () => signal.removeEventListener('abort', onAbort)
    const finishResolve = (result: T) => {
      if (settled) return
      settled = true
      onAbortCleanup()
      resolve(result)
    }
    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      onAbortCleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(finishResolve, finishReject)
  })
}

const cancelResponseBody = (response: Response): void => {
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // The body may already be consumed or closed.
  }
}

const getResponseContentLength = (response: Response): number | undefined => {
  const value = response.headers?.get('content-length')
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const readResponseBlobWithinLimit = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Blob> => {
  const limitError = () =>
    new Error(`OpenAI file search response body exceeds the ${maxBytes}-byte limit.`)
  const contentLength = getResponseContentLength(response)
  if (contentLength !== undefined && contentLength > maxBytes) {
    cancelResponseBody(response)
    throw limitError()
  }

  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    const blob = await awaitWithAbort(response.blob(), signal, () => cancelResponseBody(response))
    if (blob.size > maxBytes) {
      cancelResponseBody(response)
      throw limitError()
    }
    return blob
  }

  const reader = body.getReader()
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      // Best effort, including injected readers that throw synchronously.
    }
  }
  const chunks: BlobPart[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await awaitWithAbort(reader.read(), signal, cancelReader)
      if (result.done) break
      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value)
      if (chunk.byteLength > maxBytes - totalBytes) throw limitError()
      totalBytes += chunk.byteLength
      const ownedChunk = new ArrayBuffer(chunk.byteLength)
      new Uint8Array(ownedChunk).set(chunk)
      chunks.push(ownedChunk)
    }
  } catch (error) {
    cancelReader()
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Do not mask the primary failure when an injected reader cannot release.
    }
  }

  return new Blob(chunks, {
    type: response.headers?.get('content-type') || ''
  })
}

const readResponseTextWithinLimit = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> => {
  const blob = await readResponseBlobWithinLimit(response, maxBytes, signal)
  const bytes = await awaitWithAbort(blob.arrayBuffer(), signal)
  return new TextDecoder().decode(bytes)
}

const readResponseJsonWithinLimit = async <T>(
  response: Response,
  signal?: AbortSignal,
  maxBytes = 1024 * 1024
): Promise<T> => {
  if (!response.body && typeof response.json === 'function') {
    const payload = await awaitWithAbort(response.json(), signal, () =>
      cancelResponseBody(response)
    )
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxBytes) {
      throw new Error(`OpenAI file search response body exceeds the ${maxBytes}-byte limit.`)
    }
    return payload as T
  }
  const text = await readResponseTextWithinLimit(response, maxBytes, signal)
  return JSON.parse(text) as T
}

const createBoundedFetch = (fetchImpl: FetchImpl, signal: AbortSignal): FetchImpl =>
  ((input, init) => {
    if (signal.aborted) return Promise.reject(abortReason(signal))

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const cleanup = () => signal.removeEventListener('abort', onAbort)
      const finishResolve = (value: Response) => {
        if (settled) {
          cancelResponseBody(value)
          return
        }
        settled = true
        cleanup()
        resolve(value)
      }
      const finishReject = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const onAbort = () => finishReject(abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        Promise.resolve(fetchImpl(input, { ...init, signal })).then(finishResolve, finishReject)
      } catch (error) {
        finishReject(error)
      }
    })
  }) as FetchImpl

const hashIdentity = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase()

const getStableString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const buildCacheKey = async (
  baseUrl: string,
  apiKey: string,
  attachment: ChatAttachment,
  accountIdentifier?: string
): Promise<ProviderFileIdCacheKey> => {
  const stableAccountIdentifier = getStableString(accountIdentifier)
  const accountFingerprint = stableAccountIdentifier
    ? `id:${stableAccountIdentifier}`
    : `key-sha256:${await hashIdentity(apiKey)}`
  // Request bytes, not caller-supplied media IDs, hashes or paths, own cache identity.
  // Managed originals must already have been resolved by the guarded main-process flow.
  return {
    provider: 'openai',
    accountIdentity: `${normalizeBaseUrl(baseUrl)}:${accountFingerprint}`,
    contentIdentity: `source-sha256:${await hashIdentity(attachment.url.trim())}`
  }
}

const FILE_SEARCH_SUPPORTED_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'csv',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'markdown',
  'pdf',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svg',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml'
])

const FILE_SEARCH_SUPPORTED_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml'
])

export type OpenAIFileSearchSession = {
  cleanup: () => Promise<void>
  vectorStoreIds: string[]
}

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(typeof signal?.reason === 'string' ? signal.reason : 'The request was aborted.')
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)

    const handleAbort = () => {
      clearTimeout(timeoutId)
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(
              typeof signal?.reason === 'string' ? signal.reason : 'The request was aborted.'
            )
      )
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

const normalizeMimeType = (value?: string): string =>
  String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

const inferFileNameFromUrl = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('data:')) {
    return ''
  }

  try {
    const url = new URL(trimmed)
    return decodeURIComponent(url.pathname.split('/').pop() || '')
  } catch {
    return decodeURIComponent(trimmed.split(/[\\/]/).pop() || '')
  }
}

const inferAttachmentFileName = (attachment: ChatAttachment, index: number): string =>
  attachment.fileName?.trim() ||
  attachment.relativePath?.trim() ||
  inferFileNameFromUrl(attachment.url) ||
  `attachment-${index + 1}.txt`

const inferAttachmentExtension = (attachment: ChatAttachment, index: number): string => {
  const fileName = inferAttachmentFileName(attachment, index)
  const lastDot = fileName.lastIndexOf('.')
  return lastDot >= 0 && lastDot < fileName.length - 1
    ? fileName.slice(lastDot + 1).toLowerCase()
    : ''
}

export const isOpenAIFileSearchAttachment = (attachment: ChatAttachment, index = 0): boolean => {
  if (attachment.type !== 'file') {
    return false
  }

  const mimeType = normalizeMimeType(attachment.mimeType)
  if (mimeType.startsWith('text/') || FILE_SEARCH_SUPPORTED_MIME_TYPES.has(mimeType)) {
    return true
  }

  const extension = inferAttachmentExtension(attachment, index)
  return FILE_SEARCH_SUPPORTED_EXTENSIONS.has(extension)
}

const inspectFileDataUrl = (value: string): { mimeType: string; base64: string } | null => {
  const match = /^data:([^;,]+)?;base64,([a-z0-9+/]*={0,2})$/i.exec(value.trim())
  if (!match || match[2].length % 4 !== 0) return null
  const base64 = match[2]
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const decodedBytes = (base64.length / 4) * 3 - padding
  if (decodedBytes > FILE_SEARCH_MAX_ATTACHMENT_BYTES) {
    throw new Error('OpenAI file search attachment exceeds the 50 MiB limit.')
  }
  return { mimeType: normalizeMimeType(match[1]) || 'application/octet-stream', base64 }
}

const dataUrlToBlob = (value: string): Blob | null => {
  const inspected = inspectFileDataUrl(value)
  if (!inspected) return null
  const bytes = Buffer.from(inspected.base64, 'base64')
  if (bytes.toString('base64') !== inspected.base64) {
    throw new Error('OpenAI file search attachment has invalid base64 content.')
  }
  return new Blob([Uint8Array.from(bytes)], { type: inspected.mimeType })
}

const assertSupportedFileSearchSources = (attachments: ChatAttachment[]): void => {
  for (const attachment of attachments) {
    if (inspectFileDataUrl(attachment.url)) continue
    throw new Error(
      'OpenAI file search requires materialized base64 data URLs; local-media, remote and file URLs must be resolved by a guarded main-process flow first.'
    )
  }
}

const loadAttachmentBlob = (
  attachment: ChatAttachment,
  index: number,
  signal?: AbortSignal
): { blob: Blob; fileName: string } => {
  if (signal?.aborted) throw abortReason(signal)
  const blob = dataUrlToBlob(attachment.url)
  if (!blob) throw new Error('OpenAI file search requires materialized base64 data URLs.')
  return { blob, fileName: inferAttachmentFileName(attachment, index) }
}

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey.trim()
    ? {
        Authorization: `Bearer ${apiKey}`
      }
    : {}

const jsonHeaders = (apiKey: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...authHeaders(apiKey)
})

const safeText = async (response: Response, signal?: AbortSignal): Promise<string> => {
  try {
    if (!response.body && typeof response.text === 'function') {
      return await awaitWithAbort(response.text(), signal, () => cancelResponseBody(response))
    }
    return await readResponseTextWithinLimit(response, 64 * 1024, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    return ''
  }
}

const uploadFile = async (
  apiKey: string,
  baseUrl: string,
  attachment: ChatAttachment,
  index: number,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl
): Promise<string> => {
  const { blob, fileName } = loadAttachmentBlob(attachment, index, signal)
  const formData = new FormData()
  formData.append('purpose', 'assistants')
  formData.append('file', blob, fileName)

  const response = await fetchImpl(`${baseUrl}/files`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: formData,
    signal
  })

  if (!response.ok) {
    throw new Error(
      `OpenAI file upload failed for ${fileName}: ${response.status} ${response.statusText} ${await safeText(
        response,
        signal
      )}`
    )
  }

  const payload = await readResponseJsonWithinLimit<{ id?: string }>(response, signal)
  if (!payload.id) {
    throw new Error(`OpenAI file upload returned no file id for ${fileName}.`)
  }

  return payload.id
}

const createVectorStore = async (
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl
): Promise<string> => {
  const response = await fetchImpl(`${baseUrl}/vector_stores`, {
    method: 'POST',
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      name: `magicpot-file-search-${Date.now()}`
    }),
    signal
  })

  if (!response.ok) {
    throw new Error(
      `OpenAI vector store creation failed: ${response.status} ${response.statusText} ${await safeText(
        response,
        signal
      )}`
    )
  }

  const payload = await readResponseJsonWithinLimit<{ id?: string }>(response, signal)
  if (!payload.id) {
    throw new Error('OpenAI vector store creation returned no id.')
  }

  return payload.id
}

class OpenAIFileAttachError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const addFileToVectorStore = async (
  apiKey: string,
  baseUrl: string,
  vectorStoreId: string,
  fileId: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl
): Promise<void> => {
  const response = await fetchImpl(
    `${baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}/files`,
    {
      method: 'POST',
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({
        file_id: fileId
      }),
      signal
    }
  )

  if (!response.ok) {
    throw new OpenAIFileAttachError(
      `OpenAI vector store file attach failed: ${response.status} ${response.statusText} ${await safeText(
        response,
        signal
      )}`,
      response.status
    )
  }
  cancelResponseBody(response)
}

const waitForVectorStoreFiles = async (
  apiKey: string,
  baseUrl: string,
  vectorStoreId: string,
  fileIds: string[],
  signal?: AbortSignal,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl
): Promise<void> => {
  const deadline = Date.now() + FILE_SEARCH_READY_TIMEOUT_MS
  const expectedIds = new Set(fileIds)
  type FileRecord = { id?: string; last_error?: { message?: string }; status?: string }

  while (Date.now() < deadline) {
    const relevantRecords = new Map<string, FileRecord>()
    const cursors = new Set<string>()
    let after = ''
    do {
      const response = await fetchImpl(
        `${baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}/files${
          after ? `?after=${encodeURIComponent(after)}` : ''
        }`,
        { method: 'GET', headers: authHeaders(apiKey), signal }
      )
      if (!response.ok) {
        throw new Error(
          `OpenAI vector store polling failed: ${response.status} ${response.statusText} ${await safeText(
            response,
            signal
          )}`
        )
      }
      const payload = await readResponseJsonWithinLimit<{
        data?: FileRecord[]
        has_more?: boolean
        last_id?: string
      }>(response, signal)
      for (const record of Array.isArray(payload.data) ? payload.data : []) {
        if (!record?.id || !expectedIds.has(record.id)) continue
        if (
          ['cancelled', 'expired', 'failed'].includes(
            String(record.status || '')
              .trim()
              .toLowerCase()
          )
        ) {
          throw new Error(
            record.last_error?.message ||
              `OpenAI file search indexing failed with status "${record.status || 'unknown'}".`
          )
        }
        relevantRecords.set(record.id, record)
      }
      after = ''
      if (payload.has_more) {
        if (
          typeof payload.last_id !== 'string' ||
          !payload.last_id ||
          cursors.has(payload.last_id)
        ) {
          throw new Error('OpenAI vector store polling returned an invalid pagination cursor.')
        }
        after = payload.last_id
        cursors.add(after)
      }
    } while (after)

    if (
      relevantRecords.size === expectedIds.size &&
      [...relevantRecords.values()].every(
        (record) =>
          String(record.status || '')
            .trim()
            .toLowerCase() === 'completed'
      )
    )
      return
    await sleep(FILE_SEARCH_POLL_INTERVAL_MS, signal)
  }

  throw new Error('OpenAI file search indexing timed out before the files became ready.')
}

const safeDelete = async (
  apiKey: string,
  url: string,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl
): Promise<void> => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    const error = new Error('OpenAI file search cleanup timed out.')
    error.name = 'TimeoutError'
    controller.abort(error)
  }, FILE_SEARCH_CLEANUP_TIMEOUT_MS)

  try {
    const response = await createBoundedFetch(fetchImpl, controller.signal)(url, {
      method: 'DELETE',
      headers: authHeaders(apiKey)
    })
    cancelResponseBody(response)
  } catch {
    // Best-effort cleanup only; never delay the original result forever.
  } finally {
    clearTimeout(timeoutId)
  }
}

type SharedUploadLease = {
  references: number
  cacheKeys: Map<string, ProviderFileIdCacheKey>
  deleteOwned?: () => Promise<void>
}

// Cache entries are only lookup hints. Leases must survive eviction/replacement so
// an owner cannot delete an upload while another live session is still using it.
const uploadLeases = new WeakMap<ProviderFileIdCache, Map<string, SharedUploadLease>>()

const retainUploadedFile = (
  cache: ProviderFileIdCache,
  cacheKey: ProviderFileIdCacheKey,
  fileId: string,
  deleteOwned?: () => Promise<void>
): (() => Promise<void>) => {
  let leases = uploadLeases.get(cache)
  if (!leases) {
    leases = new Map()
    uploadLeases.set(cache, leases)
  }
  const identity = JSON.stringify([cacheKey.provider, cacheKey.accountIdentity, fileId])
  let lease = leases.get(identity)
  if (!lease) {
    lease = { references: 0, cacheKeys: new Map(), deleteOwned }
    leases.set(identity, lease)
  } else if (deleteOwned && !lease.deleteOwned) {
    lease.deleteOwned = deleteOwned
  }
  lease.cacheKeys.set(JSON.stringify(cacheKey), cacheKey)
  lease.references += 1
  let released = false
  return async () => {
    if (released) return
    released = true
    if (--lease.references > 0) return
    leases.delete(identity)
    if (!lease.deleteOwned) return // A pre-existing external cache entry is not ours to delete.
    for (const key of lease.cacheKeys.values()) {
      if (cache.get(key)?.fileId === fileId) cache.invalidate(key)
    }
    await lease.deleteOwned()
  }
}

export function collectOpenAIFileSearchAttachments(messages: ChatMessage[]): ChatAttachment[] {
  const attachments: ChatAttachment[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }

    for (const attachment of message.attachments || []) {
      const nextIndex = attachments.length
      if (!isOpenAIFileSearchAttachment(attachment, nextIndex)) {
        continue
      }

      const key = `${attachment.type}:${attachment.fileName || attachment.relativePath || ''}:${attachment.url}`
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      attachments.push(attachment)
    }
  }

  return attachments
}

export function buildOpenAIFileSearchTool(vectorStoreIds: string[]): Record<string, unknown> {
  return {
    type: 'file_search',
    vector_store_ids: vectorStoreIds
  }
}

export async function createOpenAIFileSearchSession(options: {
  apiKey: string
  baseUrl: string
  accountIdentifier?: string
  fileIdCache?: ProviderFileIdCache
  messages: ChatMessage[]
  signal?: AbortSignal
  fetchImpl?: FetchImpl
}): Promise<OpenAIFileSearchSession | null> {
  const attachments = collectOpenAIFileSearchAttachments(options.messages)
  const fileIdCache = options.fileIdCache ?? providerFileIdCache
  if (!attachments.length) {
    return null
  }
  if (options.signal?.aborted) {
    throw abortReason(options.signal)
  }
  assertSupportedFileSearchSources(attachments)

  const boundedOperation = createBoundedOperationSignal(
    options.signal,
    FILE_SEARCH_READY_TIMEOUT_MS
  )
  const operationSignal = boundedOperation.signal
  const baseFetch = options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchImpl)
  const operationFetch = createBoundedFetch(baseFetch, operationSignal)
  const files: Array<{
    cacheKey: ProviderFileIdCacheKey
    fileId: string
    release: () => Promise<void>
  }> = []
  const seenContentKeys = new Set<string>()
  let vectorStoreId = ''
  let cleanupPromise: Promise<void> | undefined

  const cleanupSessionResources = (): Promise<void> => {
    if (!cleanupPromise) {
      const cleanupTasks = files.map((file) => file.release())
      if (vectorStoreId) {
        cleanupTasks.push(
          safeDelete(
            options.apiKey,
            `${options.baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}`,
            baseFetch
          )
        )
      }
      cleanupPromise = Promise.allSettled(cleanupTasks).then(() => undefined)
    }
    return cleanupPromise
  }

  try {
    for (const [index, attachment] of attachments.entries()) {
      const cacheKey = await awaitWithAbort(
        buildCacheKey(options.baseUrl, options.apiKey, attachment, options.accountIdentifier),
        operationSignal
      )
      const contentKey = JSON.stringify(cacheKey)
      if (seenContentKeys.has(contentKey)) continue
      seenContentKeys.add(contentKey)
      const cached = fileIdCache.get(cacheKey)
      if (cached) {
        files.push({
          cacheKey,
          fileId: cached.fileId,
          release: retainUploadedFile(fileIdCache, cacheKey, cached.fileId)
        })
        continue
      }

      const fileId = await uploadFile(
        options.apiKey,
        options.baseUrl,
        attachment,
        index,
        operationSignal,
        operationFetch
      )
      fileIdCache.set(cacheKey, { fileId })
      files.push({
        cacheKey,
        fileId,
        release: retainUploadedFile(fileIdCache, cacheKey, fileId, () =>
          safeDelete(
            options.apiKey,
            `${options.baseUrl}/files/${encodeURIComponent(fileId)}`,
            baseFetch
          )
        )
      })
    }

    vectorStoreId = await createVectorStore(
      options.apiKey,
      options.baseUrl,
      operationSignal,
      operationFetch
    )
    const uniqueFiles = [...new Map(files.map((file) => [file.fileId, file])).values()]
    for (const file of uniqueFiles) {
      try {
        await addFileToVectorStore(
          options.apiKey,
          options.baseUrl,
          vectorStoreId,
          file.fileId,
          operationSignal,
          operationFetch
        )
      } catch (error) {
        if (
          error instanceof OpenAIFileAttachError &&
          [400, 404].includes(error.status) &&
          fileIdCache.get(file.cacheKey)?.fileId === file.fileId
        ) {
          fileIdCache.invalidate(file.cacheKey)
        }
        throw error
      }
    }

    await waitForVectorStoreFiles(
      options.apiKey,
      options.baseUrl,
      vectorStoreId,
      uniqueFiles.map((file) => file.fileId),
      operationSignal,
      operationFetch
    )

    boundedOperation.cleanup()
    return {
      vectorStoreIds: [vectorStoreId],
      cleanup: cleanupSessionResources
    }
  } catch (error) {
    boundedOperation.cleanup()
    await cleanupSessionResources()

    throw error
  }
}
