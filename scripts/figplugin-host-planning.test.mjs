import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
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

function fixture(
  host,
  {
    corruptResult = false,
    locked = false,
    approvePlan = false,
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
    authorityHook = null
  } = {}
) {
  let time = 1_800_000_000_000,
    serial = 0
  const timers = new Map(),
    posts = [],
    requests = [],
    elements = new Map()
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        textContent: '',
        checked: false,
        disabled: false,
        handlers: {},
        addEventListener(name, fn) {
          this.handlers[name] = fn
        }
      })
    return elements.get(id)
  }
  const rootNode = { id: '0:0', type: 'DOCUMENT' }
  const page = { id: '0:1', type: 'PAGE', name: 'Owned page', parent: rootNode, selection: [] }
  const document = { id: 5, activeLayers: [], layers: [] }
  const data =
    host === 'figma'
      ? {
          id: '1:2',
          type: 'RECTANGLE',
          name: 'Original owned name',
          parent: page,
          locked,
          visible: true
        }
      : {
          id: 7,
          kind: 'pixel',
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
  const app = Object.freeze({ activeDocument: document, documents: [document] })
  const figma = {
    root: rootNode,
    ...(journalAvailable ? { clientStorage } : {}),
    currentPage: page,
    showUI() {},
    on() {},
    closePlugin() {},
    getNodeById(id) {
      return [rootNode, page, node, second].find((item) => item.id === id) || null
    },
    ui: { postMessage: (value) => posts.push(plain(value)) }
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
  let planResult = null
  let lastResultStatus = null
  const planResults = []
  const claimedExecutions = new Set()
  const plannedSteps = () => {
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
    ...(journalAvailable ? { localStorage } : {}),
    AbortController,
    TextEncoder,
    TextDecoder,
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
      else if (url.endsWith('/plan/correction/prepare')) {
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
      } else if (url.endsWith('/plan/claim')) {
        claimedExecutions.add(body.executionId || sourceExecutionId)
        const correction = body.executionId === correctionExecutionId
        const context = correction ? correctionContext : approvedContext
        const selected = context.nodes[0]
        const authorizationTargets = [approvedContext.nodes[0].id]
        value = {
          protocol: 1,
          status: 'ready',
          intent: {
            protocol: 1,
            purpose: 'execute-host-plan',
            executionId: correction ? correctionExecutionId : sourceExecutionId,
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
              steps: correction
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
            actionId: correction ? 'e'.repeat(32) : sourceExecutionId,
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
        value = {
          protocol: 1,
          callId,
          status: 'completed',
          content: JSON.stringify({
            kind: 'host-plan-preview',
            executable: !corruptResult,
            plan,
            risk: twoSteps ? 'medium' : 'low',
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
              before: approvedContext.nodes.find((item) => item.id === step.targetId)?.name,
              after: step.name
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
      return {
        app,
        core: {
          async executeAsModal(callback) {
            if (modalGate) await modalGate()
            return callback()
          }
        },
        imaging: {
          async getPixels(request) {
            if (visualGate) await visualGate({ node, second })
            const layer = [node, second].find((item) => item.id === request.layerID)
            assert.ok(layer)
            return {
              imageData: {
                width: 2,
                height: 1,
                components: 4,
                componentSize: 8,
                pixelFormat: 'RGBA',
                colorSpace: 'RGB',
                colorProfile: 'sRGB IEC61966-2.1',
                async getData() {
                  return fakePixels(layer.name)
                },
                dispose() {}
              }
            }
          }
        }
      }
    },
    document: { readyState: 'complete', getElementById: element, addEventListener() {} },
    window: { addEventListener() {} }
  }
  const vm = createContext(sandbox)
  new Script(
    `globalThis.MAGICPOT_BRIDGE_CONFIG = Object.freeze(${JSON.stringify({ protocol: 1, origin, pluginId, host })});`
  ).runInContext(vm)
  new Script(read('shared/selection-snapshot.js')).runInContext(vm)
  new Script(read('shared/pixel-audit.js')).runInContext(vm)
  new Script(read('shared/visual-evidence.js')).runInContext(vm)
  new Script(read('shared/plan-preview.js')).runInContext(vm)
  if (journalHelper) new Script(read('shared/execution-journal.js')).runInContext(vm)
  new Script(
    read(host === 'figma' ? 'figma/bridge/code.js' : 'photoshop-uxp/bridge/main.js')
  ).runInContext(vm)
  const send = (message) => figma.ui.onmessage({ protocol: 1, ...message })
  const click = (id) => element(id).handlers.click()
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
    if (host === 'figma')
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
    tick,
    output,
    requests,
    node,
    second,
    vm,
    posts,
    element,
    cancel: () => (host === 'figma' ? send({ type: 'cancel' }) : click('cancel')),
    nativeWrites,
    persistedActions,
    planResult: () => planResult,
    planResults: () => planResults.map(plain),
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
