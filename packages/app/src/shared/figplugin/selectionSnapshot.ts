import { z } from 'zod'

export const FIGPLUGIN_SELECTION_SNAPSHOT_MAX_SELECTION = 100
export const FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NODES = 512
export const FIGPLUGIN_SELECTION_SNAPSHOT_MAX_DEPTH = 32
export const FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NAME_BYTES = 4096
export const FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES = 256 * 1024

// Complete selected-node/ancestor metadata only: not consent, host authentication,
// a mutation revision, exclusion, rollback data, or execution authority.
type SnapshotErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'SNAPSHOT_TOO_LARGE'
  | 'SELECTION_TOO_LARGE'
  | 'TOO_MANY_NODES'
  | 'ANCESTRY_TOO_DEEP'
const invalidData = Symbol('Invalid snapshot')
const tooLarge = Symbol('Snapshot too large')
const arrayLimits = new Map<symbol, SnapshotErrorCode>([
  [Symbol('Selection limit'), 'SELECTION_TOO_LARGE'],
  [Symbol('Node limit'), 'TOO_MANY_NODES'],
  [Symbol('Depth limit'), 'ANCESTRY_TOO_DEEP']
])
const limitFault = (code: SnapshotErrorCode): symbol => {
  for (const [fault, name] of arrayLimits) if (name === code) return fault
  return invalidData
}

// Reject unpaired surrogates instead of TextEncoder's silent replacement. JSON escaping
// counts towards the total size, while field limits measure the original UTF-8 text.
const stringBytes = (text: string, json = false): number => {
  let bytes = json ? 2 : 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw invalidData
      bytes += 4
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidData
    } else if (json && (code === 0x22 || code === 0x5c)) {
      bytes += 2
    } else if (json && code <= 0x1f) {
      bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
    }
  }
  return bytes
}
const boundedText = (max: number, nonempty = false) =>
  z
    .string()
    .max(max)
    .refine((text) => {
      try {
        return (!nonempty || text.length > 0) && stringBytes(text) <= max
      } catch {
        return false
      }
    }, 'Invalid snapshot text')
const identifier = boundedText(256, true)
const epoch = boundedText(48, true).refine((text) =>
  /^[a-f0-9]{32}:[1-9][0-9]{0,14}$(?![\s\S])/.test(text)
)
const positiveSafeInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const nodeSchema = z
  .object({
    id: identifier,
    parentId: identifier.nullable(),
    kind: boundedText(128, true),
    name: boundedText(FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NAME_BYTES),
    role: z.enum(['scene', 'structural']),
    visible: z.boolean().nullable(),
    locked: z.boolean().nullable()
  })
  .strict()
const contract = z
  .object({
    protocol: z.literal(1),
    purpose: z.literal('read-only-selection-review'),
    host: z.enum(['figma', 'photoshop']),
    complete: z.literal(true),
    document: z
      .object({
        id: identifier,
        idSource: z.enum(['figma-plugin-root', 'photoshop-open-document']),
        openEpoch: epoch,
        openEpochSource: z.literal('plugin-observation'),
        pageId: identifier.nullable()
      })
      .strict(),
    observation: z
      .object({ sequence: positiveSafeInteger, source: z.literal('capture-counter') })
      .strict(),
    capabilities: z
      .object({
        readSnapshot: z.literal(true),
        writeCommands: z.tuple([]),
        authenticatedHost: z.literal(false),
        nativeDocumentRevision: z.literal(false),
        mutationExclusion: z.literal(false),
        rollback: z.literal(false),
        remoteMutationTracking: z.literal(false)
      })
      .strict(),
    nodes: z.array(nodeSchema).max(FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NODES),
    selected: z
      .array(
        z
          .object({
            id: identifier,
            ancestors: z.array(identifier).max(FIGPLUGIN_SELECTION_SNAPSHOT_MAX_DEPTH),
            effectiveLocked: z.boolean(),
            effectiveVisible: z.boolean()
          })
          .strict()
      )
      .max(FIGPLUGIN_SELECTION_SNAPSHOT_MAX_SELECTION)
  })
  .strict()
export type FigPluginSelectionSnapshot = z.output<typeof contract>
export type FigPluginSelectionSnapshotCheck =
  | { ok: true; snapshot: FigPluginSelectionSnapshot }
  | { ok: false; error: { code: SnapshotErrorCode } }

const photoshopId = (text: string): boolean =>
  /^[1-9][0-9]{0,15}$(?![\s\S])/.test(text) && Number.isSafeInteger(Number(text))
