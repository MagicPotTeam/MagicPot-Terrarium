import Ajv from 'ajv'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentRouteLike } from '@shared/agent'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'

export type TeamMessageSource = Readonly<{ scope: string; thread: string; lead: string; member: string }>
export type TeamMessageIntent = Readonly<{ source: TeamMessageSource; kind: 'message' | 'channel'; hop: 1 | 2; recipient?: string; text: string }>
const MAX_CALLS = 8
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } as const
const text = { type: 'string', minLength: 1, maxLength: 4000 } as const
const definitions = [
  { name: 'send_message', description: 'Queue a message to one member ID; queued is not received or processed.', inputSchema: { type: 'object', additionalProperties: false, required: ['recipient', 'text'], properties: { recipient: id, text } } },
  { name: 'send_channel', description: 'Queue a channel message for host-resolved recipients; queued is not received or processed.', inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text } } }
] as const
const ajv = new Ajv({ strict: true, ownProperties: true })
const validators = definitions.map(definition => ajv.compile(definition.inputSchema))
const validPart = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !Array.from(value).some(c => c.charCodeAt(0) < 32)

/** Request-scoped enqueue adapter. Source is a controlled-renderer
 * functional binding, not authenticated identity. Host owns membership, channel
 * resolution, actual queue and approval; this never starts a model or grants tools. */
export function createAgentTeamMessageTools(options: {
  source: TeamMessageSource
  /** Assigned by the host request, never accepted from model tool arguments. */
  outgoingHop: 1 | 2
  route: AgentRouteLike
  lease: { assertLive(): void }
  assertInvocation(name: string): void
  assertNotEnded(source: TeamMessageSource): void
  enqueue(intent: TeamMessageIntent, signal?: AbortSignal): Promise<{ requestId: string }>
}): AssistantRunToolProvider {
  const source = Object.freeze({ ...options.source })
  if (![source.scope, source.thread, source.lead, source.member].every(validPart) || source.member === source.lead || (options.outgoingHop !== 1 && options.outgoingHop !== 2)) throw Error('Invalid team source or message hop.')
  const routeKey = getAgentSessionKey(normalizeAgentRoute(options.route))
  let calls = 0, busy = false
  return {
    listTools: () => definitions.map(definition => structuredClone(definition)),
    async callTool(name, args, context) {
      context.signal?.throwIfAborted(); options.lease.assertLive(); options.assertInvocation(name)
      if (getAgentSessionKey(normalizeAgentRoute(context.route)) !== routeKey) throw Error('Tool is outside this Agent conversation.')
      const index = definitions.findIndex(definition => definition.name === name)
      if (index < 0 || !validators[index](args) || typeof args.text !== 'string' || !args.text.trim()) throw Error('Invalid team message arguments.')
      const recipient = index === 0 && 'recipient' in args ? args.recipient : undefined
      if (index === 0 && (typeof recipient !== 'string' || recipient === source.member)) throw Error('Invalid recipient.')
      if (busy || calls >= MAX_CALLS) throw Error('Team message request limit reached.')
      options.assertNotEnded(source)
      context.signal?.throwIfAborted(); options.lease.assertLive(); options.assertInvocation(name)
      busy = true; calls++
      try {
        const result = await options.enqueue({ source, kind: index === 0 ? 'message' : 'channel', hop: options.outgoingHop, ...(typeof recipient === 'string' ? { recipient } : {}), text: args.text }, context.signal)
        if (!result || !validPart(result.requestId) || result.requestId.length > 128) throw Error('Invalid queue result.')
        return { content: JSON.stringify({ status: 'queued', requestId: result.requestId }) }
      } finally { busy = false }
    }
  }
}
