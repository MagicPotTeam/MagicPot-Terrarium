import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { deflateSync } from 'node:zlib'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
const bundle = await buildHostPlanPreview()
const copy = (value) => JSON.parse(JSON.stringify(value))
const hash = (data) => createHash('sha256').update(data).digest('hex')
const flush = () => new Promise((resolve) => setImmediate(resolve))
const gate = () => {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function syntheticPng(padding = 0) {
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length)
    bytes.write(type, 4)
    data.copy(bytes, 8)
    let crc = 0xffffffff
    for (const byte of bytes.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
    return bytes
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(padding ? [chunk('tEXt', Buffer.from('Fixture\0' + 'a'.repeat(padding)))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, 11, 22, 33, 255, 44, 55, 66, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Production Figma bridge, validators, lifecycle and journal; native objects and
// HTTP replies are synthetic. This is not a GUI/real-Figma compatibility claim.
function fixture(options = {}) {
  let now = 1800000000000
  let serial = 0
  let claimed = false
  let executionPhase = 'claimed'
  let approvedContext
  let recovery
  let lastResult
  const timers = new Map()
  const requests = []
  const messages = []
  const writes = []
  const imports = []
  const nativeBuffers = []
  const sourceBuffers = []
  const runs = []
  const journal = new Map()
  const events = new Map()
  const images = new Map()
  const png = syntheticPng(options.chunked ? 60000 : 0)
  const nativePng = syntheticPng(37)
  const origin = 'http://127.0.0.1:49152'
  const pluginId = 'fixture.figma.image'
  const sessionId = 'b'.repeat(32)
  const callId = 'c'.repeat(32)
  const executionId = 'd'.repeat(32)
  const actionId = 'e'.repeat(32)
  const planSha256 = 'f'.repeat(64)
  const asset = {
    version: 1,
    kind: 'session-image-asset',
    purpose: 'local-preview',
    sessionId,
    pluginId,
    projectId: 'fixture_project',
    host: 'figma',
    assetId: 'a'.repeat(32),
    sha256: hash(png),
    mimeType: 'image/png',
    sizeBytes: png.length,
    width: 2,
    height: 1,
    chunkSize: 24576,
    chunkCount: Math.ceil(png.length / 24576),
    createdAt: now,
    expiresAt: now + 120000
  }
  const metadata = ({ assetId, sha256, mimeType, sizeBytes, width, height, expiresAt }) => ({
    assetId,
    sha256,
    mimeType,
    sizeBytes,
    width,
    height,
    expiresAt
  })
  const document = { id: '0:0', type: 'DOCUMENT', documentColorProfile: 'SRGB' }
  const page = { id: '0:1', type: 'PAGE', parent: document, selection: [] }
  const baseline = options.fills ?? [
    { type: 'SOLID', color: { r: 0.2, g: 0.3, b: 0.4 }, visible: true, opacity: 0.8 },
    {
      type: 'IMAGE',
      imageHash: '0'.repeat(40),
      scaleMode: 'CROP',
      imageTransform: [
        [1, 0, 0.125],
        [0, 1, 0.25]
      ],
      filters: { exposure: 0.2 }
    }
  ]
  let fills = copy(baseline)
  for (const paint of baseline)
    if (paint.type === 'IMAGE' && paint.imageHash)
      images.set(paint.imageHash, { hash: paint.imageHash })
  const node = {
    id: '1:2',
    type: 'RECTANGLE',
    name: 'Unchanged name',
    parent: page,
    visible: true,
    locked: false,
    opacity: 0.75,
    fillStyleId: '',
    width: 100,
    height: 50,
    x: 3,
    y: 4,
    absoluteBoundingBox: { x: 3, y: 4, width: 100, height: 50 },
    strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    effects: [{ type: 'LAYER_BLUR', radius: 2, visible: true }],
    get fills() {
      return copy(fills)
    },
    set fills(value) {
      writes.push(copy(value))
      if (options.setter) options.setter(value, api, writes.length)
      else fills = copy(value)
    }
  }
  const second = {
    id: '1:3',
    type: 'RECTANGLE',
    parent: page,
    visible: true,
    locked: false,
    get name() {
      return 'Second original'
    },
    set name(_value) {
      throw new Error('Synthetic native refusal')
    }
  }
  page.selection = options.twoSteps ? [node, second] : [node]
  const figma = {
    root: document,
    currentPage: page,
    mixed: Symbol('mixed'),
    showUI() {},
    closePlugin() {},
    on(name, callback) {
      events.set(name, callback)
    },
    off(name, callback) {
      if (events.get(name) === callback) events.delete(name)
    },
    ui: {
      postMessage(value) {
        messages.push(copy(value))
      }
    },
    clientStorage: {
      async getAsync(key) {
        return journal.get(key)
      },
      async setAsync(key, value) {
        journal.set(key, value)
      },
      async keysAsync() {
        return [...journal.keys()]
      },
      async deleteAsync(key) {
        journal.delete(key)
      }
    },
    createImage(data) {
      assert.deepEqual(Buffer.from(data), png, 'native import receives the full verified source')
      const nativeHash = String(imports.length + 1).repeat(40)
      imports.push({ data, copied: Buffer.from(data), nativeHash })
      if (options.importError) throw new Error('Native decoder refused image')
      const image = {
        hash: nativeHash,
        async getBytesAsync() {
          if (options.nativeRead) await options.nativeRead(api, nativeHash)
          const data = new Uint8Array(nativePng)
          nativeBuffers.push(data)
          return data
        }
      }
      images.set(nativeHash, image)
      return image
    },
    getImageByHash(value) {
      return images.get(value) ?? null
    }
  }
  const steps = () => [
    {
      command: 'image.fill',
      targetId: node.id,
      assetId: asset.assetId,
      sha256: asset.sha256,
      scaleMode: options.scaleMode ?? 'FIT'
    },
    ...(options.twoSteps ? [{ command: 'node.rename', targetId: second.id, name: 'New name' }] : [])
  ]
  const plan = () => ({
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: approvedContext.captureId,
    steps: steps()
  })
  const preview = () => ({
    kind: 'host-plan-preview',
    executable: true,
    plan: plan(),
    risk: 'high',
    differences: steps().map((step) => ({
      targetId: step.targetId,
      command: step.command,
      before:
        step.command === 'image.fill'
          ? { fingerprint: approvedContext.nodes[0].imageFill.fingerprint }
          : second.name,
      after:
        step.command === 'image.fill'
          ? { assetId: step.assetId, sha256: step.sha256, scaleMode: step.scaleMode }
          : step.name
    })),
    execution: {
      mode: 'native-write',
      adapterVersion: 'figma-native-1',
      rollback: 'verified-in-place',
      visualAudit: 'unavailable',
      requiresWriteApproval: true
    }
  })
  const sandbox = {
    console,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    TextDecoder,
    AbortController,
    figma,
    __html__: '',
    Date: class extends Date {
      static now() {
        return now
      }
    },
    setTimeout(callback, delay) {
      const id = ++serial
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    observe(api) {
      return Object.freeze({
        ...api,
        async readExecutionAsset(...args) {
          const data = await api.readExecutionAsset(...args)
          sourceBuffers.push(data)
          return data
        },
        createHostAdapterLifecycle(options) {
          const record = { releases: 0, options }
          runs.push(record)
          const lifecycle = api.createHostAdapterLifecycle({
            ...options,
            async prepareResources(args) {
              const resources = await options.prepareResources(args)
              record.resources = resources
              return resources
            },
            async releaseResources(args) {
              record.releases++
              await options.releaseResources(args)
            }
          })
          return {
            ...lifecycle,
            async run(...args) {
              record.result = await lifecycle.run(...args)
              return record.result
            }
          }
        }
      })
    },
    async fetch(url, request) {
      const body = JSON.parse(request.body)
      requests.push({ url, body })
      assert.equal(
        request.headers.Authorization,
        url.endsWith('/pair') ? undefined : 'Bearer ' + '9'.repeat(64)
      )
      let value
      let status = 200
      if (url.endsWith('/pair'))
        value = {
          protocol: 1,
          sessionId,
          sessionToken: '9'.repeat(64),
          expiresAt: now + 600000,
          idleTimeoutMs: 120000
        }
      else if (url.endsWith('/assets/list'))
        value = { protocol: 1, purpose: 'local-preview', sessionId, assets: [asset] }
      else if (url.endsWith('/plan/assets/read')) {
        assert.equal(claimed, true, 'execution resource cannot be fetched before claim')
        assert.deepEqual(body, {
          protocol: 1,
          purpose: 'host-plan-execution',
          callId,
          executionId,
          actionId,
          planSha256,
          assetId: asset.assetId,
          sha256: asset.sha256,
          index: body.index
        })
        if (options.chunkRead) await options.chunkRead(body, api)
        const data = Buffer.from(
          png.subarray(body.index * asset.chunkSize, (body.index + 1) * asset.chunkSize)
        )
        if (options.corruptBytes) data[0] ^= 1
        value = {
          protocol: 1,
          purpose: 'host-plan-execution',
          callId,
          executionId,
          actionId,
          planSha256,
          sessionId,
          assetId: asset.assetId,
          chunk: {
            version: 1,
            kind: 'content-addressed-binary-chunk',
            sha256: asset.sha256,
            index: body.index,
            chunkCount: asset.chunkCount,
            bytesBase64: data.toString('base64')
          }
        }
        options.chunkEnvelope?.(value)
      } else if (url.endsWith('/plan/recovery/prepare')) {
        approvedContext = body.hostContext
        const sourceAssetId = '0'.repeat(32)
        const source = metadata(asset)
        delete source.expiresAt
        const manifest = {
          version: 1,
          sourcePlanSha256: '1'.repeat(64),
          assets: [{ ...source, assetId: sourceAssetId }],
          targets: [
            {
              command: 'image.fill',
              targetId: node.id,
              assetId: sourceAssetId,
              sha256: asset.sha256,
              scaleMode: options.scaleMode ?? 'FIT',
              acceptedEvidence: {
                kind: 'figma-image-fill',
                sourceSha256: asset.sha256,
                nativeImageHash: 'historical-native-hash-not-in-this-vm',
                fillsSha256: '2'.repeat(64)
              }
            }
          ],
          manifestSha256: '3'.repeat(64)
        }
        manifest.manifestSha256 = hash(
          vm.MagicPotPlanPreviewV1.recoveryImagesManifestContent(manifest)
        )
        recovery = {
          baselineId: '4'.repeat(32),
          sourceExecutionId: '5'.repeat(32),
          requestId: body.requestId,
          round: 1,
          maxCorrectionRounds: 3,
          targetIds: [...approvedContext.selectedIds].sort(),
          images: { manifest, assetBindings: [{ sourceAssetId, assetId: asset.assetId }] }
        }
        options.preparedRecovery?.(recovery)
        value = {
          protocol: 1,
          status: 'prepared',
          callId,
          executionId,
          expiresAt: asset.expiresAt,
          recovery
        }
      } else if (url.endsWith('/prepare')) {
        approvedContext = body.hostContext
        value = { protocol: 1, callId, status: 'awaiting-approval', expiresAt: asset.expiresAt }
      } else if (url.endsWith('/plan/claim')) {
        claimed = true
        value = {
          protocol: 1,
          status: 'ready',
          intent: {
            protocol: 1,
            purpose: 'execute-host-plan',
            pluginId,
            host: 'figma',
            callId,
            executionId,
            actionId,
            planSha256,
            documentId: approvedContext.documentId,
            scopeId: approvedContext.scopeId,
            captureId: approvedContext.captureId,
            adapterVersion: 'figma-native-1',
            expiresAt: asset.expiresAt,
            plan: plan(),
            executionAssets: [
              { ...asset, kind: 'execution-image-asset', purpose: 'host-plan-execution' }
            ],
            ...(recovery ? { recovery: copy(recovery) } : {})
          }
        }
        options.intent?.(value.intent)
      } else if (url.endsWith('/plan/status')) {
        value = { protocol: 1, callId, executionId, state: claimed ? executionPhase : 'approved' }
        options.authority?.(value, api)
      } else if (url.endsWith('/plan/progress')) {
        await options.progress?.(body, api)
        executionPhase = body.phase
        value = { protocol: 1, callId, executionId, state: body.phase }
      } else if (url.endsWith('/plan/result')) {
        lastResult = copy(body)
        value = {
          protocol: 1,
          executionId,
          status: {
            protocol: 1,
            executionId,
            callId,
            state: body.status,
            effect: body.effect,
            completed: body.completed,
            total: body.total
          }
        }
      } else if (url.endsWith('/status'))
        value = { protocol: 1, callId, status: 'completed', content: JSON.stringify(preview()) }
      else if (url.endsWith('/cancel') || url.endsWith('/close')) status = 204
      else assert.fail('Unexpected route ' + url)
      if (url.endsWith('/assets/list')) options.catalog?.(value, api)
      return {
        ok: true,
        status,
        url,
        headers: {
          get() {
            return null
          }
        },
        async text() {
          return JSON.stringify(value)
        }
      }
    }
  }
  const vm = createContext(sandbox)
  new Script(`globalThis.MAGICPOT_BRIDGE_CONFIG = Object.freeze(${JSON.stringify({
    protocol: 1,
    origin,
    pluginId,
    host: 'figma'
  })});
  const define = Object.defineProperty;
  Object.defineProperty = function (target, name, descriptor) {
    if (target === globalThis && name === 'MagicPotPlanPreviewV1') {
      Object.defineProperty = define;
      descriptor = {...descriptor, value: observe(descriptor.value)};
    }
    return define(target, name, descriptor);
  };`).runInContext(vm)
  for (const text of [
    read('shared/visual-evidence.js'),
    bundle.text,
    read('shared/execution-journal.js'),
    read('figma/bridge/code.js')
  ])
    new Script(text).runInContext(vm)
  const send = (value) => figma.ui.onmessage({ protocol: 1, ...value })
  const api = {
    figma,
    node,
    second,
    page,
    document,
    asset,
    metadata,
    requests,
    messages,
    writes,
    imports,
    sourceBuffers,
    nativeBuffers,
    journal,
    runs,
    images,
    baseline,
    send,
    get result() {
      return lastResult
    },
    get context() {
      return approvedContext
    },
    get recovery() {
      return recovery
    },
    userFills(value) {
      fills = copy(value)
    },
    setNow(value) {
      now = value
    },
    get now() {
      return now
    },
    capture() {
      send({ type: 'capture-plan', nonce: '5'.repeat(32), instanceEpoch: '6'.repeat(32) })
    },
    async tick(ms) {
      const target = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > target) break
        timers.delete(next[0])
        now = next[1].at
        next[1].callback()
        await flush()
      }
      now = target
    },
    async start() {
      send({
        type: 'pair',
        nonce: '4'.repeat(32),
        ticket: JSON.stringify({
          ticketId: '1'.repeat(32),
          pairingSecret: '2'.repeat(64),
          expiresAt: now + 120000,
          bridgeOrigin: origin,
          pluginId,
          host: 'figma',
          artifactSha256: '3'.repeat(64)
        })
      })
      await flush()
      if (options.recovery) {
        send({ type: 'restore-task', nonce: '8'.repeat(32), instanceEpoch: '6'.repeat(32) })
        await flush()
        return
      }
      send({ type: 'refresh-session-assets', nonce: '7'.repeat(32) })
      await flush()
      api.capture()
      await flush()
      send({
        type: 'share',
        nonce: '8'.repeat(32),
        revision: '5'.repeat(32),
        prompt: 'Use the explicitly selected image as the sole approved fill.',
        consent: true,
        assetReferences: [{ assetId: asset.assetId, sha256: asset.sha256 }]
      })
      await flush()
      await api.tick(1000)
    },
    async execute() {
      await api.start()
      await api.tick(1000)
      await flush()
    }
  }
  options.setup?.(api)
  return api
}

test('Figma image.fill imports verified claim-only chunks and reports observed native identity, not source encoding', async () => {
  for (const scaleMode of ['FILL', 'FIT']) {
    const f = fixture({ chunked: true, scaleMode })
    const unaffected = copy({
      name: f.node.name,
      opacity: f.node.opacity,
      x: f.node.x,
      y: f.node.y,
      width: f.node.width,
      height: f.node.height,
      strokes: f.node.strokes,
      effects: f.node.effects
    })
    await f.execute()
    assert.equal(f.result?.status, 'completed', JSON.stringify(f.messages.slice(-4)))
    assert.equal(f.result.effect, 'applied')
    assert.equal(f.imports.length, 1)
    assert.equal(f.writes.length, 1)
    assert.equal(f.node.fills[0].imageHash, f.imports[0].nativeHash)
    assert.equal(f.node.fills[0].scaleMode, scaleMode)
    const row = f.result.readback.steps[0]
    assert.deepEqual(row.value, { assetId: f.asset.assetId, sha256: f.asset.sha256, scaleMode })
    assert.equal(row.observation, 'requested')
    assert.deepEqual(row.imageEvidence, {
      kind: 'figma-image-fill',
      sourceSha256: f.asset.sha256,
      nativeImageHash: f.imports[0].nativeHash,
      fillsSha256: row.imageEvidence.fillsSha256
    })
    assert.match(row.imageEvidence.fillsSha256, /^[a-f0-9]{64}$/)
    assert.notEqual(row.imageEvidence.fillsSha256, f.context.nodes[0].imageFill.fingerprint)
    assert.deepEqual(
      {
        name: f.node.name,
        opacity: f.node.opacity,
        x: f.node.x,
        y: f.node.y,
        width: f.node.width,
        height: f.node.height,
        strokes: f.node.strokes,
        effects: f.node.effects
      },
      unaffected
    )
    assert.equal(
      f.requests.filter((r) => r.url.endsWith('/plan/assets/read')).length,
      f.asset.chunkCount
    )
    assert.equal(
      f.requests.some((r) => r.url.endsWith('/v1/assets/read')),
      false
    )
    assert.equal(f.runs[0].options.retainExecution, false)
    assert.equal(f.runs[0].result.execution, undefined)
    assert.equal(f.runs[0].releases, 1)
    assert.equal(f.runs[0].resources.imageResources.size, 0)
    assert.equal(f.sourceBuffers.length, 1)
    for (const bytes of [...f.sourceBuffers, ...f.nativeBuffers, ...f.imports.map((x) => x.data)])
      assert.ok(
        bytes.every((byte) => byte === 0),
        'all owned image buffers are cleared'
      )
    assert.ok(
      [...f.journal.values()].every((value) => !value.includes(f.asset.assetId)),
      'durable journal is a replay fence, not a restorable image baseline'
    )
  }
})

test('Figma recovery in a new VM imports saved source with a fresh asset and native hash, without a catalog lease', async () => {
  for (const scaleMode of ['FILL', 'FIT']) {
    const f = fixture({ recovery: true, scaleMode, chunked: true })
    await f.execute()
    assert.equal(f.result?.status, 'completed', JSON.stringify(f.messages.slice(-5)))
    assert.equal(f.writes.length, 1)
    assert.equal(f.imports.length, 1)
    const target = f.recovery.images.manifest.targets[0]
    assert.notEqual(f.asset.assetId, target.assetId)
    assert.equal(f.images.has(target.acceptedEvidence.nativeImageHash), false)
    assert.notEqual(f.node.fills[0].imageHash, target.acceptedEvidence.nativeImageHash)
    assert.equal(f.node.fills[0].scaleMode, scaleMode)
    assert.equal(f.result.readback.steps[0].imageEvidence.sourceSha256, target.sha256)
    assert.equal(
      f.requests.some((r) => r.url.endsWith('/assets/list') || r.url.endsWith('/v1/assets/read')),
      false
    )
    assert.equal(
      f.requests.filter((r) => r.url.endsWith('/plan/assets/read')).length,
      f.asset.chunkCount
    )
    assert.equal(f.runs[0].result.execution, undefined)
    assert.equal(f.runs[0].releases, 1)
    for (const bytes of [
      ...f.sourceBuffers,
      ...f.nativeBuffers,
      ...f.imports.map((entry) => entry.data)
    ])
      assert.ok(bytes.every((byte) => byte === 0))
  }
})

test('Figma recovery rejects prepared corruption and substituted claim bindings before image import', async () => {
  const faults = [
    {
      preparedRecovery: (value) => {
        value.images.manifest.manifestSha256 = '0'.repeat(64)
      }
    },
    {
      preparedRecovery: (value) => {
        value.images.extra = 'untrusted'
      }
    },
    {
      preparedRecovery: (value) => {
        value.images.assetBindings[0].assetId = value.images.assetBindings[0].sourceAssetId
      }
    },
    ...[
      (value) => {
        value.recovery.baselineId = '0'.repeat(32)
      },
      (value) => {
        value.recovery.images.manifest.sourcePlanSha256 = '0'.repeat(64)
      },
      (value) => {
        value.recovery.images.manifest.targets[0].targetId = '9:9'
      },
      (value) => {
        value.recovery.images.assetBindings[0].assetId = '9'.repeat(32)
      },
      (value) => {
        value.executionAssets[0].sha256 = '0'.repeat(64)
      },
      (value) => {
        value.executionAssets[0].sessionId = '0'.repeat(32)
      },
      (value) => {
        value.executionAssets[0].purpose = 'local-preview'
      },
      (value) => {
        value.plan.steps[0].assetId = value.recovery.images.manifest.assets[0].assetId
      },
      (value) => {
        value.plan.steps[0].scaleMode = 'FILL'
      },
      (value) => {
        delete value.recovery.images
      }
    ].map((intent) => ({ intent }))
  ]
  for (const fault of faults) {
    const f = fixture({ recovery: true, ...fault })
    await f.execute()
    assert.equal(f.imports.length, 0, JSON.stringify(fault))
    assert.equal(f.writes.length, 0)
    assert.notEqual(f.result?.status, 'completed')
    assert.equal(
      f.requests.some((r) => r.url.endsWith('/plan/assets/read')),
      false
    )
  }
})

test('Figma recovery failure rolls back this attempt fresh paints, not the historical accepted image', async () => {
  const f = fixture({ recovery: true, twoSteps: true })
  await f.execute()
  assert.equal(f.result?.effect, 'rolled-back', JSON.stringify(f.messages.slice(-5)))
  assert.deepEqual(f.node.fills, f.baseline)
  assert.equal(f.result.readback.steps[0].observation, 'original')
  assert.equal(f.writes.length, 2)
})

test('Figma recovery cancellation, expiry and later edits cannot resurrect an image write or rollback', async () => {
  for (const stop of ['cancel', 'expire']) {
    const waiting = gate()
    const f = fixture({ recovery: true, chunkRead: () => waiting.promise })
    await f.start()
    await f.tick(1000)
    if (stop === 'cancel') f.send({ type: 'cancel' })
    else f.setNow(f.now + 120001)
    waiting.release()
    await flush()
    assert.equal(f.writes.length, 0)
    assert.equal(f.imports.length, 0)
    assert.notEqual(f.result?.status, 'completed')
  }
  const changed = [{ type: 'SOLID', color: { r: 0.7, g: 0.1, b: 0.9 } }]
  const f = fixture({
    recovery: true,
    progress(body, native) {
      if (body.phase === 'executing') {
        native.userFills(changed)
        throw new Error('Later user edit')
      }
    }
  })
  await f.execute()
  assert.deepEqual(f.node.fills, changed)
  assert.equal(f.writes.length, 1)
  assert.notEqual(f.result?.status, 'completed')
})

test('Figma image.fill rejects stale, mixed, bound, non-normal or unbounded native fills', async () => {
  const cases = [
    (f) => {
      f.node.locked = true
    },
    (f) => {
      f.node.type = 'TEXT'
    },
    (f) => {
      f.node.type = 'INSTANCE'
    },
    (f) => {
      f.node.fillStyleId = 'style-bound'
    },
    (f) => {
      f.figma.createImage = undefined
    },
    (f) => {
      f.figma.getImageByHash = undefined
    },
    (f) => {
      f.images.clear()
    },
    (f) => {
      Object.defineProperty(f.node, 'fills', { get: () => f.figma.mixed })
    },
    (f) => {
      f.node.parent = { id: '2:1', type: 'INSTANCE', locked: false, parent: f.page }
    },
    (f) => f.userFills([{ type: 'IMAGE', imageHash: 'x'.repeat(32768), scaleMode: 'FIT' }]),
    (f) =>
      f.userFills(
        Array.from({ length: 33 }, () => ({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }))
      ),
    (f) =>
      f.userFills([
        { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: 'v' } } }
      ])
  ]
  for (const setup of cases) {
    const f = fixture({ setup })
    f.capture()
    await flush()
    const context = JSON.parse(f.messages.filter((m) => m.type === 'preview' && m.text).at(-1).text)
    assert.equal(context.nodes[0].commands.includes('image.fill'), false)
    assert.equal(f.writes.length, 0)
    assert.equal(f.imports.length, 0)
  }
  const f = fixture()
  await f.start()
  f.userFills([{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }])
  await f.tick(1000)
  assert.equal(f.writes.length, 0)
  assert.equal(f.imports.length, 0)
})

test('Figma image.fill rejects corrupt bytes, wrong claim envelopes, preview leases and native import failure', async () => {
  for (const options of [
    { corruptBytes: true },
    {
      chunkEnvelope: (reply) => {
        reply.actionId = '0'.repeat(32)
      }
    },
    {
      intent: (intent) => {
        intent.executionAssets[0].purpose = 'local-preview'
      }
    },
    {
      intent: (intent) => {
        intent.executionAssets[0].width = 3
      }
    },
    {
      intent: (intent) => {
        intent.executionAssets[0].projectId = 'unapproved_project'
      }
    },
    { importError: true }
  ]) {
    const f = fixture(options)
    await f.execute()
    assert.equal(f.writes.length, 0)
    assert.notEqual(f.result?.status, 'completed')
    assert.equal(f.runs[0].releases, 1)
    for (const bytes of f.sourceBuffers) assert.ok(bytes.every((byte) => byte === 0))
  }
})

test('Figma image.fill restores the complete captured paints after a later native failure', async () => {
  const f = fixture({ twoSteps: true })
  await f.execute()
  assert.equal(f.result?.status, 'failed')
  assert.equal(f.result.effect, 'rolled-back')
  assert.deepEqual(f.node.fills, f.baseline)
  assert.equal(f.writes.length, 2)
  assert.equal(f.result.readback.steps[0].observation, 'original')
  assert.equal(f.result.readback.steps[0].imageEvidence, undefined)
})

test('Figma image.fill never overwrites later user edits, locks, moves or native resource changes', async () => {
  const userPaint = [{ type: 'SOLID', color: { r: 0.9, g: 0.1, b: 0.2 } }]
  for (const change of [
    (f) => f.userFills(userPaint),
    (f) => {
      f.node.locked = true
    },
    (f) => {
      f.node.parent = { id: '9:9', type: 'FRAME', locked: false, parent: f.page }
    },
    (f) => {
      f.images.delete(f.imports[0].nativeHash)
    },
    (f) => {
      f.images.delete('0'.repeat(40))
    }
  ]) {
    const f = fixture({
      twoSteps: true,
      progress(body, f) {
        if (body.phase === 'executing' && body.completed === 1) change(f)
      }
    })
    await f.execute()
    assert.notEqual(f.result?.status, 'completed')
    assert.equal(f.writes.length, 1)
    if (f.node.fills[0].type === 'SOLID') assert.deepEqual(f.node.fills, userPaint)
  }
})

test('Figma image.fill reads live paints and cannot claim success for an ignored or altered setter', async () => {
  for (const setter of [
    () => {},
    (value, f) => f.userFills([{ ...value[0], imageHash: 'unrelated-image' }]),
    (value, f) => f.userFills([{ ...value[0], filters: { exposure: 0.7 } }])
  ]) {
    const f = fixture({ setter })
    await f.execute()
    assert.notEqual(f.result?.status, 'completed')
    assert.notEqual(f.result?.readback.steps[0].observation, 'requested')
    assert.equal(f.result?.readback.steps[0].imageEvidence, undefined)
  }
})

test('Figma image.fill cancellation or expiry during resource await cannot produce a late write', async () => {
  for (const stage of ['chunk', 'native']) {
    for (const stop of ['cancel', 'expire']) {
      const waiting = gate()
      const options =
        stage === 'chunk'
          ? { chunkRead: () => waiting.promise }
          : { nativeRead: () => waiting.promise }
      const f = fixture(options)
      await f.execute()
      if (stop === 'cancel') f.send({ type: 'cancel' })
      else f.setNow(f.asset.expiresAt)
      waiting.release()
      await flush()
      assert.equal(f.writes.length, 0, stage + '/' + stop)
      assert.notEqual(f.result?.status, 'completed')
      assert.equal(f.runs[0].releases, 1)
      for (const bytes of [...f.sourceBuffers, ...f.nativeBuffers])
        assert.ok(bytes.every((byte) => byte === 0))
    }
  }
})

test('Figma image.fill cancel or revoked authority after a write never starts another write or rollback', async () => {
  for (const stop of ['cancel', 'expire', 'revoke']) {
    let revoked = false
    const f = fixture({
      twoSteps: true,
      progress(body, f) {
        if (body.phase !== 'executing') return
        if (stop === 'cancel') f.send({ type: 'cancel' })
        else if (stop === 'expire') f.setNow(f.asset.expiresAt)
        else revoked = true
      },
      authority(reply) {
        if (revoked) reply.state = 'cancelled'
      }
    })
    await f.execute()
    assert.equal(f.writes.length, 1, stop)
    assert.equal(f.node.fills[0].type, 'IMAGE')
    assert.notEqual(f.result?.status, 'completed')
  }
})

test('Figma image.fill final progress wait rechecks the native paints before emitting success', async () => {
  const f = fixture({
    progress(body, f) {
      if (body.phase === 'readback') f.userFills([{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }])
    }
  })
  await f.execute()
  assert.equal(f.result?.status, 'failed')
  assert.equal(f.result.effect, 'unknown')
  assert.equal(f.result.readback.steps[0].observation, 'other')
  assert.equal(f.result.readback.steps[0].imageEvidence, undefined)
  assert.equal(f.writes.length, 1)
})

test('Figma image.fill accepts native default normalization but retains the full observed fingerprint', async () => {
  const f = fixture({
    setter(value, f) {
      f.userFills(
        value.map((paint) => ({
          ...paint,
          boundVariables: {},
          rotation: 0,
          scalingFactor: 1,
          imageTransform: [
            [1, 0, 0],
            [0, 1, 0]
          ],
          filters: { exposure: 0, contrast: 0 }
        }))
      )
    }
  })
  await f.execute()
  assert.equal(f.result?.status, 'completed')
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])])
          )
        : value
  assert.equal(
    f.result.readback.steps[0].imageEvidence.fillsSha256,
    hash(JSON.stringify(canonical(f.node.fills)))
  )
})

