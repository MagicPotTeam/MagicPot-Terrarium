import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertCanvasImportFileSize,
  CANVAS_IMPORT_PREFLIGHT_LIMITS as limits,
  parseCanvasImportText
} from './canvasImportPreflight'

const message = 'Invalid or oversized MagicPot canvas import'
const item = () => ({ id: 'text-a', type: 'text', text: 'Synthetic import', x: 0, y: 0 })
const payload = () => ({ magic: 'MAGICPOT_CANVAS', version: 8, createdAt: 'synthetic', items: [item()] })
const empty = () => ({ magic: 'MAGICPOT_CANVAS', version: 8, createdAt: 'synthetic', items: [] })
const encodedZeros = (bytes: number) => 'AAAA'.repeat(Math.floor(bytes / 3)) + ['', 'AA==', 'AAA='][bytes % 3]
const blob = (base64 = 'AQ==') => ({ base64, mimeType: 'application/octet-stream' })
function expectRejected(value: unknown) {
  expect(() => parseCanvasImportText(JSON.stringify(value))).toThrowError(message)
}
function nested(depth: number): unknown {
  let value: unknown = 0
  for (let i = 1; i < depth; i++) value = { child: value }
  return value
}

afterEach(() => vi.restoreAllMocks())

describe('explicit canvas import supplied-text preflight, not a full canvas codec', () => {
  it('publishes frozen deliberate application budgets', () => {
    expect(Object.isFrozen(limits)).toBe(true)
    expect(limits).toEqual({ maxFileBytes: 67108864, maxTextBytes: 67108864, maxItems: 10000,
      maxGroups: 10000, maxGroupBranches: 10000, maxBlobEntries: 4096, maxTexturesPerItem: 4096,
      maxDepth: 64, maxNodes: 100000, maxIdentityCodeUnits: 1024, maxMimeCodeUnits: 1024,
      maxAssetBytes: 16777216, maxTotalAssetBytes: 33554432 })
  })
  for (const [name, size] of [['missing', undefined], ['zero', 0], ['maximum', limits.maxFileBytes]] as const) {
    it(`accepts ${name} advertised file size without requiring a genuine File`, () => {
      expect(() => assertCanvasImportFileSize(size)).not.toThrow()
    })
  }
  for (const [name, size] of [
    ['over cap', limits.maxFileBytes + 1], ['negative', -1], ['fractional', 0.5], ['NaN', NaN],
    ['infinite', Infinity], ['null', null], ['string', '1'], ['boolean', true], ['bigint', 1n]
  ] as const) {
    it(`rejects ${name} advertised file size with fixed pathless error`, () => {
      expect(() => assertCanvasImportFileSize(size)).toThrowError(message)
    })
  }
  it('does not coerce an advertised size object', () => {
    const coerce = vi.fn(() => 1)
    expect(() => assertCanvasImportFileSize({ valueOf: coerce })).toThrowError(message)
    expect(coerce).not.toHaveBeenCalled()
  })
  for (const [name, value] of [['undefined', undefined], ['null', null], ['number', 1], ['boolean', true], ['boxed', Object('{}')]] as const) {
    it(`rejects ${name} nonprimitive text before JSON.parse`, () => {
      const parse = vi.spyOn(JSON, 'parse')
      expect(() => parseCanvasImportText(value)).toThrowError(message)
      expect(parse).not.toHaveBeenCalled()
    })
  }
  it('does not coerce a text object', () => {
    const coerce = vi.fn(() => JSON.stringify(payload()))
    const parse = vi.spyOn(JSON, 'parse')
    expect(() => parseCanvasImportText({ toString: coerce })).toThrowError(message)
    expect(coerce).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled()
  })
  it('rejects oversized code units before encoding or parsing (parse boundary stubbed)', () => {
    const text = ' '.repeat(limits.maxTextBytes + 1)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(empty())
    expect(() => parseCanvasImportText(text)).toThrowError(message)
    expect(encode).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled()
  })
  it('rejects UTF8 overflow after cheap length admission but before parsing (parse boundary stubbed)', () => {
    const text = 'é'.repeat(Math.floor(limits.maxTextBytes / 2) + 1)
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(empty())
    expect(text.length).toBeLessThan(limits.maxTextBytes)
    expect(() => parseCanvasImportText(text)).toThrowError(message)
    expect(parse).not.toHaveBeenCalled()
  })
  it('accepts exact ASCII text-byte boundary without a reviver (parse boundary stubbed)', () => {
    const data = empty(), json = JSON.stringify(data)
    const text = json + ' '.repeat(limits.maxTextBytes - json.length)
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(data)
    expect(parseCanvasImportText(text)).toBe(data)
    expect(parse).toHaveBeenCalledExactlyOnceWith(text)
  })
  it('accepts exact multibyte text-byte boundary (parse boundary stubbed)', () => {
    const data = empty(), prefix = JSON.stringify(data).slice(0, -1) + ',"unknown":"'
    const suffix = '"}', remaining = limits.maxTextBytes - prefix.length - suffix.length
    const text = prefix + 'é'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'a' : '') + suffix
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(data)
    expect(parseCanvasImportText(text)).toBe(data); expect(parse).toHaveBeenCalledExactlyOnceWith(text)
  })
  for (const [name, text] of [['empty', ''], ['truncated', '{"magic":'], ['invalid token', 'private-path-is-not-json']] as const) {
    it(`normalizes ${name} parse failure to fresh fixed error without raw diagnostics`, () => {
      let first: unknown, second: unknown
      try { parseCanvasImportText(text) } catch (error) { first = error }
      try { parseCanvasImportText(text) } catch (error) { second = error }
      expect(first).toBeInstanceOf(Error); expect((first as Error).message).toBe(message)
      expect(second).toBeInstanceOf(Error); expect(second).not.toBe(first)
    })
  }
  it('parses once and returns unknown metadata without normalization or additional serialization', () => {
    const source = JSON.stringify({ ...payload(), metadata: { future: ['untouched', null], html: '<script>not validated</script>' } })
    const parse = vi.spyOn(JSON, 'parse'), stringify = vi.spyOn(JSON, 'stringify')
    const result = parseCanvasImportText(source)
    expect(parse).toHaveBeenCalledExactlyOnceWith(source); expect(stringify).not.toHaveBeenCalled()
    expect(result).toEqual({ ...payload(), metadata: { future: ['untouched', null], html: '<script>not validated</script>' } })
  })
  for (const version of [3, 7, 8, 999, -1, 0, null, 'future', true]) {
    it(`preserves primitive version label ${String(version)} without claiming format-version support`, () => {
      const data = { ...payload(), version }
      expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    })
  }
  it('accepts absent version/createdAt labels and legacy absent optional fields', () => {
    const data = { magic: 'MAGICPOT_CANVAS', items: [item()] }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
  })
  it('keeps storageMode fallback, legacy qapp and optional provenance metadata untouched', () => {
    const data = { ...payload(), storageMode: 'future-mode', groups: null, groupBranches: null, blobs: null,
      currentQAppKey: 'ignored-by-explicit-import', qAppCache: { legacy: {} }, provenance: { arbitrary: [true, 1] } }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
  })
  for (const [name, value] of [['null root', null], ['array root', []], ['primitive root', 1], ['wrong magic', { ...payload(), magic: 'OTHER' }],
    ['missing items', { magic: 'MAGICPOT_CANVAS' }], ['nonarray items', { ...payload(), items: {} }],
    ['object version label', { ...payload(), version: {} }], ['array createdAt label', { ...payload(), createdAt: [] }]] as const) {
    it(`rejects ${name} envelope`, () => expectRejected(value))
  }
  for (const [name, value] of [['null', null], ['array', []], ['number', 1], ['missing id', { type: 'text' }],
    ['empty id', { id: '', type: 'text' }], ['nonstr id', { id: 1, type: 'text' }], ['unknown type', { id: 'a', type: 'future' }],
    ['oversized id', { id: 'a'.repeat(limits.maxIdentityCodeUnits + 1), type: 'text' }]] as const) {
    it(`rejects ${name} item before any restoration`, () => expectRejected({ ...empty(), items: [value] }))
  }
  it('accepts all seven discriminants without pretending to validate every subtype field', () => {
    const items = ['image', 'model3d', 'video', 'file', 'text', 'annotation', 'html'].map((type) => ({ id: type, type }))
    expect(parseCanvasImportText(JSON.stringify({ ...empty(), items }))).toEqual({ ...empty(), items })
  })
  for (const type of ['image', 'model3d', 'video', 'file']) {
    it(`rejects nonstring ${type} source but preserves absent/null/empty sources`, () => {
      expectRejected({ ...empty(), items: [{ id: 'a', type, src: {} }] })
      for (const src of [undefined, null, '']) {
        const data = { ...empty(), items: [{ id: 'a', type, ...(src !== undefined ? { src } : {}) }] }
        expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
      }
    })
  }
  it('rejects nonfinite numbers even in unknown metadata after JSON.parse', () => {
    const text = JSON.stringify(empty()).slice(0, -1) + ',"metadata":{"value":1e999}}'
    expect(() => parseCanvasImportText(text)).toThrowError(message)
  })
  it('counts root/property/array-element values inclusively and rejects only after maxNodes', () => {
    const data = { ...empty(), extra: Array(limits.maxNodes - 6).fill(null) }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...data, extra: [...data.extra, null] })
  })
  it('counts cumulative values across many sibling subtrees at the exact limit and one beyond', () => {
    // Six envelope values; each sibling contributes its record, leaves array and leaf values.
    const subtrees = Array.from({ length: 100 }, (_, index) => ({ leaves: Array(index === 99 ? 992 : 998).fill(null) }))
    const data = { ...empty(), extra: subtrees }
    expect(6 + subtrees.reduce((sum, subtree) => sum + 2 + subtree.leaves.length, 0)).toBe(100000)
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    // The first sibling is expanded last by the LIFO walker, after the other 99 subtrees.
    subtrees[0].leaves.push(null)
    expect(6 + subtrees.reduce((sum, subtree) => sum + 2 + subtree.leaves.length, 0)).toBe(100001)
    expectRejected(data)
  })
  it('applies depth to primitives at the exact inclusive limit', () => {
    const data = { ...empty(), extra: nested(limits.maxDepth) }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...empty(), extra: nested(limits.maxDepth + 1) })
  })
  for (const [name, key, maximum] of [['items', 'items', limits.maxItems], ['groups', 'groups', limits.maxGroups], ['branches', 'groupBranches', limits.maxGroupBranches]] as const) {
    it(`enforces inclusive ${name} count without requiring unique IDs or referential integrity`, () => {
      const value = key === 'items' ? item() : key === 'groups' ? { id: 'g', itemIds: [] } : { id: 'b' }
      const data = { ...empty(), [key]: Array(maximum).fill(value) }
      expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
      expectRejected({ ...data, [key]: Array(maximum + 1).fill(value) })
    })
  }
  for (const [name, groups] of [['nonarray', {}], ['null entry', [null]], ['array entry', [[]]], ['missing id', [{ itemIds: [] }]],
    ['nonarray members', [{ id: 'g', itemIds: {} }]], ['nonstr member', [{ id: 'g', itemIds: [1] }]],
    ['empty member', [{ id: 'g', itemIds: [''] }]], ['oversized member', [{ id: 'g', itemIds: ['a'.repeat(1025)] }]],
    ['nonstr name', [{ id: 'g', itemIds: [], name: 1 }]], ['object createdAt', [{ id: 'g', itemIds: [], createdAt: {} }]]] as const) {
    it(`rejects ${name} group container consumed by append normalization`, () => expectRejected({ ...empty(), groups }))
  }
  it('bounds group membership independently', () => {
    const data = { ...empty(), groups: [{ id: 'g', itemIds: Array(limits.maxItems).fill('orphan') }] }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...data, groups: [{ id: 'g', itemIds: Array(limits.maxItems + 1).fill('orphan') }] })
  })
  for (const [name, groupBranches] of [['nonarray', {}], ['null entry', [null]], ['empty id', [{ id: '' }]],
    ['nonstr name', [{ id: 'b', name: {} }]], ['array createdAt', [{ id: 'b', createdAt: [] }]]] as const) {
    it(`rejects ${name} branch container`, () => expectRejected({ ...empty(), groupBranches }))
  }
  for (const [name, textures] of [['array', []], ['string', 'bad'], ['null entry', { a: null }], ['nonstr entry', { a: 1 }],
    ['empty key', { '': '' }], ['long key', { ['a'.repeat(1025)]: '' }]] as const) {
    it(`rejects ${name} model texture map`, () => expectRejected({ ...empty(), items: [{ id: 'model', type: 'model3d', textures }] }))
  }
  it('bounds texture maps inclusively without validating source schemes', () => {
    const textures = Object.fromEntries(Array.from({ length: limits.maxTexturesPerItem }, (_, i) => ['t' + i, '']))
    const data = { ...empty(), items: [{ id: 'model', type: 'model3d', textures }] }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...empty(), items: [{ id: 'model', type: 'model3d', textures: { ...textures, extra: '' } }] })
  })
  for (const [name, blobs] of [['array', []], ['string', 'bad'], ['null entry', { a: null }], ['array entry', { a: [] }],
    ['missing base64', { a: { mimeType: '' } }], ['nonstr base64', { a: { base64: 1, mimeType: '' } }],
    ['missing mime', { a: { base64: '' } }], ['nonstr mime', { a: { base64: '', mimeType: 1 } }],
    ['long mime', { a: { base64: '', mimeType: 'a'.repeat(1025) } }], ['empty key', { '': blob() }],
    ['long key', { ['a'.repeat(1025)]: blob() }]] as const) {
    it(`rejects ${name} embedded container`, () => expectRejected({ ...empty(), blobs }))
  }
  it('bounds blob count inclusively and preserves unreferenced valid entries', () => {
    const blobs = Object.fromEntries(Array.from({ length: limits.maxBlobEntries }, (_, i) => ['b' + i, blob('')]))
    const data = { ...empty(), blobs }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...data, blobs: { ...blobs, extra: blob('') } })
  })
  for (const role of ['item ID', 'group ID', 'branch ID', 'group member ID', 'blob key', 'texture key']) {
    it(`accepts exactly 1024 code units and rejects one beyond for ${role}`, () => {
      const dataFor = (value: string): unknown => {
        switch (role) {
          case 'item ID': return { ...empty(), items: [{ ...item(), id: value }] }
          case 'group ID': return { ...empty(), groups: [{ id: value, itemIds: [] }] }
          case 'branch ID': return { ...empty(), groupBranches: [{ id: value }] }
          case 'group member ID': return { ...empty(), groups: [{ id: 'g', itemIds: [value] }] }
          case 'blob key': return { ...empty(), blobs: { [value]: blob('') } }
          case 'texture key': return { ...empty(), items: [{ id: 'm', type: 'model3d', textures: { [value]: '' } }] }
          default: throw new Error('Unrecognized fixture role')
        }
      }
      const boundary = 'é'.repeat(1024), data = dataFor(boundary)
      expect(boundary.length).toBe(limits.maxIdentityCodeUnits)
      expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
      expectRejected(dataFor(boundary + 'a'))
    })
  }
  it('accepts exact 1024-code-unit MIME metadata and rejects one additional unit without MIME normalization', () => {
    const mimeType = 'é'.repeat(1024), data = { ...empty(), blobs: { a: { base64: '', mimeType } } }
    expect(mimeType.length).toBe(limits.maxMimeCodeUnits)
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...empty(), blobs: { a: { base64: '', mimeType: mimeType + 'a' } } })
  })
  for (const [name, base64] of [['empty', ''], ['padded', 'AQ=='], ['unpadded two', 'AQ'], ['unpadded three', 'AAA'],
    ['full quartet', 'AAAA'], ['nonzero padbits', 'AR=='], ['ASCII whitespace', ' A\tQ\n=\f=\r ']] as const) {
    it(`preserves forgiving atob-compatible ${name} base64 without decoding`, () => {
      const decode = vi.spyOn(globalThis, 'atob')
      const data = { ...empty(), blobs: { orphan: blob(base64) } }
      expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data); expect(decode).not.toHaveBeenCalled()
    })
  }
  for (const [name, base64] of [['remainder one', 'A'], ['short padding', 'AQ='], ['excess padding', 'AQ==='],
    ['embedded padding', 'AQ==AA'], ['leading padding', '=AAA'], ['URL safe', 'AA-_'], ['vertical tab', 'AQ\v=='],
    ['NBSP', 'AQ\u00a0=='], ['nonalphabet', 'AQ!'], ['too much quartet padding', 'AAAA=']] as const) {
    it(`rejects ${name} base64 syntax before atob`, () => {
      const decode = vi.spyOn(globalThis, 'atob')
      expectRejected({ ...empty(), blobs: { first: blob(), last: blob(base64) } })
      expect(decode).not.toHaveBeenCalled()
    })
  }
  it('admits exact per-asset decoded budget and rejects one decoded byte more without decoding', () => {
    const decode = vi.spyOn(globalThis, 'atob')
    const data = { ...empty(), blobs: { orphan: blob(encodedZeros(limits.maxAssetBytes)) } }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...empty(), blobs: { orphan: blob(encodedZeros(limits.maxAssetBytes + 1)) } })
    expect(decode).not.toHaveBeenCalled()
  })
  it('admits aggregate decoded boundary and rejects one byte more across all entries before decoding', () => {
    const decode = vi.spyOn(globalThis, 'atob'), base64 = encodedZeros(limits.maxAssetBytes)
    const data = { ...empty(), blobs: { a: blob(base64), b: blob(base64) } }
    expect(parseCanvasImportText(JSON.stringify(data))).toEqual(data)
    expectRejected({ ...data, blobs: { ...data.blobs, final: blob() } })
    expect(decode).not.toHaveBeenCalled()
  })
})
