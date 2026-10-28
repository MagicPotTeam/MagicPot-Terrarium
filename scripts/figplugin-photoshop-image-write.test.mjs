import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { deflateSync, inflateSync } from 'node:zlib'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const source = (path) => readFileSync(new URL(path, root), 'utf8')
const bundle = await buildHostPlanPreview()
const copy = (value) => JSON.parse(JSON.stringify(value))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const initial = Uint8Array.from([
  10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255
])
const replacement = Uint8Array.from([1, 3, 5, 255, 7, 9, 11, 255, 13, 15, 17, 255, 19, 21, 23, 255])

function png(rgba = replacement, width = 2, height = 2) {
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
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(
      rows,
      y * (width * 4 + 1) + 1
    )
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function decodeOwnedPng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert.equal(bytes[24], 8)
  assert.equal(bytes[25], 6)
  const length = bytes.readUInt32BE(33)
  const rows = inflateSync(bytes.subarray(41, 41 + length))
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y * (width * 4 + 1)], 0)
    rgba.set(rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4)
  }
  return { width, height, rgba }
}

// Runs the production script, lifecycle, journal, validators and execution asset client.
// Photoshop and UXP are explicit native-shape fixtures, not a native decoder certification.
function fixture(options = {}) {
  let now = 1800000000000
  let serial = 10
  let modal = false
  let putCount = 0
  const hooks = {}
  const requests = []
  const pixelRequests = []
  const events = []
  const lifecycleErrors = []
  const nativeImages = new Set()
  const ownedFiles = new Set()
  const documents = []
  const autoClose = new Set()
  const histories = new Map()
  const persisted = new Map()
  const elements = new Map()
  const timers = new Map()
  const rgba = options.rgba || replacement
  const bytes = png(rgba)
  const constants = {
    DocumentMode: { RGB: 'native-RGB-mode' },
    BitsPerChannelType: { EIGHT: 'native-eight-bit' },
    ChannelType: { COMPONENT: 'native-component' },
    LayerKind: { NORMAL: 'pixel' }
  }
  const channels = ['native-r', 'native-g', 'native-b'].map((name) => ({
    name,
    kind: constants.ChannelType.COMPONENT
  }))
  const doc = {
    id: 5,
    width: 300,
    height: 200,
    resolution: 72,
    pixelAspectRatio: 1,
    mode: constants.DocumentMode.RGB,
    bitsPerChannel: constants.BitsPerChannelType.EIGHT,
    colorProfileName: 'sRGB IEC61966-2.1',
    quickMaskMode: false,
    selection: { bounds: null },
    componentChannels: channels,
    activeChannels: channels,
    activeHistoryState: { id: 17 },
    activeLayers: [],
    layers: []
  }
  const layer = {
    id: 7,
    kind: 'pixel',
    name: 'Original name',
    opacity: 100,
    visible: true,
    document: doc,
    parent: null,
    allLocked: false,
    pixelsLocked: false,
    positionLocked: false,
    transparentPixelsLocked: false,
    isBackgroundLayer: false,
    isClippingMask: false,
    boundsNoEffects: { left: 10, top: 20, right: 12, bottom: 22 },
    rgba: new Uint8Array(initial)
  }
  doc.layers = doc.activeLayers = [layer]
  documents.push(doc)
  let activeDocument = doc
  const auth = {
    sessionId: '1'.repeat(32),
    sessionToken: 'owned-session-token',
    projectId: 'owned_project',
    expiresAt: now + 60000,
    idleAt: now + 60000
  }
  const asset = {
    version: 1,
    kind: 'execution-image-asset',
    purpose: 'host-plan-execution',
    sessionId: auth.sessionId,
    pluginId: 'photoshop.pixel-test',
    projectId: auth.projectId,
    host: 'photoshop',
    assetId: '2'.repeat(32),
    mimeType: 'image/png',
    sha256: hash(bytes),
    sizeBytes: bytes.length,
    width: 2,
    height: 2,
    chunkSize: 24576,
    chunkCount: 1,
    createdAt: now,
    expiresAt: now + 60000
  }
  const close = (document) => {
    assert.notEqual(document, doc, 'never close the user document')
    events.push('close-import')
    const index = documents.indexOf(document)
    if (index >= 0) documents.splice(index, 1)
    if (activeDocument === document) activeDocument = doc
  }
  const restore = (snapshot) => {
    layer.rgba = new Uint8Array(snapshot.rgba)
    layer.boundsNoEffects = copy(snapshot.bounds)
    layer.name = snapshot.name
    doc.activeHistoryState = { id: snapshot.history }
  }
  const modalContext = {
    isCancelled: false,
    hostControl: {
      suspendHistory({ documentID }) {
        assert.equal(modal, true)
        assert.equal(documentID, doc.id)
        const id = ++serial
        histories.set(id, {
          rgba: new Uint8Array(layer.rgba),
          bounds: copy(layer.boundsNoEffects),
          name: layer.name,
          history: doc.activeHistoryState.id
        })
        events.push('suspend')
        return id
      },
      async resumeHistory(id, commit) {
        await hooks.resume?.(commit)
        if (modalContext.isCancelled) throw new Error('CANCELLED')
        assert.ok(histories.has(id))
        events.push(commit ? 'commit' : 'rollback')
        if (!commit) restore(histories.get(id))
        else doc.activeHistoryState.id++
        histories.delete(id)
      },
      registerAutoCloseDocument(id) {
        autoClose.add(id)
      },
      unregisterAutoCloseDocument(id) {
        autoClose.delete(id)
      }
    }
  }
  const photoshop = {
    constants,
    app: {
      get activeDocument() {
        return activeDocument
      },
      get documents() {
        return documents
      },
      async open(file) {
        assert.equal(modal, true)
        assert.ok(ownedFiles.has(file))
        assert.deepEqual(file.bytes, bytes)
        events.push('open-import')
        const decoded = decodeOwnedPng(file.bytes)
        const imported = {
          id: ++serial,
          ...decoded,
          activeHistoryState: { id: 1 },
          closeWithoutSaving() {
            if (modalContext.isCancelled) throw new Error('CANCELLED')
            close(imported)
          }
        }
        documents.push(imported)
        activeDocument = imported
        await hooks.open?.(imported)
        return options.returnUserDocument ? doc : imported
      }
    },
    core: {
      async executeAsModal(callback) {
        modal = true
        try {
          return await callback(modalContext)
        } catch (error) {
          for (const snapshot of histories.values()) restore(snapshot)
          if (histories.size) events.push('auto-rollback')
          histories.clear()
          throw error
        } finally {
          for (const imported of [...documents]) if (autoClose.has(imported.id)) close(imported)
          autoClose.clear()
          modal = false
        }
      }
    },
    imaging: {
      async getPixels(request) {
        pixelRequests.push(copy(request))
        events.push(request.targetSize ? 'thumbnail' : 'full-pixels')
        const owner = documents.find((document) => document.id === request.documentID)
        assert.ok(owner, 'explicit open document identity')
        const target = request.layerID === undefined ? owner : layer
        if (request.layerID !== undefined) assert.equal(request.layerID, layer.id)
        let bounds =
          target === layer
            ? copy(layer.boundsNoEffects)
            : { left: 0, top: 0, right: owner.width, bottom: owner.height }
        let data = new Uint8Array(target.rgba)
        let width = bounds.right - bounds.left
        let height = bounds.bottom - bounds.top
        if (options.trim && target !== layer) {
          bounds = { left: 1, top: 0, right: 2, bottom: 2 }
          width = 1
          data = Uint8Array.from([...data.subarray(4, 8), ...data.subarray(12, 16)])
        }
        const components = options.rgb ? 3 : 4
        if (components === 3)
          data = Uint8Array.from(Array.from(data).filter((_, index) => index % 4 !== 3))
        const image = {
          width,
          height,
          components,
          componentSize: 8,
          colorSpace: 'RGB',
          colorProfile: 'sRGB IEC61966-2.1',
          pixelFormat: components === 4 ? 'RGBA' : 'RGB',
          hasAlpha: components === 4,
          type: 'image/uncompressed',
          bytes: data,
          async getData(args) {
            assert.deepEqual(copy(args), { chunky: true })
            await hooks.data?.({ request, target, image })
            return data
          },
          dispose() {
            assert.ok(nativeImages.delete(image), 'dispose native data exactly once')
            events.push('dispose-pixels')
          }
        }
        nativeImages.add(image)
        if (options.badNative && target !== layer) image.componentSize = 16
        await hooks.pixels?.({ request, target, image })
        return {
          imageData: image,
          sourceBounds: bounds,
          level: options.cachedLevel && !request.targetSize ? 1 : 0
        }
      },
      async putPixels(request) {
        assert.equal(modal, true)
        assert.equal(histories.size, 1)
        assert.equal(request.documentID, doc.id)
        assert.equal(request.layerID, layer.id)
        assert.equal(request.replace, true)
        assert.ok(nativeImages.has(request.imageData))
        events.push('put-pixels')
        putCount++
        const { imageData, targetBounds } = request
        const data = imageData.bytes
        layer.rgba =
          imageData.components === 4
            ? new Uint8Array(data)
            : Uint8Array.from(
                Array.from({ length: imageData.width * imageData.height }, (_, index) => [
                  ...data.subarray(index * 3, index * 3 + 3),
                  255
                ]).flat()
              )
        layer.boundsNoEffects = {
          left: targetBounds.left,
          top: targetBounds.top,
          right: targetBounds.left + imageData.width,
          bottom: targetBounds.top + imageData.height
        }
        doc.activeHistoryState.id++
        await hooks.put?.(request)
      }
    }
  }
  const storage = {
    formats: { binary: Symbol('native-binary') },
    localFileSystem: {
      async getTemporaryFolder() {
        return {
          async createFile(name, config) {
            assert.match(name, /^magicpot-[a-f0-9]{32}\.png$/)
            assert.deepEqual(copy(config), { overwrite: false })
            const file = {
              async write(buffer, options) {
                assert.equal(options.format, storage.formats.binary)
                assert.equal(Object.prototype.toString.call(buffer), '[object ArrayBuffer]')
                file.bytes = Buffer.from(buffer)
                events.push('write-owned-file')
                await hooks.file?.(file)
              },
              async delete() {
                ownedFiles.delete(file)
                events.push('delete-owned-file')
                return 0
              }
            }
            ownedFiles.add(file)
            return file
          }
        }
      }
    }
  }
  let intent
  let item
  const context = createContext({
    console,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    AbortController,
    Date: class extends Date {
      static now() {
        return now
      }
    },
    crypto: {
      getRandomValues(data) {
        data.fill(++serial & 255)
        return data
      }
    },
    setTimeout(callback) {
      const id = ++serial
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    localStorage: {
      get length() {
        return persisted.size
      },
      key: (index) => [...persisted.keys()][index],
      getItem: (key) => persisted.get(key) ?? null,
      setItem: (key, value) => persisted.set(key, value),
      removeItem: (key) => persisted.delete(key)
    },
    document: {
      readyState: 'loading',
      getElementById(id) {
        if (!elements.has(id))
          elements.set(id, {
            textContent: '',
            checked: false,
            disabled: false,
            value: '',
            style: {}
          })
        return elements.get(id)
      }
    },
    require(name) {
      if (name === 'photoshop') return photoshop
      if (name === 'uxp') return { storage }
      throw new Error('Unknown native module')
    },
    MAGICPOT_BRIDGE_CONFIG: Object.freeze({
      protocol: 1,
      host: 'photoshop',
      pluginId: asset.pluginId,
      origin: 'http://127.0.0.1:34567'
    }),
    async fetch(url, options) {
      const body = JSON.parse(options.body)
      const route = new URL(url).pathname
      requests.push({ route, body })
      await hooks.fetch?.({ route, body })
      let output
      if (route.endsWith('/plan/assets/read')) {
        assert.equal(body.purpose, 'host-plan-execution')
        for (const key of ['callId', 'executionId', 'actionId', 'planSha256'])
          assert.equal(body[key], intent[key])
        output = {
          protocol: 1,
          purpose: 'host-plan-execution',
          callId: intent.callId,
          executionId: intent.executionId,
          actionId: intent.actionId,
          planSha256: intent.planSha256,
          sessionId: auth.sessionId,
          assetId: asset.assetId,
          chunk: {
            version: 1,
            kind: 'content-addressed-binary-chunk',
            sha256: asset.sha256,
            index: 0,
            chunkCount: 1,
            bytesBase64: bytes.toString('base64')
          }
        }
        if (options.corruptChunk) output.chunk.sha256 = '0'.repeat(64)
        await hooks.chunk?.(output)
      } else if (route.endsWith('/plan/status'))
        output = {
          protocol: 1,
          callId: intent.callId,
          executionId: intent.executionId,
          state: 'claimed'
        }
      else if (route.endsWith('/plan/progress')) output = { protocol: 1 }
      else if (route.endsWith('/plan/result')) output = { status: { state: body.status } }
      else throw new Error('Unexpected route ' + route)
      await hooks.response?.({ route, body, output })
      return {
        ok: true,
        status: 200,
        redirected: false,
        url,
        headers: {
          get() {
            return null
          }
        },
        text: async () => JSON.stringify(output)
      }
    },
    observe(api) {
      return {
        ...api,
        createHostAdapterLifecycle(options) {
          const wrapped = { ...options }
          for (const phase of ['prepareResources', 'execute', 'readback'])
            wrapped[phase] = async (args) => {
              events.push('lifecycle-' + phase)
              try {
                return await options[phase](args)
              } catch (error) {
                lifecycleErrors.push({ phase, error: String(error?.stack || error) })
                throw error
              }
            }
          return api.createHostAdapterLifecycle(wrapped)
        }
      }
    }
  })
  new Script(
    bundle.text.replace(
      'value:Object.freeze(MagicPotPlanPreviewBundle)',
      'value:Object.freeze(observe(MagicPotPlanPreviewBundle))'
    )
  ).runInContext(context)
  new Script(source('shared/visual-evidence.js')).runInContext(context)
  new Script(source('shared/execution-journal.js')).runInContext(context)
  const script = source('photoshop-uxp/bridge/main.js')
  const marker = "  if (document.readyState === 'loading')"
  assert.equal(script.split(marker).length, 2)
  new Script(
    script.slice(0, script.indexOf(marker)) +
      `
    globalThis.testApi = {
      capture(id) { const value = capturePhotoshopHostContext(id); planningNodes = value.nodes; return value.context },
      descriptor: readPixelDescriptor,
      async run(item, intent) { session = item.auth; activeExecution = item; item.executionEpoch = epoch; await executeClaimedPlan(item, intent) },
      invalidate() { epoch++ },
      readback: createPlanReadback
    };
  })();`
  ).runInContext(context)
  const api = context.testApi
  const captureId = '3'.repeat(32)
  options.beforeCapture?.({ layer, doc })
  const hostContext = api.capture(captureId)
  const plan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId,
    steps: [
      { command: 'image.pixels', targetId: '7', assetId: asset.assetId, sha256: asset.sha256 }
    ]
  }
  intent = {
    protocol: 1,
    purpose: 'execute-host-plan',
    host: 'photoshop',
    pluginId: asset.pluginId,
    executionId: '4'.repeat(32),
    callId: '5'.repeat(32),
    actionId: '6'.repeat(32),
    captureId,
    documentId: '5',
    scopeId: '5',
    adapterVersion: 'photoshop-uxp-native-1',
    planSha256: hash(Buffer.from(JSON.stringify(plan))),
    expiresAt: now + 60000,
    plan,
    executionAssets: [copy(asset)]
  }
  item = {
    auth,
    callId: intent.callId,
    executionId: intent.executionId,
    actionId: intent.actionId,
    hostContext,
    expiresAt: intent.expiresAt,
    lineage: {},
    planningResources: [copy(context.MagicPotPlanPreviewV1.executionAssetMetadata(asset))]
  }
  if (options.recovery) {
    const sourceAssetId = 'a'.repeat(32)
    const canonical = new Uint8Array(rgba)
    for (let index = 0; index < canonical.length; index += 4)
      if (canonical[index + 3] === 0) canonical.fill(0, index, index + 4)
    const source = copy(item.planningResources[0])
    delete source.expiresAt
    const manifest = {
      version: 1,
      sourcePlanSha256: 'b'.repeat(64),
      assets: [{ ...source, assetId: sourceAssetId }],
      targets: [
        {
          command: 'image.pixels',
          targetId: '7',
          assetId: sourceAssetId,
          sha256: asset.sha256,
          pixelEncoding: 'rgba8-srgb-zero-alpha-v1',
          acceptedEvidence: {
            kind: 'photoshop-pixels',
            sourceSha256: asset.sha256,
            pixelSha256: hash(canonical),
            width: 2,
            height: 2,
            bounds: options.acceptedBounds || { left: 40, top: 60, right: 42, bottom: 62 }
          }
        }
      ],
      manifestSha256: 'c'.repeat(64)
    }
    manifest.manifestSha256 = hash(
      context.MagicPotPlanPreviewV1.recoveryImagesManifestContent(manifest)
    )
    item.recovery = {
      baselineId: 'd'.repeat(32),
      sourceExecutionId: 'e'.repeat(32),
      requestId: captureId,
      round: 1,
      maxCorrectionRounds: 3,
      targetIds: ['7'],
      images: { manifest, assetBindings: [{ sourceAssetId, assetId: asset.assetId }] }
    }
    intent.recovery = copy(item.recovery)
    delete item.planningResources
    delete auth.projectId
  }
  return {
    api,
    context,
    hooks,
    doc,
    layer,
    asset,
    intent,
    item,
    events,
    requests,
    pixelRequests,
    lifecycleErrors,
    nativeImages,
    ownedFiles,
    documents,
    modalContext,
    histories,
    persisted,
    photoshop,
    get puts() {
      return putCount
    },
    advance(value) {
      now += value
    },
    async run() {
      await api.run(item, intent)
      await tick()
    },
    receipt() {
      return requests.findLast((request) => request.route.endsWith('/plan/result'))?.body
    },
    assertReleased() {
      assert.equal(nativeImages.size, 0)
      assert.equal(ownedFiles.size, 0)
      assert.deepEqual(documents, [doc])
      assert.equal(histories.size, 0)
    }
  }
}

