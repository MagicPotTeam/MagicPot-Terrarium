import { createHash, timingSafeEqual } from 'node:crypto'
import { types } from 'node:util'
import { z } from 'zod'
import {
  figPluginBridgeHashSchema,
  figPluginContextSchema,
  figPluginDesktopCallSchema,
  figPluginRuntimeBindingSchema
} from '@shared/figplugin/bridge'
import {
  checkFigPluginPlan,
  figPluginPlanSchema,
  FIGPLUGIN_PLAN_MAX_BYTES,
  snapshotFigPluginPlanData,
  type FigPluginPlanErrorCode
} from '@shared/figplugin/plan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'

const MAX_PREVIEW_BYTES = 64 * 1024
const scopeSchema = z
  .object({
    context: figPluginContextSchema,
    binding: figPluginRuntimeBindingSchema,
    callId: figPluginDesktopCallSchema.shape.callId
  })
  .strict()
export type FigPluginPlanScope = z.output<typeof scopeSchema>
const envelopeSchema = scopeSchema.extend({
  domain: z.literal('figplugin-plan-preview/v1'),
  plan: figPluginPlanSchema
})
const previewSchema = z
  .object({ envelope: envelopeSchema, payloadSha256: figPluginBridgeHashSchema })
  .strict()
export type FigPluginPlanPreview = z.output<typeof previewSchema>
type PreviewResult =
  | { ok: true; preview: FigPluginPlanPreview }
  | { ok: false; code: FigPluginPlanErrorCode | 'INVALID_SCOPE' | 'PREVIEW_TOO_LARGE' }

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalFigPluginJson(value), 'utf8').digest('hex')
const freeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const parseScope = (raw: unknown): FigPluginPlanScope | undefined => {
  const snapshot = snapshotFigPluginPlanData(raw, MAX_PREVIEW_BYTES, types.isProxy)
  if (!snapshot.ok) return undefined
  const parsed = scopeSchema.safeParse(snapshot.data)
  // A hash must bind exact data, not silently trimmed or normalized authority references.
  if (!parsed.success || canonicalFigPluginJson(parsed.data) !== snapshot.json) return undefined
  return parsed.data
}

/**
 * Main-only, inert preview of a proposed change. Scope is supplied independently by its caller,
 * never by model output. No IPC/HTTP registration, provider parsing or HostAdapter is enabled.
 * The retained context may be truncated and lacks document identity/effective ancestor locks.
 * Matching this digest is NOT approval, authentication, a write capability or live revalidation.
 */
export const createFigPluginPlanPreview = (
  proposal: unknown,
  capturedScope: unknown,
  currentContext: unknown
): PreviewResult => {
  const scope = parseScope(capturedScope)
  if (!scope) return { ok: false, code: 'INVALID_SCOPE' }
  const input = snapshotFigPluginPlanData(proposal, FIGPLUGIN_PLAN_MAX_BYTES, types.isProxy)
  if (!input.ok)
    return {
      ok: false,
      code: input.code === 'TOO_LARGE' ? 'PLAN_TOO_LARGE' : 'INVALID_PLAN'
    }
  const current = snapshotFigPluginPlanData(currentContext, 48 * 1024, types.isProxy)
  if (!current.ok) return { ok: false, code: 'INVALID_CONTEXT' }
  const checked = checkFigPluginPlan(input.data, scope.context, current.data)
  if (!checked.ok) return checked
  const envelope = {
    domain: 'figplugin-plan-preview/v1' as const,
    plan: checked.plan,
    ...scope
  }
  const snapshot = snapshotFigPluginPlanData(envelope, MAX_PREVIEW_BYTES)
  if (!snapshot.ok) return { ok: false, code: 'PREVIEW_TOO_LARGE' }
  return {
    ok: true,
    preview: freeze({ envelope, payloadSha256: hash(envelope) })
  }
}

/** Compare an already main-retained preview; the hash is public integrity material, not a grant. */
export const matchesFigPluginPlanPreview = (
  storedPreview: unknown,
  presentedHash: unknown,
  currentScope: unknown
): boolean => {
  if (
    typeof presentedHash !== 'string' ||
    presentedHash.length !== 64 ||
    !figPluginBridgeHashSchema.safeParse(presentedHash).success
  )
    return false
  const scope = parseScope(currentScope)
  if (!scope) return false
  const snapshot = snapshotFigPluginPlanData(storedPreview, MAX_PREVIEW_BYTES + 256, types.isProxy)
  if (!snapshot.ok) return false
  const parsed = previewSchema.safeParse(snapshot.data)
  if (!parsed.success || canonicalFigPluginJson(parsed.data) !== snapshot.json) return false
  const { envelope, payloadSha256 } = parsed.data
  const previousScope = {
    context: envelope.context,
    binding: envelope.binding,
    callId: envelope.callId
  }
  if (canonicalFigPluginJson(previousScope) !== canonicalFigPluginJson(scope)) return false
  if (!checkFigPluginPlan(envelope.plan, envelope.context, scope.context).ok) return false
  if (!snapshotFigPluginPlanData(envelope, MAX_PREVIEW_BYTES).ok) return false
  const digest = Buffer.from(hash(envelope), 'hex')
  return (
    timingSafeEqual(digest, Buffer.from(payloadSha256, 'hex')) &&
    timingSafeEqual(digest, Buffer.from(presentedHash, 'hex'))
  )
}
