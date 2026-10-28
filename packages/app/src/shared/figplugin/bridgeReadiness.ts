import { z } from 'zod'
import { FigPluginDesktopBridgeOriginSchema } from './manifest'
import { HOST_COMMANDS, HOST_EXECUTION_ROLLBACKS, HOST_VISUAL_AUDITS } from './hostPlan'

// The anonymous probe is reachability-only. It carries no credentials or document data and
// never probes a Provider; authenticated readiness diagnostics are defined separately below.
export const FIGPLUGIN_BRIDGE_PROBE_TIMEOUT_MS = 5_000
export const FIGPLUGIN_BRIDGE_PROBE_PATH = '/figplugin/v1/probe'
/** Authenticated diagnostics are deliberately separate from the anonymous echo probe. */
export const FIGPLUGIN_BRIDGE_READINESS_PATH = '/figplugin/v1/readiness'
const nonceSchema = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]+$/)
export const figPluginBridgeProbeRequestSchema = z
  .object({ protocol: z.literal(1), nonce: nonceSchema })
  .strict()
export const figPluginBridgeProbeResponseSchema = z
  .object({
    protocol: z.literal(1),
    kind: z.literal('figplugin-bridge-probe'),
    nonce: nonceSchema
  })
  .strict()
const readinessStateSchema = z.enum(['ready', 'not-ready', 'unknown'])
const readinessCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)
const readinessCheckSchema = z
  .object({ state: readinessStateSchema, code: readinessCodeSchema })
  .strict()
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const providerCircuitStateSchema = z.enum(['closed', 'open', 'half-open'])
const providerOutcomeSchema = z.enum(['success', 'failure', 'unknown'])
const providerFailureClassSchema = z.enum([
  'upstream',
  'timeout',
  'cancelled',
  'configuration',
  'unknown'
])
/** Safe operational metadata; never includes provider payloads, credentials or raw errors. */
const providerDiagnosticsSchema = z
  .object({
    circuitState: providerCircuitStateSchema,
    failureCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    retryAt: safeInteger.optional(),
    probeInFlight: z.boolean(),
    lastOutcome: providerOutcomeSchema.optional(),
    lastOutcomeAt: safeInteger.optional(),
    lastLatencyMs: z.number().int().min(0).max(90_000).optional(),
    lastFailureClass: providerFailureClassSchema.optional(),
    lastCorrelationId: nonceSchema.optional(),
    observedAt: safeInteger.optional(),
    observedCorrelationId: nonceSchema.optional()
  })
  .strict()

/**
 * Read-only observations supplied by a paired native host. These values are
 * diagnostics only: the bridge never treats them as proof of write authority.
 * The full HostContext/HostPlan contract is still required before execution.
 */
export const figPluginHostReadinessProbeSchema = z
  .object({
    host: z.enum(['figma', 'photoshop']),
    adapterVersion: z.string().trim().min(1).max(64),
    supports: z
      .array(z.enum(HOST_COMMANDS))
      .min(1)
      .max(HOST_COMMANDS.length)
      .superRefine((commands, ctx) => {
        if (new Set(commands).size !== commands.length)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate host capabilities' })
      }),
    rollback: z.enum(HOST_EXECUTION_ROLLBACKS),
    visualAudit: z.enum(HOST_VISUAL_AUDITS),
    document: readinessCheckSchema,
    resources: z
      .object({
        fonts: readinessCheckSchema,
        visual: readinessCheckSchema
      })
      .strict()
  })
  .strict()
export type FigPluginHostReadinessProbe = z.output<typeof figPluginHostReadinessProbeSchema>

/** Protocol-only requests remain valid for older hosts and intentionally report unknown. */
export const figPluginBridgeReadinessRequestSchema = z
  .object({
    protocol: z.literal(1),
    hostProbe: figPluginHostReadinessProbeSchema.optional(),
    includeDiagnostics: z.boolean().optional()
  })
  .strict()
export type FigPluginBridgeReadinessRequest = z.output<typeof figPluginBridgeReadinessRequestSchema>
export const figPluginBridgeReadinessResponseSchema = z
  .object({
    protocol: z.literal(1),
    kind: z.literal('figplugin-bridge-readiness'),
    checkedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    bridge: readinessCheckSchema,
    configuration: readinessCheckSchema,
    provider: readinessCheckSchema.extend({ diagnostics: providerDiagnosticsSchema.optional() }),
    resources: readinessCheckSchema,
    host: readinessCheckSchema
      .extend({
        host: z.enum(['figma', 'photoshop']),
        capabilities: readinessCheckSchema
      })
      .strict()
  })
  .strict()
export type FigPluginBridgeReadinessResponse = z.output<
  typeof figPluginBridgeReadinessResponseSchema
>
export type FigPluginBridgeProbeCode =
  | 'reachable'
  | 'unavailable'
  | 'permission-denied'
  | 'invalid-response'
  | 'invalid-config'
  | 'timeout'
  | 'cancelled'
  | 'helper-unavailable'