test('image execution fetches claim-bound bytes, imports native data, replaces once and hashes true full readback', async () => {
  const f = fixture()
  await f.run()
  assert.equal(f.puts, 1, JSON.stringify(f.lifecycleErrors))
  assert.deepEqual(f.layer.rgba, replacement)
  const receipt = f.receipt()
  assert.equal(receipt.status, 'completed', JSON.stringify({ receipt, errors: f.lifecycleErrors }))
  assert.equal(receipt.effect, 'applied')
  assert.deepEqual(receipt.readback.steps[0].value, {
    assetId: f.asset.assetId,
    sha256: f.asset.sha256
  })
  assert.equal(receipt.readback.steps[0].imageEvidence.pixelSha256, hash(replacement))
  assert.deepEqual(receipt.readback.steps[0].imageEvidence.bounds, {
    left: 10,
    top: 20,
    right: 12,
    bottom: 22
  })
  assert.ok(f.events.indexOf('close-import') < f.events.indexOf('put-pixels'))
  assert.ok(f.events.indexOf('commit') > f.events.indexOf('lifecycle-readback'))
  assert.ok(f.requests.every((request) => !request.route.endsWith('/v1/assets/read')))
  assert.equal(f.persisted.size, 1)
  f.assertReleased()
})

test('RGB native images expand to canonical RGBA instead of guessing BGRA or premultiplication', async () => {
  const f = fixture({ rgb: true })
  await f.run()
  assert.equal(f.receipt().status, 'completed', JSON.stringify(f.lifecycleErrors))
  assert.equal(f.receipt().readback.steps[0].imageEvidence.pixelSha256, hash(replacement))
  f.assertReleased()
})

