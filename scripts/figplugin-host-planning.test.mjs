import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
// Drain the current microtask chain without guessing its length; VM timers stay virtual.
const flush = () => new Promise((resolve) => setImmediate(resolve))
const plain = (value) => JSON.parse(JSON.stringify(value))
const pngChunk = (type, data) => {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4)
  Buffer.from(data).copy(bytes, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}
const fakePng = (label) => {
  let marker = 0
  for (const char of String(label)) marker = (marker + char.codePointAt(0)) & 255
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64)
  header.writeUInt32BE(32, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc(32 * (64 * 4 + 1))
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++)
      raw.set([marker, marker ^ 0x55, marker ^ 0xaa, 255], y * 257 + 1 + x * 4)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
const fakePixels = (label) => {
  let marker = 0
  for (const char of String(label)) marker = (marker + char.codePointAt(0)) & 0xff
  return new Uint8Array([marker, marker ^ 0x55, marker ^ 0xaa, 0xff, 1, 2, 3, 0xff])
}
const recoveryImagesFor = (context, planner) => {
  const sourceAssetId = 'a'.repeat(32)
  const sha256 = 'b'.repeat(64)
  const manifest = {
    version: 1,
    sourcePlanSha256: 'c'.repeat(64),
    assets: [
      { assetId: sourceAssetId, sha256, mimeType: 'image/png', sizeBytes: 100, width: 2, height: 2 }
    ],
    targets: [
      {
        targetId: context.selectedIds[0],
        assetId: sourceAssetId,
        sha256,
        ...(context.host === 'figma'
          ? {
              command: 'image.fill',
              scaleMode: 'FIT',
              acceptedEvidence: {
                kind: 'figma-image-fill',
                sourceSha256: sha256,
                nativeImageHash: 'old-native-hash',
                fillsSha256: 'd'.repeat(64)
              }
            }
          : {
              command: 'image.pixels',
              pixelEncoding: 'rgba8-srgb-zero-alpha-v1',
              acceptedEvidence: {
                kind: 'photoshop-pixels',
                sourceSha256: sha256,
                pixelSha256: 'd'.repeat(64),
                width: 2,
                height: 2,
                bounds: { left: 0, top: 0, right: 2, bottom: 2 }
              }
            })
      }
    ],
    manifestSha256: 'e'.repeat(64)
  }
  manifest.manifestSha256 = createHash('sha256')
    .update(planner.recoveryImagesManifestContent(manifest))
    .digest('hex')
  return { manifest, assetBindings: [{ sourceAssetId, assetId: 'f'.repeat(32) }] }
}

// Observe production callbacks without substituting native work or lifecycle results.
function createNativeLifecycleObserver() {
  const runs = []
  return {
    runs,
    own(registry, runId, containers) {
      const run = runs.find((candidate) => candidate.runId === runId)
      if (run) run.ownershipRegistrations.push({ registry, containers })
    },
    api(api) {
      return Object.freeze({
        ...api,
        createHostAdapterLifecycle(options) {
          const record = { options, events: [], ownershipRegistrations: [], releaseCalls: 0 }
          runs.push(record)
          const lifecycle = api.createHostAdapterLifecycle({
            ...options,
            async prepareResources(args) {
              record.runId = args.runId
              record.prepareArgs = args
              record.events.push('prepare')
              const resources = await options.prepareResources(args)
              record.resources = resources
              return resources
            },
            async execute(args) {
              record.executeArgs = args
              record.events.push('execute')
              const execution = await options.execute(args)
              record.execution = execution
              return execution
            },
            async readback(args) {
              record.events.push('readback')
              const readback = await options.readback(args)
              record.readback = plain(readback)
              return readback
            },
            async releaseResources(args) {
              record.releaseCalls += 1
              record.releaseArgs = args
              record.events.push('release')
              record.contextBeforeRelease = plain(record.prepareArgs.context)
              record.ownedBeforeRelease = record.ownershipRegistrations.flatMap(({ containers }) =>
                [...containers].map((collection) => ({
                  collection,
                  size: Array.isArray(collection) ? collection.length : collection.size,
                  ...(Array.isArray(collection)
                    ? {}
                    : { points: [...collection.values()].map(plain) })
                }))
              )
              record.publishedBeforeRelease = lifecycle.getResult(args.runId)
              await options.releaseResources(args)
              record.events.push('released')
            }
          })
          record.lifecycle = lifecycle
          return {
            ...lifecycle,
            async run(...args) {
              const result = await lifecycle.run(...args)
              record.result = result
              record.events.push('terminal')
              return result
            }
          }
        }
      })
    }
  }
}

