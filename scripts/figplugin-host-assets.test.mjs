import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

const base = new URL('../packages/figplugin-hosts/', import.meta.url)
const source = (path) => readFileSync(new URL(path, base), 'utf8')
const bundle = await buildHostPlanPreview()
const drain = () => new Promise((resolve) => setImmediate(resolve))
const copy = (value) => JSON.parse(JSON.stringify(value))

// Production scripts, isolated VM/DOM/API-shape fixtures. The image load event and
// intrinsic dimensions are fixture inputs, not a claim of native-host decoding/E2E.
function fixture(
  host,
  {
    fault,
    mimeType = 'image/png',
    gate = false,
    dimensions = true,
    decoder = true,
    autoDecode = true
  } = {}
) {
  let now = 1800000000000
  let serial = 0
  const timers = new Map()
  const requests = []
  const posts = []
  const urls = new Map()
  const revoked = []
  const blobs = []
  const decodes = []
  const hashes = new Set()
  const nativeEvents = new Map()
  const uiEvents = new Map()
  const elements = new Map()
  const sideEffects = { writes: 0, exports: 0 }
  const bytes = Uint8Array.from({ length: 50001 }, (_, index) => index % 251)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const asset = {
    version: 1,
    kind: 'session-image-asset',
    purpose: 'local-preview',
    sessionId: '1'.repeat(32),
    pluginId: 'asset-preview',
    projectId: 'project_a',
    host,
    assetId: '2'.repeat(32),
    mimeType,
    sha256,
    sizeBytes: bytes.length,
    width: 96,
    height: 96,
    chunkSize: 24576,
    chunkCount: Math.ceil(bytes.length / 24576),
    createdAt: now,
    expiresAt: now + 120000
  }
  const catalog = {
    protocol: 1,
    purpose: 'local-preview',
    sessionId: asset.sessionId,
    assets: [asset]
  }
  let releaseRead = null
  const fakeSetTimeout = (callback, delay) => {
    const id = ++serial
    timers.set(id, { callback, at: now + delay })
    return id
  }
  class Clock extends Date {
    static now() {
      return now
    }
  }
  const makeElement = (tagName = 'div') => {
    let text = '',
      src = ''
    const handlers = new Map()
    const element = {
      tagName: tagName.toUpperCase(),
      id: '',
      value: '',
      hidden: false,
      disabled: false,
      checked: false,
      style: {},
      children: [],
      parentNode: null,
      naturalWidth: 0,
      naturalHeight: 0,
      get textContent() {
        return text
      },
      set textContent(value) {
        text = value
        this.children = []
      },
      set innerHTML(_value) {
        throw new Error('Unsafe HTML rendering')
      },
      get src() {
        return src
      },
      set src(value) {
        src = value
        if (value) decodes.push({ element: this, url: value })
      },
      setAttribute(name, value) {
        this[name] = value
      },
      removeAttribute(name) {
        if (name === 'src') src = ''
        else delete this[name]
      },
      addEventListener(name, callback) {
        handlers.set(name, callback)
      },
      removeEventListener(name, callback) {
        if (handlers.get(name) === callback) handlers.delete(name)
      },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        if (child.id) elements.set(child.id, child)
        return child
      },
      replaceChild(next, previous) {
        const index = this.children.indexOf(previous)
        if (index >= 0) this.children[index] = next
        next.parentNode = this
        previous.parentNode = null
        if (next.id) elements.set(next.id, next)
      },
      fire(name) {
        handlers.get(name)?.({ target: this })
        this['on' + name]?.()
      },
      listener(name) {
        return handlers.get(name) ?? this['on' + name]
      }
    }
    return element
  }
  const html = source(host === 'figma' ? 'figma/bridge/ui.html' : 'photoshop-uxp/bridge/index.html')
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = makeElement(match[1])
    element.id = match[2]
    element.hidden = match[0].includes(' hidden')
    elements.set(element.id, element)
  }
  for (const id of ['context-image', 'session-asset-image'])
    elements.get(id.replace('image', 'view'))?.appendChild(elements.get(id))
  // The context-image container uses a different suffix.
  elements.get('context-image-view').appendChild(elements.get('context-image'))
  const document = {
    readyState: 'complete',
    getElementById(id) {
      assert.ok(elements.has(id), 'Known production element: ' + id)
      return elements.get(id)
    },
    createElement: makeElement,
    addEventListener() {
      /* The fixture starts after DOMContentLoaded. */
    }
  }
  class LocalBlob {
    constructor(parts, options) {
      this.type = options.type
      this.bytes = new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))))
      blobs.push(this)
    }
  }
  class LocalImageBlob extends LocalBlob {
    constructor(buffer, options) {
      super([buffer], options)
    }
  }
  const urlApi = {
    createObjectURL(blob) {
      const url = 'blob:fixture-' + ++serial
      urls.set(url, blob)
      return url
    },
    revokeObjectURL(url) {
      revoked.push(url)
      urls.delete(url)
    }
  }
  const common = {
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    Date: Clock,
    console,
    setTimeout: fakeSetTimeout,
    clearTimeout: (id) => timers.delete(id)
  }
  const origin = 'http://127.0.0.1:34567'
  const fetch = async (url, options) => {
    const path = url.slice(origin.length)
    const body = JSON.parse(options.body)
    requests.push({ path, body, options })
    let value
    let status = 200
    if (path === '/figplugin/v1/pair')
      value = {
        protocol: 1,
        sessionId: asset.sessionId,
        sessionToken: '3'.repeat(64),
        expiresAt: now + 600000,
        idleTimeoutMs: 120000
      }
    else {
      assert.equal(options.headers.Authorization, 'Bearer ' + '3'.repeat(64))
      assert.equal(options.headers['X-Figplugin-Session'], asset.sessionId)
      if (path === '/figplugin/v1/assets/list') {
        assert.deepEqual(body, { protocol: 1, purpose: 'local-preview' })
        value = fault === 'catalog' ? { ...catalog, sessionId: 'f'.repeat(32) } : catalog
      } else if (path === '/figplugin/v1/assets/read') {
        assert.deepEqual(body, {
          protocol: 1,
          purpose: 'local-preview',
          assetId: asset.assetId,
          sha256: asset.sha256,
          index: body.index
        })
        value = {
          protocol: 1,
          purpose: 'local-preview',
          sessionId: asset.sessionId,
          assetId: asset.assetId,
          chunk: {
            version: 1,
            kind: 'content-addressed-binary-chunk',
            sha256: asset.sha256,
            index: body.index,
            chunkCount: asset.chunkCount,
            bytesBase64: Buffer.from(
              bytes.subarray(body.index * 24576, (body.index + 1) * 24576)
            ).toString('base64')
          }
        }
        if (fault === 'chunk' && body.index === 1)
          value.chunk.bytesBase64 = value.chunk.bytesBase64.replace(/^./, 'B')
        if (fault === 'identity') value.assetId = 'f'.repeat(32)
        if (fault === 'revoked') status = 404
        if (gate && !releaseRead)
          await new Promise((resolve) => {
            releaseRead = resolve
          })
      } else if (path === '/figplugin/v1/close') {
        status = 204
        value = null
      } else assert.fail('No provider, planning, upload or mutation route permitted: ' + path)
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      redirected: false,
      headers: { get: () => null },
      text: async () => JSON.stringify(value)
    }
  }
  let native,
    uiParent = null
  const random = {
    getRandomValues(data) {
      for (let index = 0; index < data.length; index++) data[index] = (++serial + index) & 255
      return data
    }
  }
  const nativeGlobals = {
    ...common,
    fetch,
    MAGICPOT_BRIDGE_CONFIG: Object.freeze({ protocol: 1, origin, pluginId: asset.pluginId, host })
  }
  const mutate = () => {
    sideEffects.writes++
    throw new Error('No host mutations allowed')
  }
  if (host === 'figma') {
    nativeGlobals.__html__ = ''
    nativeGlobals.figma = {
      currentPage: { selection: [] },
      showUI() {
        /* The production UI script is started in its own VM below. */
      },
      on: (name, callback) => nativeEvents.set(name, callback),
      closePlugin() {
        /* Shutdown authority is observed through production close callbacks. */
      },
      createRectangle: mutate,
      createText: mutate,
      createImage() {
        sideEffects.exports++
        throw new Error('No image insertion API needed')
      },
      ui: {
        postMessage(value) {
          posts.push(copy(value))
          if (uiParent)
            queueMicrotask(() =>
              uiEvents.get('message')?.({ source: uiParent, data: { pluginMessage: copy(value) } })
            )
        }
      }
    }
  } else {
    Object.assign(nativeGlobals, {
      crypto: random,
      document,
      URL: urlApi,
      ImageBlob: decoder ? LocalImageBlob : undefined,
      window: { addEventListener: (name, callback) => nativeEvents.set(name, callback) },
      require(name) {
        assert.equal(name, 'photoshop')
        return { app: {}, core: { executeAsModal: mutate }, action: { batchPlay: mutate } }
      }
    })
  }
  native = createContext(nativeGlobals)
  new Script(bundle.text).runInContext(native)
  new Script(source('shared/visual-evidence.js')).runInContext(native)
  new Script(
    source(host === 'figma' ? 'figma/bridge/code.js' : 'photoshop-uxp/bridge/main.js')
  ).runInContext(native)
  if (host === 'figma') {
    uiParent = {
      postMessage(value) {
        queueMicrotask(() => nativeGlobals.figma.ui.onmessage(copy(value.pluginMessage)))
      }
    }
    const ui = createContext({
      ...common,
      document,
      parent: uiParent,
      TextEncoder,
      crypto: {
        getRandomValues: random.getRandomValues,
        subtle: {
          digest(...args) {
            const pending = webcrypto.subtle.digest(...args)
            hashes.add(pending)
            void pending.finally(() => hashes.delete(pending))
            return pending
          }
        }
      },
      Blob: decoder ? LocalBlob : undefined,
      URL: urlApi,
      window: { addEventListener: (name, callback) => uiEvents.set(name, callback) }
    })
    const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
      .map((match) => match[1])
      .join('\n')
    new Script(inline).runInContext(ui)
  }
  const decodePending = () => {
    while (decodes.length) {
      const { element, url } = decodes.shift()
      if (element.src !== url || !urls.has(url)) continue
      element.naturalWidth = dimensions ? asset.width : asset.width + 1
      element.naturalHeight = asset.height
      element.fire('load')
    }
  }
  const flush = async () => {
    for (let index = 0; index < 4; index++) await drain()
    if (hashes.size) {
      await Promise.all([...hashes])
      await drain()
    }
    if (autoDecode) decodePending()
    await drain()
  }
  return {
    asset,
    bytes,
    requests,
    posts,
    urls,
    revoked,
    blobs,
    sideEffects,
    elements,
    async click(id) {
      elements.get(id).fire('click')
      await flush()
    },
    async pair() {
      await flush()
      const pairedCount = requests.filter((request) => request.path === '/figplugin/v1/pair').length
      elements.get('ticket').value = JSON.stringify({
        ticketId: '4'.repeat(32),
        pairingSecret: '5'.repeat(64),
        expiresAt: now + 120000,
        bridgeOrigin: origin,
        pluginId: asset.pluginId,
        host,
        artifactSha256: '6'.repeat(64)
      })
      await this.click('pair')
      assert.equal(
        requests.filter((request) => request.path === '/figplugin/v1/pair').length,
        pairedCount + 1
      )
    },
    async select() {
      const button = elements.get('session-assets-list').children[0]
      assert.ok(button)
      button.fire('click')
      await flush()
    },
    async advance(ms) {
      now += ms
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      await flush()
    },
    async release() {
      releaseRead?.()
      await flush()
    },
    async shutdown() {
      if (host === 'figma') uiEvents.get('pagehide')?.()
      else nativeEvents.get('pagehide')?.()
      await flush()
    },
    async decode() {
      decodePending()
      await flush()
    },
    flush
  }
}

