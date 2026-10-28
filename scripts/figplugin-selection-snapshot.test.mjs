import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'

// Fixture-only tests: no native hosts, user data, filesystem writes or transport.
const helper = new URL('../packages/figplugin-hosts/shared/selection-snapshot.js', import.meta.url)
let source
try {
  source = readFileSync(helper, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const epoch = 'a'.repeat(32)
const plain = (value) => JSON.parse(JSON.stringify(value))

function fixture(host) {
  assert.equal(typeof source, 'string', 'selection snapshot core missing')
  const violations = []
  const reads = []
  const originals = new WeakMap()
  const deny = (key) => {
    violations.push(String(key))
    throw new Error('MARKER HOST NAME /fixture/path ' + String(key))
  }
  const guard = (raw) => {
    const proxy = new Proxy(raw, {
      get(target, key) {
        reads.push(String(key))
        if (!Object.hasOwn(target, key)) return deny(key)
        return Reflect.get(target, key)
      },
      set(_target, key) {
        return deny('write:' + String(key))
      },
      defineProperty(_target, key) {
        return deny('define:' + String(key))
      },
      deleteProperty(_target, key) {
        return deny('delete:' + String(key))
      }
    })
    originals.set(proxy, raw)
    return proxy
  }
  const patch = (value, changes) => Object.assign(originals.get(value), changes)
  const collection = (items, length = items.length, onRead = () => {}) =>
    new Proxy(
      { length },
      {
        get(target, key) {
          if (key === 'length') return target.length
          if (!/^(0|[1-9][0-9]*)$/.test(String(key))) return deny('collection:' + String(key))
          onRead(Number(key))
          return items[Number(key)]
        },
        set(_target, key) {
          return deny('collection-write:' + String(key))
        }
      }
    )
  const root = guard({ id: '0:0', type: 'DOCUMENT' })
  const page = guard({ id: '0:1', type: 'PAGE', name: '测试 page', parent: root, selection: [] })
  const doc = guard({ id: 1, name: 'PRIVATE document name', activeLayers: [] })
  const scene = (id, parent = host === 'figma' ? page : null, changes = {}, owner = doc) =>
    guard(
      host === 'figma'
        ? {
            id: String(id),
            type: 'FRAME',
            name: '节点 😀',
            visible: true,
            locked: false,
            parent,
            ...changes
          }
        : {
            id,
            kind: 'pixel',
            name: '节点 😀',
            visible: true,
            allLocked: false,
            pixelsLocked: false,
            positionLocked: false,
            transparentPixelsLocked: false,
            isBackgroundLayer: false,
            document: owner,
            parent,
            ...changes
          }
    )
  const node = scene(host === 'figma' ? '1:1' : 1)
  patch(page, { selection: collection([node]) })
  patch(doc, { activeLayers: collection([node]) })
  const native = guard(
    host === 'figma'
      ? { root, currentPage: page }
      : { activeDocument: doc, documents: collection([doc]) }
  )
  const globals = {}
  for (const key of [
    'fetch',
    'require',
    'XMLHttpRequest',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'crypto',
    'console',
    'setTimeout',
    'setInterval'
  ]) {
    Object.defineProperty(globals, key, { get: () => deny('global:' + key), configurable: true })
  }
  const context = createContext(globals, { codeGeneration: { strings: false, wasm: false } })
  const before = new Script('Object.getOwnPropertyNames(globalThis)').runInContext(context)
  new Script(source, { filename: helper.pathname }).runInContext(context, { timeout: 1000 })
  const api = context.MagicPotSelectionSnapshotV1
  assert.ok(api, 'fixed snapshot API missing')
  assert.deepEqual(
    plain(new Script('Object.getOwnPropertyNames(globalThis)').runInContext(context)).sort(),
    [...plain(before), 'MagicPotSelectionSnapshotV1'].sort()
  )
  const reader =
    host === 'figma'
      ? api.createFigmaReader({ figma: native, instanceEpoch: epoch })
      : api.createPhotoshopReader({ app: native, instanceEpoch: epoch })
  assert.equal(reads.length, 0, 'creating a reader must not read the host')
  return {
    host,
    api,
    reader,
    context,
    violations,
    reads,
    root,
    page,
    doc,
    node,
    native,
    scene,
    guard,
    patch,
    collection,
    select(items, length, onRead) {
      patch(host === 'figma' ? page : doc, {
        [host === 'figma' ? 'selection' : 'activeLayers']: collection(items, length, onRead)
      })
    },
    capture: () => plain(reader.capture()),
    clean: () => assert.deepEqual(violations, [])
  }
}
function failure(result, code) {
  assert.equal(result.ok, false)
  assert.deepEqual(Object.keys(result).sort(), ['error', 'ok'])
  assert.deepEqual(Object.keys(result.error), ['code'])
  assert.match(result.error.code, /^[A-Z][A-Z_]*$/)
  if (code) assert.equal(result.error.code, code)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|节点|path|HOST NAME/)
}
function success(f) {
  const result = f.capture()
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.snapshot
}

test('helper file exists before read-only snapshot integration', () => {
  assert.equal(typeof source, 'string', 'selection snapshot helper file absent')
})
test('fixed IIFE API is frozen, non-replaceable and installs no other globals', () => {
  const f = fixture('figma')
  assert.deepEqual(Object.keys(f.api).sort(), ['createFigmaReader', 'createPhotoshopReader'])
  assert.equal(Object.isFrozen(f.api), true)
  assert.equal(Object.isFrozen(f.reader), true)
  const descriptor = Object.getOwnPropertyDescriptor(f.context, 'MagicPotSelectionSnapshotV1')
  assert.equal(descriptor.writable, false)
  assert.equal(descriptor.configurable, false)
  assert.equal(descriptor.enumerable, false)
  new Script(source).runInContext(f.context)
  assert.equal(f.context.MagicPotSelectionSnapshotV1, f.api)
  f.clean()
})

for (const host of ['figma', 'photoshop']) {
  test(`${host}: exact long Unicode/control names, normalized ancestor locks and visibility`, () => {
    const f = fixture(host)
    const name = '  中文😀'.repeat(150) + '\u0000\n\u202e e\u0301  '
    const parent = f.scene(
      host === 'figma' ? 'parent' : 2,
      undefined,
      host === 'figma' ? { locked: true, visible: false } : { pixelsLocked: true, visible: false }
    )
    f.patch(f.node, { name, parent })
    const snapshot = success(f)
    assert.equal(snapshot.protocol, 1)
    assert.equal(snapshot.purpose, 'read-only-selection-review')
    assert.equal(snapshot.complete, true)
    assert.equal(snapshot.nodes[0].name, name)
    assert.deepEqual(snapshot.selected[0], {
      id: host === 'figma' ? '1:1' : '1',
      ancestors: host === 'figma' ? ['parent', '0:1'] : ['2'],
      effectiveLocked: true,
      effectiveVisible: false
    })
    assert.deepEqual(snapshot.capabilities, {
      readSnapshot: true,
      writeCommands: [],
      authenticatedHost: false,
      nativeDocumentRevision: false,
      mutationExclusion: false,
      rollback: false,
      remoteMutationTracking: false
    })
    assert.equal(snapshot.document.openEpoch, epoch + ':1')
    assert.equal(snapshot.document.openEpochSource, 'plugin-observation')
    assert.equal(
      snapshot.document.idSource,
      host === 'figma' ? 'figma-plugin-root' : 'photoshop-open-document'
    )
    assert.equal(snapshot.observation.sequence, 1)
    assert.equal(snapshot.observation.source, 'capture-counter')
    assert.equal(success(f).observation.sequence, 2)
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE document name/)
    f.clean()
  })
  test(`${host}: full overflow rejection before reading a 101st selection getter`, () => {
    const f = fixture(host)
    const nodes = Array.from({ length: 100 }, (_, index) =>
      f.scene(host === 'figma' ? `n:${index}` : index + 1)
    )
    let reads = 0
    f.select(nodes, 100, () => {
      reads += 1
    })
    assert.equal(success(f).selected.length, 100)
    assert.equal(reads, 100)
    reads = 0
    f.select(nodes, 101, () => {
      reads += 1
      throw new Error('must not read overflow')
    })
    failure(f.capture(), 'SELECTION_TOO_LARGE')
    assert.equal(reads, 0)
    f.select(nodes, 1_000_000, () => {
      throw new Error('must not materialize')
    })
    failure(f.capture(), 'SELECTION_TOO_LARGE')
    f.clean()
  })
  test(`${host}: exact ancestor depth 32 succeeds; 33 fails without partial data`, () => {
    const f = fixture(host)
    const chain = (depth) => {
      let parent = host === 'figma' ? f.page : null
      for (let index = 0; index < depth - (host === 'figma' ? 1 : 0); index += 1) {
        parent = f.scene(host === 'figma' ? `ancestor:${index}` : index + 2, parent)
      }
      f.patch(f.node, { parent })
    }
    chain(32)
    assert.equal(success(f).selected[0].ancestors.length, 32)
    chain(33)
    failure(f.capture(), 'ANCESTRY_TOO_DEEP')
    f.clean()
  })
  test(`${host}: shared ancestors deduplicate, but duplicate IDs, selections and cycles fail`, () => {
    const f = fixture(host)
    const parent = f.scene(host === 'figma' ? 'parent' : 3)
    const other = f.scene(host === 'figma' ? 'other' : 2, parent)
    f.patch(f.node, { parent })
    f.select([f.node, other])
    assert.equal(success(f).nodes.length, host === 'figma' ? 4 : 3)
    f.select([f.node, f.node])
    failure(f.capture(), 'DUPLICATE_SELECTION')
    f.select([f.node, f.scene(host === 'figma' ? '1:1' : 1)])
    failure(f.capture(), 'DUPLICATE_ID')
    f.select([f.node])
    f.patch(parent, { parent: f.node })
    failure(f.capture(), 'CYCLIC_ANCESTRY')
    f.clean()
  })
  test(`${host}: 512 unique nodes accepted and 513 rejected, never truncating`, () => {
    const f = fixture(host)
    const build = (count) => {
      let nextId = 10
      let remaining = count - (host === 'figma' ? 1 : 0)
      const selected = []
      while (remaining > 0) {
        let parent = host === 'figma' ? f.page : null
        const length = Math.min(32, remaining)
        for (let depth = 0; depth < length; depth += 1) {
          parent = f.scene(host === 'figma' ? `unique:${nextId}` : nextId, parent)
          nextId += 1
        }
        remaining -= length
        selected.push(parent)
      }
      f.select(selected)
    }
    build(512)
    assert.equal(success(f).nodes.length, 512)
    build(513)
    failure(f.capture(), 'TOO_MANY_NODES')
    f.clean()
  })
  for (const [label, name] of [
    ['name bytes', '界'.repeat(1366)],
    ['invalid UTF-16', '\ud800']
  ]) {
    test(`${host}: rejects ${label} and does not leak partial names`, () => {
      const f = fixture(host)
      f.patch(f.node, { name })
      failure(f.capture())
      f.clean()
    })
  }
  test(`${host}: name UTF-8 byte boundary, ID/kind bounds and exact types`, () => {
    const f = fixture(host)
    f.patch(f.node, { name: '😀'.repeat(1024) })
    assert.equal(success(f).nodes[0].name, '😀'.repeat(1024))
    f.patch(f.node, { [host === 'figma' ? 'type' : 'kind']: 'x'.repeat(129) })
    failure(f.capture())
    f.patch(f.node, {
      [host === 'figma' ? 'type' : 'kind']: 'pixel',
      id: host === 'figma' ? '界'.repeat(86) : '1'
    })
    failure(f.capture())
    f.clean()
  })
  test(`${host}: rejects total serialized snapshot over 256KiB, including control escapes`, () => {
    const f = fixture(host)
    for (const [count, name] of [
      [70, 'x'.repeat(4096)],
      [15, '\u0000'.repeat(4096)]
    ]) {
      f.select(
        Array.from({ length: count }, (_, index) =>
          f.scene(host === 'figma' ? `big:${index}` : index + 1, undefined, { name })
        )
      )
      failure(f.capture(), 'SNAPSHOT_TOO_LARGE')
    }
    f.clean()
  })
  test(`${host}: unknown visibility/locks and missing required properties fail closed`, () => {
    const f = fixture(host)
    const lock = host === 'figma' ? 'locked' : 'pixelsLocked'
    f.patch(f.node, { [lock]: undefined })
    failure(f.capture())
    f.patch(f.node, { [lock]: false, visible: null })
    failure(f.capture())
    const incomplete =
      host === 'figma'
        ? { id: 'missing', type: 'FRAME', parent: f.page, name: 'PRIVATE', visible: true }
        : { id: 2, kind: 'pixel', document: f.doc, parent: null, name: 'PRIVATE', visible: true }
    f.select([incomplete])
    failure(f.capture())
    f.clean()
  })
  test(`${host}: throwing native required getter is a safe error (including hostile error objects)`, () => {
    const f = fixture(host)
    const bad = f.scene(host === 'figma' ? 'bad' : 10)
    let errorReads = 0
    const error = new Proxy(
      {},
      {
        get() {
          errorReads += 1
          throw new Error('PRIVATE HOST NAME')
        }
      }
    )
    const throwing = new Proxy(bad, {
      get(target, key) {
        if (key === 'name') throw error
        return target[key]
      }
    })
    f.select([throwing])
    failure(f.capture(), 'CAPTURE_FAILED')
    assert.equal(errorReads, 0)
    f.clean()
  })
  test(`${host}: empty selection has no unrelated nodes; invalid epoch reads nothing`, () => {
    const f = fixture(host)
    f.select([])
    assert.deepEqual(success(f).nodes, [])
    assert.deepEqual(success(f).selected, [])
    f.reads.length = 0
    for (const instanceEpoch of ['', 'A'.repeat(32), 'a'.repeat(31), epoch + '\n', 1]) {
      const reader =
        host === 'figma'
          ? f.api.createFigmaReader({ figma: f.native, instanceEpoch })
          : f.api.createPhotoshopReader({ app: f.native, instanceEpoch })
      failure(plain(reader.capture()), 'INVALID_INSTANCE_EPOCH')
    }
    assert.equal(f.reads.length, 0)
    f.clean()
  })
  test(`${host}: no network/fs/credential/modal/host writes or path/fileKey reads`, () => {
    const f = fixture(host)
    const deny = (key) => {
      throw new Error('PRIVATE forbidden ' + key)
    }
    for (const target of [f.root, f.doc, f.native]) {
      f.patch(
        target,
        Object.fromEntries(
          [
            'fileKey',
            'path',
            'fullName',
            'fileReference',
            'batchPlay',
            'executeAsModal',
            'exportAsync',
            'createNode',
            'storage',
            'token'
          ].map((key) => [key, () => deny(key)])
        )
      )
    }
    success(f)
    for (const key of [
      'fileKey',
      'path',
      'fullName',
      'fileReference',
      'batchPlay',
      'executeAsModal',
      'exportAsync',
      'createNode',
      'storage',
      'token'
    ])
      assert.equal(f.reads.includes(key), false)
    f.clean()
  })
  test(`${host}: failed captures advance capture count, not any mutation revision`, () => {
    const f = fixture(host)
    assert.equal(success(f).observation.sequence, 1)
    f.select([], 101)
    failure(f.capture())
    f.select([f.node])
    assert.equal(success(f).observation.sequence, 3)
    f.clean()
  })
}

