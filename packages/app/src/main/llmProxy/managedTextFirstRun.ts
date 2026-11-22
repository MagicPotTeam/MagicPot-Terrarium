import { createHmac, randomBytes } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { Config } from '@shared/config/config'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import { buildOpenAIChatCompletionsBody } from '@shared/llm/clients'
import { OPENAI_CHAT_DEADLINE_MS } from '@shared/llm/openaiRequestControl'
import type { ProviderRawWorkRetainer } from '@shared/llm/providerRawWork'
import { captureManagedData, managedCanonical, managedOwnValues } from '../magicAgentPlatform2/agents/managedRuntimeSnapshot'

const planBrand: unique symbol = Symbol('managed-text-first-run-plan')
type Plan = Readonly<{ [planBrand]: true }>
type TextMessage = Readonly<{ role: 'system' | 'user'; content: string }>
export type ManagedTextFirstRunMaterial = Readonly<{
  protocol: 'managed-text-first-run/v1'
  transport: Readonly<{ protocol: 'electron-client-request-final-close/v1' }>
  profileId: string
  route: NonNullable<LLMChatReq['route']>
  endpoint: string
  credentialBinding: string
  requestTimeoutMs: number
  modelAttempts: 1
  tools: readonly []
  history: 'none'
  body: Readonly<{ model: string; messages: readonly TextMessage[]; temperature: number; stream: false; max_tokens: number }>
}>
/** Preparation is data/routing, NOT an approval, owner association or clean witness. */
export type PreparedManagedTextFirstRun = Readonly<{ plan: Plan; material: ManagedTextFirstRunMaterial }>
export type ManagedTextFirstRunContext = Readonly<{ assertCurrent: () => void; retainRawWork: ProviderRawWorkRetainer }>
export type ManagedTextFirstRunOptions = Readonly<{ signal?: AbortSignal; runId: string }>
export type ManagedTextFirstRunExecution = Readonly<{
  request: LLMChatReq
  apiKey: string
  material: ManagedTextFirstRunMaterial
  wireBody: string
}>
type Invoker = (execution: ManagedTextFirstRunExecution, options: ManagedTextFirstRunOptions, context: ManagedTextFirstRunContext) => Promise<LLMChatResp>
const services = new WeakMap<object, Invoker>()
const plans = new WeakMap<object, { service: object; execution: ManagedTextFirstRunExecution; used: boolean }>()
// A per-process keyed binding, not a public dictionary hash of an API key. Reopen
// never reconstructs a runnable plan and does not need this key to match again.
const credentialBindingKey = randomBytes(32)
export function registerManagedTextFirstRunService(service: object, invoke: Invoker): void {
  if (services.has(service)) throw Error('Prepared text service already registered.')
  services.set(service, invoke)
}
function reject(detail: string): never { throw Error(`Unsupported prepared managed text input: ${detail}.`) }
const exactFields = (value: object, keys: readonly string[]): void => {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) reject('fields')
}
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

/** MAIN-only, effect-free preparation for one no-history user message. No config
 * provider, registry, file read, slash helper or model client is consulted here. */
