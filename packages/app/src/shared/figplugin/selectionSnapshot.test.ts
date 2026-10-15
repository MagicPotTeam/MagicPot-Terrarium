import { createContext, Script } from 'node:vm'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import {
  checkFigPluginSelectionSnapshot,
  figPluginSelectionSnapshotSchema,
  FIGPLUGIN_SELECTION_SNAPSHOT_MAX_SELECTION,
  FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NODES,
  FIGPLUGIN_SELECTION_SNAPSHOT_MAX_DEPTH,
  FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NAME_BYTES,
  FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES,
  type FigPluginSelectionSnapshot
} from './selectionSnapshot'

const epoch = 'a'.repeat(32)
const value = (host: 'figma' | 'photoshop' = 'figma'): FigPluginSelectionSnapshot => ({
  protocol: 1,
  purpose: 'read-only-selection-review',
  host,
  complete: true,
  document: {
    id: host === 'figma' ? '0:0' : '1',
    idSource: host === 'figma' ? 'figma-plugin-root' : 'photoshop-open-document',
    openEpoch: epoch + ':1',
    openEpochSource: 'plugin-observation',
    pageId: host === 'figma' ? '0:1' : null
  },
  observation: { sequence: 1, source: 'capture-counter' },
  capabilities: {
    readSnapshot: true,
    writeCommands: [],
    authenticatedHost: false,
    nativeDocumentRevision: false,
    mutationExclusion: false,
    rollback: false,
    remoteMutationTracking: false
  },
  nodes: [
    {
      id: host === 'figma' ? '1:1' : '1',
      parentId: host === 'figma' ? '0:1' : null,
      kind: 'FRAME',
      name: '完整名字 😀',
      role: 'scene',
      visible: true,
      locked: false
    },
    ...(host === 'figma'
      ? [
          {
            id: '0:1',
            parentId: null,
            kind: 'PAGE',
            name: '页面',
            role: 'structural' as const,
            visible: null,
            locked: null
          }
        ]
      : [])
  ],
  selected: [
    {
      id: host === 'figma' ? '1:1' : '1',
      ancestors: host === 'figma' ? ['0:1'] : [],
      effectiveLocked: false,
      effectiveVisible: true
    }
  ]
})
const invalid = { ok: false, error: { code: 'INVALID_SNAPSHOT' } }
const check = checkFigPluginSelectionSnapshot
const bytes = (snapshot: unknown) => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength

function chain(depth: number, host: 'figma' | 'photoshop' = 'photoshop') {
  const snapshot = value(host)
  const target = snapshot.nodes[0]
  const terminal = host === 'figma' ? snapshot.nodes[1] : undefined
  snapshot.nodes = [target]
  snapshot.selected[0].ancestors = []
  for (let index = 0; index < depth - (terminal ? 1 : 0); index += 1) {
    const parent = {
      ...target,
      id: host === 'figma' ? `ancestor:${index}` : String(index + 2),
      parentId: null
    }
    snapshot.nodes.at(-1)!.parentId = parent.id
    snapshot.nodes.push(parent)
    snapshot.selected[0].ancestors.push(parent.id)
  }
  if (terminal) {
    snapshot.nodes.at(-1)!.parentId = terminal.id
    snapshot.nodes.push(terminal)
    snapshot.selected[0].ancestors.push(terminal.id)
  }
  return snapshot
}
function flat(count: number, name = '') {
  const snapshot = value('photoshop')
  snapshot.nodes = Array.from({ length: count }, (_, index) => ({
    ...snapshot.nodes[0],
    id: String(index + 1),
    name
  }))
  snapshot.selected = snapshot.nodes.map((node) => ({
    id: node.id,
    ancestors: [],
    effectiveLocked: false,
    effectiveVisible: true
  }))
  return snapshot
}