test('trimmed transparent margins preserve placement and canonical zero-alpha RGB comparison', async () => {
  const rgba = Uint8Array.from([111, 112, 113, 0, 7, 9, 11, 255, 121, 122, 123, 0, 19, 21, 23, 128])
  const f = fixture({ rgba, trim: true })
  await f.run()
  const expected = new Uint8Array(rgba)
  expected.fill(0, 0, 4)
  expected.fill(0, 8, 12)
  assert.equal(f.receipt().status, 'completed', JSON.stringify(f.lifecycleErrors))
  assert.equal(f.receipt().readback.steps[0].imageEvidence.pixelSha256, hash(expected))
  assert.deepEqual(f.layer.boundsNoEffects, { left: 11, top: 20, right: 12, bottom: 22 })
  f.assertReleased()
})

test('recovery in a fresh VM restores accepted full pixels and placement from a cropped current layer without a catalog', async () => {
  const f = fixture({
    recovery: true,
    beforeCapture({ layer }) {
      layer.boundsNoEffects = { left: 80, top: 90, right: 81, bottom: 91 }
      layer.rgba = Uint8Array.from([41, 42, 43, 255])
    }
  })
  await f.run()
  assert.equal(f.puts, 1, JSON.stringify(f.lifecycleErrors))
  assert.equal(f.receipt()?.status, 'completed', JSON.stringify(f.lifecycleErrors))
  assert.deepEqual(f.layer.rgba, replacement)
  const accepted = copy(f.item.recovery.images.manifest.targets[0].acceptedEvidence)
  assert.deepEqual(f.layer.boundsNoEffects, accepted.bounds)
  assert.deepEqual(f.receipt().readback.steps[0].imageEvidence, accepted)
  assert.notEqual(f.item.recovery.images.manifest.assets[0].assetId, f.asset.assetId)
  assert.equal(f.item.planningResources, undefined)
  assert.ok(f.requests.every((request) => !request.route.includes('/v1/assets/')))
  assert.ok(f.events.indexOf('close-import') < f.events.indexOf('put-pixels'))
  const fullReads = f.pixelRequests.filter(
    (request) => !request.targetSize && request.layerID === f.layer.id
  )
  assert.ok(
    fullReads.some(
      (request) => JSON.stringify(request.sourceBounds) === JSON.stringify(accepted.bounds)
    )
  )
  assert.ok(
    fullReads.some(
      (request) => request.sourceBounds.left === 80 && request.sourceBounds.right === 81
    )
  )
  f.assertReleased()
})

