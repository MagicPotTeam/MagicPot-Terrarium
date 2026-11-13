import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createIsolatedCppPreviewPlugin } from './isolatedCppPreviewTransform.mjs'

const PREFIX = 'data:image/png;base64,'
const MiB = 1024 * 1024
const fixture = (id) => PREFIX + Buffer.from('private-source-' + id).toString('base64')
const output = (id) => ({ dataUrl: fixture('output-' + id), width: 512, height: 256 })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))
const relativeTargets = [
  'packages/app/src/renderer/src/pages/ChatPage/components/ChatComposer.tsx',
  'packages/app/src/renderer/src/pages/ChatPage/components/ChatMessageList.tsx'
]
const actualTarget = (relative) => fileURLToPath(new URL('../../../' + relative, import.meta.url))
const hookImport = "import { useIsolatedCppPreview } from 'virtual:magicpot-isolated-cpp-preview'\n"

function hookHost() {
  const slots = []
  let cursor = 0, pending = [], mounted = true, lateUpdates = 0, runtime
  const react = {
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: { current: initial } }
      return slots[index].value
    },
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: initial }
      return [slots[index].value, (value) => {
        if (!mounted) { lateUpdates += 1; return }
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
      }]
    },
    useEffect(effect, dependencies) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || dependencies.some((value, at) => value !== previous.dependencies[at])) {
        pending.push({ index, effect, dependencies })
      }
    }
  }
  return {
    react,
    bind(value) { runtime = value },
    render(source, allowInline = true) {
      cursor = 0
      pending = []
      const result = runtime.useIsolatedCppPreview(source, allowInline)
      for (const item of pending) {
        slots[item.index]?.cleanup?.()
        slots[item.index] = { dependencies: item.dependencies, cleanup: item.effect() }
      }
      return result
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.()
      mounted = false
    },
    get lateUpdates() { return lateUpdates }
  }
}

function sandbox(bridge) {
  const plugin = createIsolatedCppPreviewPlugin()
  const virtual = plugin.load(plugin.resolveId('virtual:magicpot-isolated-cpp-preview'))
  const reactImport = "import { useEffect, useRef, useState } from 'react'"
  assert.equal(virtual.split(reactImport).length, 2)
  const host = hookHost()
  let now = 0, nextTimer = 0
  const timers = new Map()
  const window = { __MAGICPOT_CPP_PREVIEW__: bridge }
  const context = {
    window, __react: host.react, queueMicrotask,
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++nextTimer
      timers.set(id, { callback, due: now + delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) }
  }
  const source = virtual
    .replace(reactImport, 'const { useEffect, useRef, useState } = globalThis.__react')
    .replace('export function useIsolatedCppPreview', 'function useIsolatedCppPreview') +
    '\nglobalThis.__testRuntime = { subscribePreview, useIsolatedCppPreview, stats };'
  vm.runInNewContext(source, context, { timeout: 1000 })
  host.bind(context.__testRuntime)
  return {
    ...context.__testRuntime,
    window,
    host,
    advance(milliseconds) {
      now += milliseconds
      for (;;) {
        const ready = [...timers].find(([, value]) => value.due <= now)
        if (!ready) break
        timers.delete(ready[0])
        ready[1].callback()
      }
    }
  }
}

test('pre transform changes only the two real display assignments', async () => {
  const plugin = createIsolatedCppPreviewPlugin()
  assert.equal(plugin.enforce, 'pre')
  const anchors = [
    '  const displaySrc = canRequestDerivative ? current?.src : src',
    '  const displaySrc = displaySource?.src ?? null'
  ]
  const replacements = [
    "  const displaySrc = useIsolatedCppPreview(canRequestDerivative ? current?.src : src, media?.kind !== 'managed')",
    "  const displaySrc = useIsolatedCppPreview(displaySource?.src ?? null, media?.kind !== 'managed')"
  ]
  for (let index = 0; index < relativeTargets.length; index += 1) {
    const id = actualTarget(relativeTargets[index])
    const original = await readFile(id, 'utf8')
    const transformed = plugin.transform(original, id + '?v=private-fixture')
    assert.equal(transformed.code, hookImport + original.replace(anchors[index], replacements[index]))
    assert.equal(transformed.map, null)
    assert.equal(plugin.transform(original, id + '.unrelated'), null)
  }
  assert.equal(plugin.transform('const x = 1', actualTarget('packages/app/src/renderer/src/Other.tsx')), null)
  assert.equal(plugin.resolveId('unrelated'), null)
  assert.equal(plugin.load('unrelated'), null)
})

