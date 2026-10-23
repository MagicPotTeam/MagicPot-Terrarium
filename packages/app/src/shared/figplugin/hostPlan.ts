import { z } from 'zod'

/** Shared data contract for Bridge planning and future native-host validation.
 * A valid plan is data, never consent or proof that a host performed a change. */
export const HOST_PLAN_VERSION = 2 as const
export const HOST_CONTEXT_MAX_BYTES = 40 * 1024
export const HOST_PLAN_MAX_BYTES = 16 * 1024
export const HOST_COMMANDS = [
  'node.rename',
  'node.opacity',
  'node.visibility',
  'text.content',
  'layout.flow'
] as const
export const HOST_EXECUTION_ROLLBACKS = ['verified-in-place', 'native-history', 'none'] as const
export const HOST_VISUAL_AUDITS = ['hash-only', 'unavailable'] as const
const id = z.string().min(1).max(128)
const name = z.string().min(1).max(4096)
const finite = z.number().finite().min(-10_000_000).max(10_000_000)
const hasUnsafeControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true
  }
  return false
}
export const hostLayoutSchema = z
  .object({
    direction: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']),
    gap: z.number().finite().min(0).max(10000),
    padding: z.tuple([
      z.number().min(0).max(10000),
      z.number().min(0).max(10000),
      z.number().min(0).max(10000),
      z.number().min(0).max(10000)
    ])
  })
  .strict()
export const hostExecutionCapabilitySchema = z
  .object({
    mode: z.literal('native-write'),
    adapterVersion: z.string().min(1).max(64),
    supports: z.array(z.enum(HOST_COMMANDS)).min(1).max(HOST_COMMANDS.length),
    rollback: z.enum(HOST_EXECUTION_ROLLBACKS),
    visualAudit: z.enum(HOST_VISUAL_AUDITS),
    // Declared by a native adapter, not requested by the model. No arbitrary tolerance.
    opacityEncoding: z.literal('uint8').optional()
  })
  .strict()
export type HostExecutionCapability = z.output<typeof hostExecutionCapabilitySchema>
export const hostContextNodeSchema = z
  .object({
    id,
    type: z.string().min(1).max(128),
    name: z.string().max(4096),
    parentId: id.nullable(),
    ancestors: z
      .array(z.object({ id, type: z.string().max(128), locked: z.boolean() }).strict())
      .max(32),
    locked: z.boolean(),
    visible: z.boolean(),
    opacity: z.number().finite().min(0).max(1).optional(),
    commands: z.array(z.enum(HOST_COMMANDS)).max(HOST_COMMANDS.length),
    children: z.array(id).max(100).optional(),
    geometry: z.object({ x: finite, y: finite, width: finite, height: finite }).strict().optional(),
    text: z.string().max(4096).optional(),
    fontKey: z.string().max(4096).optional(),
    layout: hostLayoutSchema.optional()
  })
  .strict()
export const hostContextSchema = z
  .object({
    version: z.literal(1),
    host: z.enum(['figma', 'photoshop']),
    documentId: id,
    scopeId: id,
    captureId: z.string().regex(/^[a-f0-9]{32}$/),
    // Native runtime identity prevents recovery across unrelated host instances that reuse node IDs.
    recoveryIdentity: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    nodes: z.array(hostContextNodeSchema).min(1).max(100),
    selectedIds: z.array(id).min(1).max(100).optional(),
    execution: hostExecutionCapabilitySchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.execution?.opacityEncoding && value.host !== 'photoshop')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported opacity encoding' })
    const ids = new Set(value.nodes.map((node) => node.id))
    if (ids.size !== value.nodes.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate nodes' })
    const selected = new Set(value.selectedIds ?? [])
    if (selected.size !== (value.selectedIds?.length ?? 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate selected nodes' })
    if (value.selectedIds && value.selectedIds.some((nodeId) => !ids.has(nodeId)))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Selected node is missing' })
    if (value.execution && !value.selectedIds)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Native execution requires a scope' })
    if (
      value.execution &&
      value.nodes.some((node) =>
        node.commands.some((command) => !value.execution!.supports.includes(command))
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Node advertises unsupported commands' })
    if (utf8Size(JSON.stringify(value)) > HOST_CONTEXT_MAX_BYTES)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Context is too large' })
  })
export type HostContext = z.output<typeof hostContextSchema>
export type HostContextNode = z.output<typeof hostContextNodeSchema>
export const hostStepSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('node.rename'),
      targetId: id,
      name: name.refine((value) => value.trim().length > 0 && !hasUnsafeControlCharacter(value))
    })
    .strict(),
  z
    .object({
      command: z.literal('node.opacity'),
      targetId: id,
      opacity: z.number().finite().min(0).max(1)
    })
    .strict(),
  z.object({ command: z.literal('node.visibility'), targetId: id, visible: z.boolean() }).strict(),
  z
    .object({ command: z.literal('text.content'), targetId: id, text: z.string().max(4096) })
    .strict(),
  z.object({ command: z.literal('layout.flow'), targetId: id, layout: hostLayoutSchema }).strict()
])
export const hostPlanSchema = z
  .object({
    schemaVersion: z.literal(HOST_PLAN_VERSION),
    kind: z.literal('host-plan'),
    captureId: z.string().regex(/^[a-f0-9]{32}$/),
    steps: z.array(hostStepSchema).min(1).max(20)
  })
  .strict()