test('recovery keeps transparent accepted margins and verifies the full destination rectangle', async () => {
  const rgba = Uint8Array.from([111, 112, 113, 0, 7, 9, 11, 255, 121, 122, 123, 0, 19, 21, 23, 128])
  const f = fixture({ recovery: true, rgba, trim: true })
  await f.run()
  assert.equal(f.receipt()?.status, 'completed', JSON.stringify(f.lifecycleErrors))
  assert.deepEqual(f.layer.boundsNoEffects, { left: 41, top: 60, right: 42, bottom: 62 })
  assert.deepEqual(
    f.receipt().readback.steps[0].imageEvidence,
    copy(f.item.recovery.images.manifest.targets[0].acceptedEvidence)
  )
  f.assertReleased()
})

test('recovery rejects manifest, claim, target, source and fresh-asset substitutions before native import', async () => {
  for (const change of [
    (f) => {
      f.intent.recovery.baselineId = '0'.repeat(32)
    },
    (f) => {
      f.intent.recovery.images.manifest.sourcePlanSha256 = '0'.repeat(64)
    },
    (f) => {
      f.intent.recovery.images.assetBindings[0].assetId = '0'.repeat(32)
    },
    (f) => {
      f.intent.recovery.images.manifest.targets[0].targetId = '9'
    },
    (f) => {
      f.intent.executionAssets[0].sha256 = '0'.repeat(64)
    },
    (f) => {
      f.intent.executionAssets[0].sessionId = '0'.repeat(32)
    },
    (f) => {
      f.intent.executionAssets[0].purpose = 'local-preview'
    },
    (f) => {
      f.intent.plan.steps[0].assetId = f.item.recovery.images.manifest.assets[0].assetId
    },
    (f) => {
      f.item.recovery.images.manifest.manifestSha256 = '0'.repeat(64)
      f.intent.recovery = copy(f.item.recovery)
    },
    (f) => {
      delete f.intent.recovery.images
    },
    (f) => {
      delete f.item.recovery
    }
  ]) {
    const f = fixture({ recovery: true })
    change(f)
    await f.run()
    assert.equal(f.puts, 0)
    assert.ok(!f.events.includes('open-import'))
    assert.notEqual(f.receipt()?.status, 'completed')
    f.assertReleased()
  }
})

