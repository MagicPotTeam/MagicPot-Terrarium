import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'

// Node 24 only. All host objects, transports and DOM are local fixtures, never native sessions.
const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
const sources = {
  figma: { code: read('figma/bridge/code.js'), html: read('figma/bridge/ui.html') },
  photoshop: {
    code: read('photoshop-uxp/bridge/main.js'),
    html: read('photoshop-uxp/bridge/index.html')
  }
}
const warning =
  'Local read-only observation. Not authenticated host identity, native revision, mutation exclusion or permission to write.'
const fullName = 'Exact <img src=x onerror=evil()> 名称 ' + 'N'.repeat(160)
const ancestorName = 'Ancestor <script>evil()</script> ' + 'A'.repeat(140)
const plain = (value) => JSON.parse(JSON.stringify(value))
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
const sample = {
  protocol: 1,
  purpose: 'read-only-selection-review',
  selected: [{ id: 'n:1', name: fullName, ancestors: [{ name: ancestorName }] }]
}

function fixture(host, options = {}) {
  const elements = new Map()
  const listeners = new Map()
  const docListeners = new Map()
  const requests = []
  const sends = []
  const posts = []
  const factories = []
  const violations = []
  let captures = 0
  let reads = 0
  let randomCalls = 0
  let receive
  const deny = (key) => {
    violations.push(key)
    throw new Error('PRIVATE EXCEPTION ' + key)
  }
  const readonly = (value) =>
    new Proxy(value, {
      get(target, key) {
        if (!Object.hasOwn(target, key)) return deny(String(key))
        return Reflect.get(target, key)
      },
      set(_target, key) {
        return deny('write ' + String(key))
      }
    })
  for (const [, id] of sources[host].html.matchAll(/\bid="([^"]+)"/g)) {
    const handlers = new Map()
    const element = {
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      addEventListener(type, callback) {
        assert.equal(handlers.has(type), false)
        handlers.set(type, callback)
      },
      fire(type) {
        handlers.get(type)?.({})
      }
    }
    Object.defineProperty(element, 'innerHTML', {
      get() {
        return deny('HTML')
      },
      set() {
        deny('HTML')
      }
    })
    elements.set(id, element)
  }
  const el = (id) => {
    assert.ok(elements.has(id), 'known panel element: ' + id)
    return elements.get(id)
  }
  const document = {
    readyState: options.loading ? 'loading' : 'complete',
    getElementById: el,
    addEventListener(type, callback) {
      docListeners.set(type, callback)
    }
  }
  const window = {
    addEventListener(type, callback) {
      listeners.set(type, callback)
    }
  }
  const crypto =
    options.crypto === false
      ? undefined
      : {
          getRandomValues(data) {
            assert.equal(data.length, 16)
            data.fill((options.seed || 0) + ++randomCalls)
            return data
          }
        }
  const nativeRoot = readonly({
    id: '0:0',
    type: 'DOCUMENT',
    name: 'Synthetic document',
    parent: null
  })
  const pageData = { id: '0:1', type: 'PAGE', name: 'Exact page name', parent: nativeRoot }
  const page = readonly(pageData)
  const ancestor = readonly({
    id: 'n:0',
    type: 'FRAME',
    name: ancestorName,
    parent: page,
    locked: true,
    visible: false
  })
  const scene = readonly({
    id: 'n:1',
    type: 'RECTANGLE',
    name: options.name || fullName,
    parent: ancestor,
    locked: false,
    visible: true,
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    rotation: 0
  })
  pageData.selection = Object.freeze([scene])
  const psData = { id: 7, name: 'Exact Photoshop document' }
  const psDoc = readonly(psData)
  const layer = readonly({
    id: 11,
    kind: 'pixel',
    name: options.name || fullName,
    parent: null,
    document: psDoc,
    visible: true,
    allLocked: false,
    pixelsLocked: true,
    positionLocked: false,
    transparentPixelsLocked: false,
    isBackgroundLayer: false
  })
  psData.activeLayers = Object.freeze([layer])
  const app = readonly({
    documents: Object.freeze([psDoc]),
    get activeDocument() {
      reads++
      return psDoc
    }
  })
  const ui = {
    onmessage: null,
    postMessage(value) {
      posts.push(plain(value))
      if (options.postResultThrows && value.type === 'read-only-snapshot')
        throw new Error('PRIVATE host postMessage failure')
      if (!options.delayResult || value.type !== 'read-only-snapshot') {
        listeners.get('message')?.({ source: parent, data: { pluginMessage: plain(value) } })
      }
    }
  }
  const figma = readonly({
    ui,
    root: nativeRoot,
    get currentPage() {
      reads++
      return page
    },
    showUI(html) {
      assert.equal(html, sources.figma.html)
    },
    closePlugin() {
      return undefined
    },
    on(type, callback) {
      listeners.set('native-' + type, callback)
    }
  })
  const parent = {
    postMessage(envelope, target) {
      assert.equal(target, '*')
      sends.push(plain(envelope.pluginMessage))
      if (options.postRequestThrows && envelope.pluginMessage.type === 'capture-read-only-snapshot')
        throw new Error('PRIVATE UI postMessage failure')
      receive(envelope.pluginMessage)
    }
  }
  const config =
    options.config === false
      ? null
      : { protocol: 1, origin: 'http://127.0.0.1:49152', pluginId: 'local.review', host }
  const prefix =
    'globalThis.MAGICPOT_BRIDGE_CONFIG = ' +
    (config ? 'Object.freeze(' + JSON.stringify(config) + ')' : 'null') +
    ';\n'
  const helper =
    options.helper === false
      ? undefined
      : {
          [host === 'figma' ? 'createFigmaReader' : 'createPhotoshopReader'](input) {
            assert.deepEqual(
              Object.keys(input).sort(),
              [host === 'figma' ? 'figma' : 'app', 'instanceEpoch'].sort()
            )
            assert.equal(input[host === 'figma' ? 'figma' : 'app'], host === 'figma' ? figma : app)
            assert.match(input.instanceEpoch, /^[a-f0-9]{32}$/)
            factories.push(input.instanceEpoch)
            return {
              capture() {
                captures++
                return options.capture ? options.capture() : { ok: true, snapshot: sample }
              }
            }
          }
        }
  let now = 1700000000000
  let timerSequence = 0
  const timers = new Map()
  const fetch = async (url, init) => {
    const route = url.split('/').at(-1)
    requests.push({ route, body: JSON.parse(init.body), init })
    const value =
      route === 'pair'
        ? {
            protocol: 1,
            sessionId: '1'.repeat(32),
            sessionToken: '2'.repeat(64),
            expiresAt: now + 600000,
            idleTimeoutMs: 120000
          }
        : {
            protocol: 1,
            callId: '3'.repeat(32),
            status: 'awaiting-approval',
            expiresAt: now + 120000
          }
    return {
      ok: true,
      status: route === 'close' || route === 'cancel' ? 204 : 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(value)
    }
  }
  function run(code, extra) {
    const context = createContext(
      {
        Date: class extends Date {
          static now() {
            return now
          }
        },
        setTimeout(callback, delay) {
          const id = ++timerSequence
          timers.set(id, { callback, due: now + delay })
          return id
        },
        clearTimeout(id) {
          timers.delete(id)
        },
        TextEncoder,
        Uint8Array,
        AbortController,
        Math: Object.create(Math),
        fetch,
        localStorage: readonly({}),
        sessionStorage: readonly({}),
        XMLHttpRequest: () => deny('XHR'),
        WebSocket: () => deny('WebSocket'),
        console: { log: () => deny('log'), error: () => deny('error') },
        ...extra
      },
      { codeGeneration: { strings: false, wasm: false } }
    )
    new Script('Math.random = () => { throw new Error("No random fallback") }').runInContext(
      context
    )
    new Script(code).runInContext(context, { timeout: 1000 })
    return context
  }
  const helperCode = options.real ? read('shared/selection-snapshot.js') : ''
  if (host === 'figma') {
    run(prefix + helperCode + '\n;' + sources.figma.code, {
      figma,
      __html__: sources.figma.html,
      ...(options.real ? {} : { MagicPotSelectionSnapshotV1: helper })
    })
    receive = ui.onmessage
    run(sources.figma.html.match(/<script>([\s\S]*?)<\/script>/)[1], {
      document,
      window,
      parent,
      crypto,
      fetch: () => deny('UI network')
    })
  } else {
    run(prefix + helperCode + '\n;' + sources.photoshop.code, {
      document,
      window,
      crypto,
      ...(options.real ? {} : { MagicPotSelectionSnapshotV1: helper }),
      require(name) {
        assert.equal(name, 'photoshop')
        return readonly({
          app,
          // This read-only fixture intentionally exposes no notification API.
          // Production may probe `photoshop.action` before deciding that context-image
          // observation is unavailable; returning null keeps that probe non-mutating.
          action: null,
          core: readonly({
            executeAsModal: async (operation) => operation({})
          })
        })
      }
    })
  }
  return {
    el,
    sends,
    posts,
    requests,
    factories,
    violations,
    parent,
    page: pageData,
    psDoc: psData,
    get captures() {
      return captures
    },
    get reads() {
      return reads
    },
    get randomCalls() {
      return randomCalls
    },
    click(id) {
      el(id).fire('click')
    },
    local() {
      el('read-only-capture').fire('click')
      return el('read-only-output').textContent
    },
    receive(value) {
      receive(value)
    },
    emit(value, source = parent) {
      listeners.get('message')?.({ source, data: { pluginMessage: value } })
    },
    timerCount() {
      return timers.size
    },
    advance(milliseconds, runTimers = true) {
      now += milliseconds
      if (!runTimers) return
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    hide() {
      listeners.get('pagehide')?.()
    },
    loaded() {
      document.readyState = 'complete'
      docListeners.get('DOMContentLoaded')?.()
    },
    async pair() {
      el('ticket').value = JSON.stringify({
        ticketId: 'a'.repeat(32),
        pairingSecret: 'b'.repeat(64),
        expiresAt: now + 120000,
        bridgeOrigin: 'http://127.0.0.1:49152',
        pluginId: 'local.review',
        host,
        artifactSha256: 'c'.repeat(64)
      })
      el('pair').fire('click')
      await flush()
    },
    clean() {
      assert.deepEqual(violations, [])
    }
  }
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: one explicit local click, lazy reader, lifetime epoch and literal complete output`, () => {
    const f = fixture(host)
    assert.equal(f.captures, 0)
    assert.equal(f.reads, 0)
    assert.equal(f.randomCalls, 0)
    assert.deepEqual(f.factories, [])
    assert.deepEqual(f.requests, [])
    assert.match(sources[host].html, /Review complete selection locally \(read-only\)/)
    assert.ok(sources[host].html.replace(/\s+/g, ' ').includes(warning))
    const text = f.local()
    assert.equal(f.captures, 1)
    assert.equal(f.factories.length, 1)
    assert.equal(f.randomCalls, host === 'figma' ? 2 : 1)
    assert.deepEqual(JSON.parse(text), sample)
    assert.ok(text.includes(fullName))
    assert.ok(text.includes(ancestorName))
    f.local()
    assert.equal(f.captures, 2)
    assert.equal(f.factories.length, 1)
    assert.equal(f.randomCalls, host === 'figma' ? 3 : 1)
    assert.deepEqual(f.requests, [])
    assert.equal(f.el('consent').checked, false)
    f.clean()
  })
  test(`${host}: missing helper/config or randomness never falls back or connects`, () => {
    for (const options of [{ helper: false }, { crypto: false }]) {
      const f = fixture(host, options)
      assert.match(f.local(), /^[A-Z][A-Z0-9_]{0,63}$/)
      assert.equal(f.captures, 0)
      assert.equal(f.reads, 0)
      assert.deepEqual(f.requests, [])
      f.clean()
    }
    const f = fixture(host, { config: false })
    assert.deepEqual(JSON.parse(f.local()), sample)
    assert.equal(f.el('pair').disabled, true)
    f.click('pair')
    f.click('capture')
    f.click('share')
    assert.deepEqual(f.requests, [])
    f.clean()
  })
  test(`${host}: local error codes sanitized and no partial snapshot or thrown details rendered`, () => {
    for (const capture of [
      () => ({ ok: false, error: { code: 'INCOMPLETE_METADATA' } }),
      () => ({ ok: false, error: { code: '<img onerror=evil()> MARKER' }, snapshot: sample }),
      () => ({ ok: false, error: { code: 'MARKER\nEXCEPTION' } }),
      () => ({ ok: false, error: { code: 'SAFE', extra: 'MARKER' } }),
      () => ({ ok: true, snapshot: sample, extra: 'MARKER' }),
      () => {
        throw new Error('MARKER EXCEPTION ' + fullName)
      }
    ]) {
      const f = fixture(host, { capture })
      const text = f.local()
      assert.match(text, /^[A-Z][A-Z0-9_]{0,63}$/)
      assert.ok(!text.includes('MARKER'))
      assert.ok(!text.includes(fullName))
      assert.deepEqual(f.requests, [])
      f.clean()
    }
    const f = fixture(host, {
      capture: () => ({ ok: false, error: { code: 'INCOMPLETE_METADATA' } })
    })
    assert.equal(f.local(), 'INCOMPLETE_METADATA')
  })
  test(`${host}: paired local review never changes old capture/consent or enters prepare`, async () => {
    const f = fixture(host)
    f.local()
    await f.pair()
    f.click('capture')
    const context = JSON.parse(f.el('selection').textContent)
    f.el('prompt').value = 'Review old context'
    f.el('consent').checked = true
    f.el('consent').fire('change')
    const before = plain(f.requests)
    f.local()
    assert.deepEqual(plain(f.requests), before)
    assert.equal(f.el('consent').checked, true)
    assert.deepEqual(JSON.parse(f.el('selection').textContent), context)
    assert.equal(f.el('share').disabled, false)
    f.click('share')
    await flush()
    assert.deepEqual(
      f.requests.map((r) => r.route),
      ['pair', 'prepare']
    )
    assert.deepEqual(f.requests[1].body.context, context)
    assert.equal(JSON.stringify(f.requests).includes('read-only-selection-review'), false)
    assert.equal(f.el('consent').checked, false)
    f.local()
    assert.deepEqual(
      f.requests.map((r) => r.route),
      ['pair', 'prepare']
    )
    f.clean()
  })
  test(`${host}: panel lifetime closes reader use without writing files or restarting old consent`, () => {
    const f = fixture(host, { loading: host === 'photoshop' })
    f.loaded()
    f.loaded()
    f.local()
    f.hide()
    f.local()
    assert.equal(f.captures, 1)
    assert.deepEqual(f.requests, [])
    const fresh = fixture(host, { seed: 20 })
    fresh.local()
    assert.notEqual(f.factories[0], fresh.factories[0])
    f.clean()
    fresh.clean()
  })
  test(`${host}: real shared helper returns a complete native-shaped observation locally`, async () => {
    const f = fixture(host, { real: true, config: false })
    assert.equal(f.reads, 0)
    const selected = host === 'figma' ? f.page.selection : f.psDoc.activeLayers
    const text = f.local()
    assert.ok(text.startsWith('{'), text)
    const snapshot = JSON.parse(text)
    assert.equal(snapshot.protocol, 1)
    assert.equal(snapshot.purpose, 'read-only-selection-review')
    assert.equal(snapshot.host, host)
    assert.equal(snapshot.complete, true)
    assert.equal(snapshot.document.id, host === 'figma' ? '0:0' : '7')
    assert.equal(snapshot.document.openEpoch, '01'.repeat(16) + ':1')
    assert.equal(snapshot.document.openEpochSource, 'plugin-observation')
    assert.deepEqual(snapshot.observation, { sequence: 1, source: 'capture-counter' })
    assert.equal(snapshot.capabilities.readSnapshot, true)
    assert.deepEqual(snapshot.capabilities.writeCommands, [])
    for (const key of [
      'authenticatedHost',
      'nativeDocumentRevision',
      'mutationExclusion',
      'rollback',
      'remoteMutationTracking'
    ])
      assert.equal(snapshot.capabilities[key], false)
    assert.deepEqual(snapshot.selected, [
      {
        id: host === 'figma' ? 'n:1' : '11',
        ancestors: host === 'figma' ? ['n:0', '0:1'] : [],
        effectiveLocked: true,
        effectiveVisible: host !== 'figma'
      }
    ])
    assert.equal(snapshot.nodes[0].name, fullName)
    if (host === 'figma') {
      assert.equal(snapshot.nodes[1].name, ancestorName)
      assert.equal(snapshot.nodes[2].role, 'structural')
      assert.equal(snapshot.nodes[2].locked, null)
      assert.equal(snapshot.nodes[2].visible, null)
    } else assert.equal(snapshot.nodes[0].parentId, null)
    const second = JSON.parse(f.local())
    assert.equal(second.observation.sequence, 2)
    assert.equal(second.document.openEpoch, snapshot.document.openEpoch)
    assert.equal(host === 'figma' ? f.page.selection : f.psDoc.activeLayers, selected)
    assert.deepEqual(f.requests, [])
    await f.pair()
    assert.deepEqual(f.requests, [])
    f.clean()
  })
  test(`${host}: real shared helper refuses incomplete/oversized data instead of displaying partials`, () => {
    const f = fixture(host, { real: true, name: 'X'.repeat(4097) })
    assert.equal(f.local(), 'FIELD_TOO_LARGE')
    assert.deepEqual(f.requests, [])
    f.clean()
  })
}

test('Figma local lost responses time out, release the button, and allow a fresh capture', () => {
  const f = fixture('figma', { delayResult: true })
  f.local()
  assert.equal(f.el('read-only-capture').disabled, true)
  f.advance(10000)
  assert.equal(f.el('read-only-capture').disabled, false)
  assert.equal(f.el('read-only-output').textContent, 'SNAPSHOT_TIMEOUT')
  assert.equal(f.timerCount(), 0)
  f.local()
  assert.equal(f.captures, 2)
  assert.deepEqual(f.requests, [])
  f.hide()
  assert.equal(f.timerCount(), 0)
  f.clean()
})

test('Figma ordinary close clears pending local capture and ignores its delayed response', () => {
  const f = fixture('figma', { delayResult: true })
  f.local()
  const delayed = f.posts.at(-1)
  f.click('close')
  assert.equal(f.el('read-only-capture').disabled, false)
  assert.equal(f.timerCount(), 0)
  f.emit(delayed)
  assert.equal(f.el('read-only-output').textContent, '')
  f.local()
  assert.equal(f.captures, 2)
  assert.equal(f.factories.length, 1)
  assert.deepEqual(f.requests, [])
  f.hide()
  f.clean()
})

test('Figma host postMessage failures are contained and UI send failures clean their timers', () => {
  const main = fixture('figma', { postResultThrows: true })
  assert.doesNotThrow(() => main.local())
  assert.equal(main.el('read-only-capture').disabled, true)
  main.advance(10000)
  assert.equal(main.el('read-only-output').textContent, 'SNAPSHOT_TIMEOUT')
  assert.equal(main.timerCount(), 0)
  main.clean()
  const ui = fixture('figma', { postRequestThrows: true })
  assert.equal(ui.local(), 'SNAPSHOT_UNAVAILABLE')
  assert.equal(ui.el('read-only-capture').disabled, false)
  assert.equal(ui.captures, 0)
  assert.equal(ui.timerCount(), 0)
  ui.clean()
})

test('Figma subsequent pending captures reject old request IDs and wrong epochs', () => {
  const f = fixture('figma', { delayResult: true })
  f.local()
  const old = f.posts.at(-1)
  const firstRequest = f.sends.at(-1)
  assert.match(firstRequest.requestId, /^[a-f0-9]{32}$/)
  assert.equal(old.requestId, firstRequest.requestId)
  assert.equal(old.instanceEpoch, firstRequest.instanceEpoch)
  f.emit(old)
  assert.equal(f.timerCount(), 0)
  f.local()
  const current = f.posts.at(-1)
  assert.notEqual(current.requestId, old.requestId)
  f.emit(old)
  f.emit({ ...current, instanceEpoch: 'f'.repeat(32) })
  assert.equal(f.el('read-only-output').textContent, '')
  assert.equal(f.el('read-only-capture').disabled, true)
  f.emit(current)
  assert.deepEqual(JSON.parse(f.el('read-only-output').textContent), sample)
  assert.equal(f.el('read-only-capture').disabled, false)
  assert.equal(f.timerCount(), 0)
  assert.deepEqual(f.requests, [])
  f.clean()
})

test('Figma local deadline rejects delayed responses before the timer callback runs', () => {
  const f = fixture('figma', { delayResult: true })
  f.local()
  const delayed = f.posts.at(-1)
  f.advance(10000, false)
  f.emit(delayed)
  assert.equal(f.el('read-only-output').textContent, 'SNAPSHOT_TIMEOUT')
  assert.equal(f.el('read-only-capture').disabled, false)
  assert.equal(f.timerCount(), 0)
  f.local()
  const current = f.posts.at(-1)
  f.emit(delayed)
  assert.equal(f.el('read-only-output').textContent, '')
  f.emit(current)
  assert.deepEqual(JSON.parse(f.el('read-only-output').textContent), sample)
  assert.equal(f.timerCount(), 0)
  assert.deepEqual(f.requests, [])
  f.clean()
})

test('Figma main rejects malformed/extra message fields and rebinding the instance epoch', () => {
  const f = fixture('figma')
  const message = {
    protocol: 1,
    type: 'capture-read-only-snapshot',
    instanceEpoch: 'a'.repeat(32),
    requestId: 'c'.repeat(32)
  }
  for (const value of [
    null,
    [],
    { ...message, protocol: 2 },
    { ...message, extra: true },
    { ...message, nonce: 'b'.repeat(32) },
    { ...message, instanceEpoch: 'A'.repeat(32) },
    { ...message, instanceEpoch: 'a'.repeat(31) + '\n' },
    { ...message, requestId: 'C'.repeat(32) },
    { ...message, requestId: 'c'.repeat(31) + '\n' },
    { protocol: 1, type: message.type, instanceEpoch: message.instanceEpoch },
    { protocol: 1, type: message.type }
  ])
    f.receive(value)
  assert.equal(f.captures, 0)
  assert.deepEqual(f.factories, [])
  f.receive(message)
  assert.equal(f.captures, 1)
  f.receive({ ...message, instanceEpoch: 'b'.repeat(32) })
  assert.equal(f.captures, 1)
  assert.deepEqual(f.posts.at(-1), {
    protocol: 1,
    type: 'read-only-snapshot',
    instanceEpoch: 'b'.repeat(32),
    requestId: message.requestId,
    result: { ok: false, error: { code: 'INSTANCE_EPOCH_MISMATCH' } }
  })
  f.receive(message)
  assert.equal(f.captures, 2)
  assert.equal(f.factories.length, 1)
  assert.deepEqual(f.requests, [])
  f.clean()
})

test('Figma UI sends exact local request and ignores unsolicited/forged result envelopes', () => {
  const f = fixture('figma', { delayResult: true })
  f.emit({
    protocol: 1,
    type: 'read-only-snapshot',
    instanceEpoch: 'a'.repeat(32),
    requestId: 'b'.repeat(32),
    result: { ok: true, snapshot: sample }
  })
  assert.equal(f.el('read-only-output').textContent, '')
  f.local()
  f.local()
  assert.equal(f.captures, 1)
  const message = f.sends.find((m) => m.type === 'capture-read-only-snapshot')
  assert.deepEqual(Object.keys(message).sort(), ['instanceEpoch', 'protocol', 'requestId', 'type'])
  assert.match(message.instanceEpoch, /^[a-f0-9]{32}$/)
  assert.match(message.requestId, /^[a-f0-9]{32}$/)
  const value = f.posts.at(-1)
  f.emit({ ...value, protocol: 2 })
  f.emit({ ...value, extra: true })
  f.emit(value, {})
  assert.equal(f.el('read-only-output').textContent, '')
  f.emit(value)
  assert.deepEqual(JSON.parse(f.el('read-only-output').textContent), sample)
  f.emit({ ...value, result: { ok: false, error: { code: 'PRIVATE' } } })
  assert.deepEqual(JSON.parse(f.el('read-only-output').textContent), sample)
  assert.deepEqual(f.requests, [])
  f.clean()
})

test('Figma UI clears output and emits only a safe code for malformed results while awaiting capture', () => {
  for (const result of [
    { ok: false, error: { code: 'MARKER\nEXCEPTION' } },
    { ok: false, error: { code: 'MARKER' }, snapshot: sample },
    { ok: true, snapshot: sample, extra: true },
    null
  ]) {
    const f = fixture('figma', { delayResult: true })
    f.local()
    f.emit({ ...f.posts.at(-1), result })
    assert.equal(f.el('read-only-output').textContent, 'SNAPSHOT_FAILED')
    assert.equal(f.el('consent').checked, false)
    assert.deepEqual(f.requests, [])
    f.clean()
  }
})