test('target source drift and duplicate anchors fail the private build', async () => {
  const plugin = createIsolatedCppPreviewPlugin()
  const id = actualTarget(relativeTargets[0])
  const source = await readFile(id, 'utf8')
  const anchor = '  const displaySrc = canRequestDerivative ? current?.src : src'
  assert.throws(() => plugin.transform(source.replace(anchor, '  const displaySrc = src'), id), /exactly one/)
  assert.throws(() => plugin.transform(source + '\n' + anchor, id), /exactly one/)
  assert.throws(() => plugin.transform(source.replace('const ComposerImageThumbnail:', 'const Renamed:'), id), /exactly one/)
  assert.throws(() => plugin.transform(plugin.transform(source, id).code, id), /already present/)
})

test('serializes IPC, shares pending input and reuses completed composer output for a message', async () => {
  const calls = [], first = deferred(), second = deferred()
  const bridge = { enabled: true, request: ({ dataUrl }) => {
    calls.push(dataUrl)
    return calls.length === 1 ? first.promise : second.promise
  } }
  const runtime = sandbox(bridge)
  const seen = []
  runtime.subscribePreview(fixture(1), bridge, (value) => seen.push(['composer', value]))
  runtime.subscribePreview(fixture(1), bridge, (value) => seen.push(['shared', value]))
  runtime.subscribePreview(fixture(2), bridge, (value) => seen.push(['second', value]))
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(runtime.stats.activeRequests, 1)
  assert.equal(runtime.stats.queueDepth, 1)
  first.resolve(output(1))
  await flush()
  assert.equal(calls.length, 2)
  assert.deepEqual(seen, [['composer', output(1).dataUrl], ['shared', output(1).dataUrl]])
  runtime.subscribePreview(fixture(1), bridge, (value) => seen.push(['message', value]))
  assert.equal(calls.length, 2)
  assert.equal(runtime.stats.cacheHitCount, 1)
  second.resolve(output(2))
  await flush()
  assert.equal(runtime.stats.peakActiveRequests, 1)
  assert.equal(runtime.stats.successCount, 2)
  assert.ok(Object.values(runtime.window.__MAGICPOT_CPP_PREVIEW_RENDERER__).every((value) => typeof value === 'number'))
})

test('removes queued work only after its last subscriber leaves and bounds admission to 16 entries', async () => {
  const first = deferred(), calls = []
  const bridge = { enabled: true, request: ({ dataUrl }) => { calls.push(dataUrl); return first.promise } }
  const runtime = sandbox(bridge)
  runtime.subscribePreview(fixture(0), bridge, () => {})
  await flush()
  const cancelA = runtime.subscribePreview(fixture(1), bridge, () => {})
  const cancelB = runtime.subscribePreview(fixture(1), bridge, () => {})
  cancelA()
  assert.equal(runtime.stats.queueDepth, 1)
  cancelB()
  assert.equal(runtime.stats.queueDepth, 0)
  assert.equal(runtime.stats.cancelledQueuedCount, 1)
  const releases = []
  for (let index = 1; index <= 15; index += 1) {
    releases.push(runtime.subscribePreview(fixture(index), bridge, () => {}))
  }
  let rejected = false
  runtime.subscribePreview(fixture(16), bridge, (value) => { rejected = value === null })
  assert.equal(rejected, true)
  assert.equal(runtime.stats.cacheEntries, 16)
  assert.equal(runtime.stats.queueDepth, 15)
  assert.equal(runtime.stats.capacityRejectionCount, 1)
  releases.forEach((release) => release())
  first.resolve(output(0))
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(runtime.stats.queueDepth, 0)
})

test('counts source strings as UTF16, refuses growth beyond 96 MiB and expires completed entries', async () => {
  const pending = deferred()
  const bridge = { enabled: true, request: () => pending.promise }
  const runtime = sandbox(bridge)
  const atLimit = PREFIX + 'A'.repeat(48 * MiB - PREFIX.length)
  runtime.subscribePreview(atLimit, bridge, () => {})
  await flush()
  assert.equal(runtime.stats.cacheSourceUtf16Bytes, 96 * MiB)
  let rejected = false
  runtime.subscribePreview(fixture('extra'), bridge, (value) => { rejected = value === null })
  assert.equal(rejected, true)
  assert.equal(runtime.stats.cacheEntries, 1)
  pending.resolve(output('bounded'))
  await flush()
  runtime.advance(60_001)
  assert.equal(runtime.stats.cacheEntries, 0)
  assert.equal(runtime.stats.cacheSourceUtf16Bytes, 0)
  assert.equal(runtime.stats.cacheOutputUtf16Bytes, 0)
  assert.equal(runtime.stats.expiredCount, 1)
})