test('recovery requires the saved canonical hash to match the actual decoded source before any write', async () => {
  const f = fixture({ recovery: true })
  const manifest = f.item.recovery.images.manifest
  manifest.targets[0].acceptedEvidence.pixelSha256 = '0'.repeat(64)
  manifest.manifestSha256 = hash(
    f.context.MagicPotPlanPreviewV1.recoveryImagesManifestContent(manifest)
  )
  f.intent.recovery = copy(f.item.recovery)
  await f.run()
  assert.equal(f.puts, 0)
  assert.ok(f.events.includes('open-import'))
  assert.equal(f.receipt()?.status, 'failed')
  assert.deepEqual(f.layer.rgba, initial)
  assert.ok(
    f.lifecycleErrors.some((entry) => entry.error.includes('IMAGE_RECOVERY_DECODE_MISMATCH'))
  )
  f.assertReleased()
})

test('recovery write failure rolls back the fresh cropped native state, never the accepted destination', async () => {
  const freshPixels = Uint8Array.from([81, 82, 83, 0])
  const freshBounds = { left: 80, top: 90, right: 81, bottom: 91 }
  const f = fixture({
    recovery: true,
    beforeCapture({ layer }) {
      layer.rgba = new Uint8Array(freshPixels)
      layer.boundsNoEffects = copy(freshBounds)
    }
  })
  f.hooks.put = () => {
    f.layer.rgba[0] ^= 255
  }
  await f.run()
  assert.equal(f.puts, 1)
  assert.deepEqual(
    f.layer.rgba,
    freshPixels,
    'native history also preserves hidden zero-alpha storage'
  )
  assert.deepEqual(f.layer.boundsNoEffects, freshBounds)
  assert.ok(f.events.includes('rollback'))
  assert.equal(f.receipt()?.effect, 'rolled-back', JSON.stringify(f.lifecycleErrors))
  assert.equal(f.receipt().readback.steps[0].observation, 'original')
  assert.equal(f.receipt().readback.steps[0].imageEvidence, undefined)
  f.assertReleased()
})

