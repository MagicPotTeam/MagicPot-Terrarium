import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { buildHostBridgeReadiness } from './build-figplugin-bridge-readiness.mjs'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

// Run with Node 24.18.0: node --test scripts/figplugin-host-bridge.test.mjs
// Every transport and host API below is a fixture; no account, document or endpoint is contacted.
const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const sources = {
  figma: { code: read('figma/bridge/code.js'), html: read('figma/bridge/ui.html') },
  photoshop: {
    code: read('photoshop-uxp/bridge/main.js'),
    html: read('photoshop-uxp/bridge/index.html')
  }
}
const generationValidators = (await buildHostPlanPreview()).text
const origin = 'http://127.0.0.1:49152'
const pluginId = 'external.review-v1'
const sessionId = '1'.repeat(32)
const sessionToken = '2'.repeat(64)
const callId = '3'.repeat(32)
const plain = (value) => JSON.parse(JSON.stringify(value))
const flush = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function response(value, options = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(value),
    ...options
  }
}
function clockFixture() {
  let now = 1700000000000
  let serial = 0
  const timers = new Map()
  return {
    Date: class extends Date {
      static now() {
        return now
      }
    },
    get now() {
      return now
    },
    setTimeout(fn, delay) {
      const id = ++serial
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > target) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
        await flush()
      }
      now = target
      await flush()
    },
    get timerCount() {
      return timers.size
    }
  }
}
function fixture(host, options = {}) {
  const origin = options.origin ?? 'http://127.0.0.1:49152'
  const clock = clockFixture()
  const violations = []
  const posts = []
  const uiSends = []
  const requests = []
  const elements = new Map()
  const windowListeners = new Map()
  const documentListeners = new Map()
  const lifecycle = new Map()
  let reads = 0
  let cryptoCalls = 0
  let mainReceive
  let nodeReads = 0
  const denied = (label) => {
    violations.push(label)
    throw new Error('PRIVATE EXCEPTION ' + label)
  }
  const guarded = (value, label) =>
    new Proxy(value, {
      get(target, key) {
        if (!Object.hasOwn(target, key)) return denied(label + '.' + String(key))
        return Reflect.get(target, key)
      },
      set(_target, key) {
        return denied(label + '.write.' + String(key))
      }
    })
  const makeNode = (index, overrides = {}) =>
    guarded(
      host === 'figma'
        ? {
            id: 'n:' + index,
            type: 'RECTANGLE',
            name: 'Layer\u0000\u202e<img src=x onerror=evil()>',
            locked: false,
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            rotation: 0,
            ...overrides
          }
        : {
            id: index,
            kind: 'pixel',
            name: 'Layer\u0000\u202e<img src=x onerror=evil()>',
            allLocked: false,
            ...overrides
          },
      'node'
    )
  let selection = [makeNode(1)]
  const boundedSelection = (count) =>
    new Proxy(
      Array.from({ length: count }, (_, index) => makeNode(index)),
      {
        get(target, key) {
          if (key === 'length') return target.length
          if (!/^\d+$/.test(String(key)) || Number(key) >= 100)
            return denied('selection.' + String(key))
          nodeReads += 1
          return target[key]
        }
      }
    )
  for (const [, id] of sources[host].html.matchAll(/\bid="([^"]+)"/g)) {
    const handlers = new Map()
    const element = {
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      addEventListener(type, callback) {
        assert.equal(handlers.has(type), false, 'one handler per element event')
        handlers.set(type, callback)
      },
      fire(type) {
        handlers.get(type)?.({})
      }
    }
    Object.defineProperty(element, 'innerHTML', {
      set() {
        denied('innerHTML')
      },
      get() {
        denied('innerHTML')
      }
    })
    elements.set(id, element)
  }
  const el = (id) => {
    assert.ok(elements.has(id), 'known DOM ID ' + id)
    return elements.get(id)
  }
  const document = {
    readyState: options.loading ? 'loading' : 'complete',
    getElementById: el,
    addEventListener(type, callback) {
      documentListeners.set(type, callback)
    }
  }
  const window = {
    addEventListener(type, callback) {
      windowListeners.set(type, callback)
    }
  }
  const crypto =
    options.crypto === false
      ? undefined
      : {
          getRandomValues(data) {
            cryptoCalls += 1
            assert.equal(data.length, 16)
            data.fill(cryptoCalls)
            return data
          }
        }
  const config =
    options.config === undefined ? { protocol: 1, origin, pluginId, host } : options.config
  const globals = {
    Date: clock.Date,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    TextEncoder,
    Uint8Array,
    AbortController: options.abort === false ? undefined : AbortController,
    console: { log: () => denied('log'), error: () => denied('error'), warn: () => denied('warn') },
    localStorage: guarded({}, 'storage'),
    sessionStorage: guarded({}, 'storage'),
    XMLHttpRequest: () => denied('XHR'),
    WebSocket: () => denied('WebSocket'),
    setInterval: () => denied('setInterval'),
    require: () => denied('require')
  }
  function run(code, extra, filename) {
    const context = createContext(
      { ...globals, ...extra },
      { codeGeneration: { strings: false, wasm: false } }
    )
    new Script('Math.random = () => { throw new Error("No random fallback") }').runInContext(
      context
    )
    new Script(code, { filename }).runInContext(context, { timeout: 1000 })
    return context
  }
  const ticket = (overrides = {}) => ({
    ticketId: 'a'.repeat(32),
    pairingSecret: 'b'.repeat(64),
    expiresAt: clock.now + 120000,
    bridgeOrigin: origin,
    pluginId,
    host,
    artifactSha256: 'c'.repeat(64),
    ...overrides
  })
  const pairResult = (overrides = {}) => ({
    protocol: 1,
    sessionId,
    sessionToken,
    expiresAt: clock.now + 600000,
    idleTimeoutMs: 120000,
    ...overrides
  })
  const readinessResult = (overrides = {}) => ({
    protocol: 1,
    kind: 'figplugin-bridge-readiness',
    checkedAt: clock.now,
    bridge: { state: 'ready', code: 'bridge-reachable' },
    configuration: { state: 'ready', code: 'configuration-current' },
    provider: { state: 'unknown', code: 'provider-not-probed' },
    resources: { state: 'unknown', code: 'resources-not-probed' },
    host: {
      state: 'ready',
      code: 'host-paired',
      host,
      capabilities: { state: 'unknown', code: 'capabilities-not-probed' }
    },
    ...overrides
  })
  const prepareResult = (overrides = {}) => ({
    protocol: 1,
    callId,
    status: 'awaiting-approval',
    expiresAt: clock.now + 120000,
    ...overrides
  })
  const statusResult = (status = 'awaiting-approval', extra = {}) => ({
    protocol: 1,
    callId,
    status,
    ...extra
  })
  const api = {
    clock,
    requests,
    posts,
    uiSends,
    violations,
    el,
    ticket,
    pairResult,
    readinessResult,
    prepareResult,
    statusResult,
    generationStatus(phase = 'generating', extra = {}) {
      const request = api.route('image-generation/prepare')[0]
      return {
        protocol: 1,
        requestId: request.body.requestId,
        proposalId: '8'.repeat(32),
        phase,
        createdAt: api.generationCreatedAt,
        updatedAt: clock.now,
        expiresAt: api.generationExpiresAt,
        ...extra
      }
    },
    makeNode,
    boundedSelection,
    handlers: new Map(),
    get reads() {
      return reads
    },
    get nodeReads() {
      return nodeReads
    },
    get cryptoCalls() {
      return cryptoCalls
    },
    set selection(value) {
      selection = value
    },
    click(id) {
      el(id).fire('click')
    },
    input(id, value) {
      el(id).value = value
      el(id).fire('input')
    },
    async pair(value = ticket()) {
      el('ticket').value = typeof value === 'string' ? value : JSON.stringify(value)
      api.click('pair')
      await flush()
    },
    capture() {
      api.click('capture')
      return el('selection').textContent ? JSON.parse(el('selection').textContent) : null
    },
    async share(prompt = 'Review the selected layout', consent = true) {
      api.input('prompt', prompt)
      el('consent').checked = consent
      el('consent').fire('change')
      api.click('share')
      await flush()
    },
    async generate(prompt = '  A green terrarium  ', consent = true) {
      api.input('generation-prompt', prompt)
      el('generation-consent').checked = consent
      el('generation-consent').fire('change')
      api.click('generation-submit')
      await flush()
    },
    route(name) {
      return requests.filter((request) => request.route === name)
    },
    async prepare() {
      await api.pair()
      api.capture()
      await api.share()
    },
    receive(message) {
      assert.equal(host, 'figma')
      mainReceive(message)
    },
    emit(value, source) {
      windowListeners.get('message')?.({ source, data: { pluginMessage: value } })
    },
    dispose() {
      if (host === 'figma') lifecycle.get('close')()
      else windowListeners.get('pagehide')()
    },
    loaded() {
      document.readyState = 'complete'
      documentListeners.get('DOMContentLoaded')?.()
    },
    visible() {
      return [...elements.values()].map((item) => item.textContent + item.value).join('\n')
    },
    clean() {
      assert.deepEqual(violations, [])
    }
  }
  const fetch = (url, fetchOptions) => {
    assert.match(
      url,
      /^http:\/\/(?:127\.0\.0\.1|localhost):49152\/figplugin\/v1\/(pair|readiness|prepare|status|cancel|close|probe|image-generation\/(?:prepare|status|cancel))$/
    )
    const route = url.slice((origin + '/figplugin/v1/').length)
    assert.equal(url, origin + '/figplugin/v1/' + route)
    const request = { url, route, options: fetchOptions, body: JSON.parse(fetchOptions.body) }
    requests.push(request)
    if (route === 'pair') api.initialSessionIdleAt = clock.now + 120000
    if (route === 'image-generation/prepare') {
      api.generationCreatedAt = clock.now
      api.generationExpiresAt = Math.min(clock.now + 120000, api.initialSessionIdleAt)
    }
    if (api.handlers.has(route)) return api.handlers.get(route)(request)
    return Promise.resolve(
      response(
        route === 'probe'
          ? { protocol: 1, kind: 'figplugin-bridge-probe', nonce: request.body.nonce }
          : route === 'pair'
            ? pairResult()
            : route === 'readiness'
              ? readinessResult()
              : route === 'prepare'
                ? prepareResult()
                : route === 'status'
                  ? statusResult()
                  : route === 'image-generation/prepare'
                    ? {
                        protocol: 1,
                        requestId: request.body.requestId,
                        proposalId: '8'.repeat(32),
                        status: 'awaiting-approval',
                        createdAt: clock.now,
                        expiresAt: api.generationExpiresAt
                      }
                    : route === 'image-generation/status'
                      ? {
                          protocol: 1,
                          requestId: request.body.requestId,
                          proposalId: request.body.proposalId,
                          phase: 'awaiting-approval',
                          createdAt: api.generationCreatedAt,
                          updatedAt: clock.now,
                          expiresAt: api.generationExpiresAt
                        }
                      : undefined,
        {
          status:
            route === 'close' || route === 'cancel' || route === 'image-generation/cancel'
              ? 204
              : 200
        }
      )
    )
  }
  const injected =
    'globalThis.MAGICPOT_BRIDGE_CONFIG = ' +
    (config === null
      ? 'null'
      : options.unfrozen
        ? JSON.stringify(config)
        : 'Object.freeze(' + JSON.stringify(config) + ')') +
    ';\n'
  if (host === 'figma') {
    const parent = {
      postMessage(envelope, target) {
        assert.equal(target, '*')
        uiSends.push(plain(envelope.pluginMessage))
        mainReceive(envelope.pluginMessage)
      }
    }
    api.parent = parent
    const ui = {
      onmessage: null,
      postMessage(value) {
        posts.push(plain(value))
        api.emit(plain(value), parent)
      }
    }
    const figma = guarded(
      {
        ui,
        showUI(html) {
          assert.equal(html, sources.figma.html)
        },
        closePlugin() {},
        on(type, callback) {
          assert.equal(type, 'close')
          lifecycle.set(type, callback)
        },
        get currentPage() {
          reads += 1
          return guarded(
            {
              get selection() {
                return selection
              }
            },
            'page'
          )
        }
      },
      'figma'
    )
    run(
      injected +
        (options.generationHelper === false ? '' : generationValidators) +
        '\n;\n' +
        (options.probeHelper === false ? '' : read('shared/bridge-readiness.js')) +
        '\n;\n' +
        sources.figma.code,
      { figma, __html__: sources.figma.html, fetch },
      'figma/bridge/code.js'
    )
    mainReceive = ui.onmessage
    const script = sources.figma.html.match(/<script>([\s\S]*?)<\/script>/)[1]
    run(
      script,
      { document, window, parent, crypto, fetch: () => denied('UI fetch') },
      'figma/bridge/ui.html'
    )
  } else {
    const app = guarded(
      {
        get activeDocument() {
          reads += 1
          return options.noDocument
            ? null
            : guarded(
                {
                  get activeLayers() {
                    return selection
                  }
                },
                'document'
              )
        }
      },
      'app'
    )
    run(
      injected +
        (options.generationHelper === false ? '' : generationValidators) +
        '\n;\n' +
        (options.probeHelper === false ? '' : read('shared/bridge-readiness.js')) +
        '\n;\n' +
        sources.photoshop.code,
      {
        document,
        window,
        crypto,
        fetch,
        require(name) {
          assert.equal(name, 'photoshop')
          return { app }
        }
      },
      'photoshop-uxp/bridge/main.js'
    )
  }
  return api
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: startup has no network, selection read, timers, or random generation`, () => {
    const f = fixture(host)
    assert.equal(f.requests.length, 0)
    assert.equal(f.reads, 0)
    assert.equal(f.clock.timerCount, 0)
    assert.equal(f.cryptoCalls, 0)
    f.clean()
  })
  test(`${host}: capture reads only 100 allowlisted nodes and previews exact sanitized context`, () => {
    const f = fixture(host)
    f.selection = f.boundedSelection(101)
    const context = f.capture()
    assert.equal(f.reads, 1)
    assert.equal(f.nodeReads, 100)
    assert.equal(context.nodes.length, 100)
    assert.match(context.selectionRevision, /^[a-f0-9]{32}$/)
    assert.equal(context.nodes[0].name, 'Layer<img src=x onerror=evil()>')
    assert.equal(typeof context.nodes[0].id, 'string')
    assert.deepEqual(
      Object.keys(context.nodes[0]).sort(),
      host === 'figma'
        ? ['geometry', 'id', 'locked', 'name', 'type']
        : ['id', 'locked', 'name', 'type']
    )
    assert.equal(f.requests.length, 0)
    f.clean()
  })
  test(`${host}: valid pair is bound to fixed configuration, secret stays out of UI`, async () => {
    const f = fixture(host)
    await f.pair()
    const request = f.route('pair')[0]
    assert.deepEqual(Object.keys(request.body).sort(), [
      'artifactSha256',
      'clientNonce',
      'host',
      'pairingSecret',
      'pluginId',
      'protocol',
      'ticketId'
    ])
    assert.equal(request.body.host, host)
    assert.equal(request.body.pluginId, pluginId)
    assert.equal(request.body.clientNonce, '01'.repeat(16))
    assert.equal(f.cryptoCalls, 1)
    assert.equal(f.el('ticket').value, '')
    assert.equal(request.options.headers.Authorization, undefined)
    const visible = f.visible() + JSON.stringify(f.posts)
    for (const secret of [sessionToken, sessionId, f.ticket().pairingSecret])
      assert.ok(!visible.includes(secret))
    f.clean()
  })
  test(`${host}: paired host can request and render authenticated layered readiness`, async () => {
    const f = fixture(host)
    await f.pair()
    assert.equal(f.route('readiness').length, 0)
    f.click('check-readiness')
    await flush()
    const request = f.route('readiness')[0]
    assert.ok(request)
    assert.equal(request.body.protocol, 1)
    assert.equal(request.body.hostProbe.host, host)
    assert.match(request.body.hostProbe.adapterVersion, /^(figma-native|photoshop-uxp-native)-/)
    assert.deepEqual(
      Object.keys(request.body.hostProbe).sort(),
      [
        'adapterVersion',
        'document',
        'host',
        'resources',
        'rollback',
        'supports',
        'visualAudit'
      ].sort()
    )
    assert.deepEqual(Object.keys(request.body.hostProbe.resources).sort(), ['fonts', 'visual'])
    assert.equal(request.options.headers.Authorization, 'Bearer ' + sessionToken)
    assert.equal(request.options.headers['X-Figplugin-Session'], sessionId)
    assert.match(f.el('readiness-status').textContent, /provider-not-probed/)
    assert.match(f.el('readiness-status').textContent, /host-paired/)
    f.clean()
  })
  test(`${host}: malformed readiness response is rejected without rendering server text`, async () => {
    const f = fixture(host)
    f.handlers.set('readiness', () => response({ protocol: 1, evil: 'secret' }))
    await f.pair()
    f.click('check-readiness')
    await flush()
    assert.match(f.el('readiness-status').textContent, /Invalid readiness response|就绪检查失败/)
    assert.doesNotMatch(f.el('readiness-status').textContent, /secret/)
    f.clean()
  })
  test(`${host}: ticket rejects mismatched bindings, expiry, unknown keys and malformed secrets before IO`, async () => {
    const invalid = [
      { bridgeOrigin: 'http://127.0.0.1:49153' },
      { bridgeOrigin: 'https://evil.invalid' },
      { pluginId: 'other' },
      { host: 'other' },
      { expiresAt: 0 },
      { extra: true },
      { pairingSecret: 'a'.repeat(63) },
      { pairingSecret: 'a'.repeat(63) + '\n' },
      { artifactSha256: 'C'.repeat(64) },
      { artifactSha256: 'a'.repeat(63) + '\n' },
      { ticketId: 'x'.repeat(32) },
      { ticketId: 'a'.repeat(31) + '\n' },
      { expiresAt: 1.5 }
    ]
    for (const override of invalid) {
      const f = fixture(host)
      await f.pair(f.ticket(override))
      assert.equal(f.requests.length, 0)
      f.clean()
    }
    const f = fixture(host)
    for (const text of [
      '{',
      'null',
      '[]',
      'x'.repeat(4097),
      JSON.stringify({ ...f.ticket(), extra: '你'.repeat(1500) })
    ])
      await f.pair(text)
    assert.equal(f.requests.length, 0)
    assert.equal(f.el('ticket').value, '')
  })
  test(`${host}: absent, unfrozen, or unsafe configuration fails closed`, async () => {
    for (const options of [
      { config: null },
      { unfrozen: true },
      ...[
        'http://localhost.invalid:49152',
        'http://127.0.0.1:999',
        'http://127.0.0.1:65536',
        origin + '/',
        origin + '\n'
      ].map((value) => ({ config: { protocol: 1, host, origin: value, pluginId } }))
    ]) {
      const f = fixture(host, options)
      await f.pair()
      f.capture()
      assert.equal(f.requests.length, 0)
      assert.equal(f.reads, 0)
      f.clean()
    }
  })
  test(`${host}: missing cryptographic randomness has no fallback`, async () => {
    const f = fixture(host, { crypto: false })
    await f.pair()
    f.capture()
    await f.share()
    assert.equal(f.requests.length, 0)
    assert.equal(f.reads, 0)
    f.clean()
  })
  test(`${host}: share requires consent and uses captured snapshot, never fresh selection`, async () => {
    const f = fixture(host)
    await f.pair()
    const captured = f.capture()
    f.selection = [f.makeNode(99, { name: 'NEW PRIVATE SELECTION' })]
    await f.share('Review', false)
    assert.equal(f.route('prepare').length, 0)
    await f.share('  Review  ')
    const request = f.route('prepare')[0]
    assert.deepEqual(request.body.context, captured)
    assert.equal(request.body.prompt, 'Review')
    assert.equal(f.reads, 1)
    assert.equal(request.body.sequence, 1)
    assert.match(request.body.requestId, /^[a-f0-9]{32}$/)
    f.clean()
  })
  test(`${host}: prompt bounds and total UTF-8 envelope bounds reject before prepare`, async () => {
    const f = fixture(host)
    await f.pair()
    f.capture()
    await f.share('')
    await f.share('x'.repeat(16385))
    assert.equal(f.route('prepare').length, 0)
    f.selection = Array.from({ length: 100 }, (_, index) =>
      f.makeNode(index, { name: '你'.repeat(90) })
    )
    const context = f.capture()
    assert.ok(context)
    assert.ok(Buffer.byteLength(JSON.stringify(context)) < 48 * 1024)
    assert.ok(
      Buffer.byteLength(JSON.stringify({ context, prompt: '你'.repeat(16384) })) > 64 * 1024
    )
    await f.share('你'.repeat(16384))
    assert.equal(f.route('prepare').length, 0)
    f.clean()
  })
  test(`${host}: transport is only fixed POST routes with explicit credential isolation`, async () => {
    const f = fixture(host)
    await f.prepare()
    await f.clock.advance(1000)
    f.click('cancel')
    await flush()
    f.click('close')
    await flush()
    assert.deepEqual(
      f.requests.map((request) => request.route),
      ['pair', 'prepare', 'status', 'cancel', 'close']
    )
    for (const request of f.requests) {
      const options = request.options
      assert.equal(options.method, 'POST')
      assert.equal(options.credentials, 'omit')
      assert.equal(options.redirect, 'error')
      assert.equal(options.cache, 'no-store')
      assert.equal(options.headers['Content-Type'], 'application/json')
      assert.ok(options.signal instanceof AbortSignal)
      assert.ok(Buffer.byteLength(options.body) <= 64 * 1024)
      if (request.route !== 'pair') {
        assert.equal(options.headers.Authorization, 'Bearer ' + sessionToken)
        assert.equal(options.headers['X-Figplugin-Session'], sessionId)
        assert.equal(Object.keys(options.headers).length, 3)
      }
    }
    f.clean()
  })
  test(`${host}: no automatic prepare, approval or model calls; poll starts at 1000ms`, async () => {
    const f = fixture(host)
    await f.pair()
    f.capture()
    await f.clock.advance(1000)
    assert.deepEqual(
      f.requests.map((r) => r.route),
      ['pair']
    )
    await f.share()
    await f.clock.advance(999)
    assert.equal(f.route('status').length, 0)
    await f.clock.advance(1)
    assert.equal(f.route('status').length, 1)
    assert.equal(f.route('prepare').length, 1)
    f.clean()
  })
  test(`${host}: duplicate pair/share UI actions and consumed snapshot cannot replay`, async () => {
    const f = fixture(host)
    const pending = deferred()
    f.handlers.set('pair', () => pending.promise)
    await f.pair()
    await f.pair()
    assert.equal(f.route('pair').length, 1)
    pending.resolve(response(f.pairResult()))
    await flush()
    f.capture()
    const prepare = deferred()
    f.handlers.set('prepare', () => prepare.promise)
    await f.share()
    await f.share()
    assert.equal(f.route('prepare').length, 1)
    prepare.resolve(response(f.prepareResult()))
    await flush()
    f.handlers.set('status', () => response(f.statusResult('completed', { content: 'done' })))
    await f.clock.advance(1000)
    await f.share()
    assert.equal(f.route('prepare').length, 1)
    f.capture()
    await f.share()
    assert.equal(f.route('prepare')[1].body.sequence, 2)
    f.clean()
  })
  test(`${host}: session absolute and idle expiry forget credentials and forbid share`, async () => {
    for (const absolute of [true, false]) {
      const f = fixture(host)
      f.handlers.set('pair', () =>
        response(f.pairResult(absolute ? { expiresAt: f.clock.now + 1000 } : {}))
      )
      await f.pair()
      f.capture()
      await f.clock.advance(absolute ? 1000 : 120000)
      await f.share()
      assert.equal(f.route('prepare').length, 0)
      assert.match(f.el('status').textContent, /expired/)
      assert.equal(f.clock.timerCount, 0)
      f.clean()
    }
  })
  test(`${host}: network errors are fixed labels, not secret-bearing exception strings`, async () => {
    const f = fixture(host)
    f.handlers.set('pair', () => Promise.reject(new Error(sessionToken + ' PRIVATE EXCEPTION')))
    await f.pair()
    assert.match(f.el('status').textContent, /Pairing failed/)
    assert.ok(!f.visible().includes(sessionToken))
    assert.ok(!f.visible().includes('PRIVATE EXCEPTION'))
    await f.clock.advance(30000)
    assert.equal(f.requests.length, 1)
    f.clean()
  })
  test(`${host}: 15s total request deadline settles without AbortController and suppresses late pair`, async () => {
    const f = fixture(host, { abort: false })
    const pending = deferred()
    f.handlers.set('pair', () => pending.promise)
    await f.pair()
    assert.equal('signal' in f.requests[0].options, false)
    await f.clock.advance(15000)
    assert.match(f.el('status').textContent, /Pairing failed/)
    pending.resolve(response(f.pairResult()))
    await flush()
    f.capture()
    await f.share()
    assert.equal(f.route('prepare').length, 0)
    assert.equal(f.clock.timerCount, 0)
    f.clean()
  })
  test(`${host}: deadline includes response text, with AbortSignal when available`, async () => {
    const f = fixture(host)
    const pending = deferred()
    f.handlers.set('pair', () => response(null, { text: () => pending.promise }))
    await f.pair()
    await f.clock.advance(15000)
    assert.equal(f.requests[0].options.signal.aborted, true)
    pending.resolve(JSON.stringify(f.pairResult()))
    await flush()
    assert.match(f.el('status').textContent, /Pairing failed/)
    f.clean()
  })
  test(`${host}: oversized Content-Length, UTF-8 body, redirects and malformed pair response denied`, async () => {
    let textReads = 0
    for (const makeResponse of [
      (f) =>
        response(f.pairResult(), {
          headers: { get: () => '131073' },
          text: async () => {
            textReads += 1
            return '{}'
          }
        }),
      () => response(null, { text: async () => '你'.repeat(50000) }),
      (f) => response(f.pairResult(), { redirected: true }),
      (f) => response(f.pairResult(), { url: 'https://evil.invalid' }),
      (f) => response(f.pairResult({ extra: 'secret' })),
      (f) => response(f.pairResult({ sessionToken: 'a'.repeat(63) + '\n' })),
      (f) => response(f.pairResult({ idleTimeoutMs: 1 })),
      (f) => response(f.pairResult({ expiresAt: f.clock.now }))
    ]) {
      const f = fixture(host)
      f.handlers.set('pair', () => makeResponse(f))
      await f.pair()
      assert.match(f.el('status').textContent, /Pairing failed/)
      f.capture()
      await f.share()
      assert.equal(f.route('prepare').length, 0)
      f.clean()
    }
    assert.equal(textReads, 0)
  })
  test(`${host}: cancel invalidates outstanding status epoch and never renders stale content`, async () => {
    const f = fixture(host)
    await f.prepare()
    const pending = deferred()
    f.handlers.set('status', () => pending.promise)
    await f.clock.advance(1000)
    f.click('cancel')
    await flush()
    assert.equal(f.route('cancel').length, 1)
    pending.resolve(response(f.statusResult('completed', { content: 'STALE PRIVATE RESULT' })))
    await flush()
    await f.clock.advance(10000)
    assert.equal(f.el('result').textContent, '')
    assert.equal(f.route('status').length, 1)
    f.clean()
  })
  test(`${host}: recapture cancels pending review and binds only the new snapshot`, async () => {
    const f = fixture(host)
    await f.prepare()
    f.selection = [f.makeNode(88, { name: 'Second capture' })]
    const second = f.capture()
    await flush()
    assert.equal(f.route('cancel').length, 1)
    await f.share()
    assert.deepEqual(f.route('prepare')[1].body.context, second)
    assert.equal(f.route('prepare')[1].body.sequence, 2)
    assert.equal(f.reads, 2)
    f.clean()
  })
  test(`${host}: cancel in-flight prepare closes once and ignores late call receipt`, async () => {
    const f = fixture(host)
    await f.pair()
    f.capture()
    const pending = deferred()
    f.handlers.set('prepare', () => pending.promise)
    await f.share()
    f.click('cancel')
    await flush()
    assert.equal(f.route('close').length, 1)
    pending.resolve(response(f.prepareResult()))
    await flush()
    await f.clock.advance(5000)
    assert.equal(f.route('status').length, 0)
    f.capture()
    await f.share()
    assert.equal(f.route('prepare').length, 1)
    f.clean()
  })
  test(`${host}: uncertain prepare failure closes session once, with no automatic retry`, async () => {
    const f = fixture(host)
    await f.pair()
    f.capture()
    f.handlers.set('prepare', () => Promise.reject(new Error(sessionToken)))
    await f.share()
    assert.equal(f.route('close').length, 1)
    await f.clock.advance(30000)
    assert.equal(f.route('prepare').length, 1)
    assert.ok(!f.visible().includes(sessionToken))
    f.clean()
  })
  test(`${host}: completed content is plain text, and all terminal statuses stop polling`, async () => {
    for (const status of ['completed', 'cancelled', 'failed']) {
      const f = fixture(host)
      await f.prepare()
      const content = '<script>globalThis.pwned=true</script><img src=x onerror=evil()>'
      f.handlers.set('status', () =>
        response(f.statusResult(status, status === 'completed' ? { content } : {}))
      )
      await f.clock.advance(1000)
      await f.clock.advance(5000)
      assert.equal(f.route('status').length, 1)
      assert.equal(f.el('result').textContent, status === 'completed' ? content : '')
      f.clean()
    }
  })
  test(`${host}: response content UTF-8 limit and status identity/shape validated`, async () => {
    for (const extra of [
      { content: '你'.repeat(11000) },
      { content: 'x'.repeat(32769) },
      { content: 'valid', callId: 'f'.repeat(32) },
      { content: 'valid', extra: 'secret' },
      { content: '' }
    ]) {
      const f = fixture(host)
      await f.prepare()
      f.handlers.set('status', () => response(f.statusResult('completed', extra)))
      await f.clock.advance(1000)
      await f.clock.advance(5000)
      assert.equal(f.el('result').textContent, '')
      assert.equal(f.route('status').length, 1)
      f.clean()
    }
  })
  test(`${host}: unauthorized or expired HTTP session is forgotten without body disclosure`, async () => {
    for (const status of [401, 410]) {
      const f = fixture(host)
      await f.prepare()
      f.handlers.set('status', () =>
        response(null, {
          ok: false,
          status,
          text: () => {
            throw new Error('MUST NOT READ SECRET')
          }
        })
      )
      await f.clock.advance(1000)
      f.capture()
      await f.share()
      assert.equal(f.route('prepare').length, 1)
      assert.equal(f.clock.timerCount, 0)
      f.clean()
    }
  })
  test(`${host}: at most 120 polls, no retry after status failure, and call expiry halts polling`, async () => {
    const f = fixture(host)
    f.handlers.set('prepare', () => response(f.prepareResult({ expiresAt: f.clock.now + 500000 })))
    await f.prepare()
    await f.clock.advance(121000)
    assert.equal(f.route('status').length, 120)
    assert.equal(f.route('cancel').length, 1)
    const failed = fixture(host)
    await failed.prepare()
    failed.handlers.set('status', () => Promise.reject(new Error(sessionToken)))
    await failed.clock.advance(10000)
    assert.equal(failed.route('status').length, 1)
    assert.equal(failed.route('close').length, 1)
    const expired = fixture(host)
    expired.handlers.set('prepare', () =>
      response(expired.prepareResult({ expiresAt: expired.clock.now + 1500 }))
    )
    await expired.prepare()
    await expired.clock.advance(10000)
    assert.equal(expired.route('status').length, 1)
    assert.equal(expired.route('cancel').length, 1)
    f.clean()
    failed.clean()
    expired.clean()
  })
  test(`${host}: close and disposal make one best-effort attempt and forget secrets`, async () => {
    const f = fixture(host)
    await f.prepare()
    f.handlers.set('close', () => Promise.reject(new Error(sessionToken)))
    f.click('close')
    f.click('close')
    f.dispose()
    await flush()
    await f.clock.advance(30000)
    assert.equal(f.route('close').length, 1)
    assert.equal(f.route('status').length, 0)
    assert.equal(f.el('result').textContent, '')
    assert.equal(f.el('selection').textContent, '')
    assert.equal(f.clock.timerCount, 0)
    assert.ok(!f.visible().includes(sessionToken))
    f.clean()
  })
  test(`${host}: capture exception/duplicate IDs fail closed without a partial shareable snapshot`, async () => {
    const f = fixture(host)
    await f.pair()
    f.capture()
    f.selection = [f.makeNode(1), f.makeNode(1)]
    assert.equal(f.capture(), null)
    await f.share()
    assert.equal(f.route('prepare').length, 0)
    f.selection = [
      {
        get id() {
          throw new Error(sessionToken)
        }
      }
    ]
    assert.equal(f.capture(), null)
    assert.ok(!f.visible().includes(sessionToken))
    f.clean()
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: local review without an injected helper leaves the bridge review and consent untouched`, async () => {
    const f = fixture(host)
    await f.prepare()
    const requestsBefore = f.requests.length
    const timersBefore = f.clock.timerCount
    const statusBefore = f.el('status').textContent
    f.el('consent').checked = true
    f.click('read-only-capture')
    assert.equal(f.el('read-only-output').textContent, 'SNAPSHOT_UNAVAILABLE')
    assert.equal(f.el('consent').checked, true)
    assert.equal(f.el('status').textContent, statusBefore)
    assert.equal(f.requests.length, requestsBefore)
    assert.equal(f.clock.timerCount, timersBefore)
    assert.equal(f.reads, 1)
    await f.clock.advance(1000)
    assert.equal(f.route('status').length, 1)
    f.clean()
  })
}