test('limits total cached output to 8 MiB with LRU eviction and rejects an oversized bridge result', async () => {
  const largeA = PREFIX + 'A'.repeat(3 * MiB - PREFIX.length)
  const largeB = PREFIX + 'B'.repeat(3 * MiB - PREFIX.length)
  let nextOutput = { dataUrl: largeA, width: 512, height: 512 }
  const bridge = { enabled: true, request: async () => nextOutput }
  const runtime = sandbox(bridge)
  runtime.subscribePreview(fixture(1), bridge, () => {})
  await flush()
  assert.equal(runtime.stats.cacheOutputUtf16Bytes, 6 * MiB)
  nextOutput = { dataUrl: largeB, width: 512, height: 512 }
  runtime.subscribePreview(fixture(2), bridge, () => {})
  await flush()
  assert.equal(runtime.stats.cacheOutputUtf16Bytes, 6 * MiB)
  assert.equal(runtime.stats.cacheEntries, 1)
  assert.equal(runtime.stats.evictedCount, 1)
  nextOutput = { dataUrl: PREFIX + 'C'.repeat(4 * MiB), width: 512, height: 512 }
  let failed = false
  runtime.subscribePreview(fixture(3), bridge, (value) => { failed = value === null })
  await flush()
  assert.equal(failed, true)
  assert.equal(runtime.stats.failureCount, 1)
  assert.ok(runtime.stats.peakOutputUtf16Bytes <= 8 * MiB)
  assert.ok(runtime.stats.peakSourceUtf16Bytes <= 96 * MiB)
})

test('disabled, managed and non-PNG display remain original while a failed eligible PNG stays a placeholder', async () => {
  const pending = deferred()
  let calls = 0
  const bridge = { enabled: false, request: () => { calls += 1; return pending.promise } }
  const runtime = sandbox(bridge)
  const source = fixture('hook')
  assert.equal(runtime.host.render(source), source)
  bridge.enabled = true
  assert.equal(runtime.host.render(source, false), source)
  assert.equal(runtime.host.render('data:image/jpeg;base64,AA=='), 'data:image/jpeg;base64,AA==')
  assert.equal(runtime.host.render('local-media:///fixture.png'), 'local-media:///fixture.png')
  assert.equal(runtime.host.render(undefined), undefined)
  assert.equal(runtime.host.render(null), null)
  await flush()
  assert.equal(calls, 0)
  assert.equal(runtime.host.render(source), null)
  await flush()
  assert.equal(calls, 1)
  pending.reject(new Error('synthetic private worker failure'))
  await flush()
  assert.equal(runtime.host.render(source), null)
  await flush()
  assert.equal(calls, 1)
  bridge.enabled = false
  assert.equal(runtime.host.render(source), source)
})

test('source replacement and unmount ignore late results; output larger than 512 is rejected', async () => {
  const pending = [deferred(), deferred(), deferred(), deferred()]
  let calls = 0
  const bridge = { enabled: true, request: () => pending[calls++].promise }
  const runtime = sandbox(bridge)
  const first = fixture('old'), second = fixture('new'), third = fixture('gone')
  assert.equal(runtime.host.render(first), null)
  await flush()
  assert.equal(runtime.host.render(second), null)
  pending[0].resolve(output('old'))
  await flush()
  assert.equal(calls, 2)
  assert.equal(runtime.host.render(second), null)
  pending[1].resolve(output('new'))
  await flush()
  assert.equal(runtime.host.render(second), output('new').dataUrl)
  assert.equal(runtime.host.render(third), null)
  await flush()
  runtime.host.unmount()
  pending[2].resolve(output('gone'))
  await flush()
  assert.equal(runtime.host.lateUpdates, 0)
  let failed = false
  runtime.subscribePreview(fixture('wrong-dimension'), bridge, (value) => { failed = value === null })
  await flush()
  pending[3].resolve({ ...output('wrong-dimension'), width: 513 })
  await flush()
  assert.equal(failed, true)
  assert.equal(runtime.stats.peakActiveRequests, 1)
})