function fixture(
  host,
  {
    corruptResult = false,
    locked = false,
    approvePlan = false,
    textPlan = false,
    fontGate = null,
    missingFonts = false,
    nativeTextEncoding = true,
    pendingClaims = 0,
    twoSteps = false,
    failSecond = false,
    correctionFlow = false,
    tamperCorrectionAuthorization = false,
    visualGate = null,
    modalGate = null,
    tamperComparisonIdentity = false,
    progressHook = null,
    persistedActions = new Map(),
    journalHook = null,
    journalAvailable = true,
    journalHelper = true,
    dropResult = false,
    actionSeed = '8',
    authorityHook = null,
    recoveryRebindFault = null,
    documentRebindFault = null,
    unsolicitedDocumentRebind = false,
    nativeDocumentId = 5,
    unsolicitedRebind = false,
    recoveryGate = null,
    recoveryUnchanged = false,
    recoveryImages = undefined,
    tamperRecovery = false,
    figmaUi = false,
    uxpImagePreview = true,
    uxpNotifications = true,
    observeLifecycle = false
  } = {}
) {
  let time = 1_800_000_000_000,
    serial = 0
  const timers = new Map(),
    posts = [],
    requests = [],
    elements = new Map()
  const nativeEvents = new Map(),
    uiEvents = new Map(),
    uiSends = []
  const lifecycleObserver = observeLifecycle ? createNativeLifecycleObserver() : null
  let uiParent = null
  const createElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    id: '',
    value: '',
    textContent: '',
    checked: false,
    disabled: false,
    style: {},
    children: [],
    parentNode: null,
    parentElement: null,
    ...(tagName.toLowerCase() === 'img' ? { naturalWidth: 0, naturalHeight: 0 } : {}),
    handlers: {},
    removeAttribute(name) {
      delete this[name]
    },
    setAttribute(name, value) {
      this[name] = value
    },
    addEventListener(name, fn) {
      this.handlers[name] = fn
    },
    removeEventListener(name, fn) {
      if (this.handlers[name] === fn) delete this.handlers[name]
    },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      child.parentElement = this
      if (child.id) elements.set(child.id, child)
      return child
    },
    replaceChild(child, previous) {
      assert.ok(this.children.includes(previous), 'replace only an attached preview element')
      this.children = this.children.filter((value) => value !== previous)
      previous.parentNode = null
      previous.parentElement = null
      if (previous.id && elements.get(previous.id) === previous) elements.delete(previous.id)
      this.appendChild(child)
      return previous
    }
  })
  const element = (id) => {
    if (!elements.has(id)) {
      const value = createElement(id === 'context-image' ? 'img' : 'div')
      value.id = id
      elements.set(id, value)
      if (id === 'context-image') element('context-image-view').appendChild(value)
    }
    return elements.get(id)
  }
  const rootNode = { id: '0:0', type: 'DOCUMENT' }
  const pageEvents = new Map()
  const page = {
    id: '0:1',
    type: 'PAGE',
    name: 'Owned page',
    parent: rootNode,
    selection: [],
    on(name, callback) {
      pageEvents.set(name, callback)
    },
    off(name, callback) {
      if (pageEvents.get(name) === callback) pageEvents.delete(name)
    }
  }
  const document = {
    id: nativeDocumentId,
    activeLayers: [],
    layers: [],
    width: 320,
    height: 180,
    resolution: 300,
    pixelAspectRatio: 1,
    activeHistoryState: { id: 17 }
  }
  const data =
    host === 'figma'
      ? {
          id: '1:2',
          type: textPlan ? 'TEXT' : 'RECTANGLE',
          ...(textPlan
            ? {
                characters: 'Original owned text',
                fontName: { family: 'Owned Sans', style: 'Regular' },
                fontSize: 14,
                hasMissingFont: missingFonts
              }
            : {}),
          name: 'Original owned name',
          parent: page,
          locked,
          visible: true
        }
      : {
          id: 7,
          kind: textPlan ? 'text' : 'pixel',
          ...(textPlan
            ? {
                textItem: {
                  contents: 'Original owned text',
                  characterStyle: { font: 'OwnedSans-Regular', size: 14 }
                }
              }
            : {}),
          name: 'Original owned name',
          parent: null,
          document,
          visible: true,
          allLocked: locked,
          pixelsLocked: false,
          positionLocked: false,
          transparentPixelsLocked: false,
          isBackgroundLayer: false
        }
  const node = data
  const fontLoads = [],
    textWrites = [],
    loadedFonts = new Set()
  if (host === 'figma' && textPlan) {
    let characters = node.characters
    node.getStyledTextSegments = () => [
      { start: 0, end: characters.length, fontName: node.fontName, fontSize: node.fontSize }
    ]
    Object.defineProperty(node, 'characters', {
      enumerable: true,
      configurable: true,
      get: () => characters,
      set(value) {
        const fonts = characters.length
          ? node.getStyledTextSegments().map((x) => x.fontName)
          : [node.fontName]
        if (fonts.some((font) => !loadedFonts.has(JSON.stringify(font))))
          throw Error('Fixture font was not loaded')
        textWrites.push(value)
        characters = value
      }
    })
  }
  const nativeWrites = []
  let firstName = data.name
  Object.defineProperty(node, 'name', {
    enumerable: true,
    configurable: true,
    get: () => firstName,
    set: (value) => {
      nativeWrites.push(value)
      firstName = value
    }
  })
  const storeRead = (key) => {
    if (journalHook) journalHook('read', key)
    return persistedActions.get(key)
  }
  const storeWrite = (key, value) => {
    if (journalHook) journalHook('write', key, value)
    persistedActions.set(key, value)
  }
  const clientStorage = {
    getAsync: async (key) => storeRead(key),
    setAsync: async (key, value) => storeWrite(key, value),
    keysAsync: async () => [...persistedActions.keys()],
    deleteAsync: async (key) => persistedActions.delete(key)
  }
  const localStorage = {
    get length() {
      return persistedActions.size
    },
    key: (index) => [...persistedActions.keys()][index] ?? null,
    getItem: (key) => storeRead(key) ?? null,
    setItem: storeWrite,
    removeItem: (key) => persistedActions.delete(key)
  }
  page.selection = [node]
  document.activeLayers = [node]
  let secondName = 'Second original name'
  const second =
    host === 'figma'
      ? {
          id: '1:3',
          type: 'RECTANGLE',
          name: secondName,
          parent: page,
          locked: false,
          visible: true
        }
      : {
          id: 8,
          kind: 'pixel',
          name: secondName,
          parent: null,
          document,
          visible: true,
          allLocked: false,
          pixelsLocked: false,
          positionLocked: false,
          transparentPixelsLocked: false,
          isBackgroundLayer: false
        }
  document.layers = [node, second]
  for (const item of [node, second]) {
    if (host === 'figma') item.absoluteBoundingBox = { x: -24.5, y: 16.25, width: 64, height: 32 }
    else item.boundsNoEffects = { left: -24.5, top: 16.25, right: 39.5, bottom: 48.25 }
  }
  if (host === 'figma') {
    for (const item of [node, second]) {
      item.width = 64
      item.height = 32
      item.exportAsync = async () => {
        if (visualGate) await visualGate({ node, second })
        return fakePng(item.name)
      }
    }
  }
  if (failSecond)
    Object.defineProperty(second, 'name', {
      enumerable: true,
      configurable: true,
      get: () => secondName,
      set: () => {
        throw new Error('Native write refused')
      }
    })
  if (twoSteps) {
    page.selection.push(second)
    document.activeLayers.push(second)
  }
  let activeDocument = document
  let openDocuments = [document]
  const app = Object.freeze({
    get activeDocument() {
      return activeDocument
    },
    get documents() {
      return openDocuments
    }
  })
  const photoshopNotifications = new Map()
  const coreNotifications = new Map()
  const notificationRegistrations = []
  const notificationRemovals = []
  const coreNotificationRegistrations = []
  const coreNotificationRemovals = []
  const pixelRequests = []
  const pixelReads = []
  const pixelDisposals = []
  const imageObjectUrls = new Map()
  const createdImageUrls = []
  const revokedImageUrls = []
  class NativeImageBlob {
    constructor(buffer, options) {
      assert.equal(Object.prototype.toString.call(buffer), '[object ArrayBuffer]')
      assert.deepEqual(plain(options), { type: 'image/png' })
      this.bytes = new Uint8Array(buffer.slice(0))
    }
  }
  class NativeImageURL extends URL {
    static createObjectURL(blob) {
      assert.ok(blob instanceof NativeImageBlob)
      const url = 'blob:uxp-fixture/' + ++serial
      imageObjectUrls.set(url, new Uint8Array(blob.bytes))
      createdImageUrls.push(url)
      return url
    }
    static revokeObjectURL(url) {
      revokedImageUrls.push(url)
      imageObjectUrls.delete(url)
    }
  }
  const photoshop = {
    app,
    action: uxpNotifications
      ? {
          async addNotificationListener(events, callback) {
            assert.ok(Array.isArray(events) && events.length > 0)
            assert.ok(events.every((event) => typeof event === 'string'))
            assert.equal(typeof callback, 'function')
            notificationRegistrations.push([...events])
            photoshopNotifications.set(callback, [...events])
          },
          async removeNotificationListener(events, callback) {
            notificationRemovals.push([...events])
            if (photoshopNotifications.has(callback))
              assert.deepEqual(plain(events), photoshopNotifications.get(callback))
            photoshopNotifications.delete(callback)
          }
        }
      : undefined,
    core: {
      async executeAsModal(callback) {
        if (modalGate) await modalGate()
        return callback()
      },
      async addNotificationListener(group, events, callback) {
        assert.ok(['UI', 'OS'].includes(group))
        assert.ok(Array.isArray(events) && events.every((event) => typeof event === 'string'))
        const listeners = coreNotifications.get(group) || new Map()
        listeners.set(callback, [...events])
        coreNotifications.set(group, listeners)
        coreNotificationRegistrations.push({ group, events: [...events] })
      },
      async removeNotificationListener(group, events, callback) {
        const listeners = coreNotifications.get(group)
        if (listeners?.has(callback)) assert.deepEqual(plain(events), listeners.get(callback))
        listeners?.delete(callback)
        coreNotificationRemovals.push({ group, events: [...events] })
      }
    },
    imaging: {
      async getPixels(request) {
        pixelRequests.push(plain(request))
        if (visualGate) await visualGate({ node, second })
        const layer = [node, second].find((item) => item.id === request.layerID)
        assert.ok(layer)
        const probe = request.targetSize?.width === 1 && request.targetSize?.height === 1
        const width = probe ? 1 : 2
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
            async getData(options) {
              assert.equal(disposed, false, 'native pixel data cannot be read after disposal')
              pixelReads.push({ request: plain(request), options: plain(options) })
              return fakePixels(layer.name).subarray(0, width * 4)
            },
            dispose() {
              assert.equal(disposed, false, 'each native image resource must be disposed once')
              disposed = true
              pixelDisposals.push(plain(request))
            }
          }
        }
      }
    }
  }
  const figma = {
    root: rootNode,
    async loadFontAsync(font) {
      fontLoads.push(plain(font))
      if (fontGate) await fontGate({ node, font })
      loadedFonts.add(JSON.stringify(font))
    },
    ...(journalAvailable ? { clientStorage } : {}),
    currentPage: page,
    showUI() {
      // The fixture runs the UI script separately when requested.
    },
    on(name, callback) {
      if (name === 'documentchange') throw new Error('dynamic-page requires loadAllPagesAsync')
      nativeEvents.set(name, callback)
    },
    off(name, callback) {
      if (nativeEvents.get(name) === callback) nativeEvents.delete(name)
    },
    closePlugin() {
      // Bridge cleanup is exercised without closing a real Figma process.
    },
    getNodeById(id) {
      return [rootNode, page, node, second].find((item) => item.id === id) || null
    },
    ui: {
      postMessage(value) {
        const message = plain(value)
        posts.push(message)
        uiEvents.get('message')?.({ source: uiParent, data: { pluginMessage: message } })
      }
    }
  }
  const origin = 'http://127.0.0.1:49152',
    pluginId = 'owned.' + host
  const sessionId = 'b'.repeat(32),
    sessionToken = 'c'.repeat(64),
    callId = 'd'.repeat(32),
    sourceExecutionId = actionSeed.repeat(32),
    correctionExecutionId = 'a'.repeat(32),
    correctionAuthorizationId = '5'.repeat(32),
    correctionBaselineId = '4'.repeat(32),
    sourceVisualEvidenceSha256 = '6'.repeat(64),
    baselineVisualEvidenceSha256 = '7'.repeat(64),
    comparisonSha256 = 'a'.repeat(64)
  let approvedContext
  let correctionContext
  let recoveryContext
  let recoveryDescriptor
  const recoveryExecutionId = '0123'.repeat(8)
  let planResult = null
  let lastResultStatus = null
  const planResults = []
  const claimedExecutions = new Set()
  const plannedSteps = () => {
    if (textPlan)
      return [
        {
          command: 'text.content',
          targetId: approvedContext.nodes[0].id,
          text: 'Approved owned text 中文😀'
        }
      ]
    const steps = [
      {
        command: 'node.rename',
        targetId: approvedContext.nodes[0].id,
        name: 'Approved new name'
      }
    ]
    if (twoSteps)
      steps.push({
        command: 'node.rename',
        targetId: approvedContext.nodes[1].id,
        name: 'Second approved name'
      })
    return steps
  }
  const sandbox = {
    console,
    ...(lifecycleObserver
      ? {
          __observeNativeLifecycleApi: (api) => lifecycleObserver.api(api),
          __observeNativeOwnedCollections: (registry, runId, containers) =>
            lifecycleObserver.own(registry, runId, containers)
        }
      : {}),
    ...(journalAvailable ? { localStorage } : {}),
    AbortController,
    ...(nativeTextEncoding ? { TextEncoder, TextDecoder } : {}),
    ...(host === 'photoshop' && uxpImagePreview
      ? { ImageBlob: NativeImageBlob, URL: NativeImageURL }
      : {}),
    Uint8Array,
    Date: class extends Date {
      static now() {
        return time
      }
    },
    setTimeout(fn, ms) {
      const id = ++serial
      timers.set(id, { fn, at: time + ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    crypto: {
      getRandomValues(bytes) {
        bytes.fill(++serial % 255)
        return bytes
      }
    },
    fetch: async (url, options) => {
      assert.ok(url.startsWith(origin + '/figplugin/v1/'))
      const body = JSON.parse(options.body)
      requests.push({ url, body })
      let value,
        status = 200
      if (url.endsWith('/pair'))
        value = {
          protocol: 1,
          sessionId,
          sessionToken,
          expiresAt: time + 600_000,
          idleTimeoutMs: 120_000
        }
      else if (url.endsWith('/plan/recovery/prepare')) {
        assert.deepEqual(
          Object.keys(body).sort(),
          [
            'hostContext',
            'protocol',
            'requestId',
            'sequence',
            ...(body.rebindBaselineId ? ['rebindBaselineId'] : []),
            ...(body.reopenDocument ? ['reopenDocument'] : [])
          ].sort()
        )
        recoveryContext = body.hostContext
        recoveryDescriptor = {
          baselineId: '4'.repeat(32),
          sourceExecutionId: '8'.repeat(32),
          requestId: body.requestId,
          round: 1,
          maxCorrectionRounds: 3,
          targetIds: [...body.hostContext.selectedIds].sort()
        }
        if (recoveryImages !== undefined)
          recoveryDescriptor.images = recoveryImages(body.hostContext, vm.MagicPotPlanPreviewV1)
        if (body.rebindBaselineId || unsolicitedRebind) {
          recoveryDescriptor.rebind = {
            previousIdentity: '1'.repeat(32),
            nextIdentity: body.hostContext.recoveryIdentity
          }
          if (body.reopenDocument || unsolicitedDocumentRebind) {
            recoveryDescriptor.rebind.document = {
              host: 'photoshop',
              previousDocumentId: '101',
              nextDocumentId: body.hostContext.documentId
            }
            if (documentRebindFault === 'current')
              recoveryDescriptor.rebind.document.nextDocumentId = '999'
            if (documentRebindFault === 'previous')
              recoveryDescriptor.rebind.document.previousDocumentId = '101\n'
            if (documentRebindFault === 'host') recoveryDescriptor.rebind.document.host = 'figma'
            if (documentRebindFault === 'extra') recoveryDescriptor.rebind.document.file = 'PRIVATE'
          }
          if (recoveryRebindFault === 'identity')
            recoveryDescriptor.rebind.nextIdentity = '0'.repeat(32)
          if (recoveryRebindFault === 'baseline') recoveryDescriptor.baselineId = '0'.repeat(32)
        }
        if (recoveryGate) await recoveryGate()
        value = recoveryUnchanged
          ? { protocol: 1, status: 'unchanged', baselineId: recoveryDescriptor.baselineId }
          : {
              protocol: 1,
              status: 'prepared',
              callId,
              executionId: recoveryExecutionId,
              expiresAt: time + 120000,
              recovery: recoveryDescriptor
            }
      } else if (url.endsWith('/plan/correction/prepare')) {
        const selectedId = approvedContext.nodes[0].id
        if (!body.hostContext) {
          value = {
            protocol: 1,
            status: 'authorized',
            authorization: {
              protocol: 1,
              authorizationId: correctionAuthorizationId,
              baselineId: tamperComparisonIdentity ? 'f'.repeat(32) : correctionBaselineId,
              sourceExecutionId,
              pluginId,
              host,
              projectId: 'project_1',
              documentId: approvedContext.documentId,
              scopeId: approvedContext.scopeId,
              captureId: approvedContext.captureId,
              adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
              baselineEvidenceSha256: baselineVisualEvidenceSha256,
              visualEvidenceSha256: sourceVisualEvidenceSha256,
              comparisonSha256,
              visualTargetIds: [selectedId],
              authorizedTargetIds: [tamperCorrectionAuthorization ? String(second.id) : selectedId],
              round: 1,
              maxCorrectionRounds: 3,
              authorizedAt: time,
              expiresAt: time + 60_000,
              state: 'authorized'
            }
          }
        } else {
          correctionContext = body.hostContext
          value = {
            protocol: 1,
            status: 'prepared',
            executionId: correctionExecutionId,
            callId,
            state: 'awaiting-approval',
            expiresAt: time + 60_000
          }
        }
      } else if (url.endsWith('/prepare')) {
        approvedContext = body.hostContext
        value = { protocol: 1, callId, status: 'awaiting-approval', expiresAt: time + 120_000 }
      } else if (url.endsWith('/plan/status')) {
        const executionId = body.executionId || sourceExecutionId
        value = {
          protocol: 1,
          executionId,
          callId,
          state: claimedExecutions.has(executionId)
            ? 'claimed'
            : approvePlan
              ? 'approved'
              : 'awaiting-approval',
          completed: 0,
          total: executionId === correctionExecutionId ? 1 : twoSteps ? 2 : 1,
          effect: 'none',
          updatedAt: time
        }
        if (authorityHook) authorityHook(value)
      } else if (url.endsWith('/plan/claim') && pendingClaims-- > 0) {
        value = { protocol: 1, status: 'pending', state: 'approved' }
      } else if (url.endsWith('/plan/claim')) {
        claimedExecutions.add(body.executionId || sourceExecutionId)
        const correction = body.executionId === correctionExecutionId
        const restoring = body.executionId === recoveryExecutionId
        const context = restoring
          ? recoveryContext
          : correction
            ? correctionContext
            : approvedContext
        const selected = context.nodes[0]
        const authorizationTargets = [(restoring ? recoveryContext : approvedContext).nodes[0].id]
        value = {
          protocol: 1,
          status: 'ready',
          intent: {
            protocol: 1,
            purpose: 'execute-host-plan',
            executionId: restoring
              ? recoveryExecutionId
              : correction
                ? correctionExecutionId
                : sourceExecutionId,
            callId,
            pluginId,
            host,
            documentId: context.documentId,
            scopeId: context.scopeId,
            captureId: context.captureId,
            plan: {
              schemaVersion: 2,
              kind: 'host-plan',
              captureId: context.captureId,
              steps: restoring
                ? [
                    {
                      command: 'node.rename',
                      targetId: context.selectedIds[0],
                      name: 'Accepted recovery name'
                    }
                  ]
                : correction
                  ? [
                      {
                        command: 'node.rename',
                        targetId: selected.id,
                        name: 'Original owned name'
                      }
                    ]
                  : plannedSteps()
            },
            planSha256: correction ? 'f'.repeat(64) : '9'.repeat(64),
            expiresAt: time + 120000,
            adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
            actionId: restoring
              ? '0123'.repeat(8)
              : correction
                ? 'e'.repeat(32)
                : sourceExecutionId,
            ...(restoring
              ? {
                  recovery: tamperRecovery
                    ? { ...recoveryDescriptor, baselineId: '0'.repeat(32) }
                    : recoveryDescriptor
                }
              : {}),
            ...(correction
              ? {
                  visualTargetIds: authorizationTargets,
                  visualCorrection: {
                    authorizationId: correctionAuthorizationId,
                    baselineId: correctionBaselineId,
                    sourceExecutionId,
                    round: 1,
                    maxCorrectionRounds: 3,
                    authorizedTargetIds: authorizationTargets
                  }
                }
              : {})
          }
        }
      } else if (url.endsWith('/plan/progress')) {
        if (progressHook) await progressHook(body, { node, second })
        value = {
          protocol: 1,
          executionId: body.executionId,
          callId,
          state: body.phase,
          completed: body.completed,
          total: body.total,
          effect: body.effect,
          updatedAt: time
        }
      } else if (url.endsWith('/plan/result')) {
        if (dropResult) throw new Error('Owned result transport loss')
        planResult = body
        planResults.push(plain(body))
        const correction = body.executionId === correctionExecutionId
        const statusValue = {
          protocol: 1,
          executionId: body.executionId,
          callId,
          state: body.status === 'completed' ? 'completed' : 'failed',
          completed: body.completed,
          total: body.total,
          effect: body.effect,
          updatedAt: time,
          ...(body.visualEvidence ? { visualEvidence: body.visualEvidence } : {})
        }
        if (correctionFlow && body.status === 'completed' && body.visualEvidence) {
          const current = body.visualEvidence[0].after
          const baseline = correction ? current : body.visualEvidence[0].before
          Object.assign(statusValue, {
            visualEvidenceSha256: correction
              ? baselineVisualEvidenceSha256
              : sourceVisualEvidenceSha256,
            visualBaselineComparison: {
              protocol: 1,
              baselineId: correctionBaselineId,
              executionId: body.executionId,
              baselineEvidenceSha256: baselineVisualEvidenceSha256,
              visualEvidenceSha256: correction
                ? baselineVisualEvidenceSha256
                : sourceVisualEvidenceSha256,
              comparedAt: time,
              targets: [
                {
                  targetId: body.visualEvidence[0].targetId,
                  baseline,
                  current,
                  changed: !correction
                }
              ],
              changedCount: correction ? 0 : 1,
              exactMatch: correction
            }
          })
        }
        lastResultStatus = statusValue
        value = { protocol: 1, executionId: body.executionId, status: statusValue }
      } else if (url.endsWith('/plan/pixel-audit')) {
        assert.equal(body.executionId, lastResultStatus.executionId)
        const changedTargets = body.targets.filter(
          (target) =>
            target.status === 'dimensions-changed' ||
            (target.status === 'compared' && target.changedPixels > 0)
        ).length
        const unavailableTargets = body.targets.filter(
          (target) => target.status === 'unavailable'
        ).length
        value = {
          protocol: 1,
          executionId: body.executionId,
          status: {
            ...lastResultStatus,
            pixelAudit: {
              policy: body.policy,
              baselineId: body.baselineId,
              baselineEvidenceSha256: body.baselineEvidenceSha256,
              visualEvidenceSha256: body.visualEvidenceSha256,
              targets: body.targets,
              checkedAt: time,
              outcome: unavailableTargets ? 'incomplete' : changedTargets ? 'different' : 'match',
              changedTargets,
              unavailableTargets,
              comparedTargets: body.targets.filter((target) => target.status === 'compared').length,
              changedPixels: body.targets.reduce(
                (sum, target) => sum + (target.changedPixels || 0),
                0
              )
            }
          }
        }
      } else if (url.endsWith('/status')) {
        const selected = approvedContext.nodes[0]
        const plan = {
          schemaVersion: 2,
          kind: 'host-plan',
          captureId: approvedContext.captureId,
          steps: [
            { command: 'node.rename', targetId: selected.id, name: 'Proposed new name' },
            ...(twoSteps
              ? [
                  {
                    command: 'node.rename',
                    targetId: approvedContext.nodes[1].id,
                    name: 'Second proposed name'
                  }
                ]
              : [])
          ]
        }
        if (textPlan) plan.steps = plannedSteps()
        value = {
          protocol: 1,
          callId,
          status: 'completed',
          content: JSON.stringify({
            kind: 'host-plan-preview',
            executable: !corruptResult,
            plan,
            risk: twoSteps || textPlan ? 'medium' : 'low',
            execution: {
              mode: 'native-write',
              adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
              rollback: 'verified-in-place',
              visualAudit: approvedContext.execution.visualAudit,
              requiresWriteApproval: true
            },
            differences: plan.steps.map((step) => ({
              targetId: step.targetId,
              command: step.command,
              before: approvedContext.nodes.find((item) => item.id === step.targetId)?.[
                textPlan ? 'text' : 'name'
              ],
              after: textPlan ? step.text : step.name
            }))
          })
        }
      } else {
        status = 204
      }
      return {
        ok: true,
        status,
        url,
        headers: { get: () => null },
        text: async () => JSON.stringify(value)
      }
    },
    figma,
    __html__: '',
    require(name) {
      assert.equal(name, 'photoshop')
      return photoshop
    },
    document: {
      readyState: 'complete',
      getElementById: element,
      createElement,
      addEventListener() {
        // This fixture starts with a complete DOM, so no ready event is needed.
      }
    },
    window: {
      addEventListener(name, callback) {
        uiEvents.set(name, callback)
      }
    }
  }
  const vm = createContext(sandbox)
  if (lifecycleObserver) {
    new Script(
      `(() => {
      const defineProperty = Object.defineProperty;
      Object.defineProperty = function (target, name, descriptor) {
        if (target === globalThis && name === 'MagicPotPlanPreviewV1') {
          Object.defineProperty = defineProperty;
          descriptor = { ...descriptor, value: globalThis.__observeNativeLifecycleApi(descriptor.value) };
        }
        return defineProperty(target, name, descriptor);
      };
      const set = Map.prototype.set;
      Map.prototype.set = function (key, value) {
        const result = set.call(this, key, value);
        if (typeof key === 'string' && value instanceof Set)
          globalThis.__observeNativeOwnedCollections(this, key, value);
        return result;
      };
    })();`,
      { filename: 'native-lifecycle-observer.fixture.js' }
    ).runInContext(vm)
  }
  const configuration = `globalThis.MAGICPOT_BRIDGE_CONFIG = Object.freeze(${JSON.stringify({ protocol: 1, origin, pluginId, host })});\n`
  if (host === 'photoshop') {
    // Match prepare-figplugin-host.mjs ordering and UXP's module-local var bindings.
    const source =
      configuration +
      [
        read('shared/bridge-readiness.js'),
        read('shared/selection-snapshot.js'),
        read('shared/pixel-audit.js'),
        read('shared/visual-evidence.js'),
        read('shared/plan-preview.js'),
        ...(journalHelper ? [read('shared/execution-journal.js')] : []),
        read('photoshop-uxp/bridge/main.js')
      ].join('\n;\n')
    const filename = 'photoshop-uxp/bridge/main.js'
    const module = { exports: {} }
    const entry = new Script(Module.wrap(source), { filename }).runInContext(vm)
    entry.call(
      module.exports,
      module.exports,
      sandbox.require,
      module,
      filename,
      'photoshop-uxp/bridge'
    )
    assert.equal(
      vm.MagicPotPixelAuditBundle,
      undefined,
      'private CommonJS bundle variables are not host globals'
    )
  } else {
    new Script(configuration).runInContext(vm)
    new Script(read('shared/selection-snapshot.js')).runInContext(vm)
    new Script(read('shared/pixel-audit.js')).runInContext(vm)
    new Script(read('shared/visual-evidence.js')).runInContext(vm)
    new Script(read('shared/plan-preview.js')).runInContext(vm)
    if (journalHelper) new Script(read('shared/execution-journal.js')).runInContext(vm)
    new Script(read('figma/bridge/code.js')).runInContext(vm)
  }
  const send = (message) => figma.ui.onmessage({ protocol: 1, ...message })
  const click = (id) => element(id).handlers.click()
  if (figmaUi) {
    assert.equal(host, 'figma')
    uiParent = {
      postMessage(envelope, origin) {
        assert.equal(origin, '*')
        uiSends.push(plain(envelope.pluginMessage))
        figma.ui.onmessage(envelope.pluginMessage)
      }
    }
    vm.parent = uiParent
    new Script(read('figma/bridge/ui.html').match(/<script>([\s\S]*?)<\/script>/)[1]).runInContext(
      vm
    )
  }
  async function pair() {
    const ticket = JSON.stringify({
      ticketId: '1'.repeat(32),
      pairingSecret: '2'.repeat(64),
      expiresAt: time + 120000,
      bridgeOrigin: origin,
      pluginId,
      host,
      artifactSha256: '3'.repeat(64)
    })
    if (host === 'figma') send({ type: 'pair', ticket, nonce: '4'.repeat(32) })
    else {
      element('ticket').value = ticket
      click('pair')
    }
    await flush()
  }
  function capture() {
    if (figmaUi) click('plan-capture')
    else if (host === 'figma')
      send({ type: 'capture-plan', nonce: '5'.repeat(32), instanceEpoch: '6'.repeat(32) })
    else click('plan-capture')
  }
  function share() {
    if (host === 'figma') {
      const revision = posts.filter((post) => post.type === 'preview').at(-1).revision
      send({
        type: 'share',
        nonce: '7'.repeat(32),
        revision,
        prompt: 'Propose a clearer name only.',
        consent: true
      })
    } else {
      element('prompt').value = 'Propose a clearer name only.'
      element('consent').checked = true
      click('share')
    }
  }
  async function tick(ms) {
    const target = time + ms
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > target) break
      timers.delete(next[0])
      time = next[1].at
      next[1].fn()
      await flush()
    }
    time = target
  }
  const output = () =>
    host === 'figma'
      ? posts.filter((post) => post.type === 'content').at(-1)?.text
      : element('result').textContent
  return {
    pair,
    capture,
    share,
    captureImage: (revision = '5'.repeat(32)) =>
      host === 'photoshop'
        ? click('image-capture')
        : figmaUi
          ? click('plan-image-capture')
          : send({ type: 'capture-plan-image', nonce: revision, instanceEpoch: '6'.repeat(32) }),
    send,
    click,
    uiSends,
    figma,
    photoshop,
    setActiveDocument(value, documents = value ? [value] : []) {
      activeDocument = value
      openDocuments = documents
    },
    firePhotoshopNotification(name, descriptor = {}) {
      for (const [callback, events] of [...photoshopNotifications])
        if (events.includes(name) || events.includes('all')) callback(name, descriptor)
    },
    firePhotoshopCoreNotification(group, name, descriptor = {}) {
      for (const [callback, events] of [...(coreNotifications.get(group) || [])])
        if (events.includes(name)) callback(name, descriptor)
    },
    photoshopObserverCount: () =>
      photoshopNotifications.size +
      [...coreNotifications.values()].reduce((count, listeners) => count + listeners.size, 0),
    notificationRegistrations,
    notificationRemovals,
    coreNotificationRegistrations,
    coreNotificationRemovals,
    pixelRequests,
    pixelReads,
    pixelDisposals,
    createdImageUrls,
    revokedImageUrls,
    contextImageBytes: () => {
      const source = element('context-image').src
      return host === 'photoshop'
        ? Buffer.from(imageObjectUrls.get(source) || [])
        : Buffer.from(source.split(',')[1], 'base64')
    },
    fireNative: (name) => nativeEvents.get(name)?.(),
    firePage: (name, value = {}) => pageEvents.get(name)?.(value),
    imageObserverCount: () => pageEvents.size + (nativeEvents.has('stylechange') ? 1 : 0),
    loadContextImage: () => {
      const image = element('context-image')
      const png =
        host === 'photoshop'
          ? Buffer.from(imageObjectUrls.get(image.src) || [])
          : Buffer.from(image.src.split(',')[1], 'base64')
      image.naturalWidth = png.readUInt32BE(16)
      image.naturalHeight = png.readUInt32BE(20)
      const loaded = image.onload || image.handlers.load
      assert.equal(typeof loaded, 'function', 'the exact image needs a native load callback')
      loaded()
    },
    fireUi: (name) => uiEvents.get(name)?.(),
    restore: () =>
      host === 'figma'
        ? send({ type: 'restore-task', nonce: 'f'.repeat(32), instanceEpoch: '6'.repeat(32) })
        : click('restore-task'),
    rebind: (baselineId = '4'.repeat(32), reopenDocument = false) => {
      if (host === 'figma')
        send({
          type: 'restore-task',
          nonce: 'f'.repeat(32),
          instanceEpoch: '6'.repeat(32),
          rebindBaselineId: baselineId
        })
      else {
        element('rebind-checkpoint').value = baselineId
        element('reopen-document').checked = reopenDocument
        click('rebind-task')
      }
    },
    tick,
    advanceClock: (ms) => {
      time += ms
    },
    output,
    requests,
    nativeDocument: document,
    node,
    second,
    vm,
    posts,
    element,
    cancel: () => (host === 'figma' ? send({ type: 'cancel' }) : click('cancel')),
    nativeWrites,
    fontLoads,
    textWrites,
    loadedFonts,
    persistedActions,
    planResult: () => planResult,
    planResults: () => planResults.map(plain),
    lifecycleRuns: lifecycleObserver?.runs,
    close: () => {
      if (host === 'figma') send({ type: 'dispose' })
      else click('close')
    }
  }
}