for (const host of ['figma', 'photoshop']) {
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp'])
    test(`${host}: explicit metadata list, chosen exact ${mimeType} preview, bounded messages and no writes/model`, async () => {
      const f = fixture(host, { mimeType })
      await f.pair()
      assert.deepEqual(
        f.requests.map((request) => request.path),
        ['/figplugin/v1/pair']
      )
      await f.click('session-assets-refresh')
      assert.equal(f.requests.filter((request) => request.path.endsWith('/assets/read')).length, 0)
      assert.equal(f.blobs.length, 0)
      await f.select()
      assert.equal(
        f.requests.filter((request) => request.path.endsWith('/assets/read')).length,
        f.asset.chunkCount
      )
      assert.equal(f.elements.get('session-asset-view').hidden, false)
      assert.equal(f.blobs.at(-1).type, mimeType)
      assert.equal(Buffer.compare(Buffer.from(f.blobs.at(-1).bytes), Buffer.from(f.bytes)), 0)
      assert.equal(f.elements.get('consent').checked, false)
      assert.deepEqual(f.sideEffects, { writes: 0, exports: 0 })
      for (const message of f.posts.filter((message) => message.type === 'session-asset-bytes')) {
        assert.ok(message.data.length <= 24576)
        assert.ok(Buffer.byteLength(JSON.stringify(message)) < 128 * 1024)
      }
      await f.click('session-assets-clear')
      assert.equal(f.urls.size, 0)
      assert.equal(f.elements.get('session-asset-view').hidden, true)
      assert.ok(f.revoked.length)
    })

  for (const fault of ['chunk', 'identity', 'revoked', 'catalog'])
    test(`${host}: ${fault} fails closed before local image publication`, async () => {
      const f = fixture(host, { fault })
      await f.pair()
      await f.click('session-assets-refresh')
      if (fault !== 'catalog') await f.select()
      assert.equal(f.blobs.length, 0)
      assert.equal(f.urls.size, 0)
      assert.equal(f.elements.get('session-asset-view').hidden, true)
      assert.deepEqual(f.sideEffects, { writes: 0, exports: 0 })
    })

  test(`${host}: cancelled in-flight read ignores its late response and may refresh again`, async () => {
    const f = fixture(host, { gate: true })
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    await f.click('session-assets-clear')
    await f.release()
    assert.equal(f.blobs.length, 0)
    assert.equal(f.urls.size, 0)
    assert.equal(f.requests.filter((request) => request.path.endsWith('/assets/read')).length, 1)
    await f.click('session-assets-refresh')
    assert.equal(f.elements.get('session-assets-list').children.length, 1)
  })

  test(`${host}: re-pair never accepts a late response from the closed session`, async () => {
    const f = fixture(host, { gate: true })
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    await f.click('close')
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    assert.equal(f.elements.get('session-asset-view').hidden, false)
    const preview = f.elements.get('session-asset-image').src
    await f.release()
    assert.equal(f.elements.get('session-asset-image').src, preview)
    assert.equal(f.elements.get('session-asset-view').hidden, false)
    assert.equal(f.urls.size, 1)
  })

  test(`${host}: native load is required before showing success and a cancelled late decode cannot resurrect it`, async () => {
    const f = fixture(host, { autoDecode: false })
    await f.pair()
    f.elements.get('consent').checked = true
    await f.click('session-assets-refresh')
    await f.select()
    assert.equal(f.elements.get('session-asset-view').hidden, true)
    assert.doesNotMatch(
      f.elements.get('session-assets-status').textContent,
      /Exact desktop image decoded/
    )
    assert.equal(f.elements.get('consent').checked, true)
    const lateLoad = f.elements.get('session-asset-image').listener('load')
    assert.equal(typeof lateLoad, 'function')
    await f.click('session-assets-clear')
    lateLoad()
    await f.flush()
    assert.equal(f.elements.get('session-asset-view').hidden, true)
    assert.equal(f.urls.size, 0)
    await f.click('session-assets-refresh')
    await f.select()
    await f.decode()
    assert.equal(f.elements.get('session-asset-view').hidden, false)
    assert.equal(f.elements.get('consent').checked, true)
  })

  test(`${host}: late old-image load/error cannot authorize or clear a new same-dimension asset`, async () => {
    const f = fixture(host, { autoDecode: false })
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    const oldImage = f.elements.get('session-asset-image')
    const oldLoad = oldImage.listener('load')
    const oldError = oldImage.listener('error')
    f.asset.assetId = '7'.repeat(32)
    await f.click('session-assets-refresh')
    await f.select()
    const newImage = f.elements.get('session-asset-image')
    assert.notEqual(newImage, oldImage)
    const source = newImage.src
    oldLoad()
    oldError()
    await f.flush()
    assert.equal(f.elements.get('session-asset-view').hidden, true)
    assert.equal(f.urls.size, 1)
    assert.equal(newImage.src, source)
    await f.decode()
    assert.equal(f.elements.get('session-asset-view').hidden, false)
    oldLoad()
    oldError()
    await f.flush()
    assert.equal(f.elements.get('session-asset-view').hidden, false)
    assert.equal(newImage.src, source)
    assert.equal(f.urls.size, 1)
  })

  test(`${host}: intrinsic dimensions must match and object URLs are revoked on decode failure`, async () => {
    const f = fixture(host, { dimensions: false })
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    assert.equal(f.elements.get('session-asset-view').hidden, true)
    assert.equal(f.urls.size, 0)
    assert.ok(f.revoked.length)
  })

  test(`${host}: unavailable exact decoder fails closed without conversion`, async () => {
    const f = fixture(host, { decoder: false })
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    assert.equal(f.elements.get('session-asset-view').hidden, true)
    assert.equal(f.blobs.length, 0)
    assert.deepEqual(f.sideEffects, { writes: 0, exports: 0 })
  })

  test(`${host}: expiry and shutdown clear displayed bytes, URLs and catalog`, async () => {
    for (const transition of ['expiry', 'shutdown', 'cancel', 'close']) {
      const f = fixture(host)
      await f.pair()
      await f.click('session-assets-refresh')
      await f.select()
      assert.equal(f.elements.get('session-asset-view').hidden, false)
      if (transition === 'expiry') await f.advance(120000)
      else if (transition === 'shutdown') await f.shutdown()
      else await f.click(transition)
      assert.equal(f.urls.size, 0)
      assert.equal(f.elements.get('session-asset-view').hidden, true)
      assert.equal(f.elements.get('session-assets-list').children.length, 0)
    }
  })
}

test('native SHA helper supports 8 MiB assets without widening the existing visual/journal hash limit', () => {
  const context = createContext({ Uint8Array, Uint32Array, DataView, ArrayBuffer })
  new Script(source('shared/visual-evidence.js')).runInContext(context)
  const helper = context.MagicPotVisualEvidenceV1
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(73)
  assert.equal(helper.sha256SessionAsset(bytes), createHash('sha256').update(bytes).digest('hex'))
  assert.throws(() => helper.sha256(bytes))
  assert.throws(() => helper.sha256SessionAsset(new Uint8Array(bytes.length + 1)))
})