const validGraph = (snapshot: FigPluginSelectionSnapshot): boolean => {
  const figma = snapshot.host === 'figma'
  const { document, nodes, selected } = snapshot
  if (figma) {
    if (
      document.idSource !== 'figma-plugin-root' ||
      document.pageId === null ||
      document.pageId === document.id ||
      !document.openEpoch.endsWith(':1')
    )
      return false
  } else if (
    document.idSource !== 'photoshop-open-document' ||
    document.pageId !== null ||
    !photoshopId(document.id)
  )
    return false
  const byId = new Map<string, FigPluginSelectionSnapshot['nodes'][number]>()
  for (const node of nodes) {
    if (byId.has(node.id)) return false
    byId.set(node.id, node)
    if (
      !figma &&
      (!photoshopId(node.id) || (node.parentId !== null && !photoshopId(node.parentId)))
    )
      return false
    if (figma && node.id === document.id) return false
    if (node.role === 'structural') {
      if (
        !figma ||
        node.id !== document.pageId ||
        node.kind !== 'PAGE' ||
        node.parentId !== null ||
        node.visible !== null ||
        node.locked !== null
      )
        return false
    } else {
      if (typeof node.visible !== 'boolean' || typeof node.locked !== 'boolean') return false
      if (
        figma &&
        (node.kind === 'PAGE' ||
          node.kind === 'DOCUMENT' ||
          node.id === document.pageId ||
          node.parentId === null)
      )
        return false
    }
  }
  const selectedIds = new Set<string>()
  const used = new Set<string>()
  for (const selection of selected) {
    if (selectedIds.has(selection.id)) return false
    selectedIds.add(selection.id)
    let current = byId.get(selection.id)
    if (!current || current.role !== 'scene') return false
    const seen = new Set([current.id])
    used.add(current.id)
    let locked = current.locked === true
    let visible = current.visible === true
    let depth = 0
    while (current.parentId !== null) {
      if (
        depth === FIGPLUGIN_SELECTION_SNAPSHOT_MAX_DEPTH ||
        selection.ancestors[depth] !== current.parentId
      )
        return false
      const parent = byId.get(current.parentId)
      if (!parent || seen.has(parent.id)) return false
      used.add(parent.id)
      seen.add(parent.id)
      if (parent.role === 'scene') {
        locked = locked || parent.locked === true
        visible = visible && parent.visible === true
      }
      current = parent
      depth += 1
    }
    if (
      depth !== selection.ancestors.length ||
      selection.effectiveLocked !== locked ||
      selection.effectiveVisible !== visible ||
      (figma && current.id !== document.pageId)
    )
      return false
  }
  return used.size === nodes.length
}

// Descriptor copying bounds arrays/strings before Zod. Reflection is not a sandbox for
// in-process Proxies or arbitrarily wide objects: ingress must bound raw decoded input too.
// All reflection faults are caught, and no property accessor or JSON hook is invoked here.
type Shape =
  | { fields: Record<string, Shape> }
  | { item: Shape; max: number; overflow?: SnapshotErrorCode }
  | { text: number }
  | 'primitive'