test('recovery cancellation, expiry, revocation and later native edits never authorize a late write or foreign undo', async () => {
  for (const stop of ['cancel', 'expire', 'revoke']) {
    const f = fixture({ recovery: true })
    if (stop === 'cancel')
      f.hooks.open = () => {
        f.modalContext.isCancelled = true
        f.api.invalidate()
      }
    if (stop === 'expire') f.hooks.open = () => f.advance(60001)
    if (stop === 'revoke')
      f.hooks.response = ({ route, output }) => {
        if (route.endsWith('/plan/status')) output.state = 'cancelled'
      }
    await f.run()
    assert.equal(f.puts, 0)
    assert.notEqual(f.receipt()?.status, 'completed')
    f.assertReleased()
  }
  const f = fixture({ recovery: true })
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'executing') {
      f.layer.rgba.fill(99)
      f.doc.activeHistoryState.id += 100
      throw new Error('Later user edit')
    }
  }
  await f.run()
  assert.deepEqual(f.layer.rgba, new Uint8Array(16).fill(99))
  assert.ok(!f.events.includes('rollback'))
  assert.equal(f.receipt()?.effect, 'unknown')
  f.assertReleased()
})

test('native write mismatch restores the owned native history, never converted baseline pixels', async () => {
  const f = fixture()
  f.hooks.put = () => {
    f.layer.rgba[0] ^= 255
  }
  await f.run()
  assert.equal(f.puts, 1)
  assert.deepEqual(f.layer.rgba, initial)
  assert.ok(f.events.includes('rollback'))
  assert.equal(f.receipt().effect, 'rolled-back')
  assert.equal(f.receipt().readback.steps[0].observation, 'original')
  assert.equal(f.receipt().readback.steps[0].imageEvidence, undefined)
  f.assertReleased()
})

test('a failed progress receipt rolls back the whole mixed image and metadata transaction', async () => {
  const f = fixture()
  f.intent.plan.steps.push({ command: 'node.rename', targetId: '7', name: 'Approved name' })
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'executing' && body.completed === 2)
      throw new Error('Lost progress')
  }
  await f.run()
  assert.equal(f.puts, 1)
  assert.equal(f.layer.name, 'Original name')
  assert.deepEqual(f.layer.rgba, initial)
  assert.equal(f.receipt().effect, 'rolled-back')
  f.assertReleased()
})