test('Figma image.fill observes a partial native setter failure and restores only its own paint', async () => {
  const f = fixture({
    setter(value, f, count) {
      f.userFills(value)
      if (count === 1) throw new Error('Setter failed after applying its paint')
    }
  })
  await f.execute()
  assert.equal(f.result?.status, 'failed')
  assert.equal(f.result.effect, 'rolled-back')
  assert.deepEqual(f.node.fills, f.baseline)
  assert.equal(f.writes.length, 2)
})

test('Figma image.fill cannot use a mutated current catalog as the approved planning metadata', async () => {
  let listing = 0
  const f = fixture({
    catalog(value) {
      if (++listing > 1) value.assets = value.assets.map((asset) => ({ ...asset, width: 3 }))
    }
  })
  await f.start()
  f.send({ type: 'refresh-session-assets', nonce: '2'.repeat(32) })
  await flush()
  await f.tick(1000)
  assert.equal(f.result?.status, 'completed')
  assert.equal(f.imports.length, 1)
})

test("Figma image.fill native re-read changes invalidate evidence without restoring someone else's resource", async () => {
  const f = fixture({
    progress(body, f) {
      if (body.phase === 'executing') {
        const image = f.images.get(f.imports[0].nativeHash)
        image.getBytesAsync = async () => {
          const data = new Uint8Array(syntheticPng(11))
          f.nativeBuffers.push(data)
          return data
        }
      }
    }
  })
  await f.execute()
  assert.equal(f.result?.status, 'failed')
  assert.equal(f.result.readback.steps[0].observation, 'other')
  assert.equal(f.result.readback.steps[0].imageEvidence, undefined)
  assert.equal(f.writes.length, 1)
  for (const data of f.nativeBuffers) assert.ok(data.every((byte) => byte === 0))
})