export type HostPlan = z.output<typeof hostPlanSchema>
export type HostStep = z.output<typeof hostStepSchema>
export type HostCommand = (typeof HOST_COMMANDS)[number]
export const hostPlanReadbackSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('host-plan-readback'),
    host: z.enum(['figma', 'photoshop']),
    documentId: id,
    scopeId: id,
    captureId: z.string().regex(/^[a-f0-9]{32}$/),
    steps: z
      .array(
        z
          .object({
            targetId: id,
            command: z.enum(HOST_COMMANDS),
            observation: z.enum(['original', 'requested', 'other', 'unknown']),
            value: z.unknown().optional()
          })
          .strict()
      )
      .min(1)
      .max(20)
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, step] of value.steps.entries()) {
      const key = `${step.targetId}\u0000${step.command}`
      if (seen.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate readback step',
          path: ['steps', index]
        })
      seen.add(key)
    }
    if (utf8Size(JSON.stringify(value)) > HOST_PLAN_MAX_BYTES)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Readback is too large' })
  })
export type HostPlanReadback = z.output<typeof hostPlanReadbackSchema>
export function utf8Size(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}
export function parseHostPlan(text: string, context: HostContext): HostPlan {
  if (
    typeof text !== 'string' ||
    text.length > HOST_PLAN_MAX_BYTES ||
    utf8Size(text) > HOST_PLAN_MAX_BYTES
  )
    throw new Error('PLAN_TOO_LARGE')
  const plan = normalizeHostPlan(hostPlanSchema.parse(JSON.parse(text)), context)
  validateHostPlan(plan, context)
  return plan
}
/** Canonicalize only explicitly advertised native numeric precision BEFORE preview/approval.
 * Every downstream hash and exact readback refers to these actual representable values. */
export function normalizeHostPlan(input: HostPlan, rawContext: HostContext): HostPlan {
  const context = hostContextSchema.parse(rawContext)
  const plan = hostPlanSchema.parse(input)
  if (context.execution?.opacityEncoding !== 'uint8') return plan
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.command === 'node.opacity'
        ? { ...step, opacity: Math.round(step.opacity * 255) / 255 }
        : step
    )
  }
}
export function validateHostPlan(plan: HostPlan, rawContext: HostContext): void {
  const context = hostContextSchema.parse(rawContext)
  if (plan.captureId !== context.captureId) throw new Error('STALE_CONTEXT')
  const selected = new Map(context.nodes.map((node) => [node.id, node]))
  const allowedTargets = context.selectedIds ? new Set(context.selectedIds) : undefined
  const seen = new Set<string>()
  for (const step of plan.steps) {
    const node = selected.get(step.targetId)
    if (!node) throw new Error('OUT_OF_SCOPE')
    if (allowedTargets && !allowedTargets.has(step.targetId)) throw new Error('OUT_OF_SCOPE')
    if (node.locked || node.ancestors.some((ancestor) => ancestor.locked))
      throw new Error('LOCKED_TARGET')
    if (!node.commands.includes(step.command)) throw new Error('UNSUPPORTED_COMMAND')
    if (
      step.command === 'node.opacity' &&
      context.execution?.opacityEncoding === 'uint8' &&
      step.opacity !== Math.round(step.opacity * 255) / 255
    )
      throw new Error('HOST_PRECISION_MISMATCH')

    const key = `${step.targetId}\u0000${step.command}`
    if (seen.has(key)) throw new Error('DUPLICATE_COMMAND')
    seen.add(key)
    if (step.command === 'layout.flow') {
      if (!node.children) throw new Error('LAYOUT_SCOPE_INCOMPLETE')
      const pending = [...node.children]
      const visited = new Set<string>([node.id])
      while (pending.length) {
        const childId = pending.pop()!
        const child = selected.get(childId)
        if (
          !child ||
          visited.has(childId) ||
          child.locked ||
          child.ancestors.some((ancestor) => ancestor.locked)
        )
          throw new Error('LAYOUT_SCOPE_INCOMPLETE')
        visited.add(childId)
        if (!child.children) throw new Error('LAYOUT_SCOPE_INCOMPLETE')
        pending.push(...child.children)
      }
    }
  }
}