test('Figma: page is structural, scene parents stop at PAGE, root ID is local only', () => {
  const f = fixture('figma')
  const snapshot = success(f)
  assert.deepEqual(
    snapshot.nodes.find((node) => node.id === '0:1'),
    {
      id: '0:1',
      parentId: null,
      kind: 'PAGE',
      name: '测试 page',
      role: 'structural',
      visible: null,
      locked: null
    }
  )
  assert.equal(snapshot.document.id, '0:0')
  assert.equal(snapshot.document.pageId, '0:1')
  assert.equal(snapshot.document.openEpoch, epoch + ':1')
  f.clean()
})
test('Figma: wrong page/root/selection ownership and changing root/page IDs fail', () => {
  for (const mutate of [
    (f) =>
      f.patch(f.node, {
        parent: f.guard({ id: 'other', type: 'PAGE', name: 'other', parent: f.root })
      }),
    (f) => f.patch(f.page, { parent: f.guard({ id: 'other-root', type: 'DOCUMENT' }) }),
    (f) => f.patch(f.node, { parent: null }),
    (f) => f.patch(f.node, { id: '0:0' }),
    (f) => {
      let calls = 0
      f.patch(f.native, {
        root: new Proxy(f.root, {
          get(target, key) {
            if (key === 'id') return ++calls === 1 ? '0:0' : 'changed'
            return target[key]
          }
        })
      })
    },
    (f) => {
      let calls = 0
      const page = new Proxy(f.page, {
        get(target, key) {
          if (key === 'id') return ++calls === 1 ? '0:1' : 'changed'
          return target[key]
        }
      })
      f.patch(f.native, { currentPage: page })
      f.patch(f.node, { parent: page })
    }
  ]) {
    const f = fixture('figma')
    mutate(f)
    failure(f.capture())
    f.clean()
  }
})
test('Photoshop: official Layer.parent null is document root even when document and layer IDs match', () => {
  const f = fixture('photoshop')
  const snapshot = success(f)
  assert.equal(snapshot.document.id, '1')
  assert.equal(snapshot.nodes[0].id, '1')
  assert.equal(snapshot.nodes[0].parentId, null)
  assert.deepEqual(snapshot.selected[0].ancestors, [])
  f.patch(f.node, { parent: { id: 1 } })
  failure(f.capture())
  f.clean()
})
test('Photoshop: every official partial/background lock is conservatively ORed and required', () => {
  for (const key of [
    'allLocked',
    'pixelsLocked',
    'positionLocked',
    'transparentPixelsLocked',
    'isBackgroundLayer'
  ]) {
    const f = fixture('photoshop')
    f.patch(f.node, { [key]: true })
    assert.equal(success(f).selected[0].effectiveLocked, true)
    f.patch(f.node, { [key]: 0 })
    failure(f.capture())
    f.clean()
  }
})
test('Photoshop: wrong layer/ancestor ownership, duplicate/open document membership fail', () => {
  for (const mutate of [
    (f) => f.patch(f.node, { document: f.guard({ id: 2 }) }),
    (f) => f.patch(f.node, { parent: f.scene(2, null, {}, f.guard({ id: 2 })) }),
    (f) => f.patch(f.native, { documents: f.collection([]) }),
    (f) => f.patch(f.native, { documents: f.collection([f.doc, f.doc]) }),
    (f) => f.patch(f.node, { id: 0 }),
    (f) => f.patch(f.node, { id: Number.MAX_SAFE_INTEGER + 1 })
  ]) {
    const f = fixture('photoshop')
    mutate(f)
    failure(f.capture())
    f.clean()
  }
})
test('Photoshop: documents bound checked before indexing; missing active document is safe', () => {
  const f = fixture('photoshop')
  let indexed = 0
  f.patch(f.native, {
    documents: f.collection([], 1001, () => {
      indexed += 1
    })
  })
  failure(f.capture(), 'DOCUMENTS_TOO_LARGE')
  assert.equal(indexed, 0)
  const documents = [
    f.doc,
    ...Array.from({ length: 999 }, (_, index) => f.guard({ id: index + 2 }))
  ]
  f.patch(f.native, { documents: f.collection(documents), activeDocument: f.doc })
  success(f)
  f.patch(f.native, { documents: f.collection([]), activeDocument: null })
  failure(f.capture(), 'NO_DOCUMENT')
  f.clean()
})
test('Photoshop: switching documents preserves epochs; observed absence then reopen creates new epoch', () => {
  const f = fixture('photoshop')
  const second = f.guard({ id: 2, name: 'second', activeLayers: [] })
  const secondNode = f.scene(2, null, {}, second)
  f.patch(second, { activeLayers: f.collection([secondNode]) })
  f.patch(f.native, { documents: f.collection([f.doc, second]) })
  const first = success(f)
  f.patch(f.native, { activeDocument: second })
  const other = success(f)
  assert.notEqual(first.document.openEpoch, other.document.openEpoch)
  f.patch(f.native, { activeDocument: f.doc })
  assert.equal(success(f).document.openEpoch, first.document.openEpoch)
  f.patch(f.native, { documents: f.collection([second]), activeDocument: second })
  success(f)
  f.patch(f.native, { documents: f.collection([f.doc, second]), activeDocument: f.doc })
  const reopened = success(f)
  assert.notEqual(reopened.document.openEpoch, first.document.openEpoch)
  assert.equal(reopened.observation.sequence, 5)
  assert.equal(reopened.document.openEpochSource, 'plugin-observation')
  f.clean()
})
test('Photoshop: observed empty documents retires epochs; an unobserved close/reopen gap is not attested', () => {
  const f = fixture('photoshop')
  const first = success(f)
  f.patch(f.native, { documents: f.collection([]), activeDocument: null })
  failure(f.capture(), 'NO_DOCUMENT')
  f.patch(f.native, { documents: f.collection([f.doc]), activeDocument: f.doc })
  const reopened = success(f)
  assert.notEqual(reopened.document.openEpoch, first.document.openEpoch)
  const replacement = f.guard({ id: 1, activeLayers: [] })
  f.patch(f.native, { documents: f.collection([replacement]), activeDocument: replacement })
  assert.equal(success(f).document.openEpoch, reopened.document.openEpoch)
  f.clean()
})