describe('strict read-only FIGPLUGIN selection snapshot v1 (no execution authority)', () => {
  it('exports the bounded contract and exact result type', () => {
    expect([
      FIGPLUGIN_SELECTION_SNAPSHOT_MAX_SELECTION,
      FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NODES,
      FIGPLUGIN_SELECTION_SNAPSHOT_MAX_DEPTH,
      FIGPLUGIN_SELECTION_SNAPSHOT_MAX_NAME_BYTES,
      FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES
    ]).toEqual([100, 512, 32, 4096, 256 * 1024])
    expectTypeOf(check).parameter(0).toEqualTypeOf<unknown>()
    expectTypeOf(
      figPluginSelectionSnapshotSchema._output
    ).toEqualTypeOf<FigPluginSelectionSnapshot>()
    const result = check(value())
    if (result.ok) expectTypeOf(result.snapshot).toEqualTypeOf<FigPluginSelectionSnapshot>()
  })
  it.each(['figma', 'photoshop'] as const)('accepts exact %s metadata and detaches it', (host) => {
    const input = value(host)
    input.nodes[0].name = '  中文😀'.repeat(150) + '\u0000\n\u202e e\u0301  '
    const before = structuredClone(input)
    const result = check(input)
    expect(result).toEqual({ ok: true, snapshot: input })
    expect(input).toEqual(before)
    if (result.ok) expect(result.snapshot).not.toBe(input)
    expect(figPluginSelectionSnapshotSchema.safeParse(input).success).toBe(true)
    expect(figPluginSelectionSnapshotSchema.parse(input)).toEqual(input)
  })
  it('accepts null-prototype data and empty selection without unrelated nodes', () => {
    const input = Object.assign(Object.create(null), value())
    input.nodes = []
    input.selected = []
    expect(check(input).ok).toBe(true)
  })
  it.each([
    { protocol: 2 },
    { purpose: 'execute' },
    { complete: false },
    { path: 'private' },
    { host: 'uxp' },
    { consent: true },
    { script: 'eval' },
    { sessionToken: 'secret' }
  ])('rejects extra fields and contract mismatches %j', (fields) => {
    expect(check({ ...value(), ...fields })).toEqual(invalid)
  })
  it.each([
    { readSnapshot: false },
    { writeCommands: ['node.rename'] },
    { authenticatedHost: true },
    { nativeDocumentRevision: true },
    { mutationExclusion: true },
    { rollback: true },
    { remoteMutationTracking: true },
    { execute: true }
  ])('rejects forged authority %j', (fields) => {
    const input = value()
    expect(check({ ...input, capabilities: { ...input.capabilities, ...fields } })).toEqual(invalid)
    expect(
      figPluginSelectionSnapshotSchema.safeParse({
        ...input,
        capabilities: { ...input.capabilities, ...fields }
      }).success
    ).toBe(false)
  })
  it.each([
    { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: 1.5 },
    { sequence: '1' },
    { source: 'native-revision' },
    { revision: 1 }
  ])('requires a positive safe capture counter, not a native revision %j', (fields) => {
    const input = value()
    expect(check({ ...input, observation: { ...input.observation, ...fields } })).toEqual(invalid)
  })
  it('accepts max safe capture count and at most 15-digit positive observed epoch counters', () => {
    const input = value('photoshop')
    input.observation.sequence = Number.MAX_SAFE_INTEGER
    input.document.openEpoch = epoch + ':999999999999999'
    expect(check(input).ok).toBe(true)
    for (const openEpoch of [
      epoch + ':0',
      epoch + ':01',
      epoch + ':1000000000000000',
      epoch.toUpperCase() + ':1',
      epoch + ':1\n',
      epoch + ':1:2'
    ]) {
      input.document.openEpoch = openEpoch
      expect(check(input)).toEqual(invalid)
    }
    const figma = value()
    figma.document.openEpoch = epoch + ':2'
    expect(check(figma)).toEqual(invalid)
  })
  it.each([
    { idSource: 'photoshop-open-document' },
    { pageId: null },
    { pageId: '0:0' },
    { openEpochSource: 'host-guaranteed' },
    { name: 'private' },
    { id: 1 }
  ])('enforces Figma document/page/source relationship %j', (fields) => {
    const input = value()
    expect(check({ ...input, document: { ...input.document, ...fields } })).toEqual(invalid)
  })
  it('enforces Photoshop canonical safe positive IDs without confusing document and layer namespaces', () => {
    const input = value('photoshop')
    expect(input.document.id).toBe(input.nodes[0].id)
    expect(check(input).ok).toBe(true)
    for (const id of ['0', '01', '-1', '1.0', '1e2', '9007199254740992', '1\n']) {
      input.document.id = id
      expect(check(input)).toEqual(invalid)
    }
    input.document.id = '1'
    input.document.pageId = '2'
    expect(check(input)).toEqual(invalid)
    input.document.pageId = null
    input.nodes[0].id = '01'
    input.selected[0].id = '01'
    expect(check(input)).toEqual(invalid)
  })
  it.each([
    { name: 1 },
    { id: 1 },
    { kind: null },
    { visible: null },
    { locked: undefined },
    { locked: 0 },
    { role: 'structural' },
    { parentId: 1 },
    { bounds: {} }
  ])('rejects scene type mismatches or unknown locks %j', (fields) => {
    const input = value()
    input.nodes[0] = { ...input.nodes[0], ...fields } as FigPluginSelectionSnapshot['nodes'][number]
    expect(check(input)).toEqual(invalid)
  })
  it('only allows the single Figma PAGE to be structural, with null visible/locked and parent', () => {
    for (const fields of [
      { visible: true },
      { locked: false },
      { kind: 'FRAME' },
      { parentId: '1:1' },
      { role: 'scene' }
    ]) {
      const input = value()
      Object.assign(input.nodes[1], fields)
      expect(check(input)).toEqual(invalid)
    }
    const input = value('photoshop')
    Object.assign(input.nodes[0], { kind: 'PAGE', role: 'structural', locked: null, visible: null })
    expect(check(input)).toEqual(invalid)
  })
  it.each(['\ud800', '\udfff', 'ok\ud800tail'])(
    'rejects invalid UTF-16 rather than replacing it %j',
    (name) => {
      const input = value()
      input.nodes[0].name = name
      expect(check(input)).toEqual(invalid)
    }
  )
  it('uses exact UTF-8 limits for original names, kind and IDs (no trim or control removal)', () => {
    const input = value()
    input.nodes[0].name = '😀'.repeat(1024)
    expect(check(input).ok).toBe(true)
    input.nodes[0].name += 'x'
    expect(check(input)).toEqual(invalid)
    input.nodes[0].name = ''
    input.nodes[0].kind = '界'.repeat(42) + 'xx'
    expect(check(input).ok).toBe(true)
    input.nodes[0].kind += 'x'
    expect(check(input)).toEqual(invalid)
    input.nodes[0].kind = 'FRAME'
    input.document.id = '界'.repeat(85) + 'x'
    expect(check(input).ok).toBe(true)
    input.document.id += 'x'
    expect(check(input)).toEqual(invalid)
  })
  it('accepts 100 but rejects 101 before touching any array item accessor', () => {
    expect(check(flat(100)).ok).toBe(true)
    const input = flat(100)
    let calls = 0
    Object.defineProperty(input.selected, '100', {
      get: () => {
        calls += 1
        throw new Error('PRIVATE')
      },
      enumerable: true
    })
    expect(check(input)).toEqual({ ok: false, error: { code: 'SELECTION_TOO_LARGE' } })
    expect(calls).toBe(0)
  })
  it.each(['figma', 'photoshop'] as const)(
    'bounds exact %s ancestry at 32 and rejects 33',
    (host) => {
      expect(check(chain(32, host)).ok).toBe(true)
      expect(check(chain(33, host))).toEqual({ ok: false, error: { code: 'ANCESTRY_TOO_DEEP' } })
    }
  )
  it('bounds unique nodes before materializing arrays', () => {
    const input = value()
    const nodes = new Array(513)
    let calls = 0
    Object.defineProperty(nodes, '0', {
      get: () => {
        calls += 1
        throw new Error('PRIVATE')
      },
      enumerable: true
    })
    expect(check({ ...input, nodes })).toEqual({ ok: false, error: { code: 'TOO_MANY_NODES' } })
    expect(calls).toBe(0)
  })
  it('accepts all 512 related nodes with bounded branches', () => {
    const input = value('photoshop')
    input.nodes = []
    input.selected = []
    let next = 1
    for (let branch = 0; branch < 16; branch += 1) {
      const part = chain(31)
      const map = new Map(part.nodes.map((node) => [node.id, String(next++)]))
      for (const node of part.nodes) {
        input.nodes.push({
          ...node,
          id: map.get(node.id)!,
          parentId: node.parentId === null ? null : map.get(node.parentId)!
        })
      }
      input.selected.push({
        ...part.selected[0],
        id: map.get(part.selected[0].id)!,
        ancestors: part.selected[0].ancestors.map((id) => map.get(id)!)
      })
    }
    expect(input.nodes).toHaveLength(512)
    expect(check(input).ok).toBe(true)
  })
  it('rejects total serialized bytes, including JSON control-character escaping', () => {
    expect(check(flat(70, 'x'.repeat(4096)))).toEqual({
      ok: false,
      error: { code: 'SNAPSHOT_TOO_LARGE' }
    })
    const input = flat(15, '\u0000'.repeat(4096))
    expect(bytes(input)).toBeGreaterThan(FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES)
    expect(check(input)).toEqual({ ok: false, error: { code: 'SNAPSHOT_TOO_LARGE' } })
  })
  it('accepts exactly 256KiB and rejects one byte more', () => {
    const input = flat(100)
    let left = FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES - bytes(input)
    for (const node of input.nodes) {
      const count = Math.min(4096, left)
      node.name = 'x'.repeat(count)
      left -= count
    }
    expect(left).toBe(0)
    expect(bytes(input)).toBe(FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES)
    expect(check(input).ok).toBe(true)
    input.nodes.at(-1)!.name += 'x'
    expect(check(input)).toEqual({ ok: false, error: { code: 'SNAPSHOT_TOO_LARGE' } })
  })
  it('validates exact pointer chains, effective lock OR and visibility AND', () => {
    const input = chain(3)
    input.nodes[1].locked = true
    input.nodes[2].visible = false
    input.selected[0].effectiveLocked = true
    input.selected[0].effectiveVisible = false
    expect(check(input).ok).toBe(true)
    input.selected[0].effectiveLocked = false
    expect(check(input)).toEqual(invalid)
    input.selected[0].effectiveLocked = true
    input.selected[0].effectiveVisible = true
    expect(check(input)).toEqual(invalid)
    input.selected[0].effectiveVisible = false
    input.selected[0].ancestors.reverse()
    expect(check(input)).toEqual(invalid)
  })
  it('rejects duplicates, cycles, missing parents, wrong page and every unrelated/orphan node', () => {
    for (const mutate of [
      (input: FigPluginSelectionSnapshot) => input.nodes.push({ ...input.nodes[0] }),
      (input: FigPluginSelectionSnapshot) => input.selected.push({ ...input.selected[0] }),
      (input: FigPluginSelectionSnapshot) => {
        input.nodes[0].parentId = input.nodes[0].id
      },
      (input: FigPluginSelectionSnapshot) => {
        input.nodes[0].parentId = 'missing'
      },
      (input: FigPluginSelectionSnapshot) => {
        input.nodes[0].parentId = null
      },
      (input: FigPluginSelectionSnapshot) => {
        input.selected[0].ancestors = []
      },
      (input: FigPluginSelectionSnapshot) => {
        input.selected[0].id = '0:1'
      },
      (input: FigPluginSelectionSnapshot) => {
        input.nodes[0].id = input.document.id
      },
      (input: FigPluginSelectionSnapshot) =>
        input.nodes.push({ ...input.nodes[0], id: 'unrelated' }),
      (input: FigPluginSelectionSnapshot) => {
        input.selected = []
      }
    ]) {
      const input = value()
      mutate(input)
      expect(check(input)).toEqual(invalid)
    }
  })
  it('shares ancestors without treating a selected ancestor as unrelated', () => {
    const input = chain(2)
    input.selected.push({
      id: input.nodes[1].id,
      ancestors: [input.nodes[2].id],
      effectiveLocked: false,
      effectiveVisible: true
    })
    expect(check(input).ok).toBe(true)
  })
  it('rejects accessors and JSON hooks without invoking them, at all input levels', () => {
    for (const target of ['root', 'node', 'array'] as const) {
      const input = value()
      let calls = 0
      const object = target === 'root' ? input : target === 'node' ? input.nodes[0] : input.nodes
      const key = target === 'root' ? 'host' : target === 'node' ? 'name' : '0'
      Object.defineProperty(object, key, {
        get: () => {
          calls += 1
          throw new Error('PRIVATE')
        },
        enumerable: true
      })
      expect(check(input)).toEqual(invalid)
      expect(figPluginSelectionSnapshotSchema.safeParse(input).success).toBe(false)
      expect(calls).toBe(0)
    }
    let calls = 0
    expect(
      check({
        ...value(),
        toJSON: () => {
          calls += 1
          return value()
        }
      })
    ).toEqual(invalid)
    expect(calls).toBe(0)
  })
  it('descriptor ingress precedes Zod promise probing, including direct async schema callers', async () => {
    const input = value()
    let calls = 0
    Object.defineProperty(input, 'then', {
      get() {
        calls += 1
        throw new Error('PRIVATE')
      },
      enumerable: true
    })
    expect(check(input)).toEqual(invalid)
    expect(figPluginSelectionSnapshotSchema.safeParse(input).success).toBe(false)
    expect((await figPluginSelectionSnapshotSchema.safeParseAsync(input)).success).toBe(false)
    expect(() => figPluginSelectionSnapshotSchema.parse(input)).toThrow('INVALID_SNAPSHOT')
    expect(calls).toBe(0)
  })
  it('rejects nonplain objects, object cycles, sparse/extra/symbol fields and throwing reflection safely', () => {
    const cyclic = value()
    Object.assign(cyclic.nodes[0], { name: cyclic })
    const extra = value()
    Object.assign(extra.nodes, { extra: true })
    const symbol = value()
    Object.assign(symbol, { [Symbol('secret')]: true })
    const hidden = value()
    Object.defineProperty(hidden, 'private', { value: 'secret' })
    const sparse = value()
    delete (sparse.nodes as unknown[])[0]
    class HostData {
      snapshot = value()
    }
    for (const input of [
      cyclic,
      extra,
      symbol,
      hidden,
      sparse,
      new HostData(),
      new Date(),
      new Proxy(value(), {
        ownKeys: () => {
          throw new Error('PRIVATE HOST NAME')
        }
      })
    ]) {
      expect(check(input)).toEqual(invalid)
    }
  })
  it.each(['figma', 'photoshop'] as const)(
    'cross-validates the real IIFE %s VM output with shared schema',
    async (host) => {
      const source = readFileSync(
        path.resolve(process.cwd(), 'packages/figplugin-hosts/shared/selection-snapshot.js'),
        'utf8'
      )
      const context = createContext({}, { codeGeneration: { strings: false, wasm: false } })
      new Script(source).runInContext(context, { timeout: 1000 })
      const root = { id: '0:0', type: 'DOCUMENT' }
      const page = {
        id: '0:1',
        type: 'PAGE',
        name: '页面',
        parent: root,
        selection: [] as object[]
      }
      const document = { id: 1, activeLayers: [] as object[] }
      const name = '中文😀'.repeat(150) + '\u0000\n'
      const node =
        host === 'figma'
          ? { id: '1:1', type: 'FRAME', name, visible: true, locked: false, parent: page }
          : {
              id: 1,
              kind: 'pixel',
              name,
              visible: true,
              allLocked: false,
              pixelsLocked: false,
              positionLocked: false,
              transparentPixelsLocked: false,
              isBackgroundLayer: false,
              document,
              parent: null
            }
      page.selection = [node]
      document.activeLayers = [node]
      const api = context.MagicPotSelectionSnapshotV1
      const reader =
        host === 'figma'
          ? api.createFigmaReader({ figma: { root, currentPage: page }, instanceEpoch: epoch })
          : api.createPhotoshopReader({
              app: { activeDocument: document, documents: [document] },
              instanceEpoch: epoch
            })
      const captured = JSON.parse(JSON.stringify(reader.capture()))
      expect(captured.ok).toBe(true)
      expect(check(captured.snapshot)).toEqual(captured)
      expect(figPluginSelectionSnapshotSchema.safeParse(captured.snapshot).success).toBe(true)
      expect(captured.snapshot.nodes[0].name).toBe(name)
    }
  )
})
