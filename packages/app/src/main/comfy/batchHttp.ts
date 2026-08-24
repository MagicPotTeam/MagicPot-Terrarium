import type { ComfyHistoryResp, FileItem, ObjectInfoMap, Workflow } from '@shared/comfy/types'

const DEFAULT_TIMEOUT_MS = 30_000
export const COMFY_BATCH_MAX_NETWORK_ATTEMPTS = 4

export class ComfyBatchHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ComfyBatchHttpError'
  }
}

export function normalizeComfyBatchBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new Error('Invalid ComfyUI URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid ComfyUI URL')
  }
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export async function withNetworkRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, Math.min(COMFY_BATCH_MAX_NETWORK_ATTEMPTS, options.attempts ?? 4))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const retryable =
        error instanceof ComfyBatchHttpError ? error.retryable : error instanceof TypeError
      if (!retryable || attempt === attempts) throw error
      const delayMs = options.delayMs ?? 150
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
      }
    }
  }
  throw lastError
}

type FetchLike = typeof fetch

type RequestOptions = {
  retry?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400
}

function requireSafeResponse(response: Response): void {
  if (isRedirectStatus(response.status)) {
    throw new ComfyBatchHttpError('ComfyUI redirects are not allowed', false, response.status)
  }
}

export class ComfyBatchHttpClient {
  readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.baseUrl = normalizeComfyBatchBaseUrl(baseUrl)
  }

  private url(pathname: string): URL {
    return new URL(pathname.replace(/^\/+/, ''), this.baseUrl)
  }

  private async consume<T>(
    pathname: string,
    init: RequestInit,
    options: RequestOptions,
    read: (response: Response) => Promise<T>
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const relayAbort = (): void => controller.abort()
      options.signal?.addEventListener('abort', relayAbort, { once: true })
      try {
        const response = await this.fetchImpl(this.url(pathname), {
          ...init,
          signal: controller.signal,
          redirect: 'manual'
        })
        requireSafeResponse(response)
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 1000)
          throw new ComfyBatchHttpError(
            `ComfyUI HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
            isRetryableStatus(response.status),
            response.status
          )
        }
        return await read(response)
      } catch (error) {
        if (error instanceof ComfyBatchHttpError) throw error
        if (options.signal?.aborted) throw new Error('Batch cancelled')
        throw new ComfyBatchHttpError(error instanceof Error ? error.message : String(error), true)
      } finally {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', relayAbort)
      }
    }
    return options.retry === false ? execute() : withNetworkRetry(execute)
  }

  private json<T>(pathname: string, init: RequestInit = {}, options: RequestOptions = {}) {
    return this.consume(pathname, init, options, async (response) => (await response.json()) as T)
  }

  async probe(): Promise<{ endpoint: 'system_stats' | 'queue'; latencyMs: number }> {
    const startedAt = Date.now()
    try {
      await this.json('/system_stats', {}, { retry: false, timeoutMs: 8_000 })
      return { endpoint: 'system_stats', latencyMs: Date.now() - startedAt }
    } catch {
      await this.json('/queue', {}, { retry: false, timeoutMs: 8_000 })
      return { endpoint: 'queue', latencyMs: Date.now() - startedAt }
    }
  }

  objectInfo(signal?: AbortSignal): Promise<ObjectInfoMap> {
    return this.json('/object_info', {}, { signal })
  }

  async uploadImage(filename: string, image: Uint8Array, signal?: AbortSignal): Promise<FileItem> {
    const formData = new FormData()
    formData.append('image', new Blob([image as BlobPart]), filename)
    formData.append('type', 'input')
    formData.append('overwrite', 'true')
    const response = await this.json<{
      name?: string
      filename?: string
      subfolder?: string
      type?: string
    }>('/upload/image', { method: 'POST', body: formData }, { signal, retry: false })
    const uploadedFilename = response.name ?? response.filename
    if (!uploadedFilename) throw new Error('ComfyUI upload response has no filename')
    return {
      filename: uploadedFilename,
      subfolder: response.subfolder,
      type: response.type || 'input'
    }
  }

  async prompt(
    workflow: Workflow,
    clientId: string,
    promptId: string,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await this.json<{ prompt_id?: string }>(
      '/prompt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId, prompt_id: promptId })
      },
      { signal, retry: false }
    )
    if (!response.prompt_id) throw new Error('ComfyUI prompt response has no prompt_id')
    return response.prompt_id
  }

  history(promptId: string, signal?: AbortSignal): Promise<ComfyHistoryResp> {
    return this.json(`/history/${encodeURIComponent(promptId)}`, {}, { signal })
  }

  async view(file: FileItem, signal?: AbortSignal): Promise<Uint8Array> {
    const query = new URLSearchParams({
      filename: file.filename || '',
      subfolder: file.subfolder || '',
      type: file.type || ''
    })
    return this.consume(`/view?${query.toString()}`, {}, { signal }, async (response) => {
      const contentType = String(response.headers.get('content-type') || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase()
      if (
        contentType &&
        contentType !== 'image/png' &&
        contentType !== 'application/octet-stream'
      ) {
        throw new Error(`ComfyUI output must be PNG, got ${contentType}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    })
  }

  async promptAdmission(promptId: string, signal?: AbortSignal): Promise<boolean> {
    const history = await this.history(promptId, signal)
    if (history[promptId]) return true
    const queue = await this.json<{
      queue_running?: unknown[][]
      queue_pending?: unknown[][]
    }>('/queue', {}, { signal })
    return [...(queue.queue_running || []), ...(queue.queue_pending || [])].some(
      (item) => item[1] === promptId
    )
  }

  async waitForPromptAdmission(
    promptId: string,
    signal?: AbortSignal,
    timeoutMs = 5_000
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (!signal?.aborted && Date.now() < deadline) {
      try {
        if (await this.promptAdmission(promptId, signal)) return true
      } catch {
        // Retry admission lookup until the short ambiguity window expires.
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (signal?.aborted) throw new Error('Batch cancelled')
    return false
  }

  async cancelPrompt(promptId: string): Promise<void> {
    await this.json(
      '/queue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] })
      },
      { retry: false }
    )
    await this.json(
      '/interrupt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: promptId })
      },
      { retry: false }
    )
  }
}