test('Figma image.fill cancellation between source chunks releases the partial assembly without importing', async () => {
  const waiting = gate()
  const f = fixture({
    chunked: true,
    chunkRead(body) {
      if (body.index === 1) return waiting.promise
    }
  })
  await f.execute()
  assert.equal(f.requests.filter((request) => request.url.endsWith('/plan/assets/read')).length, 2)
  f.send({ type: 'cancel' })
  waiting.release()
  await flush()
  assert.equal(f.imports.length, 0)
  assert.equal(f.writes.length, 0)
  assert.equal(f.runs[0].releases, 1)
  assert.equal(
    f.sourceBuffers.length,
    0,
    'cancelled partial bytes are never published by the reader'
  )
})

test('Figma image.fill a failed progress transport rechecks authority before rollback', async () => {
  let revoked = false
  const f = fixture({
    progress(body) {
      if (body.phase === 'executing') {
        revoked = true
        throw new Error('Execution revoked while the receipt was in flight')
      }
    },
    authority(reply) {
      if (revoked) reply.state = 'cancelled'
    }
  })
  await f.execute()
  assert.equal(f.writes.length, 1)
  assert.equal(f.result, undefined)
  assert.equal(f.node.fills[0].type, 'IMAGE')
})

test('Figma image.fill cancellation during final native readback cannot report success or rollback', async () => {
  const waiting = gate()
  let reads = 0
  const f = fixture({
    nativeRead() {
      if (++reads === 2) return waiting.promise
    }
  })
  await f.execute()
  assert.equal(f.writes.length, 1)
  f.send({ type: 'cancel' })
  waiting.release()
  await flush()
  assert.equal(f.writes.length, 1)
  assert.equal(f.result, undefined)
  for (const bytes of [...f.sourceBuffers, ...f.nativeBuffers])
    assert.ok(bytes.every((byte) => byte === 0))
})

