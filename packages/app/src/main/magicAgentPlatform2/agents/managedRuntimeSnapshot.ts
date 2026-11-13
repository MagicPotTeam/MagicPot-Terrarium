import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { canonicalPolicyJson } from '../../../shared/magicAgentPlatform2/policy'

export function invalidManagedRecording(detail: string): never { throw Error(`Invalid managed runtime recording: ${detail}.`) }
/** Detached plain data only; own undefined is material. Not a parser or approval. */
export function captureManagedData<T>(input: T): T {
  const ancestors = new Set<object>(); let nodes = 0, units = 0
  const visit = (value: unknown, depth: number, inArray = false): unknown => {
    if (++nodes > 65536 || depth > 32) invalidManagedRecording('snapshot bounds')
    if (typeof value === 'string') { units += value.length; if (units > 8 * 1024 * 1024) invalidManagedRecording('snapshot string bounds'); return value }
    if (value === undefined && !inArray || value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || isProxy(value)) invalidManagedRecording('plain snapshot data required')
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalidManagedRecording('plain snapshot prototype required')
    if (ancestors.has(value)) invalidManagedRecording('cyclic snapshot')
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
    if (keys.length > 65536 || keys.some(key => typeof key !== 'string')) invalidManagedRecording('snapshot fields')
    ancestors.add(value)
    try {
      if (array) {
        const length = descriptors.length.value as number
        if (length > 65536 || keys.length !== length + 1) invalidManagedRecording('dense snapshot arrays required')
        const result: unknown[] = []
        for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d?.enumerable || !('value' in d)) invalidManagedRecording('array accessors rejected'); result.push(visit(d.value, depth + 1, true)) }
        return Object.freeze(result)
      }
      // Existing Agent action validation requires Object.prototype objects. Own
      // descriptor writes below remain safe; reserved keys were rejected first.
      const result: Record<string, unknown> = {}
      for (const key of keys as string[]) {
        const d = descriptors[key]; units += key.length
        if (!d.enumerable || !('value' in d) || ['__proto__', 'prototype', 'constructor'].includes(key) || units > 8 * 1024 * 1024) invalidManagedRecording('snapshot fields must be own plain data, not accessors')
        Object.defineProperty(result, key, { value: visit(d.value, depth + 1), enumerable: true })
      }
      return Object.freeze(result)
    } finally { ancestors.delete(value) }
  }
  return visit(input, 0) as T
}
export const managedCanonical = (value: unknown): string => canonicalPolicyJson(value as never)
export const managedDigest = (domain: string, material: unknown): string => createHash('sha256').update(managedCanonical({ domain, material })).digest('hex')
/** Inspect without invoking accessors, proxies or inherited authority fields. */
export function managedOwnValues(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidManagedRecording('own plain request/options required')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidManagedRecording('request field')
    const d = Object.getOwnPropertyDescriptor(value, key)!
    if (!d.enumerable || !('value' in d)) invalidManagedRecording('request/options accessors rejected')
    Object.defineProperty(result, key, { value: d.value, enumerable: true })
  }
  return result
}