export function validateHostPlanExecution(plan: HostPlan, rawContext: HostContext): void {
  const context = hostContextSchema.parse(rawContext)
  if (!context.execution || context.execution.mode !== 'native-write')
    throw new Error('EXECUTION_UNAVAILABLE')
  if (!context.selectedIds) throw new Error('INCOMPLETE_CONTEXT')
  for (const step of plan.steps) {
    if (!context.execution.supports.includes(step.command)) throw new Error('UNSUPPORTED_COMMAND')
  }
  validateHostPlan(plan, context)
}
export function stepValue(step: HostStep): unknown {
  switch (step.command) {
    case 'node.rename':
      return step.name
    case 'node.opacity':
      return step.opacity
    case 'node.visibility':
      return step.visible
    case 'text.content':
      return step.text
    case 'layout.flow':
      return step.layout
  }
}
export function nodeValue(node: HostContextNode, command: HostCommand): unknown {
  switch (command) {
    case 'node.rename':
      return node.name
    case 'node.opacity':
      return node.opacity
    case 'node.visibility':
      return node.visible
    case 'text.content':
      return node.text
    case 'layout.flow':
      return node.layout
  }
}

export function createHostPlanReadback(
  before: HostContext,
  after: HostContext,
  plan: HostPlan
): HostPlanReadback {
  validateHostPlan(plan, before)
  const context = hostContextSchema.parse(after)
  if (
    context.host !== before.host ||
    context.documentId !== before.documentId ||
    context.scopeId !== before.scopeId ||
    context.captureId !== before.captureId
  )
    throw new Error('STALE_CONTEXT')
  const previous = new Map(before.nodes.map((node) => [node.id, node]))
  const current = new Map(context.nodes.map((node) => [node.id, node]))
  const readback = hostPlanReadbackSchema.parse({
    version: 1,
    kind: 'host-plan-readback',
    host: before.host,
    documentId: before.documentId,
    scopeId: before.scopeId,
    captureId: before.captureId,
    steps: plan.steps.map((step) => {
      const oldNode = previous.get(step.targetId)
      const newNode = current.get(step.targetId)
      if (!oldNode || !newNode) throw new Error('OUT_OF_SCOPE')
      const expected = stepValue(step)
      const value = nodeValue(newNode, step.command)
      return {
        targetId: step.targetId,
        command: step.command,
        observation:
          value === undefined
            ? 'unknown'
            : JSON.stringify(value) === JSON.stringify(expected)
              ? 'requested'
              : JSON.stringify(value) === JSON.stringify(nodeValue(oldNode, step.command))
                ? 'original'
                : 'other',
        ...(value === undefined ? {} : { value })
      }
    })
  })
  return readback
}

export function validateHostPlanReadback(
  plan: HostPlan,
  before: HostContext,
  rawReadback: unknown
): HostPlanReadback {
  validateHostPlan(plan, before)
  const readback = hostPlanReadbackSchema.parse(rawReadback)
  if (
    readback.host !== before.host ||
    readback.documentId !== before.documentId ||
    readback.scopeId !== before.scopeId ||
    readback.captureId !== plan.captureId
  )
    throw new Error('STALE_CONTEXT')
  if (readback.steps.length !== plan.steps.length) throw new Error('INCOMPLETE_READBACK')
  const expected = new Map(
    plan.steps.map((step) => [`${step.targetId}\u0000${step.command}`, step])
  )
  for (const step of readback.steps) {
    const source = expected.get(`${step.targetId}\u0000${step.command}`)
    if (!source) throw new Error('OUT_OF_SCOPE')
    expected.delete(`${step.targetId}\u0000${step.command}`)
  }
  if (expected.size) throw new Error('INCOMPLETE_READBACK')
  return readback
}

/** Reversible display escaping only. Never use display text as a permission/hash input. */
export function escapePlanningDisplay(text: string): string {
  return text.replace(
    /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
  )
}