test('Figma image.fill replay fence blocks a duplicate action without importing another image', async () => {
  const f = fixture()
  await f.execute()
  assert.equal(f.result?.status, 'completed')
  const recorded = new Map(f.journal)
  const next = fixture({
    setup(next) {
      for (const [key, value] of recorded) next.journal.set(key, value)
    }
  })
  await next.execute()
  assert.equal(next.imports.length, 0)
  assert.equal(next.writes.length, 0)
  assert.notEqual(next.result?.status, 'completed')
  assert.equal(next.result?.errorCode, 'QUARANTINED')
})

test('Figma image.fill supports inherited native APIs and does not invent a native-byte proof when unavailable', async () => {
  const f = fixture({
    setup(f) {
      const createImage = f.figma.createImage
      const getImageByHash = f.figma.getImageByHash
      delete f.figma.createImage
      delete f.figma.getImageByHash
      Object.setPrototypeOf(f.figma, {
        createImage(bytes) {
          const image = createImage(bytes)
          delete image.getBytesAsync
          return image
        },
        getImageByHash
      })
    }
  })
  await f.execute()
  assert.equal(f.result?.status, 'completed')
  assert.equal(f.nativeBuffers.length, 0)
  assert.equal(f.result.readback.steps[0].imageEvidence.nativeImageHash, f.imports[0].nativeHash)
})

