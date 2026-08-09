import type { AgentTransport } from './client.js'
import type { JsonValue } from './contracts.js'

export class MemoryAgentTransport implements AgentTransport {
  readonly requests: Array<{ method: string; payload: JsonValue }> = []

  constructor(
    private readonly handler: (method: string, payload: JsonValue) => JsonValue | Promise<JsonValue>
  ) {}

  async request(method: string, payload: JsonValue): Promise<JsonValue> {
    this.requests.push({ method, payload })
    return this.handler(method, payload)
  }
}
