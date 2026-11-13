// Renderer-only admission for explicit append-import, not a complete canvas codec.
// Post-read/parse checks do not bound prior file.text()/JSON.parse native work or provide rollback.
export const CANVAS_IMPORT_PREFLIGHT_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxTextBytes: 64 * 1024 * 1024,
  maxItems: 10000,
  maxGroups: 10000,
  maxGroupBranches: 10000,
  maxBlobEntries: 4096,
  maxTexturesPerItem: 4096,
  maxDepth: 64,
  maxNodes: 100000,
  maxIdentityCodeUnits: 1024,
  maxMimeCodeUnits: 1024,
  maxAssetBytes: 16 * 1024 * 1024,
  maxTotalAssetBytes: 32 * 1024 * 1024
})

const limits = CANVAS_IMPORT_PREFLIGHT_LIMITS
const invalid = (): never => { throw new Error('Invalid or oversized MagicPot canvas import') }

export function assertCanvasImportFileSize(size: unknown): void {
  if (size === undefined) return
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) invalid()
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid()
  return value
}

function identity(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > limits.maxIdentityCodeUnits) invalid()
}

function primitiveLabel(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') invalid()
}

function inspectParsedGraph(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  // Cumulative scheduled values = visited + pending, including every primitive/null value.
  let scheduled = 1
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (depth > limits.maxDepth) invalid()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid()
      continue
    }
    if (typeof value !== 'object') invalid()
    const keys = Object.keys(value as object)
    // Reject broad fanout before enqueuing any children, not after allocating its pending frames.
    if (scheduled + keys.length > limits.maxNodes || (keys.length > 0 && depth === limits.maxDepth)) invalid()
    scheduled += keys.length
    for (const key of keys) pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
  }
}

function inspectItem(value: unknown): void {
  const item = record(value)
  identity(item.id)
  switch (item.type) {
    case 'image':
    case 'model3d':
    case 'video':
    case 'file':
      if (item.src !== undefined && item.src !== null && typeof item.src !== 'string') invalid()
      break
    case 'text':
    case 'annotation':
    case 'html':
      break
    default:
      invalid()
  }
  if (item.type === 'model3d' && item.textures !== undefined && item.textures !== null) {
    const textures = record(item.textures), keys = Object.keys(textures)
    if (keys.length > limits.maxTexturesPerItem) invalid()
    for (const key of keys) {
      identity(key)
      if (typeof textures[key] !== 'string') invalid()
    }
  }
}

function inspectGroups(value: unknown, branches: boolean): void {
  if (value === undefined || value === null) return
  const entries = array(value, branches ? limits.maxGroupBranches : limits.maxGroups)
  const ids = new Set<unknown>()
  for (const entry of entries) {
    const group = record(entry)
    identity(group.id)
    if (ids.has(group.id)) invalid()
    ids.add(group.id)
    if (group.name !== undefined && typeof group.name !== 'string') invalid()
    primitiveLabel(group.createdAt)
    if (!branches) for (const id of array(group.itemIds, limits.maxItems)) identity(id)
  }
}

function decodedBase64Bytes(text: string): number {
  let alphabet = 0, padding = 0
  // Match forgiving atob syntax without decoding, stripping whitespace or copying the payload.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) continue
    if (code === 61) {
      if (++padding > 2) invalid()
      continue
    }
    if (padding || !((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) invalid()
    alphabet++
  }
  const remainder = alphabet % 4
  if (remainder === 1 || (padding > 0 && ((alphabet + padding) % 4 !== 0 || (padding === 1 ? remainder !== 3 : remainder !== 2)))) invalid()
  return Math.floor(alphabet * 6 / 8)
}

function inspectBlobs(value: unknown): void {
  if (value === undefined || value === null) return
  const blobs = record(value), keys = Object.keys(blobs)
  if (keys.length > limits.maxBlobEntries) invalid()
  let totalBytes = 0
  for (const key of keys) {
    identity(key)
    const embedded = record(blobs[key])
    if (typeof embedded.base64 !== 'string' || typeof embedded.mimeType !== 'string' || embedded.mimeType.length > limits.maxMimeCodeUnits) invalid()
    const bytes = decodedBase64Bytes(embedded.base64 as string)
    totalBytes += bytes
    if (bytes > limits.maxAssetBytes || totalBytes > limits.maxTotalAssetBytes) invalid()
  }
}

export function parseCanvasImportText(text: unknown): unknown {
  if (typeof text !== 'string' || text.length > limits.maxTextBytes) return invalid()
  if (new TextEncoder().encode(text).byteLength > limits.maxTextBytes) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return invalid() }
  inspectParsedGraph(parsed)
  const data = record(parsed)
  if (data.magic !== 'MAGICPOT_CANVAS') invalid()
  primitiveLabel(data.version)
  primitiveLabel(data.createdAt)
  const itemIds = new Set<unknown>()
  for (const item of array(data.items, limits.maxItems)) {
    inspectItem(item)
    const id = record(item).id
    if (itemIds.has(id)) invalid()
    itemIds.add(id)
  }
  inspectGroups(data.groups, false)
  inspectGroups(data.groupBranches, true)
  inspectBlobs(data.blobs)
  // Preserve unknown fields, version labels and storage-mode fallback; no full subtype certificate.
  return parsed
}
