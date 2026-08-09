import type { AgentTransport } from './client.js'
import type { JsonValue } from './contracts.js'

export interface HttpAgentTransportOptions {
  baseUrl: string
  token?: string
  fetch?: typeof globalThis.fetch
  headers?: Readonly<Record<string, string>>
}

export class HttpAgentTransport implements AgentTransport {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(private readonly options: HttpAgentTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (!this.fetchImpl) throw new Error('A Fetch API implementation is required.')
  }

  async request(method: string, payload: JsonValue): Promise<JsonValue> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/sdk/${encodeURIComponent(method)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        ...this.options.headers
      },
      body: JSON.stringify(payload)
    })
    const value = (await response.json()) as JsonValue
    if (!response.ok) {
      const message =
        typeof value === 'object' && value !== null && !Array.isArray(value) && 'message' in value
          ? String(value.message)
          : `MagicAgent request failed with HTTP ${response.status}.`
      throw new Error(message)
    }
    return value
  }

  async *stream(
    method: string,
    payload: JsonValue,
    signal?: AbortSignal
  ): AsyncIterable<JsonValue> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/sdk/${encodeURIComponent(method)}`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        ...this.options.headers
      },
      body: JSON.stringify(payload)
    })
    if (!response.ok)
      throw new Error(
        (await response.text()) || `MagicAgent request failed with HTTP ${response.status}.`
      )
    if (!response.body) throw new Error('MagicAgent stream response has no body.')
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    const abortReader = (): void => {
      void reader.cancel(signal?.reason).catch(() => undefined)
    }
    signal?.addEventListener('abort', abortReader, { once: true })
    let pending = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        pending += value
        for (;;) {
          const index = pending.indexOf('\n')
          if (index < 0) break
          const line = pending.slice(0, index).trim()
          pending = pending.slice(index + 1)
          if (line) yield JSON.parse(line) as JsonValue
        }
      }
      if (pending.trim()) yield JSON.parse(pending) as JsonValue
    } finally {
      signal?.removeEventListener('abort', abortReader)
      await reader.cancel().catch(() => undefined)
    }
  }
}
