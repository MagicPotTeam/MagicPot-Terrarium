import { z } from 'zod'
import { figPluginContextSchema } from './bridge'
import { canonicalFigPluginJson } from './manifest'

// A proposal format, independently versioned from the dialogue-only Bridge protocol.
// Validity is NOT consent, host identity, an execution capability or live-document safety.
export const FIGPLUGIN_PLAN_MAX_STEPS = 20
export const FIGPLUGIN_PLAN_MAX_BYTES = 8 * 1024
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength
const hasUnsafeNameControl = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0)!
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x61c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
  })

export const figPluginPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('plan-only'),
    selectionRevision: z.string().min(1).max(128),
    steps: z
      .array(
        z
          .object({
            command: z.literal('node.rename'),
            targetId: z.string().min(1).max(128),
            name: z
              .string()
              .min(1)
              .max(120)
              .refine(
                (value) =>
                  value.trim().length > 0 && bytes(value) <= 256 && !hasUnsafeNameControl(value)
              )
          })
          .strict()
      )
      .min(1)
      .max(FIGPLUGIN_PLAN_MAX_STEPS)
  })
  .strict()
export type FigPluginPlan = z.output<typeof figPluginPlanSchema>
export type FigPluginPlanErrorCode =
  | 'INVALID_PLAN'
  | 'PLAN_TOO_LARGE'
  | 'INVALID_CONTEXT'
  | 'STALE_CONTEXT'
  | 'DUPLICATE_TARGET'
  | 'OUT_OF_SCOPE'
  | 'LOCKED_TARGET'
export type FigPluginPlanCheck =
  { ok: true; plan: FigPluginPlan } | { ok: false; code: FigPluginPlanErrorCode }

type DataSnapshot =
  { ok: true; data: unknown; json: string } | { ok: false; code: 'INVALID_DATA' | 'TOO_LARGE' }

/**
 * Snapshots decoded plain data once, without calling accessors or JSON hooks. This shared helper
 * is not a sandbox for in-process Proxies: main supplies util.types.isProxy as rejectObject before
 * any reflection. Every ingress must bound decoded input size (including object-key count) before
 * calling: JS own-key enumeration itself cannot be bounded for an arbitrarily wide plain object.
 */
export const snapshotFigPluginPlanData = (
  value: unknown,
  maxBytes: number,
  rejectObject?: (item: object) => boolean
): DataSnapshot => {
  let values = 0
  let stringUnits = 0
  const tooLarge = Symbol('Oversized plan data')
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): unknown => {
    if (++values > 4096 || depth > 12) throw new TypeError('Invalid plan data')
    if (typeof item === 'string') {
      stringUnits += item.length
      if (stringUnits > maxBytes) throw tooLarge
      return item
    }
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null || ancestors.has(item))
      throw new TypeError('Invalid plan data')
    if (rejectObject?.(item)) throw new TypeError('Invalid plan data')
    const array = Array.isArray(item)
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new TypeError('Invalid plan data')
    const length = array ? Object.getOwnPropertyDescriptor(item, 'length')?.value : undefined
    if (array && (!Number.isInteger(length) || length < 0 || length > 100))
      throw new TypeError('Invalid plan data')
    const names = Reflect.ownKeys(item)
    if (names.length > (array ? 101 : 32) || (array && names.length !== length + 1))
      throw new TypeError('Invalid plan data')
    const detached: object = array ? [] : Object.create(null)
    ancestors.add(item)
    try {
      for (const key of names) {
        if (typeof key !== 'string') throw new TypeError('Invalid plan data')
        if (array && key === 'length') continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new TypeError('Invalid plan data')
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
          throw new TypeError('Invalid plan data')
        stringUnits += key.length
        if (stringUnits > maxBytes) throw tooLarge
        Object.defineProperty(detached, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true
        })
      }
      return detached
    } finally {
      ancestors.delete(item)
    }
  }
  try {
    const detached = visit(value, 0)
    const json = canonicalFigPluginJson(detached)
    if (bytes(json) > maxBytes) return { ok: false, code: 'TOO_LARGE' }
    return { ok: true, data: JSON.parse(json) as unknown, json }
  } catch (error) {
    return { ok: false, code: error === tooLarge ? 'TOO_LARGE' : 'INVALID_DATA' }
  }
}

/**
 * Only for bounded JSON-decoded data (see snapshotFigPluginPlanData). Compares supplied snapshots,
 * NOT a live host. Existing context may truncate names/selection,
 * lacks stable document identity and does not attest effective ancestor locks. Even a valid
 * proposal cannot be used as an old-name precondition, rollback record or write permission.
 */
export const checkFigPluginPlan = (
  raw: unknown,
  capturedContext: unknown,
  currentContext: unknown
): FigPluginPlanCheck => {
  const input = snapshotFigPluginPlanData(raw, FIGPLUGIN_PLAN_MAX_BYTES)
  if (!input.ok)
    return {
      ok: false,
      code: input.code === 'TOO_LARGE' ? 'PLAN_TOO_LARGE' : 'INVALID_PLAN'
    }
  const parsed = figPluginPlanSchema.safeParse(input.data)
  if (!parsed.success) return { ok: false, code: 'INVALID_PLAN' }
  const captured = snapshotFigPluginPlanData(capturedContext, 48 * 1024)
  const current = snapshotFigPluginPlanData(currentContext, 48 * 1024)
  if (!captured.ok || !current.ok) return { ok: false, code: 'INVALID_CONTEXT' }
  const snapshot = figPluginContextSchema.safeParse(captured.data)
  if (!snapshot.success || !figPluginContextSchema.safeParse(current.data).success)
    return { ok: false, code: 'INVALID_CONTEXT' }
  if (
    captured.json !== current.json ||
    parsed.data.selectionRevision !== snapshot.data.selectionRevision
  )
    return { ok: false, code: 'STALE_CONTEXT' }
  const seen = new Set<string>()
  const nodes = new Map(snapshot.data.nodes.map((node) => [node.id, node]))
  for (const step of parsed.data.steps) {
    if (seen.has(step.targetId)) return { ok: false, code: 'DUPLICATE_TARGET' }
    seen.add(step.targetId)
    const node = nodes.get(step.targetId)
    if (!node) return { ok: false, code: 'OUT_OF_SCOPE' }
    if (node.locked) return { ok: false, code: 'LOCKED_TARGET' }
  }
  return { ok: true, plan: parsed.data }
}
