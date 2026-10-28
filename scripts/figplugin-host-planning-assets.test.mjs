import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { deflateSync } from 'node:zlib'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

const base = new URL('../packages/figplugin-hosts/', import.meta.url)
const source = (path) => readFileSync(new URL(path, base), 'utf8')
const bundle = await buildHostPlanPreview()
const copy = (value) => JSON.parse(JSON.stringify(value))
const drain = () => new Promise((resolve) => setImmediate(resolve))
const reference = ({ assetId, sha256 }) => ({ assetId, sha256 })

function syntheticPng() {
  const chunk = (type, data) => {
    const output = Buffer.alloc(data.length + 12)
    output.writeUInt32BE(data.length)
    output.write(type, 4)
    data.copy(output, 8)
    let crc = 0xffffffff
    for (const byte of output.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
    return output
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 11, 22, 33, 255, 44, 55, 66, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// These execute the production host scripts, shared validator and Figma UI in VMs.
// Native object shapes, image decode events and transport replies are fixtures, not host E2E.
function fixture(host, { catalogFault = null } = {}) {
  let now = 1800000000000
  let serial = 0
  let pairCount = 0
  let sessionId = null
  let releaseList = null
  let gateList = false
  let releaseImage = null
  let gateImage = false
  let outboundHook = null
  const elements = new Map()
  const timers = new Map()
  const nativeEvents = new Map()
  const pageEvents = new Map()
  const uiEvents = new Map()
  const notificationListeners = new Set()
  const urls = new Map()
  const decodes = []
  const requests = []
  const posts = []
  const uiSends = []
  const sideEffects = { writes: 0, imageReads: 0 }
  const png = syntheticPng()
  const pluginId = 'planning-assets.' + host
  const origin = 'http://127.0.0.1:34567'
  const assets = [2, 3].map((id) => ({
    version: 1,
    kind: 'session-image-asset',
    purpose: 'local-preview',
    sessionId: '1'.repeat(32),
    pluginId,
    projectId: 'project_a',
    host,
    assetId: String(id).repeat(32),
    mimeType: 'image/png',
    sha256: createHash('sha256').update(png).digest('hex'),
    sizeBytes: png.length,
    width: 2,
    height: 1,
    chunkSize: 24576,
    chunkCount: 1,
    createdAt: now,
    expiresAt: now + 60000
  }))
  const makeElement = (tagName = 'div') => {
    let text = ''
    let src = ''
    const listeners = new Map()
    return {
      tagName: tagName.toUpperCase(),
      id: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      children: [],
      parentNode: null,
      style: {},
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
        throw new Error('Unsafe rendering')
      },
      get src() {
        return src
      },
      set src(value) {
        src = value
        if (value) decodes.push(this)
      },
      setAttribute(name, value) {
        this[name] = value
      },
      removeAttribute(name) {
        if (name === 'src') src = ''
        else delete this[name]
      },
      addEventListener(name, listener) {
        listeners.set(name, listener)
      },
      removeEventListener(name, listener) {
        if (listeners.get(name) === listener) listeners.delete(name)
      },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        if (child.id) elements.set(child.id, child)
        return child
      },
      replaceChild(next, previous) {
        const index = this.children.indexOf(previous)
        assert.ok(index >= 0)
        this.children[index] = next
        next.parentNode = this
        previous.parentNode = null
        if (next.id) elements.set(next.id, next)
      },
      fire(name) {
        listeners.get(name)?.({ target: this })
        this['on' + name]?.()
      }
    }
  }
  const html = source(host === 'figma' ? 'figma/bridge/ui.html' : 'photoshop-uxp/bridge/index.html')
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = makeElement(match[1])
    element.id = match[2]
    element.hidden = match[0].includes(' hidden')
    elements.set(element.id, element)
  }
  elements.get('context-image-view').appendChild(elements.get('context-image'))
  elements.get('session-asset-view').appendChild(elements.get('session-asset-image'))
  const dom = {
    readyState: 'complete',
    getElementById(id) {
      assert.ok(elements.has(id), id)
      return elements.get(id)
    },
    createElement: makeElement,
    addEventListener() {
      assert.fail('Fixture starts with a complete DOM')
    }
  }
  class MemoryBlob {
    constructor(parts, options) {
      this.type = options.type
      this.bytes = Buffer.concat(parts.map((part) => Buffer.from(part)))
    }
  }
  class MemoryImageBlob extends MemoryBlob {
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
      urls.delete(url)
    }
  }
  class Clock extends Date {
    static now() {
      return now
    }
  }
  const common = {
    Date: Clock,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout(callback, delay) {
      const id = ++serial
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    }
  }
  const crypto = {
    getRandomValues(data) {
      data.fill(++serial % 255)
      return data
    },
    subtle: webcrypto.subtle
  }
  const mutate = () => {
    sideEffects.writes++
    throw new Error('No document mutations')
  }
  const root = { id: '0:0', type: 'DOCUMENT' }
  const page = {
    id: '0:1',
    type: 'PAGE',
    parent: root,
    selection: [],
    on(name, callback) {
      pageEvents.set(name, callback)
    },
    off(name, callback) {
      if (pageEvents.get(name) === callback) pageEvents.delete(name)
    }
  }
  const nativeDocument = {
    id: 5,
    activeLayers: [],
    layers: [],
    width: 100,
    height: 100,
    resolution: 72,
    pixelAspectRatio: 1,
    activeHistoryState: { id: 7 }
  }
  const node =
    host === 'figma'
      ? {
          id: '1:2',
          type: 'RECTANGLE',
          name: 'Owned rectangle',
          parent: page,
          locked: false,
          visible: true,
          opacity: 1,
          width: 2,
          height: 1,
          absoluteBoundingBox: { x: 0, y: 0, width: 2, height: 1 },
          fills: [],
          strokes: [],
          async exportAsync() {
            sideEffects.imageReads++
            return new Uint8Array(png)
          }
        }
      : {
          id: 7,
          kind: 'pixel',
          name: 'Owned layer',
          parent: null,
          document: nativeDocument,
          visible: true,
          allLocked: false,
          opacity: 100,
          boundsNoEffects: { left: 0, top: 0, right: 2, bottom: 1 }
        }
  page.selection.push(node)
  nativeDocument.activeLayers.push(node)
  nativeDocument.layers.push(node)
  const photoshop = {
    app: { activeDocument: nativeDocument },
    core: {
      executeAsModal: mutate,
      async addNotificationListener(_group, _events, callback) {
        notificationListeners.add(callback)
      },
      async removeNotificationListener(_group, _events, callback) {
        notificationListeners.delete(callback)
      }
    },
    action: {
      batchPlay: mutate,
      async addNotificationListener(_events, callback) {
        notificationListeners.add(callback)
      },
      async removeNotificationListener(_events, callback) {
        notificationListeners.delete(callback)
      }
    },
    imaging: {
      async getPixels(request) {
        sideEffects.imageReads++
        if (gateImage) {
          gateImage = false
          await new Promise((resolve) => {
            releaseImage = resolve
          })
        }
        const width = request.targetSize?.width === 1 ? 1 : 2
        let disposed = false
        return {
          sourceBounds: { left: 0, top: 0, right: 2, bottom: 1 },
          level: 0,
          imageData: {
            width,
            height: 1,
            components: 4,
            componentSize: 8,
            pixelFormat: 'RGBA',
            colorSpace: 'RGB',
            colorProfile: 'sRGB IEC61966-2.1',
            async getData() {
              assert.equal(disposed, false)
              return new Uint8Array([11, 22, 33, 255, 44, 55, 66, 255]).subarray(0, width * 4)
            },
            dispose() {
              assert.equal(disposed, false)
              disposed = true
            }
          }
        }
      }
    }
  }
  const fetch = async (url, options) => {
    const path = url.slice(origin.length)
    const body = JSON.parse(options.body)
    assert.ok(Buffer.byteLength(options.body) <= 64 * 1024)
    requests.push({ path, body, options })
    let value
    let status = 200
    if (path === '/figplugin/v1/pair') {
      sessionId = String(++pairCount).repeat(32)
      value = {
        protocol: 1,
        sessionId,
        sessionToken: 'a'.repeat(64),
        expiresAt: now + 600000,
        idleTimeoutMs: 120000
      }
    } else {
      assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64))
      assert.equal(options.headers['X-Figplugin-Session'], sessionId)
      if (path === '/figplugin/v1/assets/list') {
        assert.deepEqual(body, { protocol: 1, purpose: 'local-preview' })
        value = { protocol: 1, purpose: 'local-preview', sessionId, assets: copy(assets) }
        if (catalogFault) catalogFault(value)
        if (gateList) {
          gateList = false
          await new Promise((resolve) => {
            releaseList = resolve
          })
        }
      } else if (path === '/figplugin/v1/assets/read') {
        const asset = assets.find((asset) => asset.assetId === body.assetId)
        assert.ok(asset)
        value = {
          protocol: 1,
          purpose: 'local-preview',
          sessionId,
          assetId: asset.assetId,
          chunk: {
            version: 1,
            kind: 'content-addressed-binary-chunk',
            sha256: asset.sha256,
            index: 0,
            chunkCount: 1,
            bytesBase64: png.toString('base64')
          }
        }
      } else if (path === '/figplugin/v1/prepare') {
        value = {
          protocol: 1,
          callId: 'b'.repeat(32),
          status: 'awaiting-approval',
          expiresAt: now + 60000
        }
      } else if (path === '/figplugin/v1/status') {
        value = { protocol: 1, callId: 'b'.repeat(32), status: 'awaiting-approval' }
      } else if (['/figplugin/v1/close', '/figplugin/v1/cancel'].includes(path)) {
        status = 204
        value = null
      } else assert.fail('No provider, upload or write endpoint allowed: ' + path)
    }
    return {
      ok: true,
      status,
      url,
      redirected: false,
      headers: { get: () => null },
      text: async () => JSON.stringify(value)
    }
  }
  let parent = null
  const figma = {
    root,
    currentPage: page,
    showUI() {
      // The production UI executes in its own VM instead of opening Figma.
    },
    closePlugin() {
      // The fixture observes shutdown without closing a native host process.
    },
    on(name, callback) {
      nativeEvents.set(name, callback)
    },
    off(name, callback) {
      if (nativeEvents.get(name) === callback) nativeEvents.delete(name)
    },
    createImage: mutate,
    createRectangle: mutate,
    ui: {
      postMessage(value) {
        posts.push(copy(value))
        if (parent)
          queueMicrotask(() =>
            uiEvents.get('message')?.({ source: parent, data: { pluginMessage: copy(value) } })
          )
      }
    }
  }
  const native = createContext({
    ...common,
    crypto,
    fetch,
    MAGICPOT_BRIDGE_CONFIG: Object.freeze({ protocol: 1, origin, pluginId, host }),
    ...(host === 'figma'
      ? { figma, __html__: '' }
      : {
          document: dom,
          URL: urlApi,
          ImageBlob: MemoryImageBlob,
          window: { addEventListener: (name, callback) => nativeEvents.set(name, callback) },
          require(name) {
            assert.equal(name, 'photoshop')
            return photoshop
          }
        })
  })
  new Script(bundle.text).runInContext(native)
  new Script(source('shared/pixel-audit.js')).runInContext(native)
  new Script(source('shared/visual-evidence.js')).runInContext(native)
  new Script(
    source(host === 'figma' ? 'figma/bridge/code.js' : 'photoshop-uxp/bridge/main.js')
  ).runInContext(native)
  if (host === 'figma') {
    parent = {
      postMessage(value) {
        const message = copy(value.pluginMessage)
        uiSends.push(copy(message))
        outboundHook?.(message)
        queueMicrotask(() => figma.ui.onmessage(message))
      }
    }
    const ui = createContext({
      ...common,
      crypto,
      document: dom,
      parent,
      Blob: MemoryBlob,
      URL: urlApi,
      window: { addEventListener: (name, callback) => uiEvents.set(name, callback) }
    })
    new Script(
      [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
    ).runInContext(ui)
  }
  const flush = async () => {
    for (let index = 0; index < 4; index++) await drain()
    while (decodes.length) {
      const image = decodes.shift()
      if (!image.src) continue
      const bytes = image.src.startsWith('data:')
        ? Buffer.from(image.src.split(',')[1], 'base64')
        : urls.get(image.src)?.bytes
      if (!bytes) continue
      image.naturalWidth = bytes.readUInt32BE(16)
      image.naturalHeight = bytes.readUInt32BE(20)
      image.fire('load')
    }
    for (let index = 0; index < 2; index++) await drain()
  }
  const controls = () =>
    elements.get('planning-assets-list').children.map((label) => label.children[0])
  const result = {
    assets,
    requests,
    posts,
    uiSends,
    elements,
    node,
    sideEffects,
    controls,
    flush,
    expandSelection(count, name) {
      const selection = host === 'figma' ? page.selection : nativeDocument.activeLayers
      selection.length = 0
      for (let index = 0; index < count; index++)
        selection.push({ ...node, id: host === 'figma' ? '2:' + index : index + 10, name })
    },
    prepared: () => requests.filter((request) => request.path === '/figplugin/v1/prepare'),
    async click(id) {
      elements.get(id).fire('click')
      await flush()
    },
    async pair() {
      await flush()
      elements.get('ticket').value = JSON.stringify({
        ticketId: 'c'.repeat(32),
        pairingSecret: 'd'.repeat(64),
        expiresAt: now + 60000,
        bridgeOrigin: origin,
        pluginId,
        host,
        artifactSha256: 'e'.repeat(64)
      })
      await this.click('pair')
      assert.equal(elements.get('pair').disabled, true)
    },
    async select(index = 0, checked = true) {
      const control = controls()[index]
      assert.ok(control, 'Explicit catalog checkbox exists')
      control.checked = checked
      control.fire('change')
      await flush()
    },
    async capture(image = false) {
      await this.click(
        image ? (host === 'figma' ? 'plan-image-capture' : 'image-capture') : 'plan-capture'
      )
      assert.ok(elements.get('selection').textContent, elements.get('status').textContent)
    },
    async consent(prompt = 'Inspect selected resource metadata; do not write images.') {
      elements.get('prompt').value = prompt
      elements.get('prompt').fire('input')
      elements.get('consent').checked = true
      elements.get('consent').fire('change')
      await flush()
    },
    async sendNative(message) {
      assert.equal(host, 'figma')
      figma.ui.onmessage(copy(message))
      await flush()
    },
    nativeShare(assetReferences) {
      return {
        protocol: 1,
        type: 'share',
        nonce: 'f'.repeat(32),
        revision: posts.filter((message) => message.type === 'preview' && message.revision).at(-1)
          .revision,
        prompt: 'Only this metadata.',
        consent: true,
        ...(assetReferences === undefined ? {} : { assetReferences })
      }
    },
    hookOutbound(hook) {
      outboundHook = hook
    },
    async advance(ms, runTimers = true) {
      now += ms
      if (runTimers)
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) {
            timers.delete(id)
            timer.callback()
          }
        }
      await flush()
    },
    gateList() {
      gateList = true
    },
    async releaseList() {
      releaseList?.()
      await flush()
    },
    gateImage() {
      gateImage = true
    },
    async releaseImage() {
      releaseImage?.()
      await flush()
    },
    async shutdown() {
      if (host === 'figma') uiEvents.get('pagehide')?.()
      else nativeEvents.get('pagehide')?.()
      await flush()
    }
  }
  return result
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: catalog and exact local preview never auto-select model metadata or consent`, async () => {
    const f = fixture(host)
    await f.pair()
    assert.equal(f.requests.length, 1)
    await f.click('session-assets-refresh')
    assert.equal(f.controls().length, 2)
    assert.ok(f.controls().every((control) => control.checked === false))
    assert.equal(f.elements.get('consent').checked, false)
    f.elements.get('session-assets-list').children[0].fire('click')
    await f.flush()
    assert.ok(f.controls().every((control) => !control.checked))
    assert.equal(f.elements.get('consent').checked, false)
    await f.capture()
    await f.consent()
    await f.click('share')
    assert.equal(f.prepared().length, 1)
    assert.equal(f.prepared()[0].body.featureId, 'plan-preview')
    assert.equal('assetReferences' in f.prepared()[0].body, false)
    assert.equal('contextImage' in f.prepared()[0].body, false)
    assert.deepEqual(f.sideEffects, { writes: 0, imageReads: 0 })
  })

  test(`${host}: exact default-off references survive capture, reset consent and share only IDs/hashes once`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.consent()
    await f.select(1)
    assert.equal(f.elements.get('consent').checked, false)
    await f.capture()
    assert.equal(f.controls()[1].checked, true)
    assert.match(f.elements.get('consent-description').textContent, /metadata \(not its pixels\)/)
    await f.consent()
    await f.select(0)
    assert.equal(f.elements.get('consent').checked, false)
    await f.click('share')
    assert.equal(f.prepared().length, 0)
    await f.consent()
    await f.click('share')
    assert.deepEqual(f.prepared()[0].body.assetReferences, [
      reference(f.assets[1]),
      reference(f.assets[0])
    ])
    assert.equal('contextImage' in f.prepared()[0].body, false)
    assert.equal(
      f.requests.some((request) => request.path.endsWith('/assets/read')),
      false
    )
    assert.equal(
      f.controls().some((control) => control.checked),
      false
    )
    assert.equal(f.elements.get('consent').checked, false)
    assert.equal(f.sideEffects.writes, 0)
    await f.click('cancel')
    await f.capture()
    await f.consent()
    await f.click('share')
    assert.equal(f.prepared().length, 2)
    assert.equal('assetReferences' in f.prepared()[1].body, false)
  })

  test(`${host}: intended references with ordinary analysis fail explicitly without silently dropping selection`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    await f.click('capture')
    await f.consent()
    await f.click('share')
    assert.equal(f.prepared().length, 0)
    assert.match(f.elements.get('status').textContent, /requires a native plan context/)
    assert.equal(f.controls()[0].checked, true)
    assert.equal(f.elements.get('consent').checked, false)
    await f.capture()
    await f.consent()
    await f.click('share')
    assert.deepEqual(f.prepared()[0].body.assetReferences, [reference(f.assets[0])])
  })

  for (const transition of ['refresh', 'clear', 'cancel', 'close', 'expiry', 'shutdown'])
    test(`${host}: ${transition} clears selection and its old model-send consent`, async () => {
      const f = fixture(host)
      await f.pair()
      await f.click('session-assets-refresh')
      const oldControl = f.controls()[0]
      await f.select()
      await f.capture()
      await f.consent()
      if (transition === 'refresh') await f.click('session-assets-refresh')
      else if (transition === 'clear') await f.click('session-assets-clear')
      else if (transition === 'expiry') await f.advance(60000)
      else if (transition === 'shutdown') await f.shutdown()
      else await f.click(transition)
      assert.equal(f.elements.get('consent').checked, false)
      assert.equal(
        f.controls().some((control) => control.checked),
        false
      )
      oldControl.checked = true
      oldControl.fire('change')
      await f.flush()
      assert.equal(
        f.controls().some((control) => control.checked),
        false
      )
      assert.equal(f.prepared().length, 0)
    })

  test(`${host}: stale pending refresh and re-pair cannot restore an old session catalog or selection`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    f.gateList()
    await f.click('session-assets-refresh')
    assert.equal(f.controls().length, 0)
    await f.click('close')
    await f.pair()
    await f.releaseList()
    assert.equal(f.controls().length, 0)
    await f.click('session-assets-refresh')
    assert.equal(
      f.controls().length,
      0,
      'Server response containing old-session assets fails closed'
    )
    for (const asset of f.assets) asset.sessionId = '2'.repeat(32)
    await f.click('session-assets-refresh')
    assert.equal(f.controls().length, 2)
    assert.ok(f.controls().every((control) => !control.checked))
  })

  for (const [fault, change] of [
    [
      'session',
      (catalog) => {
        catalog.sessionId = 'f'.repeat(32)
      }
    ],
    [
      'host',
      (catalog) => {
        catalog.assets[0].host = host === 'figma' ? 'photoshop' : 'figma'
      }
    ],
    [
      'plugin',
      (catalog) => {
        catalog.assets[0].pluginId = 'other-plugin'
      }
    ],
    [
      'mixed project',
      (catalog) => {
        catalog.assets[1].projectId = 'other-project'
      }
    ],
    [
      'expired',
      (catalog) => {
        catalog.assets[0].expiresAt = catalog.assets[0].createdAt
      }
    ],
    [
      'extra metadata',
      (catalog) => {
        catalog.assets[0].filename = 'not-authorized.png'
      }
    ]
  ])
    test(`${host}: ${fault} catalog never offers planning references`, async () => {
      const f = fixture(host, { catalogFault: change })
      await f.pair()
      await f.click('session-assets-refresh')
      assert.equal(f.controls().length, 0)
      assert.equal(f.prepared().length, 0)
    })

  test(`${host}: an expired selection fails at Share even if its expiry callback has not run`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    await f.capture()
    await f.consent()
    await f.advance(60000, false)
    await f.click('share')
    assert.equal(f.prepared().length, 0)
    assert.equal(f.elements.get('consent').checked, false)
    assert.equal(f.controls().length, 0)
  })

  test(`${host}: a session cannot silently change projects on a later authenticated catalog refresh`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    for (const asset of f.assets) asset.projectId = 'different-project'
    await f.click('session-assets-refresh')
    assert.equal(f.controls().length, 0)
    assert.equal(f.elements.get('consent').checked, false)
    assert.equal(f.prepared().length, 0)
  })

  test(`${host}: previewing a later-expiring image cannot extend another selected catalog entry`, async () => {
    const f = fixture(host)
    f.assets[0].expiresAt -= 30000
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    await f.capture()
    f.elements.get('session-assets-list').children[1].fire('click')
    await f.flush()
    assert.equal(f.controls()[0].checked, true)
    await f.consent()
    await f.advance(30000)
    assert.equal(f.controls().length, 0)
    assert.equal(f.elements.get('consent').checked, false)
    assert.equal(f.elements.get('session-asset-view').hidden, true)
  })

  test(`${host}: selected resource metadata never bypasses the complete 64 KiB request bound`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    f.expandSelection(4, 'x'.repeat(4096))
    await f.capture()
    await f.consent('\u4e2d'.repeat(16384))
    await f.click('share')
    assert.equal(f.prepared().length, 0)
    assert.match(f.elements.get('status').textContent, /too large/)
    assert.equal(
      f.requests.some((request) => request.path.endsWith('/assets/read')),
      false
    )
  })

  test(`${host}: context-image consent remains separate from catalog metadata and no write capability is added`, async () => {
    const f = fixture(host)
    await f.pair()
    await f.click('session-assets-refresh')
    await f.select()
    await f.capture(true)
    assert.equal(f.elements.get('context-image-view').hidden, false)
    assert.equal(f.elements.get('consent').checked, false)
    await f.consent()
    await f.select(0, false)
    assert.equal(f.elements.get('consent').checked, false)
    assert.equal(f.elements.get('context-image-view').hidden, false)
    await f.select()
    await f.click('share')
    assert.equal(f.prepared().length, 0)
    await f.consent()
    await f.click('share')
    const body = f.prepared()[0].body
    assert.deepEqual(body.assetReferences, [reference(f.assets[0])])
    assert.equal(body.contextImage.kind, 'host-context-image')
    assert.ok(body.contextImage.bytesBase64)
    assert.equal(
      body.hostContext.execution.supports.some((command) => /image|asset/.test(command)),
      false
    )
    assert.equal(
      f.requests.some((request) => request.path.endsWith('/assets/read')),
      false
    )
    assert.equal(f.sideEffects.writes, 0)
  })
}

for (const [fault, references] of [
  ['empty', () => []],
  ['unknown ID', (asset) => [{ ...reference(asset), assetId: 'f'.repeat(32) }]],
  ['wrong hash', (asset) => [{ ...reference(asset), sha256: 'f'.repeat(64) }]],
  ['duplicate', (asset) => [reference(asset), reference(asset)]],
  ['metadata injection', (asset) => [{ ...reference(asset), mimeType: 'image/png' }]],
  ['session injection', (asset) => [{ ...reference(asset), sessionId: asset.sessionId }]],
  ['filename injection', (asset) => [{ ...reference(asset), filename: 'private.png' }]],
  ['pixel injection', (asset) => [{ ...reference(asset), bytesBase64: 'AAAA' }]]
])
  test(`figma: native boundary rejects ${fault} in untrusted UI references`, async () => {
    const f = fixture('figma')
    await f.pair()
    await f.click('session-assets-refresh')
    await f.capture()
    await f.sendNative(f.nativeShare(references(f.assets[0])))
    assert.equal(f.prepared().length, 0)
  })

test('figma: native boundary independently rejects analysis references, extra keys, stale catalogs and expired references', async () => {
  for (const transition of ['analysis', 'extra-key', 'clear', 'refresh', 'expiry']) {
    const f = fixture('figma')
    await f.pair()
    await f.click('session-assets-refresh')
    if (transition === 'analysis') await f.click('capture')
    else await f.capture()
    const message = f.nativeShare([reference(f.assets[0])])
    if (transition === 'extra-key') message.assetCatalog = { assets: [f.assets[0]] }
    if (transition === 'clear') await f.click('session-assets-clear')
    if (transition === 'refresh') {
      f.gateList()
      await f.click('session-assets-refresh')
    }
    if (transition === 'expiry') await f.advance(60000, false)
    await f.sendNative(message)
    assert.equal(f.prepared().length, 0, transition)
  }
})

test('photoshop: selected catalog metadata cannot change silently during asynchronous context-image recheck', async () => {
  const f = fixture('photoshop')
  await f.pair()
  await f.click('session-assets-refresh')
  await f.select()
  await f.capture(true)
  await f.consent()
  f.gateImage()
  await f.click('share')
  await f.click('session-assets-clear')
  // Even a forged DOM recheck cannot revive the old selection-bound share operation.
  f.elements.get('consent').checked = true
  await f.releaseImage()
  assert.equal(f.prepared().length, 0)
  assert.equal(f.elements.get('consent').checked, false)
})

test('photoshop: DOM metadata tampering cannot substitute host-owned catalog references', async () => {
  const f = fixture('photoshop')
  await f.pair()
  await f.click('session-assets-refresh')
  const control = f.controls()[0]
  control.value = JSON.stringify({ ...f.assets[1], filename: 'fake.png' })
  control.assetId = f.assets[1].assetId
  control.sha256 = 'f'.repeat(64)
  await f.select()
  await f.capture()
  await f.consent()
  await f.click('share')
  assert.deepEqual(f.prepared()[0].body.assetReferences, [reference(f.assets[0])])
})
