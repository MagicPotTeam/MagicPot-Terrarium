/** Passive JSON and a deliberately bounded JSON-Schema subset for untrusted MCP metadata.
 * No remote refs, regex/pattern/format, custom code, coercion or defaults are executed.
 */
export function cloneBoundedMcpJson(value: unknown, maxBytes: number): unknown {
  let nodes = 0, characters = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 16) throw new Error('MCP JSON exceeds depth/node limits.')
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item === 'string') { characters += item.length; if (characters > maxBytes) throw new Error('MCP JSON exceeds text limit.'); return item }
    if (!item || typeof item !== 'object') throw new Error('MCP JSON must be passive data.')
    if (Object.getOwnPropertySymbols(item).length) throw new Error('MCP symbols are not allowed.')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 256 || Object.keys(descriptors).length !== item.length + 1) throw new Error('Invalid bounded MCP array.')
      return Array.from({ length: item.length }, (_, i) => {
        const descriptor = descriptors[String(i)]
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid MCP array data.')
        return visit(descriptor.value, depth + 1)
      })
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('MCP JSON requires plain objects.')
    const entries = Object.entries(descriptors)
    if (entries.length > 256) throw new Error('MCP object exceeds key limit.')
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of entries) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Unsafe MCP object member.')
      characters += key.length
      out[key] = visit(descriptor.value, depth + 1)
    }
    return out
  }
  const result = visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) throw new Error('MCP JSON exceeds byte limit.')
  return result
}
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'enum', 'const', 'title', 'description', 'default', 'examples', '$schema', 'deprecated', 'readOnly', 'writeOnly'])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
export function prepareMcpSchema(value: unknown): Record<string, unknown> {
  const schema = cloneBoundedMcpJson(value, 24000)
  const check = (item: unknown, depth = 0): void => {
    if (!plain(item) || depth > 8 || Object.keys(item).some((key) => !keywords.has(key)) || typeof item.type !== 'string' || !types.has(item.type)) throw new Error('MCP schema uses an unsupported construct.')
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0)) throw new Error('Invalid MCP schema bound.')
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]))) throw new Error('Invalid MCP numeric bound.')
    if (item.enum !== undefined && (!Array.isArray(item.enum) || !item.enum.length || item.enum.length > 64)) throw new Error('Invalid MCP enum.')
    if (item.properties !== undefined) { if (!plain(item.properties) || item.type !== 'object') throw new Error('Invalid MCP properties.'); Object.values(item.properties).forEach((child) => check(child, depth + 1)) }
    if (item.required !== undefined && (!Array.isArray(item.required) || item.required.some((key) => typeof key !== 'string'))) throw new Error('Invalid MCP required fields.')
    if (item.additionalProperties !== undefined && typeof item.additionalProperties !== 'boolean') check(item.additionalProperties, depth + 1)
    if (item.items !== undefined) check(item.items, depth + 1)
    if (item.type === 'array' && item.items === undefined) throw new Error('MCP arrays require bounded item schemas.')
  }
  check(schema)
  if (!plain(schema) || schema.type !== 'object') throw new Error('MCP tool arguments must be an object.')
  return schema
}
export function assertMcpArguments(schema: Record<string, unknown>, args: unknown): void {
  const fail = (): never => { throw new Error('MCP arguments do not match the discovered supported schema.') }
  const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
    if (plain(a) && plain(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    return false
  }
  const check = (s: Record<string, unknown>, value: unknown): void => {
    if (Object.hasOwn(s, 'const') && !equal(s.const, value)) fail()
    if (Array.isArray(s.enum) && !s.enum.some((item) => equal(item, value))) fail()
    if (s.type === 'object') {
      if (!plain(value)) return fail()
      const properties = plain(s.properties) ? s.properties : {}
      if (Array.isArray(s.required) && s.required.some((key) => !Object.hasOwn(value, String(key)))) fail()
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) check(properties[key] as Record<string, unknown>, item)
        else if (s.additionalProperties === false) fail()
        else if (plain(s.additionalProperties)) check(s.additionalProperties, item)
      }
    } else if (s.type === 'array') {
      if (!Array.isArray(value)) return fail()
      if (value.length < Number(s.minItems ?? 0) || value.length > Number(s.maxItems ?? 256)) fail()
      value.forEach((item) => check(s.items as Record<string, unknown>, item))
    } else if (s.type === 'string') {
      if (typeof value !== 'string') return fail()
      const length = [...value].length
      if (length < Number(s.minLength ?? 0) || length > Number(s.maxLength ?? 32000)) fail()
    } else if (s.type === 'number' || s.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (s.type === 'integer' && !Number.isSafeInteger(value))) return fail()
      if (value < Number(s.minimum ?? -Infinity) || value > Number(s.maximum ?? Infinity) || (s.exclusiveMinimum !== undefined && value <= Number(s.exclusiveMinimum)) || (s.exclusiveMaximum !== undefined && value >= Number(s.exclusiveMaximum))) fail()
    } else if (s.type === 'boolean' ? typeof value !== 'boolean' : value !== null) fail()
  }
  check(schema, args)
}