test('Figma geometry is all finite and bounded or entirely omitted', () => {
  for (const override of [
    { rotation: undefined },
    { width: Infinity },
    { x: 10000001 },
    { y: NaN }
  ]) {
    const f = fixture('figma')
    f.selection = [f.makeNode(1, override)]
    assert.equal('geometry' in f.capture().nodes[0], false)
    f.clean()
  }
})
test('Figma strict message protocol ignores forged shapes, revisions and arbitrary endpoints', async () => {
  const f = fixture('figma')
  await f.pair()
  const first = f.capture()
  f.capture()
  const share = {
    protocol: 1,
    type: 'share',
    nonce: 'a'.repeat(32),
    revision: first.selectionRevision,
    prompt: 'Review',
    consent: true
  }
  for (const value of [
    share,
    { ...share, context: {} },
    { ...share, protocol: 2 },
    { protocol: 1, type: 'capture', nonce: 'notrandom' },
    { protocol: 1, type: 'capture', nonce: 'a'.repeat(31) + '\n' },
    { protocol: 1, type: 'capture', nonce: 'b'.repeat(32), url: 'https://evil.invalid' },
    { protocol: 1, type: 'authorize' },
    { protocol: 1, type: 'status' }
  ])
    f.receive(value)
  await flush()
  assert.equal(f.route('prepare').length, 0)
  assert.equal(f.reads, 2)
  f.clean()
})
test('Figma UI accepts only parent protocol messages, no forged iframe status/config or HTML', () => {
  const f = fixture('figma')
  const content = { protocol: 1, type: 'content', text: '<img onerror=evil()>' }
  f.emit(content, {})
  assert.equal(f.el('result').textContent, '')
  f.emit({ ...content, protocol: 2 }, f.parent)
  assert.equal(f.el('result').textContent, '')
  f.emit({ ...content, extra: true }, f.parent)
  assert.equal(f.el('result').textContent, '')
  f.emit(content, f.parent)
  assert.equal(f.el('result').textContent, content.text)
  f.clean()
})
test('Photoshop initializes once on DOMContentLoaded and reads only explicit active layers', () => {
  const f = fixture('photoshop', { loading: true, noDocument: true })
  assert.equal(f.reads, 0)
  f.loaded()
  f.loaded()
  assert.deepEqual(f.capture().nodes, [])
  assert.equal(f.reads, 1)
  f.clean()
})
test('Connected protocol entrypoints contain no evaluation, HTML injection, direct credential storage or model endpoint', () => {
  for (const [host, { code, html }] of Object.entries(sources)) {
    assert.doesNotMatch(
      code + html,
      /\beval\s*\(|new\s+Function\b|innerHTML|insertAdjacentHTML|document\.write|Math\.random|localStorage|sessionStorage|clientStorage|batchPlay|\/authorize|\/chat\/completions|\/responses/
    )
    if (host === 'figma') assert.doesNotMatch(code, /executeAsModal/)
    else assert.match(code, /executeAsModal/)
    assert.match(
      html.replace(/\s+/g, ' '),
      /Send this prompt and selection metadata to MagicPot for desktop approval; may incur model charges only after approval/
    )
    assert.doesNotMatch(html, /\son\w+\s*=|<script[^>]+src="https?:/)
  }
})

test('Photoshop native plan execution uses the shared lifecycle and readback validator', () => {
  const code = sources.photoshop.code
  assert.match(code, /createHostAdapterLifecycle/)
  assert.match(
    code,
    /discoverCapabilities:\s*\(\) => \(\{\s*host:\s*HOST,\s*execution:\s*item\.hostContext\.execution/s
  )
  assert.match(
    code,
    /lifecycle\.run\(\{[\s\S]*?resources:\s*item\.lifecycleResources,[\s\S]*?imageRecovery:\s*item\.recovery\?\.images/s
  )
  assert.match(
    code,
    /validateHostPlanReadback\(\s*plan,\s*item\.hostContext,\s*candidate,\s*item\.lifecycleResources(?:,\s*item\.recovery\?\.images)?\s*\)/s
  )
  assert.match(code, /const validatedReadback = async \(\) =>/)
  assert.match(code, /prepareResources:\s*async/)
  assert.match(code, /execute:\s*async/)
  assert.match(code, /readback:\s*async/)
  assert.match(code, /lifecycle\.run\(\{[\s\S]*?runId:\s*item\.executionId/)
  assert.match(code, /let sequence = \(meta\.lastProgressSequence \?\? 1\) \+ 1/)
  assert.doesNotMatch(code, /let sequence = plan\.steps\.length \+ 2/)
  assert.match(
    code,
    /typeof executeAsModal !== 'function'[\s\S]*?reportPreparationFailure\(item, intent\.plan, 'HOST_UNAVAILABLE'\)/
  )
  assert.match(
    code,
    /if \(modalError && !result\)[\s\S]*?reportPreparationFailure\(item, plan, 'HOST_UNAVAILABLE'\)/
  )
})

test('Figma native plan execution uses shared lifecycle validation and readback contract', () => {
  const code = sources.figma.code
  assert.match(code, /function createFigmaPlanLifecycle\(planner, item\)/)
  assert.match(code, /createHostAdapterLifecycle/)
  assert.match(
    code,
    /discoverCapabilities:\s*\(\) => \(\{\s*host:\s*HOST,\s*execution:\s*item\.hostContext\.execution/s
  )
  assert.match(code, /captureContext: \(captureId\) =>/)
  assert.match(
    code,
    /lifecycle\.run\(\{[\s\S]*?resources:\s*item\.assetMetadata,[\s\S]*?imageRecovery:\s*item\.recovery\?\.images/s
  )
  assert.match(code, /function createPlanReadback\(context, plan, item\)/)
  assert.match(
    code,
    /validateHostPlanReadback\(\s*plan,\s*context,\s*readback,\s*item\?\.assetMetadata(?:,\s*item\?\.recovery\?\.images)?\s*\)/s
  )
  assert.match(code, /prepareResources:\s*async/)
  assert.match(code, /execute:\s*async/)
  assert.match(code, /readback:\s*async/)
  assert.match(code, /lifecycle\.run\(\{[\s\S]*?runId:\s*item\.executionId/)
  assert.match(code, /let sequence = \(meta\.lastProgressSequence \?\? 1\) \+ 1/)
  assert.doesNotMatch(code, /let sequence = plan\.steps\.length \+ 2/)
  assert.doesNotMatch(code, /lifecycleCancel/)
})

test('Figma recovery UI requires parent pairing state and sends only a bounded recovery opcode', () => {
  const f = fixture('figma')
  assert.equal(f.el('restore-task').disabled, true)
  const before = f.uiSends.length
  f.click('restore-task')
  assert.equal(f.uiSends.length, before)
  f.emit({ protocol: 1, type: 'state', label: 'Paired', paired: true, busy: false }, f.parent)
  assert.equal(f.el('restore-task').disabled, false)
  f.click('restore-task')
  const message = f.uiSends.at(-1)
  assert.equal(message.type, 'restore-task')
  assert.match(message.nonce, /^[a-f0-9]{32}$/)
  assert.match(message.instanceEpoch, /^[a-f0-9]{32}$/)
  assert.equal(Object.hasOwn(message, 'plan'), false)
  assert.equal(Object.hasOwn(message, 'prompt'), false)
  assert.equal(f.requests.length, 0)
  f.clean()
})

for (const host of ['figma', 'photoshop']) {
  test(`${host}: explicit connection probe sends no ticket, context, session or model request`, async () => {
    const f = fixture(host)
    const saved = JSON.stringify(f.ticket())
    f.el('ticket').value = saved
    f.click('check-connection')
    await flush()
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].route, 'probe')
    assert.deepEqual(Object.keys(f.requests[0].body).sort(), ['nonce', 'protocol'])
    assert.deepEqual(Object.keys(f.requests[0].options.headers), ['Content-Type'])
    assert.equal(f.el('ticket').value, saved)
    assert.equal(f.reads, 0)
    assert.match(f.el('connection-status').textContent, /Bridge reachable/)
    assert.equal(f.el('share').disabled, true)
    assert.equal(f.el('pair').disabled, false)
    assert.equal(f.clock.timerCount, 0)
    f.clean()
  })
  test(`${host}: pending connection probe does not permit a second probe or pairing`, async () => {
    const f = fixture(host),
      gate = deferred()
    f.handlers.set('probe', () => gate.promise)
    f.click('check-connection')
    f.click('check-connection')
    await f.pair()
    assert.equal(f.requests.length, 1)
    assert.equal(f.el('check-connection').disabled, true)
    f.click('cancel')
    await flush()
    assert.match(f.el('connection-status').textContent, /cancelled/)
    const text = f.el('connection-status').textContent
    gate.resolve(
      response({ protocol: 1, kind: 'figplugin-bridge-probe', nonce: f.requests[0].body.nonce })
    )
    await flush()
    assert.equal(f.el('connection-status').textContent, text)
    assert.equal(f.clock.timerCount, 0)
    assert.equal(f.reads, 0)
    f.clean()
  })
  test(`${host}: closing during a probe suppresses late success and clears timers`, async () => {
    const f = fixture(host, { abort: false }),
      gate = deferred()
    f.handlers.set('probe', () => gate.promise)
    f.click('check-connection')
    f.click('close')
    await flush()
    const text = f.el('connection-status').textContent
    gate.resolve(
      response({ protocol: 1, kind: 'figplugin-bridge-probe', nonce: f.requests[0].body.nonce })
    )
    await flush()
    assert.equal(f.el('connection-status').textContent, text)
    assert.equal(f.clock.timerCount, 0)
    assert.equal(f.reads, 0)
    f.clean()
  })
  test(`${host}: probe times out without automatic retry or late success`, async () => {
    const f = fixture(host),
      gate = deferred()
    f.handlers.set('probe', () => gate.promise)
    f.click('check-connection')
    await f.clock.advance(5001)
    assert.match(f.el('connection-status').textContent, /timed out/)
    gate.resolve(
      response({ protocol: 1, kind: 'figplugin-bridge-probe', nonce: f.requests[0].body.nonce })
    )
    await flush()
    assert.match(f.el('connection-status').textContent, /timed out/)
    assert.equal(f.requests.length, 1)
    assert.equal(f.clock.timerCount, 0)
    f.clean()
  })
  test(`${host}: native network refusal is actionable and does not expose the raw error`, async () => {
    const f = fixture(host)
    f.handlers.set('probe', async () => {
      throw new Error(
        'Script is not permitted to access the network apis, additioanl permissions required PRIVATE_TOKEN'
      )
    })
    f.click('check-connection')
    await flush()
    assert.match(f.el('connection-status').textContent, /UXP/)
    assert.doesNotMatch(f.visible(), /PRIVATE_TOKEN/)
    assert.equal(f.reads, 0)
    f.clean()
  })
  test(`${host}: missing probe helper does not fall back to an unbounded request`, async () => {
    const f = fixture(host, { probeHelper: false })
    f.click('check-connection')
    await flush()
    assert.match(f.el('connection-status').textContent, /helper missing/)
    assert.equal(f.requests.length, 0)
    assert.equal(f.reads, 0)
    assert.equal(f.clock.timerCount, 0)
    f.clean()
  })
}

test('native connectivity helper is generated from the same shared source as the server contract', async () => {
  const generated = await buildHostBridgeReadiness()
  assert.equal(read('shared/bridge-readiness.js'), generated.text)
})

test('native plan validators are generated from the same shared source as the server contract', () => {
  assert.equal(read('shared/plan-preview.js'), generationValidators)
})

for (const host of ['figma', 'photoshop']) {
  test(`${host}: explicit localhost pairs only against its signed origin and never normalizes a numeric ticket`, async () => {
    const origin = 'http://localhost:49152'
    const f = fixture(host, { origin })
    await f.pair(f.ticket({ bridgeOrigin: 'http://127.0.0.1:49152' }))
    assert.equal(f.requests.length, 0)
    await f.pair()
    assert.equal(f.route('pair').length, 1)
    assert.equal(f.route('pair')[0].url, origin + '/figplugin/v1/pair')
    assert.match(f.el('status').textContent, /Paired/)
    assert.equal(f.el('ticket').value, '')
    f.clean()
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: image generation requires pairing, independent prompt consent and no selection capture`, async () => {
    const f = fixture(host)
    await f.generate()
    assert.equal(f.route('image-generation/prepare').length, 0)
    await f.pair()
    await f.generate('A terrarium', false)
    assert.equal(f.route('image-generation/prepare').length, 0)
    await f.generate('   ')
    await f.generate('x'.repeat(8193))
    assert.equal(f.route('image-generation/prepare').length, 0)
    await f.generate()
    const [request] = f.route('image-generation/prepare')
    assert.deepEqual(Object.keys(request.body).sort(), [
      'prompt',
      'protocol',
      'requestId',
      'sequence'
    ])
    assert.equal(request.body.prompt, 'A green terrarium')
    assert.equal(request.body.sequence, 1)
    assert.equal(request.options.headers.Authorization, 'Bearer ' + sessionToken)
    assert.equal(request.options.redirect, 'error')
    assert.equal(f.reads, 0)
    assert.equal(f.el('generation-consent').checked, false)
    assert.equal(f.el('generation-submit').disabled, true)
    assert.equal(f.el('generation-cancel').disabled, false)
    assert.equal(f.route('prepare').length, 0)
    f.clean()
  })

  test(`${host}: active generation cannot leak a selection or be replaced by a capture/share click`, async () => {
    const f = fixture(host)
    await f.pair()
    f.capture()
    const reads = f.reads
    await f.generate()
    await f.generate('Second prompt')
    f.capture()
    f.click('plan-capture')
    await f.share('Old selection prompt')
    assert.equal(f.reads, reads)
    assert.equal(f.route('image-generation/prepare').length, 1)
    assert.equal(f.route('prepare').length, 0)
    assert.match(f.el('generation-status').textContent, /unavailable|Awaiting/)
    f.clean()
  })

  test(`${host}: status polls are one-flight and successful images remain desktop-only`, async () => {
    const f = fixture(host)
    const pending = deferred()
    f.handlers.set('image-generation/status', () => pending.promise)
    await f.pair()
    await f.generate()
    await f.clock.advance(5000)
    assert.equal(f.route('image-generation/status').length, 1)
    const statusRequest = f.route('image-generation/status')[0]
    assert.deepEqual(statusRequest.body, {
      protocol: 1,
      requestId: f.route('image-generation/prepare')[0].body.requestId,
      proposalId: '8'.repeat(32)
    })
    pending.resolve(response(f.generationStatus('accepted')))
    await flush()
    assert.match(f.el('generation-status').textContent, /desktop only/)
    assert.match(f.el('generation-status').textContent, /Separately choose\/share/)
    assert.match(f.el('generation-status').textContent, /writes need another approval/)
    await f.clock.advance(10000)
    assert.equal(f.route('image-generation/status').length, 1)
    assert.equal(f.el('generation-cancel').disabled, true)
    assert.equal(f.el('generation-submit').disabled, true)
    assert.equal(f.reads, 0)
    f.clean()
  })

  test(`${host}: exact known-proposal cancel stays independent of a pending status request`, async () => {
    const f = fixture(host)
    const pending = deferred()
    f.handlers.set('image-generation/status', () => pending.promise)
    await f.pair()
    await f.generate()
    await f.clock.advance(1000)
    f.click('generation-cancel')
    f.click('generation-cancel')
    await flush()
    assert.equal(f.route('image-generation/cancel').length, 1)
    assert.deepEqual(f.route('image-generation/cancel')[0].body, {
      protocol: 1,
      requestId: f.route('image-generation/prepare')[0].body.requestId,
      proposalId: '8'.repeat(32)
    })
    pending.resolve(response(f.generationStatus('accepted')))
    await flush()
    assert.match(f.el('generation-status').textContent, /Stopped locally/)
    assert.equal(f.route('cancel').length, 0)
    assert.equal(f.route('close').length, 0)
    f.clean()
  })

  test(`${host}: cancellation during uncertain prepare closes the session once and ignores late receipt`, async () => {
    const f = fixture(host)
    const pending = deferred()
    f.handlers.set('image-generation/prepare', () => pending.promise)
    await f.pair()
    await f.generate()
    f.click('generation-cancel')
    await flush()
    const requestId = f.route('image-generation/prepare')[0].body.requestId
    pending.resolve(
      response({
        protocol: 1,
        requestId,
        proposalId: '8'.repeat(32),
        status: 'awaiting-approval',
        createdAt: f.clock.now,
        expiresAt: f.clock.now + 120000
      })
    )
    await flush()
    await f.clock.advance(5000)
    assert.equal(f.route('close').length, 1)
    assert.equal(f.route('image-generation/cancel').length, 0)
    assert.equal(f.route('image-generation/status').length, 0)
    assert.equal(f.el('generation-submit').disabled, true)
    f.clean()
  })

  for (const fault of [
    'wrong-request',
    'wrong-proposal',
    'extra-output',
    'extended-expiry',
    'future-update'
  ]) {
    test(`${host}: ${fault} status closes the session rather than displaying or adopting data`, async () => {
      const f = fixture(host)
      f.handlers.set('image-generation/status', () =>
        response(
          f.generationStatus(
            'generating',
            fault === 'wrong-request'
              ? { requestId: '9'.repeat(32) }
              : fault === 'wrong-proposal'
                ? { proposalId: '9'.repeat(32) }
                : fault === 'extra-output'
                  ? { localMediaUrl: 'https://invalid.example/private-image' }
                  : fault === 'extended-expiry'
                    ? { expiresAt: f.generationCreatedAt + 120001 }
                    : { updatedAt: f.clock.now + 1 }
          )
        )
      )
      await f.pair()
      await f.generate()
      await f.clock.advance(5000)
      assert.equal(f.route('image-generation/status').length, 1)
      assert.equal(f.route('close').length, 1)
      assert.equal(f.visible().includes('invalid.example'), false)
      assert.equal(f.reads, 0)
      f.clean()
    })
  }

  for (const phase of ['failed', 'declined', 'cancelled']) {
    test(`${host}: ${phase} generation is terminal and never automatically retries`, async () => {
      const f = fixture(host)
      f.handlers.set('image-generation/status', () => response(f.generationStatus(phase)))
      await f.pair()
      await f.generate()
      await f.clock.advance(10000)
      assert.equal(f.route('image-generation/prepare').length, 1)
      assert.equal(f.route('image-generation/status').length, 1)
      assert.equal(f.el('generation-submit').disabled, true)
      assert.equal(f.el('generation-consent').checked, false)
      f.clean()
    })
  }

  test(`${host}: helper absence, bounded expiry and shutdown do not open another generation route`, async () => {
    const absent = fixture(host, { generationHelper: false })
    await absent.pair()
    await absent.generate()
    assert.equal(absent.route('image-generation/prepare').length, 0)
    absent.clean()
    const expired = fixture(host)
    await expired.pair()
    await expired.generate()
    await expired.clock.advance(121000)
    assert.ok(expired.route('image-generation/status').length <= 120)
    assert.equal(expired.route('image-generation/prepare').length, 1)
    assert.equal(expired.el('generation-cancel').disabled, true)
    expired.clean()
    const closed = fixture(host)
    await closed.pair()
    await closed.generate()
    closed.dispose()
    await flush()
    await closed.clock.advance(5000)
    assert.equal(closed.route('close').length, 1)
    assert.equal(closed.route('image-generation/status').length, 0)
    closed.clean()
  })

  for (const finish of ['polling', 'accepted', 'cancelled']) {
    test(`${host}: generation ${finish} never extends the original session idle deadline`, async () => {
      const f = fixture(host)
      await f.pair()
      await f.clock.advance(30000)
      if (finish === 'accepted')
        f.handlers.set('image-generation/status', () => response(f.generationStatus('accepted')))
      await f.generate()
      await f.clock.advance(1000)
      if (finish === 'cancelled') {
        f.click('generation-cancel')
        await flush()
      }
      await f.clock.advance(88999)
      assert.equal(f.el('pair').disabled, true)
      await f.clock.advance(1)
      assert.equal(f.el('pair').disabled, false)
      const polls = f.route('image-generation/status').length
      await f.clock.advance(2000)
      assert.equal(f.route('image-generation/status').length, polls)
      assert.equal(f.route('image-generation/prepare').length, 1)
      assert.equal(f.el('generation-submit').disabled, true)
      f.clean()
    })
  }
}