test('a later user history and pixels are never undone by a failed execution', async () => {
  const f = fixture()
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'executing') {
      f.layer.rgba.fill(99)
      f.doc.activeHistoryState.id += 100
      throw new Error('User changed the document')
    }
  }
  await f.run()
  assert.deepEqual(f.layer.rgba, new Uint8Array(16).fill(99))
  assert.ok(!f.events.includes('rollback'))
  assert.equal(f.receipt().effect, 'unknown')
  assert.equal(f.receipt().readback.steps[0].observation, 'unknown')
  f.assertReleased()
})

for (const scenario of [
  'local-preview',
  'foreign-project',
  'unselected-resource',
  'wrong-dimensions',
  'wrong-reference'
]) {
  test(`execution refuses ${scenario} before importing or writing`, async () => {
    const f = fixture()
    if (scenario === 'local-preview') f.intent.executionAssets[0].purpose = 'local-preview'
    if (scenario === 'foreign-project') f.intent.executionAssets[0].projectId = 'different_project'
    if (scenario === 'unselected-resource') f.item.planningResources = []
    if (scenario === 'wrong-dimensions') f.intent.executionAssets[0].width = 3
    if (scenario === 'wrong-reference') f.intent.plan.steps[0].sha256 = '0'.repeat(64)
    await f.run()
    assert.equal(f.puts, 0)
    assert.ok(!f.events.includes('open-import'))
    assert.equal(f.receipt().status, 'failed')
    f.assertReleased()
  })
}

for (const scenario of ['hash', 'action', 'purpose']) {
  test(`execution chunk ${scenario} mismatch fails before native import`, async () => {
    const f = fixture()
    f.hooks.chunk = (value) => {
      if (scenario === 'hash') value.chunk.sha256 = '0'.repeat(64)
      if (scenario === 'action') value.actionId = '0'.repeat(32)
      if (scenario === 'purpose') value.purpose = 'local-preview'
    }
    await f.run()
    assert.equal(f.puts, 0)
    assert.ok(!f.events.includes('open-import'))
    assert.equal(f.receipt().status, 'failed')
    f.assertReleased()
  })
}

for (const options of [{ badNative: true }, { cachedLevel: true }]) {
  test(`unsupported native pixels fail closed and release partial preparation ${JSON.stringify(options)}`, async () => {
    const f = fixture(options)
    await f.run()
    assert.equal(f.puts, 0)
    assert.equal(f.receipt().status, 'failed')
    f.assertReleased()
  })
}

test('native capture does not read any pixels or expose a capability when execution memory is excessive', () => {
  const f = fixture()
  assert.ok(f.item.hostContext.nodes[0].commands.includes('image.pixels'))
  assert.deepEqual(f.events, [])
  f.doc.width = f.doc.height = 4096
  f.layer.boundsNoEffects = { left: 0, top: 0, right: 4096, bottom: 4096 }
  assert.equal(f.api.descriptor(f.layer).status, 'unavailable')
  f.layer.boundsNoEffects.bottom = 2048
  assert.equal(f.api.descriptor(f.layer).status, 'unavailable', 'hash padding is inside the budget')
  f.layer.boundsNoEffects.bottom = 2047
  assert.equal(f.api.descriptor(f.layer).status, 'available')
})

for (const scenario of [
  'selection',
  'channel',
  'profile',
  'depth',
  'clipping',
  'locked',
  'history'
]) {
  test(`native ${scenario} changes after capture prevent all image writes`, async () => {
    const f = fixture()
    if (scenario === 'selection') f.doc.selection.bounds = { left: 0, top: 0, right: 1, bottom: 1 }
    if (scenario === 'channel') f.doc.activeChannels = f.doc.activeChannels.slice(0, 1)
    if (scenario === 'profile') f.doc.colorProfileName = 'Adobe RGB (1998)'
    if (scenario === 'depth') f.doc.bitsPerChannel = 16
    if (scenario === 'clipping') f.layer.isClippingMask = true
    if (scenario === 'locked') f.layer.pixelsLocked = true
    if (scenario === 'history') f.doc.activeHistoryState.id++
    await f.run()
    assert.equal(f.puts, 0)
    assert.ok(!f.events.includes('open-import'))
    f.assertReleased()
  })
}

test('cancellation during owned import closes only owned documents and deletes its temporary file', async () => {
  const f = fixture()
  f.hooks.open = () => {
    f.modalContext.isCancelled = true
    f.api.invalidate()
  }
  await f.run()
  assert.equal(f.puts, 0)
  assert.equal(f.receipt(), undefined)
  f.assertReleased()
})

test('cancellation after native write uses modal history cancellation without claiming restoration evidence', async () => {
  const f = fixture()
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'executing') {
      f.modalContext.isCancelled = true
      f.api.invalidate()
    }
  }
  await f.run()
  assert.equal(f.puts, 1)
  assert.deepEqual(f.layer.rgba, initial)
  assert.equal(f.receipt(), undefined)
  assert.ok(f.events.includes('auto-rollback'))
  f.assertReleased()
})