test('generated host validator exactly matches the current shared source', async () => {
  const built = await buildHostPlanPreview()
  assert.equal(read('shared/plan-preview.js'), built.text)
  assert.match(built.text, /MIT License/)
})

test('figma: opt-in context image stays local, displays exact bytes and requires fresh image-inclusive consent', async () => {
  const f = fixture('figma', { figmaUi: true, nativeTextEncoding: true })
  try {
    let exports = 0
    const original = f.node.exportAsync
    f.node.exportAsync = async (...args) => {
      exports++
      return original(...args)
    }
    assert.equal(f.element('context-image').src, undefined)
    f.capture()
    await flush()
    assert.equal(exports, 0, 'ordinary native context capture never exports an image')
    assert.equal(f.posts.filter((post) => post.type === 'preview').at(-1).contextImage, undefined)
    f.captureImage()
    await flush()
    assert.equal(exports, 1)
    assert.equal(
      f.requests.length,
      0,
      'opt-in local capture must not contact the desktop or a provider'
    )
    assert.equal(f.nativeWrites.length, 0)
    const preview = f.posts.filter((post) => post.type === 'preview').at(-1)
    const source = 'data:image/png;base64,' + preview.contextImage.bytesBase64
    assert.equal(f.element('context-image').src, source)
    assert.equal(f.element('context-image-view').hidden, false)
    assert.match(
      f.element('context-image-details').textContent,
      /64 x 32 px \/ \d+ bytes \/ SHA-256 [a-f0-9]{64}/
    )
    assert.match(
      f.element('consent-description').textContent,
      /AND the exact displayed selection image/
    )
    f.loadContextImage()
    await f.pair()
    assert.equal(
      f.element('context-image-view').hidden,
      true,
      'session change clears previously captured bytes'
    )
    f.captureImage()
    await flush()
    const sharedPreview = f.posts.filter((post) => post.type === 'preview').at(-1)
    f.element('prompt').value = 'Review this exact local selection image.'
    assert.equal(f.element('consent').disabled, true)
    f.element('consent').checked = true
    f.click('share')
    assert.equal(
      f.requests.filter((request) => request.url.endsWith('/prepare')).length,
      0,
      'wait until the native PNG has actually decoded in the local preview'
    )
    f.loadContextImage()
    assert.equal(f.element('consent').disabled, false)
    assert.equal(
      f.element('consent').checked,
      false,
      'pre-display consent must never enable image sharing'
    )
    assert.equal(f.element('share').disabled, true)
    f.click('share')
    assert.equal(f.requests.filter((request) => request.url.endsWith('/prepare')).length, 0)
    f.element('consent').checked = true
    f.click('share')
    await flush()
    const prepared = f.requests.find((request) => request.url.endsWith('/prepare')).body
    assert.deepEqual(prepared.contextImage, sharedPreview.contextImage)
    assert.equal(prepared.contextImage.captureId, prepared.hostContext.captureId)
    assert.equal(prepared.contextImage.targetId, prepared.hostContext.selectedIds[0])
    assert.equal(prepared.hostContext.contextImage, undefined)
    assert.equal(prepared.prompt.includes(prepared.contextImage.bytesBase64), false)
    assert.equal(prepared.prompt, 'Review this exact local selection image.')
    assert.equal(f.element('context-image').src, undefined)
    assert.equal(f.element('context-image-view').hidden, true)
    assert.equal(f.nativeWrites.length, 0)
    assert.match(f.element('status').textContent, /Awaiting explicit approval in MagicPot desktop/)
  } finally {
    f.close()
  }
})

test('figma: context image rejects zero/multiple selections and failed PNGs without a shareable fallback', async () => {
  for (const mode of ['empty', 'multiple', 'bad-png']) {
    const f = fixture('figma')
    try {
      await f.pair()
      if (mode === 'empty') f.figma.currentPage.selection = []
      if (mode === 'multiple') f.figma.currentPage.selection = [f.node, f.second]
      if (mode === 'bad-png') f.node.exportAsync = async () => Buffer.alloc(33)
      f.captureImage()
      await flush()
      assert.equal(f.posts.filter((post) => post.type === 'preview').at(-1).revision, '')
      assert.equal(
        f.posts.some((post) => post.contextImage),
        false
      )
      f.send({
        type: 'share',
        nonce: '7'.repeat(32),
        revision: '5'.repeat(32),
        prompt: 'Review',
        consent: true
      })
      await flush()
      assert.equal(f.requests.filter((request) => request.url.endsWith('/prepare')).length, 0)
      assert.equal(f.nativeWrites.length, 0)
    } finally {
      f.close()
    }
  }
})

test('figma: stale asynchronous image exports cannot resurrect after recapture, cancel, close, events or native snapshot changes', async () => {
  for (const change of [
    'recapture',
    'selection',
    'selection-away-back',
    'page',
    'root',
    'snapshot',
    'dimensions',
    'cancel',
    'close',
    'session-expiry',
    'node-event',
    'style-event'
  ]) {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const f = fixture('figma', { visualGate: () => gate })
    try {
      await f.pair()
      f.captureImage()
      assert.equal(f.posts.filter((post) => post.type === 'preview').at(-1).revision, '')
      if (change === 'recapture') f.capture()
      if (change === 'selection') f.figma.currentPage.selection = [f.second]
      if (change === 'selection-away-back') {
        f.figma.currentPage.selection = [f.second]
        f.fireNative('selectionchange')
        f.figma.currentPage.selection = [f.node]
      }
      if (change === 'page') f.figma.currentPage = { ...f.figma.currentPage }
      if (change === 'root') f.figma.root = { ...f.figma.root }
      if (change === 'snapshot') f.node.name = 'Native edit while export is pending'
      if (change === 'dimensions') f.node.width = 63
      if (change === 'cancel') f.cancel()
      if (change === 'close') f.close()
      if (change === 'session-expiry') await f.tick(120000)
      if (change === 'node-event') {
        f.node.cornerRadius = 10
        f.firePage('nodechange', {
          nodeChanges: [{ type: 'PROPERTY_CHANGE', properties: ['cornerRadius'], node: f.node }]
        })
      }
      if (change === 'style-event') f.fireNative('stylechange')
      release()
      await flush()
      assert.equal(
        f.posts.some((post) => post.contextImage),
        false,
        change
      )
      assert.equal(
        f.imageObserverCount(),
        0,
        'cancelled/stale captures release image observers: ' + change
      )
      assert.equal(
        f.requests.filter((request) => request.url.endsWith('/prepare')).length,
        0,
        change
      )
      if (change === 'recapture') {
        f.share()
        await flush()
        const prepared = f.requests.find((request) => request.url.endsWith('/prepare')).body
        assert.equal(
          prepared.contextImage,
          undefined,
          'recapture without image keeps no-image flow usable'
        )
      }
    } finally {
      release()
      f.close()
    }
  }
})

test('figma: second image capture supersedes a delayed first export without attaching the old PNG', async () => {
  const f = fixture('figma')
  let release
  try {
    await f.pair()
    let exports = 0
    const oldPng = fakePng('old capture')
    const newPng = fakePng('new capture')
    f.node.exportAsync = async () =>
      ++exports === 1
        ? new Promise((resolve) => {
            release = () => resolve(oldPng)
          })
        : newPng
    f.captureImage('a'.repeat(32))
    f.captureImage('b'.repeat(32))
    await flush()
    release()
    await flush()
    const previews = f.posts.filter((post) => post.contextImage)
    assert.equal(previews.length, 1)
    assert.equal(previews[0].contextImage.captureId, 'b'.repeat(32))
    assert.equal(previews[0].contextImage.bytesBase64, newPng.toString('base64'))
    f.share()
    await flush()
    assert.deepEqual(
      f.requests.find((request) => request.url.endsWith('/prepare')).body.contextImage,
      previews[0].contextImage
    )
  } finally {
    release?.()
    f.close()
  }
})

test('figma: delayed image decode callbacks cannot clear or authorize a newer captured image', async () => {
  const f = fixture('figma', { figmaUi: true })
  try {
    await f.pair()
    f.captureImage()
    await flush()
    const oldLoaded = f.element('context-image').onload
    const oldFailed = f.element('context-image').onerror
    f.captureImage()
    oldLoaded()
    oldFailed()
    await flush()
    const preview = f.posts.filter((post) => post.contextImage).at(-1)
    const expectedSource = 'data:image/png;base64,' + preview.contextImage.bytesBase64
    oldLoaded()
    oldFailed()
    assert.equal(f.element('context-image').src, expectedSource)
    assert.equal(f.element('consent').disabled, true)
    assert.equal(f.element('consent').checked, false)
    f.loadContextImage()
    f.element('prompt').value = 'Review the newest captured image.'
    f.element('consent').checked = true
    oldFailed()
    oldLoaded()
    assert.equal(
      f.element('consent').checked,
      true,
      'old callbacks must not change fresh consent either'
    )
    assert.equal(
      f.uiSends.some((message) => message.type === 'cancel'),
      false
    )
    f.click('share')
    await flush()
    const prepared = f.requests.find((request) => request.url.endsWith('/prepare')).body
    assert.equal(prepared.contextImage.captureId, preview.contextImage.captureId)
    assert.equal(f.imageObserverCount(), 0, 'share releases native capture observers')
  } finally {
    f.close()
  }
})

test('figma: completed images invalidate on native edits before share and are cleared on UI cancel or image decode error', async () => {
  for (const change of [
    'snapshot',
    'selection-event',
    'node-event',
    'style-event',
    'cancel',
    'image-decode-error'
  ]) {
    const f = fixture('figma', { figmaUi: true })
    try {
      await f.pair()
      f.captureImage()
      await flush()
      f.loadContextImage()
      f.element('prompt').value = 'Review this selection.'
      f.element('consent').checked = true
      if (change === 'snapshot') f.node.visible = false
      if (change === 'selection-event') f.fireNative('selectionchange')
      if (change === 'node-event') {
        f.node.effects = [{ type: 'DROP_SHADOW', visible: true }]
        f.firePage('nodechange')
      }
      if (change === 'style-event') f.fireNative('stylechange')
      if (change === 'cancel') f.click('cancel')
      if (change === 'image-decode-error') f.element('context-image').onerror()
      f.click('share')
      await flush()
      assert.equal(
        f.requests.filter((request) => request.url.endsWith('/prepare')).length,
        0,
        change
      )
      assert.equal(f.element('context-image').src, undefined, change)
      assert.equal(f.element('context-image-view').hidden, true, change)
      assert.equal(f.imageObserverCount(), 0, change)
    } finally {
      f.close()
    }
  }
})

test('figma: context image requires dynamic-page-safe change observation but no-image planning stays available', async () => {
  for (const unavailable of ['page-on', 'page-off', 'global-off', 'stylechange']) {
    const f = fixture('figma')
    try {
      await f.pair()
      if (unavailable === 'page-on') f.figma.currentPage.on = undefined
      if (unavailable === 'page-off') f.figma.currentPage.off = undefined
      if (unavailable === 'global-off') f.figma.off = undefined
      if (unavailable === 'stylechange') {
        const on = f.figma.on
        f.figma.on = (name, callback) => {
          if (name === 'stylechange') throw new Error('Style observation unavailable')
          on(name, callback)
        }
      }
      f.node.exportAsync = async () =>
        assert.fail('without invalidation observation no PNG may be captured')
      f.captureImage()
      await flush()
      assert.equal(f.posts.filter((post) => post.type === 'preview').at(-1).revision, '')
      assert.equal(
        f.posts.some((post) => post.contextImage),
        false
      )
      assert.equal(f.imageObserverCount(), 0)
      f.capture()
      f.share()
      await flush()
      assert.equal(
        f.requests.find((request) => request.url.endsWith('/prepare')).body.contextImage,
        undefined
      )
    } finally {
      f.close()
    }
  }
})

test('figma: image prepare exceeding 64 KiB fails explicitly instead of dropping the image or sending', async () => {
  const f = fixture('figma', { figmaUi: true })
  try {
    await f.pair()
    // A valid large ancillary chunk exercises the real request-size boundary without changing pixels.
    const source = fakePng('large bounded image')
    const padding = pngChunk('tEXt', Buffer.from('Padding\0' + 'x'.repeat(23800)))
    const large = Buffer.concat([source.subarray(0, 33), padding, source.subarray(33)])
    assert.ok(large.length < 24576)
    f.node.exportAsync = async () => large
    f.captureImage()
    await flush()
    f.loadContextImage()
    f.element('prompt').value = '中'.repeat(16384)
    f.element('consent').checked = true
    f.click('share')
    await flush()
    assert.equal(f.requests.filter((request) => request.url.endsWith('/prepare')).length, 0)
    assert.match(f.element('status').textContent, /exceed 64 KiB/)
    assert.equal(f.element('context-image').src, undefined)
    assert.equal(f.element('context-image-view').hidden, true)
    assert.equal(f.element('share').disabled, true)
  } finally {
    f.close()
  }
})