const labels: Record<FigPluginBridgeProbeCode, string> = {
  reachable:
    '桌面连接有响应；尚未配对，也未验证模型可用或取得写入权限。 / Bridge reachable; not authentication, model readiness or write authority.',
  unavailable:
    '无法连接桌面。请启动 MagicPot 配对服务并核对插件中的固定地址。 / Bridge unavailable; start desktop pairing and check the fixed origin.',
  'permission-denied':
    '宿主拒绝网络权限。Photoshop 请加载声明了网络权限的 UXP 插件，不要作为独立 .psjs 脚本运行。 / Host denied network permission; use a network-enabled UXP plugin, not a standalone script.',
  'invalid-response':
    '响应不匹配或插件版本不兼容；未建立会话。请核对桌面地址并更新插件。 / Unexpected response; check origin and update the plugin.',
  'invalid-config': '插件连接配置或安全随机数无效。 / Invalid plugin origin or secure challenge.',
  timeout: '连接检查超时；未建立会话。 / Connection check timed out; no session created.',
  cancelled: '连接检查已取消。 / Connection check cancelled.',
  'helper-unavailable':
    '连接检查模块缺失；请重新准备开发插件。 / Connection helper missing; prepare the development plugin again.'
}
export function bridgeProbeMessage(code: FigPluginBridgeProbeCode): string {
  return Object.prototype.hasOwnProperty.call(labels, code)
    ? labels[code]
    : labels['invalid-response']
}
export type ProbeResponse = {
  status: number
  ok: boolean
  redirected?: boolean
  url?: string
  headers?: { get?: (name: string) => string | null }
  text(): Promise<string>
}
export type ProbeFetch = (url: string, options: RequestInit) => Promise<ProbeResponse>
export type BridgeProbe = { result: Promise<FigPluginBridgeProbeCode>; cancel(): void }
const utf8Bytes = (value: string): number => {
  let total = 0
  for (const char of value) {
    const point = char.codePointAt(0)!
    total += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return total
}

/** One explicit bounded request. Importing this module never reads a document or contacts a server.
 * A successful echo is not proof of server identity: only fresh desktop pairing authorizes work.
 * A late fetch/text resolution cannot undo cancellation, even on hosts without AbortController.
 */
export function startFigPluginBridgeProbe(
  origin: string,
  nonce: string,
  transport?: ProbeFetch
): BridgeProbe {
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let resolve!: (code: FigPluginBridgeProbeCode) => void
  const result = new Promise<FigPluginBridgeProbeCode>((yes) => {
    resolve = yes
  })
  const finish = (code: FigPluginBridgeProbeCode): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (code === 'cancelled' || code === 'timeout') {
      try {
        controller?.abort()
      } catch {
        /* Some native hosts cannot abort an in-flight fetch. */
      }
    }
    resolve(code)
  }
  const handle = Object.freeze({ result, cancel: () => finish('cancelled') })
  const request = figPluginBridgeProbeRequestSchema.safeParse({ protocol: 1, nonce })
  if (!FigPluginDesktopBridgeOriginSchema.safeParse(origin).success || !request.success) {
    finish('invalid-config')
    return handle
  }
  const url = origin + FIGPLUGIN_BRIDGE_PROBE_PATH
  const deadline = Date.now() + FIGPLUGIN_BRIDGE_PROBE_TIMEOUT_MS
  const current = (): boolean => {
    if (settled) return false
    if (Date.now() >= deadline) {
      finish('timeout')
      return false
    }
    return true
  }
  try {
    if (typeof AbortController === 'function') controller = new AbortController()
    timer = setTimeout(() => finish('timeout'), FIGPLUGIN_BRIDGE_PROBE_TIMEOUT_MS)
    const fetcher: ProbeFetch = transport ?? ((address, options) => fetch(address, options))
    void (async () => {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.data),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {})
      })
      if (!current()) return
      if (!response || response.redirected === true || (response.url && response.url !== url)) {
        finish('invalid-response')
        return
      }
      if (response.status !== 200 || response.ok !== true) {
        finish(
          response.status >= 500 || response.status === 429 ? 'unavailable' : 'invalid-response'
        )
        return
      }
      const headers = response.headers
      const size =
        headers &&
        (typeof headers.get === 'function'
          ? headers.get('content-length')
          : ((headers as Record<string, unknown>)['content-length'] ??
            (headers as Record<string, unknown>)['Content-Length']))
      if (size != null && (!/^[0-9]+$(?![\s\S])/.test(String(size)) || Number(size) > 2048)) {
        finish('invalid-response')
        return
      }
      const text = await response.text()
      if (!current()) return
      if (typeof text !== 'string' || text.length > 2048 || utf8Bytes(text) > 2048) {
        finish('invalid-response')
        return
      }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        finish('invalid-response')
        return
      }
      const parsed = figPluginBridgeProbeResponseSchema.safeParse(value)
      finish(parsed.success && parsed.data.nonce === nonce ? 'reachable' : 'invalid-response')
    })().catch((error: unknown) => {
      if (!current()) return
      // Classify the observed native refusal without exposing raw exception URLs/tokens.
      let message = ''
      try {
        if (
          error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        )
          message = error.message.slice(0, 512).toLowerCase()
      } catch {
        /* Host exceptions are not trusted data and never enter UI output. */
      }
      finish(
        message.includes('script is not permitted to access the network apis') ||
          (message.startsWith('permission denied to the url ') &&
            message.includes('manifest entry not found'))
          ? 'permission-denied'
          : 'unavailable'
      )
    })
  } catch {
    finish('unavailable')
  }
  return handle
}