test('a user edit after commit invalidates the last receipt instead of reusing earlier pixel evidence', async () => {
  const f = fixture()
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'readback') {
      f.layer.rgba.fill(73)
      f.doc.activeHistoryState.id++
    }
  }
  await f.run()
  assert.equal(f.receipt().status, 'failed')
  assert.equal(f.receipt().effect, 'unknown')
  assert.equal(f.receipt().readback.steps[0].observation, 'unknown')
  assert.equal(f.receipt().readback.steps[0].imageEvidence, undefined)
  assert.deepEqual(f.layer.rgba, new Uint8Array(16).fill(73))
  f.assertReleased()
})

test('resources are retained until an in-flight native pixel read settles after cancellation', async () => {
  const f = fixture()
  let release
  let started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const entered = new Promise((resolve) => {
    started = resolve
  })
  f.hooks.data = async ({ target }) => {
    if (target !== f.layer) {
      started()
      await gate
    }
  }
  const running = f.run()
  await entered
  f.api.invalidate()
  assert.equal(f.nativeImages.size, 1)
  assert.equal(f.ownedFiles.size, 1)
  release()
  await running
  assert.equal(f.puts, 0)
  f.assertReleased()
})

test('final authority recheck accepts the real Bridge readback state but never uses it for writes', async () => {
  const f = fixture()
  let readback = false
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'readback') readback = true
  }
  f.hooks.response = ({ route, output }) => {
    if (readback && route.endsWith('/plan/status')) output.state = 'readback'
  }
  await f.run()
  assert.equal(f.puts, 1)
  assert.equal(f.receipt().status, 'completed')
  f.assertReleased()
})

test('revocation while the prewrite full pixel read is pending is rechecked before putPixels', async () => {
  const f = fixture()
  let revoked = false
  f.hooks.data = ({ request, target }) => {
    if (target === f.layer && !request.targetSize && f.events.includes('suspend')) revoked = true
  }
  f.hooks.response = ({ route, output }) => {
    if (revoked && route.endsWith('/plan/status')) output.state = 'cancelled'
  }
  await f.run()
  assert.equal(f.puts, 0)
  assert.deepEqual(f.layer.rgba, initial)
  f.assertReleased()
})

test('an unexpected pixel extent outside the approved rectangle fails readback and rolls back', async () => {
  const f = fixture()
  f.hooks.put = () => {
    f.layer.boundsNoEffects.left--
  }
  await f.run()
  assert.equal(f.puts, 1)
  assert.equal(f.receipt().effect, 'rolled-back')
  assert.deepEqual(f.layer.boundsNoEffects, { left: 10, top: 20, right: 12, bottom: 22 })
  f.assertReleased()
})

test('a replaced native layer with the same ID during import is not the authorized target', async () => {
  const f = fixture()
  f.hooks.open = () => {
    f.doc.layers = [{ ...f.layer }]
  }
  await f.run()
  assert.equal(f.puts, 0)
  assert.equal(f.receipt().status, 'failed')
  f.assertReleased()
})

test('native import dimensions must independently equal approved dimensions', async () => {
  const f = fixture()
  f.hooks.open = (imported) => {
    imported.width++
  }
  await f.run()
  assert.equal(f.puts, 0)
  assert.equal(f.receipt().status, 'failed')
  f.assertReleased()
})

test('a failed explicit native history rollback remains unknown even if modal cancellation restores pixels', async () => {
  const f = fixture()
  f.hooks.put = () => {
    f.layer.rgba[0] ^= 255
  }
  f.hooks.resume = (commit) => {
    if (!commit) throw new Error('Native resume failed')
  }
  await f.run()
  assert.deepEqual(f.layer.rgba, initial)
  assert.equal(f.receipt().effect, 'unknown')
  assert.equal(f.receipt().status, 'failed')
  f.assertReleased()
})

test('lost native selection without a history change is not permission to undo later state', async () => {
  const f = fixture()
  f.hooks.fetch = ({ route, body }) => {
    if (route.endsWith('/plan/progress') && body.phase === 'executing') {
      f.doc.selection.bounds = { left: 0, top: 0, right: 1, bottom: 1 }
      throw new Error('Native selection changed')
    }
  }
  await f.run()
  assert.deepEqual(f.layer.rgba, replacement)
  assert.ok(!f.events.includes('rollback'))
  assert.equal(f.receipt().effect, 'unknown')
  f.assertReleased()
})

test('asset and claim expiry while native import is pending prevents the write and cleans resources', async () => {
  const f = fixture()
  f.hooks.open = () => f.advance(60001)
  await f.run()
  assert.equal(f.puts, 0)
  assert.equal(f.receipt(), undefined)
  f.assertReleased()
})