const scalar: Shape = 'primitive'
const idShape: Shape = { text: 256 }
const layout: Shape = {
  fields: {
    protocol: scalar,
    purpose: scalar,
    host: scalar,
    complete: scalar,
    document: {
      fields: {
        id: idShape,
        idSource: scalar,
        openEpoch: { text: 48 },
        openEpochSource: scalar,
        pageId: idShape
      }
    },
    observation: { fields: { sequence: scalar, source: scalar } },
    capabilities: {
      fields: {
        readSnapshot: scalar,
        writeCommands: { item: scalar, max: 0 },
        authenticatedHost: scalar,
        nativeDocumentRevision: scalar,
        mutationExclusion: scalar,
        rollback: scalar,
        remoteMutationTracking: scalar
      }
    },
    nodes: {
      item: {
        fields: {
          id: idShape,
          parentId: idShape,
          kind: { text: 128 },
          name: { text: FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NAME_BYTES },
          role: scalar,
          visible: scalar,
          locked: scalar
        }
      },
      max: FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NODES,
      overflow: 'TOO_MANY_NODES'
    },
    selected: {
      item: {
        fields: {
          id: idShape,
          ancestors: {
            item: idShape,
            max: FIGPLUGIN_SELECTION_SNAPSHOT_MAX_DEPTH,
            overflow: 'ANCESTRY_TOO_DEEP'
          },
          effectiveLocked: scalar,
          effectiveVisible: scalar
        }
      },
      max: FIGPLUGIN_SELECTION_SNAPSHOT_MAX_SELECTION,
      overflow: 'SELECTION_TOO_LARGE'
    }
  }
}
type Detached = { ok: true; data: unknown } | { ok: false; code: SnapshotErrorCode }
const detach = (input: unknown): Detached => {
  let total = 0
  let values = 0
  const visiting = new Set<object>()
  const add = (bytes: number) => {
    total += bytes
    if (total > FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES) throw tooLarge
  }
  const visit = (value: unknown, shape: Shape): unknown => {
    if (++values > 10_000) throw invalidData
    if (shape === 'primitive' || 'text' in shape) {
      if (typeof value === 'string') {
        const max = shape === 'primitive' ? 128 : shape.text
        if (value.length > max || stringBytes(value) > max) throw invalidData
        add(stringBytes(value, true))
      } else if (value === null) add(4)
      else if (typeof value === 'boolean') add(value ? 4 : 5)
      else if (typeof value === 'number' && Number.isFinite(value)) add(String(value).length)
      else throw invalidData
      return value
    }
    if (value === null || typeof value !== 'object' || visiting.has(value)) throw invalidData
    const prototype = Object.getPrototypeOf(value)
    const array = 'item' in shape
    if (
      array
        ? !Array.isArray(value) || prototype !== Array.prototype
        : Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)
    )
      throw invalidData
    visiting.add(value)
    try {
      if ('item' in shape) {
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
        if (!Number.isSafeInteger(length) || length < 0) throw invalidData
        if (length > shape.max) throw limitFault(shape.overflow ?? 'INVALID_SNAPSHOT')
        if (Reflect.ownKeys(value).length !== length + 1) throw invalidData
        add(2 + Math.max(0, length - 1))
        const output: unknown[] = []
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalidData
          output.push(visit(descriptor.value, shape.item))
        }
        return output
      }
      const keys = Reflect.ownKeys(value)
      const names = Object.keys(shape.fields)
      if (
        keys.length !== names.length ||
        keys.some((key) => typeof key !== 'string' || !Object.hasOwn(shape.fields, key))
      )
        throw invalidData
      add(2 + Math.max(0, keys.length - 1))
      const output = Object.create(null) as Record<string, unknown>
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalidData
        add(stringBytes(key, true) + 1)
        output[key] = visit(descriptor.value, shape.fields[key])
      }
      return output
    } finally {
      visiting.delete(value)
    }
  }
  try {
    return { ok: true, data: visit(input, layout) }
  } catch (error) {
    return {
      ok: false,
      code:
        error === tooLarge
          ? 'SNAPSHOT_TOO_LARGE'
          : (arrayLimits.get(error as symbol) ?? 'INVALID_SNAPSHOT')
    }
  }
}
const refinedContract = contract.refine(validGraph, 'Invalid snapshot relationships')

export const checkFigPluginSelectionSnapshot = (
  input: unknown
): FigPluginSelectionSnapshotCheck => {
  try {
    const detached = detach(input)
    if (!detached.ok) return { ok: false, error: { code: detached.code } }
    const parsed = refinedContract.safeParse(detached.data)
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_SNAPSHOT' } }
    return { ok: true, snapshot: parsed.data }
  } catch {
    return { ok: false, error: { code: 'INVALID_SNAPSHOT' } }
  }
}

// Zod 3's ordinary safeParse probes input.then before a preprocess runs. This ingress
// schema must copy via descriptors first, even for direct parse()/safeParseAsync() callers.
class SelectionSnapshotSchema extends z.ZodType<FigPluginSelectionSnapshot, z.ZodTypeDef, unknown> {
  safeParse(input: unknown): z.SafeParseReturnType<unknown, FigPluginSelectionSnapshot> {
    const result = checkFigPluginSelectionSnapshot(input)
    return result.ok
      ? { success: true, data: result.snapshot }
      : {
          success: false,
          error: new z.ZodError([{ code: 'custom', path: [], message: result.error.code }])
        }
  }

  async safeParseAsync(input: unknown) {
    return this.safeParse(input)
  }

  _parse(input: z.ParseInput): z.ParseReturnType<FigPluginSelectionSnapshot> {
    const result = this.safeParse(input.data)
    if (result.success) return { status: 'valid', value: result.data }
    input.parent.common.issues.push({
      code: 'custom',
      path: input.path,
      message: 'INVALID_SNAPSHOT'
    })
    return z.INVALID
  }
}
export const figPluginSelectionSnapshotSchema = new SelectionSnapshotSchema({})