// These VM fixtures exercise the UXP-facing contract, not native Photoshop acceptance.
const photoshopImageFixture = (options) => {
  const f = fixture('photoshop', options)
  f.node.boundsNoEffects = { left: 0, top: 0, right: 2, bottom: 1 }
  return f
}
const imageGate = () => {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const holdPhotoshopImageRead = (f, stage) => {
  const gate = imageGate()
  const original = f.photoshop.imaging.getPixels
  let entered = false
  f.photoshop.imaging.getPixels = async (request) => {
    const result = await original(request)
    if (stage === 'getPixels') {
      entered = true
      await gate.promise
    } else {
      const read = result.imageData.getData
      result.imageData.getData = async (options) => {
        entered = true
        await gate.promise
        return read(options)
      }
    }
    return result
  }
  return {
    ...gate,
    entered: () => entered,
    restore: () => {
      f.photoshop.imaging.getPixels = original
    }
  }
}
const holdPhotoshopImageRemoval = (f, stage) => {
  const gate = imageGate()
  const api = stage === 'action' ? f.photoshop.action : f.photoshop.core
  const original = api.removeNotificationListener
  const callbacks = []
  api.removeNotificationListener = async (...args) => {
    if (stage === 'action' || args[0] === stage) {
      callbacks.push(args.at(-1))
      await gate.promise
    }
    return original(...args)
  }
  return { ...gate, callbacks }
}
const photoshopImageCallbacks = (f) => {
  const image = f.element('context-image')
  return {
    load: image.handlers.load || image.onload,
    error: image.handlers.error || image.onerror
  }
}
const imagePrepareRequests = (f) => f.requests.filter((request) => request.url.endsWith('/prepare'))
const assertPhotoshopImageCleared = (f) => {
  assert.ok(!f.element('context-image').src, 'no revoked image may remain in the preview')
  assert.equal(f.element('context-image-view').hidden, true)
  assert.equal(f.element('consent').checked, false)
  assert.equal(f.element('share').disabled, true)
}

test('photoshop: context image is an explicit local single-layer PNG and needs new consent after native load', async () => {
  const f = photoshopImageFixture({ nativeTextEncoding: false })
  try {
    const encoder = Object.getOwnPropertyDescriptor(f.vm, 'MagicPotContextPngV1')
    assert.ok(encoder, 'the production CommonJS bundle exposes the context PNG encoder explicitly')
    assert.equal(encoder.writable, false)
    assert.equal(encoder.configurable, false)
    assert.equal(encoder.enumerable, false)
    assert.equal(Object.isFrozen(encoder.value), true)
    assert.deepEqual(Object.keys(encoder.value), ['encode'])
    assert.equal(typeof encoder.value.encode, 'function')
    f.capture()
    await flush()
    assert.equal(f.pixelRequests.length, 0, 'metadata-only capture must not read pixels')
    f.captureImage()
    await flush()
    assert.equal(f.requests.length, 0, 'local image capture does not contact desktop or a model')
    assert.equal(f.nativeWrites.length, 0)
    assert.equal(f.pixelRequests.length, 1)
    for (const request of f.pixelRequests)
      assert.deepEqual(
        { ...request, targetSize: undefined },
        {
          documentID: 5,
          layerID: 7,
          historyStateID: 17,
          sourceBounds: { left: 0, top: 0, right: 2, bottom: 1 },
          targetSize: undefined,
          colorSpace: 'RGB',
          colorProfile: 'sRGB IEC61966-2.1',
          componentSize: 8,
          applyAlpha: false
        }
      )
    assert.deepEqual(
      f.pixelRequests.map((request) => request.targetSize),
      [{ width: 2, height: 1 }]
    )
    assert.equal(f.pixelReads.length, 1)
    assert.deepEqual(f.pixelReads[0].options, { chunky: true })
    assert.equal(f.pixelDisposals.length, 1)
    assert.equal(f.element('context-image-view').hidden, false)
    const localUrl = f.element('context-image').src
    assert.match(localUrl, /^blob:uxp-fixture\//)
    f.loadContextImage()
    await f.pair()
    assertPhotoshopImageCleared(f)
    assert.ok(f.revokedImageUrls.includes(localUrl), 'pairing invalidates an earlier local capture')

    f.captureImage()
    await flush()
    const source = f.element('context-image').src
    const png = f.contextImageBytes()
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.readUInt32BE(16), 2)
    assert.equal(png.readUInt32BE(20), 1)
    const sha256 = createHash('sha256').update(png).digest('hex')
    assert.ok(f.element('context-image-details').textContent.includes(sha256))
    assert.match(f.element('consent-description').textContent, /image/i)
    f.element('prompt').value = 'Review only this exact captured layer image.'
    assert.equal(f.element('consent').disabled, true)
    f.element('consent').checked = true
    f.click('share')
    await flush()
    assert.equal(imagePrepareRequests(f).length, 0, 'pre-load consent cannot share an image')
    f.loadContextImage()
    assert.equal(f.element('consent').disabled, false)
    assert.equal(f.element('consent').checked, false, 'native load discards pre-display consent')
    f.click('share')
    await flush()
    assert.equal(imagePrepareRequests(f).length, 0)
    f.element('consent').checked = true
    f.click('share')
    await flush()
    const prepared = imagePrepareRequests(f)[0].body
    assert.equal(prepared.featureId, 'plan-preview')
    assert.equal(prepared.contextImage.bytesBase64, png.toString('base64'))
    assert.equal(prepared.contextImage.sha256, sha256)
    assert.equal(prepared.contextImage.sizeBytes, png.length)
    assert.equal(prepared.contextImage.captureId, prepared.hostContext.captureId)
    assert.equal(prepared.contextImage.captureId, prepared.context.selectionRevision)
    assert.equal(prepared.contextImage.targetId, '7')
    assert.deepEqual(prepared.hostContext.selectedIds, ['7'])
    assert.equal(prepared.hostContext.documentId, '5')
    assert.equal(prepared.hostContext.contextImage, undefined)
    assert.equal(
      JSON.stringify(prepared.context).includes(prepared.contextImage.bytesBase64),
      false
    )
    assert.equal(prepared.prompt, 'Review only this exact captured layer image.')
    assert.equal(f.pixelRequests.length, 3, 'sharing re-reads the original native image locally')
    assert.deepEqual(f.pixelRequests[2], f.pixelRequests[1])
    assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
    assert.ok(!f.element('context-image').src)
    assert.equal(f.element('context-image-view').hidden, true)
    assert.ok(f.revokedImageUrls.includes(source))
    assert.equal(f.photoshopObserverCount(), 0, 'sharing releases capture-scoped notifications')
    assert.equal(f.nativeWrites.length, 0)
    assert.equal(
      f.requests.some((request) => request.url.includes('/plan/')),
      false
    )
  } finally {
    f.close()
    await flush()
  }
})

test('photoshop: context image failures never retain an implicit metadata-only share', async () => {
  for (const failure of [
    'empty-selection',
    'multiple-selection',
    'get-pixels-rejected',
    'get-data-rejected',
    'invalid-native-pixels',
    'missing-native-history',
    'fractional-native-bounds',
    'missing-native-preview',
    'native-load-error',
    'native-load-dimensions'
  ]) {
    const f = photoshopImageFixture({ uxpImagePreview: failure !== 'missing-native-preview' })
    try {
      await f.pair()
      f.capture()
      if (failure === 'empty-selection') f.nativeDocument.activeLayers = []
      if (failure === 'multiple-selection') f.nativeDocument.activeLayers = [f.node, f.second]
      if (failure === 'missing-native-history') f.nativeDocument.activeHistoryState = null
      if (failure === 'fractional-native-bounds') f.node.boundsNoEffects.right = 2.5
      if (failure === 'get-pixels-rejected')
        f.photoshop.imaging.getPixels = async () => {
          throw new Error('PRIVATE_NATIVE_FAILURE')
        }
      if (failure === 'invalid-native-pixels') {
        const original = f.photoshop.imaging.getPixels
        f.photoshop.imaging.getPixels = async (request) => {
          const result = await original(request)
          result.imageData.componentSize = 16
          return result
        }
      }
      if (failure === 'get-data-rejected') {
        const original = f.photoshop.imaging.getPixels
        f.photoshop.imaging.getPixels = async (request) => {
          const result = await original(request)
          result.imageData.getData = async () => {
            throw new Error('PRIVATE_NATIVE_FAILURE')
          }
          return result
        }
      }
      f.captureImage()
      await flush()
      if (failure === 'native-load-error') photoshopImageCallbacks(f).error()
      if (failure === 'native-load-dimensions') {
        const image = f.element('context-image')
        image.naturalWidth = 3
        image.naturalHeight = 1
        photoshopImageCallbacks(f).load()
      }
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(f.photoshopObserverCount(), 0, failure)
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length, failure)
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 0, failure)
      assert.equal(f.nativeWrites.length, 0, failure)
      assert.equal(f.element('status').textContent.includes('PRIVATE_NATIVE_FAILURE'), false)

      f.nativeDocument.activeLayers = [f.node]
      f.capture()
      f.share()
      await flush()
      assert.equal(
        imagePrepareRequests(f).length,
        1,
        'a separate explicit metadata recapture works'
      )
      assert.equal(imagePrepareRequests(f)[0].body.contextImage, undefined)
    } finally {
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image late native loads cannot clear or authorize a newer preview', async () => {
  const f = photoshopImageFixture()
  try {
    await f.pair()
    f.captureImage()
    await flush()
    const previous = photoshopImageCallbacks(f)
    const oldElement = f.element('context-image')
    const oldUrl = f.element('context-image').src
    f.captureImage()
    previous.load()
    previous.error()
    await flush()
    const source = f.element('context-image').src
    const bytes = f.contextImageBytes()
    assert.notEqual(f.element('context-image'), oldElement, 'native load events are element-scoped')
    assert.notEqual(source, oldUrl)
    assert.ok(f.revokedImageUrls.includes(oldUrl))
    previous.load()
    previous.error()
    assert.equal(f.element('context-image').src, source)
    assert.equal(f.element('consent').checked, false)
    assert.equal(f.element('consent').disabled, true)
    f.loadContextImage()
    f.element('prompt').value = 'Review the newest explicitly loaded image.'
    f.element('consent').checked = true
    previous.error()
    previous.load()
    assert.equal(f.element('consent').checked, true)
    assert.equal(f.element('context-image').src, source)
    f.click('share')
    await flush()
    assert.equal(imagePrepareRequests(f)[0].body.contextImage.bytesBase64, bytes.toString('base64'))
    assert.equal(f.photoshopObserverCount(), 0)
    assert.equal(
      f.createdImageUrls.every((url) => f.revokedImageUrls.includes(url)),
      true
    )
  } finally {
    f.close()
    await flush()
  }
})

test('photoshop: context image waits for all explicit native notification subscriptions before reading pixels', async () => {
  const f = photoshopImageFixture()
  const actionGate = imageGate()
  const uiGate = imageGate()
  const osGate = imageGate()
  try {
    const addAction = f.photoshop.action.addNotificationListener
    f.photoshop.action.addNotificationListener = async (...args) => {
      await addAction(...args)
      await actionGate.promise
    }
    const addCore = f.photoshop.core.addNotificationListener
    f.photoshop.core.addNotificationListener = async (...args) => {
      await addCore(...args)
      await (args[0] === 'UI' ? uiGate : osGate).promise
    }
    f.captureImage()
    await flush()
    assert.equal(f.pixelRequests.length, 0)
    assert.equal(f.coreNotificationRegistrations.length, 0)
    assert.equal(f.element('consent').disabled, true)
    actionGate.release()
    await flush()
    assert.equal(f.pixelRequests.length, 0)
    assert.deepEqual(f.coreNotificationRegistrations, [
      { group: 'UI', events: ['panelVisibilityChanged'] }
    ])
    uiGate.release()
    await flush()
    assert.equal(f.pixelRequests.length, 0)
    assert.deepEqual(f.coreNotificationRegistrations, [
      { group: 'UI', events: ['panelVisibilityChanged'] },
      { group: 'OS', events: ['activationChanged'] }
    ])
    osGate.release()
    await flush()
    assert.equal(f.pixelRequests.length, 1)
    const events = f.notificationRegistrations.flat()
    assert.equal(events.includes('all'), false, 'the UXP API has no assumed all-events shortcut')
    for (const event of [
      'select',
      'deselect',
      'open',
      'close',
      'make',
      'delete',
      'set',
      'move',
      'transform',
      'paint',
      'draw',
      'stroke',
      'undoEvent',
      'revert',
      'play',
      'modalJavaScriptScopeEnter',
      'modalJavaScriptScopeExit'
    ])
      assert.ok(events.includes(event), event)
    assert.equal(f.photoshopObserverCount(), 3)
    f.cancel()
    await flush()
    assertPhotoshopImageCleared(f)
    assert.equal(f.photoshopObserverCount(), 0)
    assert.equal(f.notificationRemovals.length, 1)
    assert.deepEqual(f.coreNotificationRemovals, f.coreNotificationRegistrations)
  } finally {
    actionGate.release()
    uiGate.release()
    osGate.release()
    f.close()
    await flush()
  }
})

test('photoshop: context image fails closed when native subscriptions are missing, rejected or not awaitable', async () => {
  for (const failure of [
    'missing-action',
    'missing-core',
    'action-rejected',
    'UI-rejected',
    'OS-rejected',
    'not-awaitable'
  ]) {
    const f = photoshopImageFixture()
    try {
      await f.pair()
      f.capture()
      if (failure === 'missing-action') f.photoshop.action = undefined
      if (failure === 'missing-core') f.photoshop.core.addNotificationListener = undefined
      if (failure === 'action-rejected' || failure === 'not-awaitable') {
        const original = f.photoshop.action.addNotificationListener
        f.photoshop.action.addNotificationListener =
          failure === 'not-awaitable'
            ? (...args) => {
                void original(...args)
              }
            : async (...args) => {
                await original(...args)
                throw new Error('PRIVATE_OBSERVER_FAILURE')
              }
      }
      if (failure === 'UI-rejected' || failure === 'OS-rejected') {
        const original = f.photoshop.core.addNotificationListener
        f.photoshop.core.addNotificationListener = async (...args) => {
          await original(...args)
          if (failure === args[0] + '-rejected') throw new Error('PRIVATE_OBSERVER_FAILURE')
        }
      }
      f.captureImage()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(f.pixelRequests.length, 0, failure)
      assert.equal(
        f.photoshopObserverCount(),
        0,
        'partially registered observers are released: ' + failure
      )
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 0, failure)
      assert.equal(f.element('status').textContent.includes('PRIVATE_OBSERVER_FAILURE'), false)
      f.capture()
      f.share()
      await flush()
      assert.equal(
        imagePrepareRequests(f).length,
        1,
        'explicit metadata recapture remains available'
      )
      assert.equal(imagePrepareRequests(f)[0].body.contextImage, undefined)
    } finally {
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image removes late native subscriptions after cancellation, close or metadata recapture', async () => {
  for (const stage of ['action', 'UI', 'OS']) {
    for (const interruption of ['cancel', 'close', 'pagehide', 'unload', 'metadata-recapture']) {
      const f = photoshopImageFixture()
      const gate = imageGate()
      try {
        await f.pair()
        const api = stage === 'action' ? f.photoshop.action : f.photoshop.core
        const original = api.addNotificationListener
        api.addNotificationListener = async (...args) => {
          await original(...args)
          if (stage === 'action' || args[0] === stage) await gate.promise
        }
        f.captureImage()
        await flush()
        assert.equal(f.pixelRequests.length, 0)
        if (interruption === 'cancel') f.cancel()
        else if (interruption === 'close') f.close()
        else if (interruption === 'metadata-recapture') f.capture()
        else f.fireUi(interruption)
        gate.release()
        await flush()
        assertPhotoshopImageCleared(f)
        assert.equal(f.photoshopObserverCount(), 0, stage + '/' + interruption)
        assert.equal(
          f.pixelRequests.length,
          0,
          'a late subscription must not start an old pixel read'
        )
        assert.equal(imagePrepareRequests(f).length, 0)
        if (interruption === 'metadata-recapture') {
          f.share()
          await flush()
          assert.equal(imagePrepareRequests(f).length, 1)
          assert.equal(imagePrepareRequests(f)[0].body.contextImage, undefined)
        }
      } finally {
        gate.release()
        f.close()
        await flush()
      }
    }
  }
})

const photoshopImageInvalidations = [
  [
    'selection changed',
    (f) => {
      f.nativeDocument.activeLayers = [f.second]
    }
  ],
  [
    'selection away and back',
    (f) => {
      f.nativeDocument.activeLayers = [f.second]
      f.firePhotoshopNotification('select')
      f.nativeDocument.activeLayers = [f.node]
    }
  ],
  ['native edit notification', (f) => f.firePhotoshopNotification('paint')],
  [
    'canvas changed',
    (f) => {
      f.nativeDocument.width += 1
    }
  ],
  [
    'layer geometry changed',
    (f) => {
      f.node.boundsNoEffects.right += 1
    }
  ],
  [
    'layer identity changed',
    (f) => {
      const replacement = { ...f.node }
      f.nativeDocument.activeLayers = [replacement]
      f.nativeDocument.layers = [replacement, f.second]
    }
  ],
  [
    'history changed',
    (f) => {
      f.nativeDocument.activeHistoryState = { id: 18 }
    }
  ],
  [
    'history unavailable',
    (f) => {
      f.nativeDocument.activeHistoryState = null
    }
  ],
  ['document closed', (f) => f.setActiveDocument(null)],
  [
    'document reopened with reused id',
    (f) => {
      const replacement = { ...f.nativeDocument }
      const layer = { ...f.node, document: replacement }
      replacement.activeLayers = [layer]
      replacement.layers = [layer]
      f.setActiveDocument(replacement)
    }
  ],
  [
    'document switched away and back',
    (f) => {
      f.setActiveDocument({ ...f.nativeDocument, id: 6 })
      f.firePhotoshopNotification('select')
      f.setActiveDocument(f.nativeDocument)
    }
  ],
  ['panel hidden', (f) => f.firePhotoshopCoreNotification('UI', 'panelVisibilityChanged')],
  ['app deactivated', (f) => f.firePhotoshopCoreNotification('OS', 'activationChanged')],
  ['cancel', (f) => f.cancel()],
  ['session close', (f) => f.close()],
  ['pagehide', (f) => f.fireUi('pagehide')],
  ['unload', (f) => f.fireUi('unload')],
  ['session expiry', (f) => f.tick(120001)]
]

test('photoshop: context image discards late getPixels and getData results after native identity or lifecycle invalidation', async () => {
  for (const stage of ['getPixels', 'getData']) {
    for (const [name, invalidate] of photoshopImageInvalidations) {
      const f = photoshopImageFixture()
      const gate = holdPhotoshopImageRead(f, stage)
      try {
        await f.pair()
        f.captureImage()
        await flush()
        assert.equal(gate.entered(), true, stage + '/' + name)
        assert.equal(f.pixelDisposals.length, 0)
        await invalidate(f)
        gate.release()
        await flush()
        assertPhotoshopImageCleared(f)
        assert.equal(
          f.createdImageUrls.length,
          0,
          'no stale pixels reach a native preview: ' + name
        )
        assert.equal(f.pixelDisposals.length, f.pixelRequests.length, stage + '/' + name)
        assert.equal(f.photoshopObserverCount(), 0, stage + '/' + name)
        f.share()
        await flush()
        assert.equal(imagePrepareRequests(f).length, 0, stage + '/' + name)
        assert.equal(f.nativeWrites.length, 0)
      } finally {
        gate.release()
        f.close()
        await flush()
      }
    }
  }
})

test('photoshop: context image serializes pending native reads even after cancellation until the actual read settles', async () => {
  for (const stage of ['getPixels', 'getData']) {
    const f = photoshopImageFixture()
    const gate = holdPhotoshopImageRead(f, stage)
    try {
      await f.pair()
      f.captureImage()
      await flush()
      assert.equal(gate.entered(), true)
      for (let index = 0; index < 3; index++) f.captureImage()
      f.share()
      await flush()
      assert.equal(
        f.pixelRequests.length,
        1,
        'repeated image actions cannot allocate parallel native resources'
      )
      assert.equal(imagePrepareRequests(f).length, 0)
      f.cancel()
      assertPhotoshopImageCleared(f)
      for (let index = 0; index < 3; index++) f.captureImage()
      await flush()
      assert.equal(
        f.pixelRequests.length,
        1,
        'cancel revokes consent but does not pretend the native read settled'
      )
      assert.equal(f.pixelDisposals.length, 0)
      gate.release()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(f.createdImageUrls.length, 0, 'the cancelled result is cleanup-only')
      assert.equal(f.pixelDisposals.length, 1)
      gate.restore()
      f.captureImage()
      await flush()
      const source = f.element('context-image').src
      const bytes = f.contextImageBytes()
      assert.ok(source)
      f.loadContextImage()
      f.element('prompt').value = 'Review only the newer capture.'
      f.element('consent').checked = true
      assert.equal(f.createdImageUrls.length, 1)
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
      f.click('share')
      await flush()
      assert.equal(
        imagePrepareRequests(f)[0].body.contextImage.bytesBase64,
        bytes.toString('base64')
      )
      assert.equal(f.photoshopObserverCount(), 0)
    } finally {
      gate.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image serializes pending native observer registration across repeated capture and cancel', async () => {
  for (const stage of ['action', 'UI', 'OS']) {
    const f = photoshopImageFixture()
    const gate = imageGate()
    try {
      await f.pair()
      const api = stage === 'action' ? f.photoshop.action : f.photoshop.core
      const original = api.addNotificationListener
      api.addNotificationListener = async (...args) => {
        await original(...args)
        if (stage === 'action' || args[0] === stage) await gate.promise
      }
      f.captureImage()
      await flush()
      const registrations = () =>
        f.notificationRegistrations.length + f.coreNotificationRegistrations.length
      const pendingCount = registrations()
      assert.ok(pendingCount > 0)
      for (let index = 0; index < 3; index++) f.captureImage()
      await flush()
      assert.equal(registrations(), pendingCount)
      f.cancel()
      for (let index = 0; index < 3; index++) f.captureImage()
      await flush()
      assert.equal(
        registrations(),
        pendingCount,
        'cancel cannot bypass the pending native subscription: ' + stage
      )
      assert.equal(f.pixelRequests.length, 0)
      gate.release()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(f.photoshopObserverCount(), 0)
      assert.equal(f.pixelRequests.length, 0)
      f.captureImage()
      await flush()
      assert.equal(
        f.pixelRequests.length,
        1,
        'a new explicit capture is allowed after cleanup settles'
      )
      f.loadContextImage()
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 1)
    } finally {
      gate.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image waits for native observer removal while explicit metadata remains usable', async () => {
  for (const stage of ['action', 'UI', 'OS']) {
    const f = photoshopImageFixture()
    const gate = holdPhotoshopImageRemoval(f, stage)
    try {
      await f.pair()
      f.captureImage()
      await flush()
      const oldImageCallbacks = photoshopImageCallbacks(f)
      const oldSource = f.element('context-image').src
      f.loadContextImage()
      f.cancel()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.ok(f.revokedImageUrls.includes(oldSource))
      assert.equal(gate.callbacks.length, 1, stage)
      assert.equal(f.photoshopObserverCount(), 1, 'one native removal has not completed')
      assert.equal(f.element('image-capture').disabled, true)
      const registrations = () =>
        f.notificationRegistrations.length + f.coreNotificationRegistrations.length
      for (let index = 0; index < 3; index++) {
        f.captureImage()
        f.cancel()
      }
      await flush()
      assert.equal(registrations(), 3, 'pending removal cannot accumulate new registrations')
      assert.equal(f.pixelRequests.length, 1)
      assert.equal(gate.callbacks.length, 1, 'cleanup is requested at most once per subscription')
      f.capture()
      f.element('prompt').value = 'Review this separately requested metadata snapshot.'
      f.element('consent').checked = true
      for (const callback of gate.callbacks) callback('paint', {})
      oldImageCallbacks.load()
      oldImageCallbacks.error()
      assert.equal(
        f.element('consent').checked,
        true,
        'old native callbacks cannot revoke new metadata consent'
      )
      f.click('share')
      await flush()
      assert.equal(imagePrepareRequests(f).length, 1)
      assert.equal(imagePrepareRequests(f)[0].body.contextImage, undefined)
      f.cancel()
      gate.release()
      await flush()
      assert.equal(f.photoshopObserverCount(), 0)
      assertPhotoshopImageCleared(f)
      f.captureImage()
      await flush()
      const source = f.element('context-image').src
      const bytes = f.contextImageBytes()
      assert.notEqual(source, oldSource)
      f.loadContextImage()
      f.element('consent').checked = true
      for (const callback of gate.callbacks) callback('paint', {})
      oldImageCallbacks.load()
      oldImageCallbacks.error()
      assert.equal(f.element('context-image').src, source)
      assert.equal(f.element('consent').checked, true)
      f.click('share')
      await flush()
      assert.equal(imagePrepareRequests(f).length, 2)
      assert.equal(
        imagePrepareRequests(f)[1].body.contextImage.bytesBase64,
        bytes.toString('base64')
      )
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
      assert.equal(f.photoshopObserverCount(), 0)
    } finally {
      gate.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image discards recapture when delivered native events occur before old observers finish detaching', async () => {
  for (const stage of ['action', 'UI', 'OS']) {
    const f = photoshopImageFixture()
    const gate = holdPhotoshopImageRemoval(f, stage)
    try {
      await f.pair()
      f.captureImage()
      await flush()
      const oldSource = f.element('context-image').src
      f.loadContextImage()
      f.captureImage()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(gate.callbacks.length, 1)
      assert.equal(f.photoshopObserverCount(), 1)
      assert.equal(
        f.pixelRequests.length,
        1,
        'recapture waits before registering or reading new pixels'
      )
      assert.ok(f.revokedImageUrls.includes(oldSource))
      const notify = () => {
        if (stage === 'action') f.firePhotoshopNotification('select')
        else
          f.firePhotoshopCoreNotification(
            stage,
            stage === 'UI' ? 'panelVisibilityChanged' : 'activationChanged'
          )
      }
      f.nativeDocument.activeLayers = [f.second]
      notify()
      f.nativeDocument.activeLayers = [f.node]
      notify()
      f.captureImage()
      await flush()
      assert.equal(f.pixelRequests.length, 1)
      assert.equal(f.notificationRegistrations.length + f.coreNotificationRegistrations.length, 3)
      gate.release()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(
        f.pixelRequests.length,
        1,
        'restoring identical context cannot revive the event-invalidated recapture: ' + stage
      )
      assert.equal(f.createdImageUrls.length, 1)
      assert.equal(f.photoshopObserverCount(), 0)
      assert.equal(imagePrepareRequests(f).length, 0)

      f.capture()
      f.element('prompt').value = 'Review this explicitly recaptured context.'
      f.element('consent').checked = true
      for (const callback of gate.callbacks) callback('select', {})
      assert.equal(
        f.element('consent').checked,
        true,
        'detached callbacks do not alter metadata consent'
      )
      f.captureImage()
      await flush()
      const source = f.element('context-image').src
      const bytes = f.contextImageBytes()
      assert.notEqual(source, oldSource)
      f.loadContextImage()
      f.element('consent').checked = true
      for (const callback of gate.callbacks) callback('select', {})
      assert.equal(
        f.element('context-image').src,
        source,
        'fully detached callbacks cannot affect a new preview'
      )
      assert.equal(f.element('consent').checked, true)
      f.click('share')
      await flush()
      assert.equal(imagePrepareRequests(f).length, 1)
      assert.equal(
        imagePrepareRequests(f)[0].body.contextImage.bytesBase64,
        bytes.toString('base64')
      )
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
      assert.equal(f.photoshopObserverCount(), 0)
    } finally {
      gate.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image keeps late registration cleanup gated until native removal actually settles', async () => {
  for (const stage of ['action', 'UI', 'OS']) {
    const f = photoshopImageFixture()
    const registrationGate = imageGate()
    const removalGate = holdPhotoshopImageRemoval(f, stage)
    try {
      await f.pair()
      const api = stage === 'action' ? f.photoshop.action : f.photoshop.core
      const original = api.addNotificationListener
      api.addNotificationListener = async (...args) => {
        await original(...args)
        if (stage === 'action' || args[0] === stage) await registrationGate.promise
      }
      f.captureImage()
      await flush()
      const registrations = () =>
        f.notificationRegistrations.length + f.coreNotificationRegistrations.length
      const pendingCount = registrations()
      f.cancel()
      registrationGate.release()
      await flush()
      assert.equal(removalGate.callbacks.length, 1)
      assert.equal(f.photoshopObserverCount(), 1)
      for (let index = 0; index < 3; index++) f.captureImage()
      await flush()
      assert.equal(
        registrations(),
        pendingCount,
        'settled add is not sufficient while its cleanup is pending'
      )
      assert.equal(f.pixelRequests.length, 0)
      removalGate.release()
      await flush()
      assert.equal(f.photoshopObserverCount(), 0)
      assertPhotoshopImageCleared(f)
      f.captureImage()
      await flush()
      assert.equal(f.pixelRequests.length, 1)
      f.loadContextImage()
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 1)
    } finally {
      registrationGate.release()
      removalGate.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image permanently disables native capture on rejected or non-awaitable observer removal', async () => {
  for (const stage of ['action', 'UI', 'OS']) {
    for (const failure of ['rejected', 'thrown', 'not-awaitable']) {
      const f = photoshopImageFixture()
      const gate = imageGate()
      const callbacks = []
      try {
        await f.pair()
        const api = stage === 'action' ? f.photoshop.action : f.photoshop.core
        const original = api.removeNotificationListener
        api.removeNotificationListener = (...args) => {
          if (stage !== 'action' && args[0] !== stage) return original(...args)
          callbacks.push(args.at(-1))
          if (failure === 'thrown') throw new Error('PRIVATE_DETACH_FAILURE')
          if (failure === 'not-awaitable') return undefined
          return gate.promise.then(() => {
            throw new Error('PRIVATE_DETACH_FAILURE')
          })
        }
        f.captureImage()
        await flush()
        f.loadContextImage()
        f.cancel()
        gate.release()
        await flush()
        assertPhotoshopImageCleared(f)
        assert.equal(callbacks.length, 1)
        assert.equal(f.element('image-capture').disabled, true, stage + '/' + failure)
        assert.equal(f.element('status').textContent.includes('PRIVATE_DETACH_FAILURE'), false)
        const registrationCount =
          f.notificationRegistrations.length + f.coreNotificationRegistrations.length
        for (let index = 0; index < 3; index++) f.captureImage()
        await flush()
        assert.equal(f.pixelRequests.length, 1)
        assert.equal(
          f.notificationRegistrations.length + f.coreNotificationRegistrations.length,
          registrationCount
        )
        assert.equal(imagePrepareRequests(f).length, 0)
        f.capture()
        f.element('prompt').value = 'Review only new metadata after image observation failed.'
        f.element('consent').checked = true
        for (const callback of callbacks) callback('paint', {})
        assert.equal(f.element('consent').checked, true)
        f.click('share')
        await flush()
        assert.equal(
          imagePrepareRequests(f).length,
          1,
          'failed native removal does not disable explicit metadata planning'
        )
        assert.equal(imagePrepareRequests(f)[0].body.contextImage, undefined)
        assert.equal(f.nativeWrites.length, 0)
      } finally {
        gate.release()
        f.close()
        await flush()
      }
    }
  }
})

test('photoshop: context image share verification holds the same native resource gate through cancellation', async () => {
  for (const stage of ['getPixels', 'getData']) {
    const f = photoshopImageFixture()
    let gate
    try {
      await f.pair()
      f.captureImage()
      await flush()
      f.loadContextImage()
      gate = holdPhotoshopImageRead(f, stage)
      f.share()
      await flush()
      assert.equal(gate.entered(), true)
      for (let index = 0; index < 3; index++) {
        f.captureImage()
        f.click('share')
      }
      await flush()
      assert.equal(f.pixelRequests.length, 2, 'capture and share cannot overlap native reads')
      assert.equal(imagePrepareRequests(f).length, 0)
      f.cancel()
      assertPhotoshopImageCleared(f)
      for (let index = 0; index < 3; index++) f.captureImage()
      await flush()
      assert.equal(
        f.pixelRequests.length,
        2,
        'the cancelled verification remains in flight natively'
      )
      gate.release()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(imagePrepareRequests(f).length, 0)
      assert.equal(f.pixelDisposals.length, 2)
      gate.restore()
      f.captureImage()
      await flush()
      f.loadContextImage()
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 1)
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
    } finally {
      gate?.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image late capture or share verification cannot replace a separately requested metadata-only plan', async () => {
  for (const stage of ['capture', 'share-verification']) {
    const f = photoshopImageFixture()
    let gate
    try {
      await f.pair()
      if (stage === 'share-verification') {
        f.captureImage()
        await flush()
        f.loadContextImage()
      }
      gate = holdPhotoshopImageRead(f, 'getData')
      if (stage === 'capture') f.captureImage()
      else f.share()
      await flush()
      assert.equal(gate.entered(), true)
      f.capture()
      assertPhotoshopImageCleared(f)
      f.share()
      await flush()
      assert.equal(
        imagePrepareRequests(f).length,
        1,
        'explicit metadata share does not wait for stale native pixels'
      )
      const prepared = imagePrepareRequests(f)[0].body
      assert.equal(prepared.featureId, 'plan-preview')
      assert.equal(prepared.contextImage, undefined)
      const revision = prepared.hostContext.captureId
      gate.release()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 1)
      assert.equal(imagePrepareRequests(f)[0].body.hostContext.captureId, revision)
      assert.equal(f.element('context-image').src, undefined)
      assert.equal(f.photoshopObserverCount(), 0)
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
    } finally {
      gate?.release()
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image invalidates loaded previews on concrete native action and lifecycle notifications', async () => {
  const actionEvents = [
    'select',
    'deselect',
    'open',
    'close',
    'make',
    'delete',
    'set',
    'move',
    'transform',
    'paint',
    'draw',
    'stroke',
    'undoEvent',
    'revert',
    'play',
    'modalJavaScriptScopeEnter',
    'modalJavaScriptScopeExit'
  ]
  for (const event of [...actionEvents, 'panelVisibilityChanged', 'activationChanged']) {
    const f = photoshopImageFixture()
    try {
      await f.pair()
      f.captureImage()
      await flush()
      const source = f.element('context-image').src
      const callbacks = photoshopImageCallbacks(f)
      f.loadContextImage()
      f.element('consent').checked = true
      if (event === 'panelVisibilityChanged') f.firePhotoshopCoreNotification('UI', event)
      else if (event === 'activationChanged') f.firePhotoshopCoreNotification('OS', event)
      else f.firePhotoshopNotification(event)
      callbacks.load()
      callbacks.error()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.ok(f.revokedImageUrls.includes(source), event)
      assert.equal(f.photoshopObserverCount(), 0, event)
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 0, event)
    } finally {
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image requires native decode capabilities and fails closed after its load deadline', async () => {
  for (const failure of [
    'missing-natural-width',
    'missing-natural-height',
    'missing-load-listener',
    'timeout'
  ]) {
    const f = photoshopImageFixture()
    try {
      await f.pair()
      if (failure === 'missing-natural-width') delete f.element('context-image').naturalWidth
      if (failure === 'missing-natural-height') delete f.element('context-image').naturalHeight
      if (failure === 'missing-load-listener')
        f.element('context-image').addEventListener = undefined
      f.captureImage()
      await flush()
      if (failure === 'timeout') {
        const source = f.element('context-image').src
        const callbacks = photoshopImageCallbacks(f)
        assert.ok(source)
        await f.tick(14999)
        assert.equal(f.element('context-image').src, source)
        await f.tick(1)
        callbacks.load()
        callbacks.error()
        assert.ok(f.revokedImageUrls.includes(source))
      }
      assertPhotoshopImageCleared(f)
      assert.equal(f.photoshopObserverCount(), 0, failure)
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 0, failure)
    } finally {
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image share rechecks native pixels even when edits emit no notification or metadata change', async () => {
  for (const failure of ['changed-pixels', 'native-read-rejected', 'changed-source-bounds']) {
    const f = photoshopImageFixture()
    try {
      await f.pair()
      f.captureImage()
      await flush()
      f.loadContextImage()
      const source = f.element('context-image').src
      const original = f.photoshop.imaging.getPixels
      f.photoshop.imaging.getPixels = async (request) => {
        if (failure === 'native-read-rejected') throw new Error('PRIVATE_RECHECK_FAILURE')
        const result = await original(request)
        if (failure === 'changed-source-bounds') result.sourceBounds.right += 1
        if (failure === 'changed-pixels') {
          const read = result.imageData.getData
          result.imageData.getData = async (options) => {
            const bytes = new Uint8Array(await read(options))
            bytes[0] ^= 0xff
            return bytes
          }
        }
        return result
      }
      f.share()
      await flush()
      assertPhotoshopImageCleared(f)
      assert.equal(imagePrepareRequests(f).length, 0, failure)
      assert.ok(f.revokedImageUrls.includes(source))
      assert.equal(f.photoshopObserverCount(), 0)
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length)
      assert.equal(f.nativeWrites.length, 0)
      assert.equal(f.element('status').textContent.includes('PRIVATE_RECHECK_FAILURE'), false)
      f.share()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 0, 'failed recheck cannot fall back to metadata')
    } finally {
      f.close()
      await flush()
    }
  }
})

test('photoshop: context image share recheck cannot outlive document, prompt, consent or session identity', async () => {
  const interruptions = [
    ...photoshopImageInvalidations,
    [
      'prompt edited and restored',
      (f) => {
        const prompt = f.element('prompt')
        const previous = prompt.value
        prompt.value = 'Another prompt'
        prompt.handlers.input()
        prompt.value = previous
        prompt.handlers.input()
        f.element('consent').checked = true
        f.element('consent').handlers.change()
      }
    ],
    [
      'consent unchecked and checked again',
      (f) => {
        f.element('consent').checked = false
        f.element('consent').handlers.change()
        f.element('consent').checked = true
        f.element('consent').handlers.change()
      }
    ]
  ]
  for (const [name, invalidate] of interruptions) {
    const f = photoshopImageFixture()
    let gate
    try {
      await f.pair()
      f.captureImage()
      await flush()
      f.loadContextImage()
      gate = holdPhotoshopImageRead(f, 'getData')
      f.share()
      await flush()
      assert.equal(gate.entered(), true, name)
      assert.equal(imagePrepareRequests(f).length, 0)
      assert.equal(f.element('share').disabled, true)
      f.click('share')
      assert.equal(f.pixelRequests.length, 2, 'duplicate share must not start another verification')
      await invalidate(f)
      gate.release()
      await flush()
      assert.equal(imagePrepareRequests(f).length, 0, name)
      assert.equal(f.pixelDisposals.length, f.pixelRequests.length, name)
      assert.equal(f.nativeWrites.length, 0)
    } finally {
      gate?.release()
      f.close()
      await flush()
      assert.equal(f.photoshopObserverCount(), 0)
    }
  }
})

test('photoshop: context image does not strip the image when the complete prepare body exceeds the transport budget', async () => {
  const f = photoshopImageFixture()
  try {
    await f.pair()
    f.captureImage()
    await flush()
    f.loadContextImage()
    f.element('prompt').value = '\u0001'.repeat(12000)
    f.element('consent').checked = true
    f.click('share')
    await flush()
    assert.equal(imagePrepareRequests(f).length, 0)
    assert.equal(f.nativeWrites.length, 0)
    assertPhotoshopImageCleared(f)
    assert.equal(f.photoshopObserverCount(), 0)
    f.share()
    await flush()
    assert.equal(
      imagePrepareRequests(f).length,
      0,
      'an oversized image request must not become metadata-only'
    )
  } finally {
    f.close()
    await flush()
  }
})

const assertNativeLifecycleReleased = (f) => {
  assert.equal(f.lifecycleRuns.length, 1, 'the native bridge creates the real shared lifecycle')
  const run = f.lifecycleRuns[0]
  assert.equal(run.options.retainExecution, false)
  assert.equal(typeof run.options.releaseResources, 'function')
  assert.equal(run.releaseCalls, 1)
  assert.equal(run.publishedBeforeRelease, undefined)
  assert.equal(run.result.stage, 'terminal')
  assert.equal(
    Object.hasOwn(run.result, 'execution'),
    false,
    'opaque execution is not retained in terminal results'
  )
  assert.equal(run.lifecycle.getResult(run.runId), run.result)
  assert.deepEqual(plain(run.result.resourceCleanup), { status: 'completed', failureCount: 0 })
  assert.deepEqual(run.events.slice(-3), ['release', 'released', 'terminal'])
  assert.equal(
    run.ownershipRegistrations.length,
    1,
    'one per-run registry owns partial and complete preparation'
  )
  for (const { registry, containers } of run.ownershipRegistrations) {
    assert.equal(registry.has(run.runId), false, 'release removes the native run ownership entry')
    assert.equal(containers.size, 0)
  }
  assert.ok(run.ownedBeforeRelease.length >= 4)
  assert.ok(run.ownedBeforeRelease.some(({ size }) => size > 0))
  for (const { collection } of run.ownedBeforeRelease)
    assert.equal(Array.isArray(collection) ? collection.length : collection.size, 0)
  assert.deepEqual(
    plain(run.prepareArgs.context),
    run.contextBeforeRelease,
    'resource release preserves captured metadata'
  )
  const diagnostics = plain(run.lifecycle.diagnostics())
  assert.equal(diagnostics.activeCount, 0)
  assert.equal(diagnostics.runs[0].status, run.result.status)
  assert.deepEqual(diagnostics.runs[0].resourceCleanup, { status: 'completed', failureCount: 0 })
  const point = run.ownedBeforeRelease.flatMap(({ points = [] }) => points)[0]
  assert.ok(point, 'native visual preparation produced a real retained pixel checkpoint')
  const cached = f.vm.MagicPotPixelAuditV1.compare([
    { targetId: String(f.node.id), baseline: point, current: point }
  ])
  assert.equal(
    cached[0].status,
    'compared',
    'release does not clear the separate shared pixel cache'
  )
  assert.equal(cached[0].changedPixels, 0)
  return run
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: native lifecycle ownership releases successful execution without retaining opaque resources`, async () => {
    const f = fixture(host, { approvePlan: true, observeLifecycle: true })
    try {
      await runApproved(f)
      const run = assertNativeLifecycleReleased(f)
      assert.deepEqual(run.events, [
        'prepare',
        'execute',
        'readback',
        'release',
        'released',
        'terminal'
      ])
      assert.equal(run.result.status, 'completed')
      assert.equal(run.releaseArgs.status, 'completed')
      assert.equal(run.releaseArgs.resources, run.resources)
      assert.equal(run.releaseArgs.execution, run.execution)
      assert.notEqual(
        run.resources.applied,
        run.execution.applied,
        'native execution owns a distinct applied array'
      )
      assert.deepEqual(Object.keys(run.resources).sort(), [
        'applied',
        'beforeVisual',
        'checked',
        'visualEntries'
      ])
      assert.deepEqual(Object.keys(run.execution).sort(), [
        'applied',
        'beforeVisual',
        'checked',
        'visualEntries'
      ])
      for (const resource of [run.resources, run.execution]) {
        assert.equal(resource.checked.length, 0)
        assert.equal(resource.visualEntries.length, 0)
        assert.equal(resource.beforeVisual.size, 0)
        assert.equal(resource.applied.length, 0)
      }
      assert.deepEqual(f.nativeWrites, ['Approved new name'])
      assert.equal(f.node.name, 'Approved new name')
      assert.equal(f.second.name, 'Second original name')
      const receipt = f.planResult()
      assert.equal(receipt.status, 'completed')
      assert.equal(receipt.effect, 'applied')
      assert.deepEqual(receipt.readback, run.readback)
      assert.deepEqual(plain(run.result.readback), run.readback)
      assert.equal(receipt.readback.steps[0].observation, 'requested')
      assert.equal(
        receipt.visualEvidence.length,
        1,
        'the independent native meta summary survives resource cleanup'
      )
      assert.equal(receipt.visualEvidence[0].changed, true)
      const pixelReport = f.vm.MagicPotPixelAuditV1.compare([
        {
          targetId: receipt.visualEvidence[0].targetId,
          baseline: receipt.visualEvidence[0].before,
          current: receipt.visualEvidence[0].after
        }
      ])
      assert.equal(pixelReport[0].status, 'compared')
      assert.ok(pixelReport[0].changedPixels > 0)
    } finally {
      f.close()
      await flush()
    }
  })

  test(`${host}: native lifecycle ownership releases an execute failure after native rollback and preserves its receipt`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      twoSteps: true,
      failSecond: true,
      observeLifecycle: true
    })
    try {
      await runApproved(f)
      const run = assertNativeLifecycleReleased(f)
      assert.deepEqual(run.events, ['prepare', 'execute', 'release', 'released', 'terminal'])
      assert.equal(run.result.status, 'failed')
      assert.equal(run.result.error.code, 'EXECUTE_FAILED')
      assert.equal(run.releaseArgs.status, 'failed')
      assert.equal(run.releaseArgs.resources, run.resources)
      assert.equal(run.releaseArgs.execution, undefined)
      assert.equal(run.resources.checked.length, 0)
      assert.equal(run.resources.visualEntries.length, 0)
      assert.equal(run.resources.beforeVisual.size, 0)
      assert.equal(run.resources.applied.length, 0)
      assert.deepEqual(f.nativeWrites, ['Approved new name', 'Original owned name'])
      assert.equal(f.node.name, 'Original owned name')
      assert.equal(f.second.name, 'Second original name')
      const receipt = f.planResult()
      assert.equal(receipt.status, 'failed')
      assert.equal(receipt.effect, 'rolled-back', 'the native meta failure marker is not cleared')
      assert.equal(receipt.errorCode, 'ROLLED_BACK')
      assert.deepEqual(
        receipt.readback.steps.map((step) => step.observation),
        ['original', 'original']
      )
      assert.equal(Object.hasOwn(receipt, 'visualEvidence'), false)
      assert.deepEqual(
        f.requests
          .filter((request) => request.url.endsWith('/plan/progress'))
          .map((request) => request.body.sequence),
        [2, 3]
      )
    } finally {
      f.close()
      await flush()
    }
  })

  test(`${host}: native lifecycle ownership releases partial preparation even when no resource object is returned`, async () => {
    const f = fixture(host, { approvePlan: true, journalAvailable: false, observeLifecycle: true })
    try {
      await runApproved(f)
      const run = assertNativeLifecycleReleased(f)
      assert.deepEqual(run.events, ['prepare', 'release', 'released', 'terminal'])
      assert.equal(run.result.status, 'failed')
      assert.equal(run.releaseArgs.status, 'failed')
      assert.equal(run.resources, undefined)
      assert.equal(run.releaseArgs.resources, undefined)
      assert.equal(run.releaseArgs.execution, undefined)
      assert.equal(run.executeArgs, undefined)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.node.name, 'Original owned name')
      const receipt = f.planResult()
      assert.equal(receipt.status, 'failed')
      assert.equal(
        receipt.effect,
        'unknown',
        'the native journalBlocked meta survives partial preparation cleanup'
      )
      assert.equal(receipt.errorCode, 'QUARANTINED')
      assert.deepEqual(
        receipt.readback.steps.map((step) => step.observation),
        ['original']
      )
      assert.equal(f.persistedActions.size, 0)
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: capture, explicit share and double-validated preview have zero native writes`, async () => {
    const f = fixture(host)
    try {
      f.capture()
      await flush()
      assert.equal(f.requests.length, 0, 'capture must not send any content')
      await f.pair()
      f.share()
      await flush()
      const prepared = f.requests.find((request) => request.url.endsWith('/prepare')).body
      assert.equal(prepared.featureId, 'plan-preview')
      assert.equal(prepared.hostContext.nodes[0].name, 'Original owned name')
      assert.equal(prepared.hostContext.host, host)
      assert.equal(prepared.hostContext.execution.visualAudit, 'hash-only')
      assert.equal(Object.hasOwn(prepared.hostContext.nodes[0], 'opacity'), false)
      await f.tick(1000)
      assert.match(f.output(), /PLAN READY/)
      assert.match(f.output(), /Proposed new name/)
      assert.equal(f.node.name, 'Original owned name')
      assert.equal(f.requests.filter((request) => request.url.endsWith('/prepare')).length, 1)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a substituted executable response is not displayed as an accepted plan`, async () => {
    const f = fixture(host, { corruptResult: true })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      assert.doesNotMatch(f.output() || '', /Proposed new name|PLAN PREVIEW ONLY/)
      assert.equal(f.node.name, 'Original owned name')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a separately approved plan claims once, writes natively and reports readback`, async () => {
    const f = fixture(host, { approvePlan: true })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      assert.equal(f.node.name, 'Original owned name')
      await f.tick(1000)
      assert.equal(f.node.name, 'Approved new name')
      const result = f.planResult()
      assert.equal(result.effect, 'applied')
      assert.equal(result.status, 'completed')
      assert.equal(result.readback.steps[0].observation, 'requested')
      assert.equal(result.visualEvidence.length, 1)
      assert.equal(result.visualEvidence[0].targetId, result.readback.steps[0].targetId)
      assert.match(result.visualEvidence[0].before.sha256, /^[a-f0-9]{64}$/)
      assert.match(result.visualEvidence[0].after.sha256, /^[a-f0-9]{64}$/)
      assert.notEqual(result.visualEvidence[0].before.sha256, result.visualEvidence[0].after.sha256)
      assert.equal(result.visualEvidence[0].changed, true)
      const routes = f.requests.map((request) => new URL(request.url).pathname)
      assert.ok(routes.includes('/figplugin/v1/plan/status'))
      assert.ok(routes.includes('/figplugin/v1/plan/claim'))
      assert.ok(routes.includes('/figplugin/v1/plan/progress'))
      assert.ok(routes.includes('/figplugin/v1/plan/result'))
      assert.equal(routes.filter((route) => route === '/figplugin/v1/plan/claim').length, 1)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a changed checkpoint requires a separately authorized and approved correction`, async () => {
    const f = fixture(host, { approvePlan: true, correctionFlow: true })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      assert.equal(f.node.name, 'Original owned name')
      await f.tick(1000)
      assert.equal(f.node.name, 'Approved new name')
      assert.equal(f.planResults().length, 1)

      await f.tick(1000)
      assert.equal(f.node.name, 'Original owned name')
      const results = f.planResults()
      assert.equal(results.length, 2)
      assert.equal(results[0].executionId, '8'.repeat(32))
      assert.equal(results[1].executionId, 'a'.repeat(32))
      assert.equal(results[1].status, 'completed')
      assert.equal(results[1].effect, 'applied')
      assert.equal(results[1].readback.captureId, '5'.repeat(32))
      assert.equal(results[1].readback.steps[0].observation, 'requested')
      assert.equal(results[1].visualEvidence.length, 1)
      assert.equal(results[1].visualEvidence[0].targetId, results[1].readback.steps[0].targetId)
      assert.equal(results[1].visualEvidence[0].changed, true)

      const correctionPrepares = f.requests.filter((request) =>
        request.url.endsWith('/plan/correction/prepare')
      )
      assert.equal(correctionPrepares.length, 2)
      assert.deepEqual(correctionPrepares[0].body, {
        protocol: 1,
        sourceExecutionId: '8'.repeat(32)
      })
      assert.equal(correctionPrepares[1].body.hostContext.captureId, '5'.repeat(32))
      assert.deepEqual(correctionPrepares[1].body.hostContext.selectedIds, [
        results[1].readback.steps[0].targetId
      ])
      const correctionClaim = f.requests.find(
        (request) =>
          request.url.endsWith('/plan/claim') && request.body.executionId === 'a'.repeat(32)
      )
      assert.ok(correctionClaim)
      assert.deepEqual(correctionClaim.body, {
        protocol: 1,
        callId: 'd'.repeat(32),
        executionId: 'a'.repeat(32)
      })
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a correction authorization cannot expand beyond the compared changed targets`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      correctionFlow: true,
      tamperCorrectionAuthorization: true
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      await f.tick(1000)
      assert.equal(f.node.name, 'Approved new name')
      await f.tick(1000)
      assert.equal(f.node.name, 'Approved new name')
      assert.equal(f.planResults().length, 1)
      assert.equal(
        f.requests.filter((request) => request.url.endsWith('/plan/correction/prepare')).length,
        1
      )
      assert.equal(
        f.requests.filter(
          (request) =>
            request.url.endsWith('/plan/claim') && request.body.executionId === 'a'.repeat(32)
        ).length,
        0
      )
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a mid-plan native failure rolls back earlier writes and reports originals`, async () => {
    const f = fixture(host, { approvePlan: true, twoSteps: true, failSecond: true })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      await f.tick(1000)
      assert.equal(f.node.name, 'Original owned name')
      const result = f.planResult()
      assert.equal(result.status, 'failed')
      assert.equal(result.effect, 'rolled-back')
      assert.equal(Object.hasOwn(result, 'visualEvidence'), false)
      // A failed plan may have fewer executing receipts than declared steps;
      // the terminal readback must append to the actual cursor, not skip over
      // the unexecuted step numbers.
      assert.deepEqual(
        f.requests
          .filter((request) => request.url.endsWith('/plan/progress'))
          .map((request) => request.body.sequence),
        [2, 3]
      )
      assert.deepEqual(
        result.readback.steps.map((step) => step.observation),
        ['original', 'original']
      )
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: locked selections do not advertise name planning`, async () => {
    const f = fixture(host, { locked: true })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      const prepared = f.requests.find((request) => request.url.endsWith('/prepare')).body
      assert.deepEqual(prepared.hostContext.nodes[0].commands, [])
      await f.tick(1000)
      assert.doesNotMatch(f.output() || '', /Proposed new name|PLAN PREVIEW ONLY/)
      assert.equal(f.node.name, 'Original owned name')
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  for (const action of ['cancel', 'close']) {
    test(`${host}: ${action} during visual capture cannot perform a late write`, async () => {
      let release
      let entered = false
      const gate = new Promise((resolve) => {
        release = resolve
      })
      const f = fixture(host, {
        approvePlan: true,
        visualGate: async () => {
          entered = true
          await gate
        }
      })
      try {
        await f.pair()
        f.capture()
        f.share()
        await flush()
        await f.tick(1000)
        await f.tick(1000)
        assert.equal(entered, true)
        assert.equal(f.node.name, 'Original owned name')
        f[action]()
        await flush()
        release()
        await flush()
        assert.equal(f.node.name, 'Original owned name')
        assert.ok(!f.planResults().some((result) => result.status === 'completed'))
      } finally {
        release()
        f.close()
        await flush()
      }
    })
  }
}
test('photoshop: cancellation while waiting for modal never starts a native write', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture('photoshop', { approvePlan: true, modalGate: () => gate })
  try {
    await f.pair()
    f.capture()
    f.share()
    await flush()
    await f.tick(1000)
    await f.tick(1000)
    f.cancel()
    await flush()
    release()
    await flush()
    assert.equal(f.node.name, 'Original owned name')
    assert.ok(!f.planResults().some((result) => result.status === 'completed'))
  } finally {
    release()
    f.close()
    await flush()
  }
})

for (const host of ['figma', 'photoshop']) {
  test(`${host}: same targets with a substituted accepted checkpoint never start correction`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      correctionFlow: true,
      tamperComparisonIdentity: true
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      await f.tick(1000)
      await f.tick(1000)
      assert.equal(f.node.name, 'Approved new name')
      assert.equal(f.planResults().length, 1)
      assert.equal(f.requests.filter((request) => request.url.endsWith('/plan/claim')).length, 1)
    } finally {
      f.close()
      await flush()
    }
  })
}

// Inject user/host changes across actual async boundaries in the production scripts.
for (const host of ['figma', 'photoshop']) {
  for (const mutation of ['rename', 'lock']) {
    test(`${host}: rechecks the next target after awaiting progress (${mutation})`, async () => {
      const f = fixture(host, {
        approvePlan: true,
        twoSteps: true,
        progressHook: (progress, { second }) => {
          if (progress.phase !== 'executing' || progress.completed !== 1) return
          if (mutation === 'rename') second.name = 'Concurrent user change'
          else second[host === 'figma' ? 'locked' : 'allLocked'] = true
        }
      })
      try {
        await f.pair()
        f.capture()
        f.share()
        await flush()
        await f.tick(2000)
        assert.equal(f.node.name, 'Original owned name', 'our prior write must be rolled back')
        assert.equal(
          f.second.name,
          mutation === 'rename' ? 'Concurrent user change' : 'Second original name'
        )
        assert.equal(f.planResult().status, 'failed')
        assert.equal(Object.hasOwn(f.planResult(), 'visualEvidence'), false)
      } finally {
        f.close()
        await flush()
      }
    })
  }
  test(`${host}: rollback never overwrites a newer user change`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      twoSteps: true,
      failSecond: true,
      progressHook: (progress, { node }) => {
        if (progress.phase === 'executing' && progress.completed === 1)
          node.name = 'Concurrent user change'
      }
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(2000)
      assert.equal(f.node.name, 'Concurrent user change')
      assert.equal(f.planResult().status, 'failed')
      assert.equal(f.planResult().effect, 'unknown')
      assert.equal(f.planResult().errorCode, 'QUARANTINED')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: post-write visual capture cannot publish stale successful readback`, async () => {
    let captures = 0
    const f = fixture(host, {
      approvePlan: true,
      visualGate: ({ node }) => {
        if (++captures === 2) node.name = 'Concurrent user change'
      }
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(2000)
      assert.equal(f.node.name, 'Concurrent user change')
      assert.equal(f.planResult().status, 'failed')
      assert.equal(f.planResult().effect, 'unknown')
      assert.equal(f.planResult().errorCode, 'QUARANTINED')
      assert.equal(Object.hasOwn(f.planResult(), 'visualEvidence'), false)
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: result rechecks readback after awaiting the final progress receipt`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      progressHook: (progress, { node }) => {
        if (progress.phase === 'readback') node.name = 'Concurrent user change'
      }
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(2000)
      assert.equal(f.node.name, 'Concurrent user change')
      assert.equal(f.planResult().status, 'failed')
      assert.equal(f.planResult().effect, 'unknown')
      assert.equal(f.planResult().errorCode, 'QUARANTINED')
      assert.equal(f.planResult().readback.steps[0].observation, 'other')
      assert.equal(Object.hasOwn(f.planResult(), 'visualEvidence'), false)
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  for (const action of ['cancel', 'close']) {
    test(`${host}: ${action} after the first progress receipt prevents later writes`, async () => {
      let f
      let progressCount = 0
      f = fixture(host, {
        approvePlan: true,
        twoSteps: true,
        progressHook: (progress) => {
          if (progress.phase === 'executing') {
            progressCount++
            if (progress.completed === 1) f[action]()
          }
        }
      })
      try {
        await f.pair()
        f.capture()
        f.share()
        await flush()
        await f.tick(2000)
        assert.equal(progressCount, 1)
        assert.equal(f.second.name, 'Second original name')
        assert.ok(!f.planResults().some((result) => result.status === 'completed'))
      } finally {
        f.close()
        await flush()
      }
    })
  }
}

// Reloading the VM destroys all host-script globals while retaining only the
// SDK-shaped persistent store. This is not an actual Figma/Photoshop process.
async function runApproved(f) {
  await f.pair()
  f.capture()
  f.share()
  await flush()
  await f.tick(1000)
  await f.tick(1000)
}
for (const host of ['figma', 'photoshop']) {
  test(`${host}: restart refuses a recorded action even when the server offers it again`, async () => {
    const persistedActions = new Map()
    const first = fixture(host, { approvePlan: true, persistedActions })
    await runApproved(first)
    assert.deepEqual(first.nativeWrites, ['Approved new name'])
    assert.equal(persistedActions.size, 1)
    assert.doesNotMatch(
      JSON.stringify([...persistedActions]),
      /Original owned|Approved new|Proposed new|cccccccc|sessionToken/
    )
    first.close()
    await flush()
    const snapshot = JSON.stringify([...persistedActions])
    const reopened = fixture(host, { approvePlan: true, persistedActions })
    try {
      await runApproved(reopened)
      assert.deepEqual(reopened.nativeWrites, [])
      assert.equal(reopened.node.name, 'Original owned name')
      assert.equal(reopened.planResult().status, 'failed')
      assert.equal(reopened.planResult().effect, 'unknown')
      assert.equal(reopened.planResult().errorCode, 'QUARANTINED')
      assert.equal(reopened.planResult().visualEvidence, undefined)
      assert.equal(JSON.stringify([...persistedActions]), snapshot)
    } finally {
      reopened.close()
      await flush()
    }
  })
  test(`${host}: lost result receipt never permits a restarted action to write twice`, async () => {
    const persistedActions = new Map()
    const first = fixture(host, { approvePlan: true, persistedActions, dropResult: true })
    await runApproved(first)
    assert.deepEqual(first.nativeWrites, ['Approved new name'])
    assert.equal(first.planResult(), null)
    first.close()
    await flush()
    const reopened = fixture(host, { approvePlan: true, persistedActions })
    try {
      await runApproved(reopened)
      assert.deepEqual(reopened.nativeWrites, [])
      assert.equal(reopened.planResult().errorCode, 'QUARANTINED')
    } finally {
      reopened.close()
      await flush()
    }
  })
  for (const broken of [
    'missing-storage',
    'missing-helper',
    'read-failure',
    'write-failure',
    'corrupt'
  ]) {
    test(`${host}: ${broken} refuses native writes without clearing safety records`, async () => {
      const persistedActions = new Map()
      if (broken === 'corrupt')
        persistedActions.set('magicpot.figplugin.execution.v1.' + '8'.repeat(32), '{corrupt')
      const before = JSON.stringify([...persistedActions])
      const f = fixture(host, {
        approvePlan: true,
        persistedActions,
        journalAvailable: broken !== 'missing-storage',
        journalHelper: broken !== 'missing-helper',
        journalHook(stage) {
          if (broken === stage + '-failure') throw new Error('PRIVATE_STORAGE_ERROR')
        }
      })
      try {
        await runApproved(f)
        assert.deepEqual(f.nativeWrites, [])
        assert.equal(f.node.name, 'Original owned name')
        assert.equal(f.planResult().status, 'failed')
        assert.equal(f.planResult().errorCode, 'QUARANTINED')
        assert.equal(JSON.stringify([...persistedActions]), before)
        assert.doesNotMatch(JSON.stringify(f.posts), /PRIVATE_STORAGE_ERROR/)
      } finally {
        f.close()
        await flush()
      }
    })
  }
  test(`${host}: cancellation while recording prevents every native write`, async () => {
    let f
    f = fixture(host, {
      approvePlan: true,
      journalHook(stage) {
        if (stage === 'write') f.cancel()
      }
    })
    try {
      await runApproved(f)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.node.name, 'Original owned name')
      assert.equal(f.persistedActions.size, 1, 'a cancelled reservation is never reused')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: desktop cancellation after reservation is checked before mutation`, async () => {
    let reserved = false
    const f = fixture(host, {
      approvePlan: true,
      journalHook(stage) {
        if (stage === 'write') reserved = true
      },
      authorityHook(status) {
        if (reserved) status.state = 'cancelled'
      }
    })
    try {
      await runApproved(f)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.persistedActions.size, 1)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a new independently approved action does not reuse the old reservation`, async () => {
    const persistedActions = new Map()
    const first = fixture(host, { approvePlan: true, persistedActions })
    await runApproved(first)
    first.close()
    await flush()
    const next = fixture(host, { approvePlan: true, persistedActions, actionSeed: '9' })
    try {
      await runApproved(next)
      assert.deepEqual(next.nativeWrites, ['Approved new name'])
      assert.equal(next.planResult().status, 'completed')
      assert.equal(persistedActions.size, 2)
    } finally {
      next.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: read-only capture and an unapproved plan never access the execution journal`, async () => {
    let accesses = 0
    const f = fixture(host, {
      journalHook() {
        accesses++
      }
    })
    try {
      f.capture()
      await flush()
      assert.equal(accesses, 0)
      await f.pair()
      f.share()
      await flush()
      await f.tick(2000)
      assert.equal(accesses, 0)
      assert.equal(f.persistedActions.size, 0)
      assert.deepEqual(f.nativeWrites, [])
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: reports real decoded pixels against the accepted checkpoint, then verifies a correction`, async () => {
    const f = fixture(host, { approvePlan: true, correctionFlow: true })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      await f.tick(1000)
      await f.tick(1000)
      const reports = f.requests
        .filter((request) => request.url.endsWith('/plan/pixel-audit'))
        .map((request) => request.body)
      assert.equal(reports.length, 2)
      assert.equal(reports[0].targets[0].status, 'compared')
      assert.ok(reports[0].targets[0].changedPixels > 0)
      assert.equal(reports[1].targets[0].status, 'compared')
      assert.equal(reports[1].targets[0].changedPixels, 0)
      assert.doesNotMatch(
        JSON.stringify(reports),
        /Original owned name|Approved new name|base64|"rgba"|"png"/i
      )
      assert.equal(f.node.name, 'Original owned name')
      const point = f.planResults()[0].visualEvidence[0].before
      f.close()
      await flush()
      assert.equal(
        f.vm.MagicPotPixelAuditV1.compare([
          { targetId: 'owned', baseline: point, current: point }
        ])[0].status,
        'unavailable'
      )
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: missing retained pixels are reported unavailable rather than inferred from hashes`, async () => {
    let f
    f = fixture(host, {
      approvePlan: true,
      correctionFlow: true,
      progressHook: async (body) => {
        if (body.phase === 'readback') f.vm.MagicPotPixelAuditV1.clear()
      }
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(1000)
      await f.tick(1000)
      const reports = f.requests.filter((request) => request.url.endsWith('/plan/pixel-audit'))
      assert.equal(reports.length, 1)
      assert.equal(reports[0].body.targets[0].status, 'unavailable')
      assert.equal(Object.hasOwn(reports[0].body.targets[0], 'changedPixels'), false)
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: explicit restore uses fresh targets, waits for approval, restores accepted task values without a model request`, async () => {
    const f = fixture(host, { approvePlan: true })
    try {
      await f.pair()
      f.node.visible = false
      f.restore()
      await flush()
      assert.equal(f.nativeWrites.length, 0)
      const request = f.requests.find((r) => r.url.endsWith('/plan/recovery/prepare'))
      assert.ok(request)
      assert.equal(request.body.hostContext.nodes[0].visible, false)
      await f.tick(1000)
      assert.equal(f.node.name, 'Accepted recovery name')
      assert.equal(f.node.visible, false)
      assert.deepEqual(f.nativeWrites, ['Accepted recovery name'])
      assert.equal(f.planResult().status, 'completed')
      assert.equal(f.planResult().readback.steps[0].value, 'Accepted recovery name')
      assert.equal(
        f.requests.some((r) => new URL(r.url).pathname === '/figplugin/v1/prepare'),
        false
      )
      assert.equal(
        f.requests.some((r) => r.url.endsWith('/plan/correction/prepare')),
        false
      )
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: pending recovery does not claim or write and cancel does not launch late work`, async () => {
    const f = fixture(host)
    try {
      await f.pair()
      f.restore()
      await flush()
      await f.tick(1000)
      f.cancel()
      await flush()
      await f.tick(5000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(
        f.requests.some((r) => r.url.endsWith('/plan/claim')),
        false
      )
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: validated durable image preparation still waits for a separate desktop approval`, async () => {
    const f = fixture(host, { recoveryImages: recoveryImagesFor })
    try {
      await f.pair()
      f.restore()
      await flush()
      await f.tick(1000)
      assert.ok(f.requests.some((request) => request.url.endsWith('/plan/status')))
      assert.equal(
        f.requests.some((request) => request.url.endsWith('/plan/claim')),
        false
      )
      assert.deepEqual(f.nativeWrites, [])
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: malformed prepared durable images never become a claim or native write`, async () => {
    for (const mutate of [
      (images) => {
        images.manifest.manifestSha256 = '0'.repeat(64)
      },
      (images) => {
        images.manifest.assets[0].sha256 = '0'.repeat(64)
      },
      (images) => {
        images.assetBindings[0].assetId = images.assetBindings[0].sourceAssetId
      },
      (images) => {
        images.manifest.targets[0].targetId = 'foreign-target'
      },
      (images) => {
        images.localPath = 'not-a-recovery-authority'
      }
    ]) {
      const f = fixture(host, {
        approvePlan: true,
        recoveryImages(context, planner) {
          const images = recoveryImagesFor(context, planner)
          mutate(images)
          return images
        }
      })
      try {
        await f.pair()
        f.restore()
        await flush()
        await f.tick(1000)
        assert.equal(
          f.requests.some((request) => request.url.endsWith('/plan/claim')),
          false
        )
        assert.deepEqual(f.nativeWrites, [])
      } finally {
        f.close()
        await flush()
      }
    }
  })
  test(`${host}: cancellation while recovery prepare is pending discards the late preview`, async () => {
    let done
    const gate = new Promise((r) => {
      done = r
    })
    const f = fixture(host, { approvePlan: true, recoveryGate: () => gate })
    try {
      await f.pair()
      f.restore()
      await flush()
      f.cancel()
      done()
      await flush()
      await f.tick(5000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(
        f.requests.some((r) => r.url.endsWith('/plan/claim')),
        false
      )
    } finally {
      done()
      f.close()
      await flush()
    }
  })
  test(`${host}: unchanged task properties do not claim, write or create a journal marker`, async () => {
    const f = fixture(host, { approvePlan: true, recoveryUnchanged: true })
    try {
      await f.pair()
      f.restore()
      await flush()
      await f.tick(3000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.persistedActions.size, 0)
      assert.equal(
        f.requests.some((r) => r.url.endsWith('/plan/claim')),
        false
      )
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a substituted recovery checkpoint in the claimed intent never writes`, async () => {
    const f = fixture(host, { approvePlan: true, tamperRecovery: true })
    try {
      await f.pair()
      f.restore()
      await flush()
      await f.tick(1000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.persistedActions.size, 0)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a target edited while recovery approval is pending is not overwritten`, async () => {
    const f = fixture(host, { approvePlan: true })
    try {
      await f.pair()
      f.restore()
      await flush()
      f.node.name = 'Newer user edit'
      f.nativeWrites.length = 0
      await f.tick(1000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.node.name, 'Newer user edit')
    } finally {
      f.close()
      await flush()
    }
  })
}

for (const host of ['figma', 'photoshop']) {
  test(`${host}: explicit reload reassociation passes the selected checkpoint and still waits for approval`, async () => {
    const f = fixture(host, { approvePlan: false })
    try {
      await f.pair()
      f.rebind()
      await flush()
      await f.tick(1000)
      const request = f.requests.find((r) => r.url.endsWith('/plan/recovery/prepare'))
      assert.equal(request.body.rebindBaselineId, '4'.repeat(32))
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(
        f.requests.filter(
          (r) => r.url.endsWith('/prepare') && !r.url.endsWith('/plan/recovery/prepare')
        ).length,
        0
      )
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: a fresh native instance executes one explicitly approved reassociation`, async () => {
    const old = fixture(host)
    old.close()
    await flush()
    const f = fixture(host, { approvePlan: true })
    try {
      await f.pair()
      f.rebind()
      f.rebind()
      await flush()
      await f.tick(1000)
      assert.equal(f.requests.filter((r) => r.url.endsWith('/plan/recovery/prepare')).length, 1)
      assert.equal(f.planResult().status, 'completed')
      assert.equal(f.nativeWrites.length, 1)
    } finally {
      f.close()
      await flush()
    }
  })
  for (const recoveryRebindFault of ['identity', 'baseline'])
    test(`${host}: refuses substituted rebind ${recoveryRebindFault}`, async () => {
      const f = fixture(host, { approvePlan: true, recoveryRebindFault })
      try {
        await f.pair()
        f.rebind()
        await flush()
        await f.tick(2000)
        assert.deepEqual(f.nativeWrites, [])
      } finally {
        f.close()
        await flush()
      }
    })
  test(`${host}: an ordinary restore cannot be silently upgraded to reassociation`, async () => {
    const f = fixture(host, { approvePlan: true, unsolicitedRebind: true })
    try {
      await f.pair()
      f.restore()
      await flush()
      await f.tick(2000)
      assert.deepEqual(f.nativeWrites, [])
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: cancellation drops a late reassociation response`, async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const f = fixture(host, { approvePlan: true, recoveryGate: () => gate })
    try {
      await f.pair()
      f.rebind()
      await flush()
      f.cancel()
      release()
      await flush()
      await f.tick(2000)
      assert.deepEqual(f.nativeWrites, [])
    } finally {
      release()
      f.close()
      await flush()
    }
  })
}

// Production Photoshop entrypoint with API-shaped fixtures. Not an actual PSD acceptance.
test('photoshop: document-reopen opt-in sends the new root and restores only after claim', async () => {
  const f = fixture('photoshop', { approvePlan: true, nativeDocumentId: 202 })
  try {
    await f.pair()
    f.node.visible = false
    f.rebind('4'.repeat(32), true)
    await flush()
    const request = f.requests.find((r) => r.url.endsWith('/plan/recovery/prepare'))
    assert.equal(request.body.reopenDocument, true)
    assert.equal(request.body.hostContext.documentId, '202')
    assert.equal(request.body.hostContext.scopeId, '202')
    assert.equal(f.element('reopen-document').checked, false)
    assert.deepEqual(f.nativeWrites, [])
    await f.tick(1000)
    assert.deepEqual(f.nativeWrites, ['Accepted recovery name'])
    assert.equal(f.node.visible, false)
    assert.equal(f.planResult().status, 'completed')
    assert.equal(f.planResult().readback.steps[0].targetId, '7')
    assert.equal(
      f.requests.some((r) => new URL(r.url).pathname === '/figplugin/v1/prepare'),
      false
    )
  } finally {
    f.close()
    await flush()
  }
})
test('photoshop: ordinary rebind cannot silently become document-root reassociation', async () => {
  const f = fixture('photoshop', {
    approvePlan: true,
    nativeDocumentId: 202,
    unsolicitedDocumentRebind: true
  })
  try {
    await f.pair()
    f.rebind()
    await flush()
    await f.tick(2000)
    assert.deepEqual(f.nativeWrites, [])
    assert.equal(f.persistedActions.size, 0)
  } finally {
    f.close()
    await flush()
  }
})
for (const documentRebindFault of ['current', 'previous', 'host', 'extra'])
  test(`photoshop: document-reopen rejects substituted ${documentRebindFault}`, async () => {
    const f = fixture('photoshop', {
      approvePlan: true,
      nativeDocumentId: 202,
      documentRebindFault
    })
    try {
      await f.pair()
      f.rebind('4'.repeat(32), true)
      await flush()
      await f.tick(2000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.persistedActions.size, 0)
    } finally {
      f.close()
      await flush()
    }
  })
test('photoshop: cancellation while document-reopen capture is pending drops late work', async () => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const f = fixture('photoshop', {
    approvePlan: true,
    nativeDocumentId: 202,
    recoveryGate: () => gate
  })
  try {
    await f.pair()
    f.rebind('4'.repeat(32), true)
    await flush()
    f.cancel()
    release()
    await flush()
    await f.tick(3000)
    assert.deepEqual(f.nativeWrites, [])
    assert.equal(
      f.requests.some((r) => r.url.endsWith('/plan/claim')),
      false
    )
  } finally {
    release()
    f.close()
    await flush()
  }
})
test('photoshop: editing a checkpoint clears the document-reopen opt-in', async () => {
  const f = fixture('photoshop')
  try {
    await f.pair()
    f.element('reopen-document').checked = true
    f.element('rebind-checkpoint').handlers.input()
    assert.equal(f.element('reopen-document').checked, false)
    assert.deepEqual(f.nativeWrites, [])
  } finally {
    f.close()
    await flush()
  }
})

for (const host of ['figma', 'photoshop']) {
  test(`${host}: document-busy claims wait without a journal write and later execute only once`, async () => {
    const f = fixture(host, { approvePlan: true, pendingClaims: 2 })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(3000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.persistedActions.size, 0)
      const status =
        host === 'figma'
          ? f.posts.filter((p) => p.type === 'state').at(-1)?.label
          : f.element('status').textContent
      assert.match(status, /Waiting for another document write/)
      await f.tick(3000)
      assert.deepEqual(f.nativeWrites, ['Approved new name'])
      assert.equal(f.planResult().status, 'completed')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: cancel during document-busy waiting never starts a late write`, async () => {
    const f = fixture(host, { approvePlan: true, pendingClaims: 2 })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(2000)
      f.cancel()
      await flush()
      await f.tick(5000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.persistedActions.size, 0)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: edits made while waiting for the document are not overwritten by the stale approved plan`, async () => {
    const f = fixture(host, { approvePlan: true, pendingClaims: 2 })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(2000)
      f.node.name = 'Newer user edit'
      f.nativeWrites.length = 0
      await f.tick(5000)
      assert.deepEqual(f.nativeWrites, [])
      assert.equal(f.node.name, 'Newer user edit')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: rollback after a deadline-expired asynchronous step cannot overwrite a newer writer`, async () => {
    let f
    f = fixture(host, {
      approvePlan: true,
      twoSteps: true,
      progressHook(body) {
        if (body.phase === 'executing' && body.completed === 1) f.advanceClock(180000)
      }
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(2000)
      assert.deepEqual(f.nativeWrites, ['Approved new name'])
      assert.equal(f.node.name, 'Approved new name')
      assert.equal(f.second.name, 'Second original name')
      assert.equal(
        f.planResults().some((r) => r.status === 'completed'),
        false
      )
    } finally {
      f.close()
      await flush()
    }
  })
}

// Real Photoshop 27.5 reports LayerKind.TEXT as "text", not "textLayer".
test('photoshop: real text kind is captured, approved, written and read back without browser encoders', async () => {
  const f = fixture('photoshop', { approvePlan: true, textPlan: true, nativeTextEncoding: false })
  try {
    await runApproved(f)
    const request = f.requests.find((r) => r.url.endsWith('/prepare') && !r.url.includes('/plan/'))
    assert.ok(request)
    assert.equal(request.body.hostContext.nodes[0].type, 'text')
    assert.equal(request.body.hostContext.nodes[0].text, 'Original owned text')
    assert.ok(request.body.hostContext.nodes[0].commands.includes('text.content'))
    assert.equal(f.node.textItem.contents, 'Approved owned text 中文😀')
    assert.equal(f.planResult().status, 'completed')
    assert.equal(f.planResult().readback.steps[0].value, 'Approved owned text 中文😀')
    assert.equal(f.vm.TextEncoder, undefined)
  } finally {
    f.close()
    await flush()
  }
})
test('photoshop: real text kind does not bypass locked layer capability checks', async () => {
  const f = fixture('photoshop', { textPlan: true, locked: true })
  try {
    await f.pair()
    f.capture()
    f.share()
    await flush()
    const request = f.requests.find((r) => r.url.endsWith('/prepare') && !r.url.includes('/plan/'))
    assert.ok(request)
    assert.equal(request.body.hostContext.nodes[0].locked, true)
    assert.equal(request.body.hostContext.nodes[0].commands.includes('text.content'), false)
    assert.equal(f.node.textItem.contents, 'Original owned text')
    assert.deepEqual(f.nativeWrites, [])
  } finally {
    f.close()
    await flush()
  }
})

for (const host of ['figma', 'photoshop']) {
  test(`${host}: spatial context reaches the explicitly shared planning request without capture-time traffic`, async () => {
    const f = fixture(host)
    try {
      f.capture()
      await flush()
      assert.equal(f.requests.length, 0)
      await f.pair()
      f.share()
      await flush()
      const context = f.requests.find((r) => r.url.endsWith('/prepare')).body.hostContext
      assert.deepEqual(context.nodes[0].spatial, {
        status: 'available',
        coordinateSpace: host === 'figma' ? 'page' : 'document',
        unit: 'px',
        boundsKind: 'axis-aligned-no-effects',
        bounds: { x: -24.5, y: 16.25, width: 64, height: 32 }
      })
      if (host === 'photoshop')
        assert.deepEqual(context.canvas, {
          status: 'available',
          unit: 'px',
          width: 320,
          height: 180,
          resolutionPpi: 300,
          pixelAspectRatio: 1
        })
      else assert.equal(Object.hasOwn(context, 'canvas'), false)
      assert.equal(f.nativeWrites.length, 0)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: unreadable bounds are explicit unavailable metadata, not invented zero geometry`, async () => {
    const f = fixture(host)
    try {
      Object.defineProperty(f.node, host === 'figma' ? 'absoluteBoundingBox' : 'boundsNoEffects', {
        get() {
          throw new Error('PRIVATE_DOCUMENT_PATH')
        },
        configurable: true
      })
      await f.pair()
      f.capture()
      f.share()
      await flush()
      const request = f.requests.find((r) => r.url.endsWith('/prepare'))
      assert.ok(request)
      assert.deepEqual(request.body.hostContext.nodes[0].spatial, { status: 'unavailable' })
      assert.equal(JSON.stringify(request.body).includes('PRIVATE_DOCUMENT_PATH'), false)
      assert.equal(f.nativeWrites.length, 0)
    } finally {
      f.close()
      await flush()
    }
  })
  test(`${host}: changed spatial input during asynchronous checkpoint collection prevents first write`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      visualGate: async ({ node }) => {
        if (host === 'figma') node.absoluteBoundingBox.x += 1
        else node.boundsNoEffects.left += 1
      }
    })
    try {
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(5000)
      assert.equal(f.nativeWrites.length, 0)
      assert.equal(f.node.name, 'Original owned name')
    } finally {
      f.close()
      await flush()
    }
  })
}
test('photoshop: changed document resolution before the first write invalidates the approved context', async () => {
  let f
  f = fixture('photoshop', {
    approvePlan: true,
    visualGate: async () => {
      f.nativeDocument.resolution = 72
    }
  })
  try {
    await f.pair()
    f.capture()
    f.share()
    await flush()
    await f.tick(5000)
    assert.equal(f.nativeWrites.length, 0)
  } finally {
    f.close()
    await flush()
  }
})

test('photoshop: an approved text change may change its own bounds without invalidating final readback', async () => {
  const f = fixture('photoshop', { approvePlan: true, textPlan: true })
  let text = f.node.textItem.contents
  Object.defineProperty(f.node.textItem, 'contents', {
    get: () => text,
    set: (value) => {
      text = value
      f.node.boundsNoEffects.right += 50
    }
  })
  try {
    await f.pair()
    f.capture()
    f.share()
    await flush()
    await f.tick(5000)
    assert.equal(text, 'Approved owned text 中文😀')
    assert.equal(f.planResult().status, 'completed')
    assert.equal(f.planResult().effect, 'applied')
  } finally {
    f.close()
    await flush()
  }
})
test('photoshop: invalid canvas values remain unknown rather than becoming a 72ppi default', async () => {
  const f = fixture('photoshop')
  try {
    f.nativeDocument.resolution = '300'
    await f.pair()
    f.capture()
    f.share()
    await flush()
    const context = f.requests.find((r) => r.url.endsWith('/prepare')).body.hostContext
    assert.deepEqual(context.canvas, { status: 'unavailable' })
    assert.equal(context.nodes[0].spatial.status, 'available')
  } finally {
    f.close()
    await flush()
  }
})

// Font preparation tests execute production native code; native APIs and HTTP are fixtures.
const fontContextOf = (f) => f.requests.find((r) => r.url.endsWith('/prepare'))?.body.hostContext
const runFontPlan = async (f) => {
  await f.pair()
  f.capture()
  f.share()
  await flush()
  await f.tick(3000)
}
test('font resources: Figma captures bounded font runs, sends only after share, and loads only after write approval', async () => {
  const f = fixture('figma', { textPlan: true })
  try {
    f.capture()
    await flush()
    assert.equal(f.requests.length, 0)
    assert.deepEqual(f.fontLoads, [])
    await f.pair()
    f.share()
    await flush()
    await f.tick(2000)
    const n = fontContextOf(f).nodes[0]
    assert.equal(n.typography.kind, 'figma-font-runs')
    assert.equal(n.typography.runs[0].font.family, 'Owned Sans')
    assert.equal(n.typography.runs[0].fontSizePx, 14)
    assert.ok(n.fontKey.includes('Owned Sans'))
    assert.deepEqual(f.fontLoads, [])
    assert.deepEqual(f.textWrites, [])
  } finally {
    f.close()
    await flush()
  }
})
test('font resources: Figma loads the exact current font before approved text mutation', async () => {
  const f = fixture('figma', { textPlan: true, approvePlan: true })
  try {
    await runFontPlan(f)
    assert.deepEqual(f.fontLoads, [{ family: 'Owned Sans', style: 'Regular' }])
    assert.deepEqual(f.textWrites, ['Approved owned text 中文😀'])
    assert.equal(f.planResult()?.status, 'completed')
  } finally {
    f.close()
    await flush()
  }
})
test('font resources: mixed and variable Figma fonts are all loaded without substitution', async () => {
  const f = fixture('figma', { textPlan: true, approvePlan: true })
  try {
    const a = { family: 'Owned Sans', style: 'Regular' },
      b = { family: 'Owned Variable', style: 'Bold', variationSettings: { wght: 650 } }
    f.node.getStyledTextSegments = () => [
      { start: 0, end: 4, fontName: a, fontSize: 14 },
      { start: 4, end: f.node.characters.length, fontName: b, fontSize: 18 }
    ]
    await runFontPlan(f)
    assert.deepEqual(f.fontLoads, [a, b])
    assert.equal(f.textWrites.length, 1)
    assert.equal(f.planResult()?.status, 'completed')
  } finally {
    f.close()
    await flush()
  }
})
test('font resources: missing Figma fonts do not advertise text writes or load a substitute', async () => {
  const f = fixture('figma', { textPlan: true, missingFonts: true, approvePlan: true })
  try {
    await runFontPlan(f)
    const n = fontContextOf(f).nodes[0]
    assert.equal(n.typography.hasMissingFont, true)
    assert.ok(!n.commands.includes('text.content'))
    assert.ok(n.commands.includes('node.rename'))
    assert.deepEqual(f.fontLoads, [])
    assert.deepEqual(f.textWrites, [])
  } finally {
    f.close()
    await flush()
  }
})
test('font resources: unavailable Figma typography is explicit and not a text capability', async () => {
  const f = fixture('figma', { textPlan: true })
  try {
    f.node.getStyledTextSegments = () => {
      throw Error('PRIVATE font path')
    }
    await runFontPlan(f)
    const n = fontContextOf(f).nodes[0]
    assert.deepEqual(n.typography, { status: 'unavailable' })
    assert.ok(!n.commands.includes('text.content'))
    assert.ok(!JSON.stringify(f.requests).includes('PRIVATE'))
  } finally {
    f.close()
    await flush()
  }
})
for (const mode of ['cancel', 'timeout', 'font-changed', 'text-changed', 'lock-changed']) {
  test(`font resources: ${mode} during Figma font preparation prevents late text writes`, async () => {
    let release
    const wait = new Promise((resolve) => {
      release = resolve
    })
    const f = fixture('figma', { textPlan: true, approvePlan: true, fontGate: () => wait })
    try {
      await runFontPlan(f)
      assert.equal(f.fontLoads.length, 1)
      assert.equal(f.textWrites.length, 0)
      if (mode === 'cancel') f.cancel()
      if (mode === 'timeout') await f.tick(16000)
      if (mode === 'font-changed') f.node.fontName = { family: 'Other Font', style: 'Regular' }
      if (mode === 'text-changed') {
        f.loadedFonts.add(JSON.stringify(f.node.fontName))
        f.node.characters = 'Later user text'
        f.textWrites.length = 0
      }
      if (mode === 'lock-changed') f.node.locked = true
      release()
      await flush()
      await f.tick(3000)
      assert.deepEqual(f.textWrites, [])
      assert.equal(f.persistedActions.size, 0)
      if (mode === 'timeout') assert.equal(f.planResult()?.errorCode, 'HOST_UNAVAILABLE')
    } finally {
      release()
      f.close()
      await flush()
    }
  })
}
test('font resources: font loader rejection is a failed receipt, not successful execution', async () => {
  const f = fixture('figma', {
    textPlan: true,
    approvePlan: true,
    fontGate: () => Promise.reject(Error('PRIVATE loader details'))
  })
  try {
    await runFontPlan(f)
    assert.equal(f.planResult()?.status, 'failed')
    assert.equal(f.planResult()?.effect, 'none')
    assert.equal(f.planResult()?.errorCode, 'HOST_UNAVAILABLE')
    assert.deepEqual(f.textWrites, [])
    assert.ok(!JSON.stringify(f.posts).includes('PRIVATE'))
  } finally {
    f.close()
    await flush()
  }
})
test('font resources: Photoshop sends explicitly primary style metadata with native size units', async () => {
  const f = fixture('photoshop', { textPlan: true, approvePlan: true })
  try {
    await runFontPlan(f)
    assert.deepEqual(fontContextOf(f).nodes[0].typography, {
      status: 'available',
      kind: 'photoshop-character-style',
      coverage: 'primary-style-only',
      fontPostScriptName: 'OwnedSans-Regular',
      size: { value: 14, unit: 'px-at-72ppi' }
    })
    assert.equal(f.planResult()?.status, 'completed')
  } finally {
    f.close()
    await flush()
  }
})
test('font resources: Photoshop font change without geometry change invalidates first write', async () => {
  const f = fixture('photoshop', {
    textPlan: true,
    approvePlan: true,
    visualGate: ({ node }) => {
      node.textItem.characterStyle.font = 'Different-Font'
    }
  })
  try {
    await runFontPlan(f)
    assert.equal(f.node.textItem.contents, 'Original owned text')
    assert.equal(f.planResult()?.effect, 'none')
  } finally {
    f.close()
    await flush()
  }
})

for (const host of ['figma', 'photoshop']) {
  test(`font resources: ${host} rollback does not overwrite text after another font edit`, async () => {
    const f = fixture(host, {
      textPlan: true,
      approvePlan: true,
      progressHook: (body, { node }) => {
        if (body.phase === 'executing') {
          if (host === 'figma') node.fontName = { family: 'Later font', style: 'Bold' }
          else node.textItem.characterStyle.font = 'LaterFont-Bold'
          throw Error('Owned failed receipt after concurrent font edit')
        }
      }
    })
    try {
      await runFontPlan(f)
      const text = host === 'figma' ? f.node.characters : f.node.textItem.contents
      assert.equal(text, 'Approved owned text 中文😀')
      if (host === 'figma') assert.equal(f.textWrites.length, 1)
    } finally {
      f.close()
      await flush()
    }
  })
}
test('font resources: Figma empty text uses its explicit insertion style', async () => {
  const f = fixture('figma', { textPlan: true, approvePlan: true })
  try {
    f.loadedFonts.add(JSON.stringify(f.node.fontName))
    f.node.characters = ''
    f.textWrites.length = 0
    f.loadedFonts.clear()
    await runFontPlan(f)
    assert.deepEqual(f.fontLoads, [{ family: 'Owned Sans', style: 'Regular' }])
    assert.equal(f.planResult()?.status, 'completed')
  } finally {
    f.close()
    await flush()
  }
})

const appearanceContext = (f) =>
  f.requests.find((r) => r.url.endsWith('/prepare'))?.body.hostContext
const solidPaint = () => ({
  type: 'SOLID',
  color: { r: 0.25, g: 0.5, b: 0.75 },
  opacity: 0.8,
  visible: true
})
const setAppearance = (f, host) => {
  if (host === 'figma') {
    f.node.fills = [solidPaint()]
    f.node.strokes = []
    f.vm.figma.root.documentColorProfile = 'DISPLAY_P3'
  } else {
    f.node.textItem.characterStyle.color = {
      base: { typename: 'RGBColor', red: 64, green: 128, blue: 192 }
    }
  }
}
for (const host of ['figma', 'photoshop']) {
  test(`appearance context: ${host} captures actual paint or native text color only after explicit share`, async () => {
    const f = fixture(host, { approvePlan: true, textPlan: host === 'photoshop' })
    try {
      setAppearance(f, host)
      f.capture()
      assert.equal(f.requests.length, 0)
      await f.pair()
      f.share()
      await flush()
      await f.tick(3000)
      const appearance = appearanceContext(f).nodes[0].appearance
      assert.equal(appearance.status, 'available')
      assert.equal(appearance.kind, host === 'figma' ? 'figma-paints' : 'photoshop-text-color')
      if (host === 'figma') {
        assert.equal(appearance.documentColorProfile, 'DISPLAY_P3')
        assert.deepEqual(appearance.fills.paints, [solidPaint()])
      } else assert.deepEqual(appearance.color, { model: 'RGB', red: 64, green: 128, blue: 192 })
      assert.equal(f.planResult()?.status, 'completed')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`appearance context: ${host} changed color with unchanged geometry prevents first write`, async () => {
    const f = fixture(host, {
      approvePlan: true,
      textPlan: host === 'photoshop',
      visualGate: ({ node }) => {
        if (host === 'figma') node.fills[0].color.r = 0.9
        else node.textItem.characterStyle.color.base.red = 230
      }
    })
    try {
      setAppearance(f, host)
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(3000)
      assert.deepEqual(f.nativeWrites, [])
      assert.deepEqual(f.textWrites, [])
      assert.equal(f.planResult()?.status, 'failed')
      assert.equal(f.planResult()?.effect, 'none')
    } finally {
      f.close()
      await flush()
    }
  })
  test(`appearance context: ${host} unreadable appearance does not invent a default color or leak errors`, async () => {
    const f = fixture(host, { approvePlan: true, textPlan: host === 'photoshop' })
    try {
      setAppearance(f, host)
      const object = host === 'figma' ? f.node : f.node.textItem.characterStyle
      Object.defineProperty(object, host === 'figma' ? 'fills' : 'color', {
        get() {
          throw Error('PRIVATE_COLOR_PATH')
        },
        configurable: true
      })
      await f.pair()
      f.capture()
      f.share()
      await flush()
      await f.tick(3000)
      assert.deepEqual(appearanceContext(f).nodes[0].appearance, { status: 'unavailable' })
      assert.ok(!JSON.stringify(f.requests).includes('PRIVATE_COLOR_PATH'))
      assert.equal(f.planResult()?.status, 'completed')
    } finally {
      f.close()
      await flush()
    }
  })
}
test('appearance context: Figma document profile drift invalidates unchanged numeric color', async () => {
  const f = fixture('figma', {
    approvePlan: true,
    visualGate: () => {
      f.vm.figma.root.documentColorProfile = 'SRGB'
    }
  })
  try {
    setAppearance(f, 'figma')
    await f.pair()
    f.capture()
    f.share()
    await flush()
    await f.tick(3000)
    assert.deepEqual(f.nativeWrites, [])
    assert.equal(f.planResult()?.effect, 'none')
  } finally {
    f.close()
    await flush()
  }
})
test('appearance context: Figma image reference is not fetched and replacement invalidates planning', async () => {
  const f = fixture('figma', {
    approvePlan: true,
    visualGate: ({ node }) => {
      node.fills[0].imageHash = 'b'.repeat(40)
    }
  })
  try {
    setAppearance(f, 'figma')
    f.node.fills = [{ type: 'IMAGE', imageHash: 'a'.repeat(40), scaleMode: 'FILL' }]
    f.vm.figma.getImageByHash = () => {
      throw Error('Resource bytes must not be requested')
    }
    await f.pair()
    f.capture()
    f.share()
    await flush()
    await f.tick(3000)
    const paint = appearanceContext(f).nodes[0].appearance.fills.paints[0]
    assert.equal(paint.imageHash, 'a'.repeat(40))
    assert.equal(paint.coverage, 'reference-only')
    assert.deepEqual(f.nativeWrites, [])
    assert.equal(f.planResult()?.effect, 'none')
  } finally {
    f.close()
    await flush()
  }
})
test('appearance context: Photoshop only reads SolidColor.base without conversion accessors', async () => {
  const f = fixture('photoshop', { textPlan: true, approvePlan: true })
  try {
    setAppearance(f, 'photoshop')
    const color = f.node.textItem.characterStyle.color
    color.base = { typename: 'CMYKColor', cyan: 10, magenta: 20, yellow: 30, black: 40 }
    for (const field of ['rgb', 'cmyk', 'lab', 'gray', 'hsb'])
      Object.defineProperty(color, field, {
        get() {
          throw Error('Do not convert')
        }
      })
    await f.pair()
    f.capture()
    f.share()
    await flush()
    await f.tick(3000)
    assert.deepEqual(appearanceContext(f).nodes[0].appearance.color, {
      model: 'CMYK',
      cyan: 10,
      magenta: 20,
      yellow: 30,
      black: 40
    })
    assert.equal(f.planResult()?.status, 'completed')
  } finally {
    f.close()
    await flush()
  }
})

test('font resources: changed Figma font before claim returns a terminal stale receipt', async () => {
  const f = fixture('figma', { textPlan: true, approvePlan: true })
  try {
    await f.pair()
    f.capture()
    f.node.fontName = { family: 'Later Font', style: 'Bold' }
    f.share()
    await flush()
    await f.tick(3000)
    assert.deepEqual(f.textWrites, [])
    assert.deepEqual(f.fontLoads, [])
    assert.equal(f.planResult()?.errorCode, 'STALE_CONTEXT')
  } finally {
    f.close()
    await flush()
  }
})

for (const host of ['figma', 'photoshop']) {
  test(`appearance context: ${host} rollback preserves later color edits`, async () => {
    const f = fixture(host, {
      textPlan: true,
      approvePlan: true,
      progressHook: (body, { node }) => {
        if (body.phase !== 'executing') return
        if (host === 'figma') node.fills[0].color.r = 0.9
        else node.textItem.characterStyle.color.base.red = 230
        throw Error('Owned receipt failure after a later style edit')
      }
    })
    try {
      setAppearance(f, host)
      await runFontPlan(f)
      {
        assert.equal(
          host === 'figma' ? f.node.characters : f.node.textItem.contents,
          'Approved owned text 中文😀'
        )
        assert.equal(
          host === 'figma'
            ? f.node.fills[0].color.r
            : f.node.textItem.characterStyle.color.base.red,
          host === 'figma' ? 0.9 : 230
        )
        if (host === 'figma') assert.equal(f.textWrites.length, 1)
      }
    } finally {
      f.close()
      await flush()
    }
  })
}