export function prepareManagedTextFirstRun(service: object, input: LLMChatReq, inputConfig: Config): PreparedManagedTextFirstRun {
  if (!services.has(service)) reject('exact registered service required')
  const request = captureManagedData(input), config = captureManagedData(inputConfig)
  exactFields(request, ['messages', 'profileId', 'systemPrompt', 'maxOutputTokens', 'temperature', 'route'])
  if (config.use_remote_llm !== false) reject('local routing required')
  if (!Array.isArray(request.messages) || request.messages.length !== 1) reject('one new user message required')
  const message = request.messages[0]
  if (!message || message.role !== 'user' || typeof message.content !== 'string' || !message.content.trim() || /^\s*\/[a-z]/iu.test(message.content)) reject('plain text, no slash helpers or history')
  exactFields(message, ['role', 'content'])
  if (request.systemPrompt !== undefined && typeof request.systemPrompt !== 'string') reject('system prompt')
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens! < 1 || request.maxOutputTokens! > 4096) reject('bounded output required')
  if (!boundedString(request.profileId, 200)) reject('exact profile required')
  const route = request.route
  if (!route || typeof route !== 'object') reject('exact route required')
  exactFields(route, ['channel', 'scopeType', 'scopeId', 'threadId', 'senderId', 'senderName'])
  if (!boundedString(route.channel, 64) || !['dm', 'thread'].includes(route.scopeType) || !boundedString(route.scopeId, 256) ||
      (['threadId', 'senderId', 'senderName'] as const).some(key => route[key] !== undefined && !boundedString(route[key], 256))) reject('canonical current-thread route required')
  const selected = config.llm_config?.api_profiles?.filter(profile => profile.id === request.profileId)
  if (selected?.length !== 1) reject('unique selected profile required')
  const profile = selected[0]
  exactFields(profile, ['id', 'model_name', 'base_url', 'api_key', 'provider', 'call_type', 'deployment', 'model_use', 'api_mode', 'request_timeout_ms'])
  if (profile.provider !== 'openai' || !['api', 'local'].includes(profile.call_type ?? '') || !['chat', 'agent'].includes(profile.model_use ?? '') ||
      !['local', 'cloud'].includes(profile.deployment ?? '') || profile.api_mode !== 'chat-completions' || !boundedString(profile.model_name, 200) ||
      typeof profile.api_key !== 'string' || profile.api_key.length > 8192 || Array.from(profile.api_key).some(char => [0, 10, 13].includes(char.charCodeAt(0))) || !boundedString(profile.base_url, 2048)) reject('builtin text profile required')
  let endpoint: URL
  try { endpoint = new URL(profile.base_url) } catch { reject('endpoint') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.href !== profile.base_url ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*chat\/completions$/u.test(endpoint.pathname) || profile.deployment === 'cloud' && (endpoint.protocol !== 'https:' || !profile.api_key.trim())) reject('explicit text endpoint required')
  const temperature = request.temperature ?? 0.7
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) reject('temperature')
  const requestTimeoutMs = profile.request_timeout_ms ?? OPENAI_CHAT_DEADLINE_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > OPENAI_CHAT_DEADLINE_MS) reject('request duration')
  const messages: TextMessage[] = [
    ...(request.systemPrompt ? [{ role: 'system' as const, content: request.systemPrompt }] : []),
    { role: 'user', content: message.content }
  ]
  const body = captureManagedData(buildOpenAIChatCompletionsBody(profile.model_name, messages, { temperature, maxOutputTokens: request.maxOutputTokens })) as ManagedTextFirstRunMaterial['body']
  const wireBody = JSON.stringify(body)
  if (Buffer.byteLength(wireBody, 'utf8') > 64 * 1024) reject('request byte budget')
  const material: ManagedTextFirstRunMaterial = captureManagedData({
    protocol: 'managed-text-first-run/v1', profileId: request.profileId, route, endpoint: endpoint.href,
    transport: { protocol: 'electron-client-request-final-close/v1' },
    credentialBinding: createHmac('sha256', credentialBindingKey).update(managedCanonical(profile)).digest('hex'),
    requestTimeoutMs, modelAttempts: 1, tools: [], history: 'none', body
  })
  const execution: ManagedTextFirstRunExecution = Object.freeze({ request: captureManagedData({ ...request, temperature }), apiKey: profile.api_key, material, wireBody })
  const plan = Object.freeze({}) as Plan
  plans.set(plan, { service, execution, used: false })
  return Object.freeze({ plan, material })
}

/** Private route selection plus a burned one-shot slot. This does NOT authenticate
 * production policy/owner authority; the actual executor must supply that check.
 * No service method accepting wire JSON calls this function. */
export async function invokePreparedManagedTextFirstRun(service: object, plan: Plan, inputOptions: ManagedTextFirstRunOptions, inputContext: ManagedTextFirstRunContext): Promise<LLMChatResp> {
  const record = plans.get(plan), invoke = services.get(service)
  if (!record || record.service !== service || !invoke || record.used) throw Error('Exact unused prepared text plan required.')
  const options = managedOwnValues(inputOptions), context = managedOwnValues(inputContext)
  exactFields(options, ['signal', 'runId']); exactFields(context, ['assertCurrent', 'retainRawWork'])
  if (!boundedString(options.runId, 200) || options.signal !== undefined && (isProxy(options.signal) || !(options.signal instanceof AbortSignal)) ||
      typeof context.assertCurrent !== 'function' || typeof context.retainRawWork !== 'function') reject('private execution context')
  // Burn before any revocation check/callout. A failure never restores eligibility.
  record.used = true
  const ownedContext = context as ManagedTextFirstRunContext
  ownedContext.assertCurrent(); (options.signal as AbortSignal | undefined)?.throwIfAborted()
  return invoke(record.execution, options as ManagedTextFirstRunOptions, ownedContext)
}