test('Figma image.fill revalidates locks and spatial bounds after native resource awaits', async () => {
  for (const change of [
    (f) => {
      f.node.locked = true
    },
    (f) => {
      f.node.absoluteBoundingBox.width = 110
    },
    (f) => {
      f.page.selection = []
    }
  ]) {
    let changed = false
    const f = fixture({
      nativeRead(f) {
        if (!changed) {
          changed = true
          change(f)
        }
      }
    })
    await f.execute()
    assert.equal(f.writes.length, 0)
    assert.notEqual(f.result?.status, 'completed')
    for (const bytes of f.sourceBuffers) assert.ok(bytes.every((byte) => byte === 0))
  }
})

test('Figma image.fill native image reads have a bounded deadline and clear late byte results', async () => {
  const waiting = gate()
  const f = fixture({ nativeRead: () => waiting.promise })
  await f.execute()
  assert.equal(f.imports.length, 1)
  await f.tick(15000)
  assert.equal(f.writes.length, 0)
  assert.equal(f.runs[0].releases, 1)
  waiting.release()
  await flush()
  assert.equal(f.writes.length, 0)
  assert.equal(f.imports.length, 1)
  assert.notEqual(f.result?.status, 'completed')
  for (const bytes of [...f.sourceBuffers, ...f.nativeBuffers])
    assert.ok(bytes.every((byte) => byte === 0))
})
