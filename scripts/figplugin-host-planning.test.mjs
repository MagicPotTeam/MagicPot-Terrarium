import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { buildHostPlanPreview } from './build-figplugin-plan-preview.mjs'

const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve()
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const fakePng = (label) => {
  const data = new Uint8Array(32)
  data.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  data.set([0, 0, 0, 13, 73, 72, 68, 82], 8)
  const view = new DataView(data.buffer)
  view.setUint32(16, 64, false)
  view.setUint32(20, 32, false)
  let marker = 0
  for (const char of String(label)) marker = (marker + char.codePointAt(0)) & 0xff
  data.set([marker, marker ^ 0x55, marker ^ 0xaa, 0xff, 1, 2, 3, 4], 24)
  return data
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
    failSecond = false
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
  const document = { id: 5, activeLayers: [] }
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
  if (host === 'figma') {
    for (const item of [node, second]) {
      item.width = 64
      item.height = 32
      item.exportAsync = async () => fakePng(item.name)
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
    currentPage: page,
    showUI() {},
    on() {},
    closePlugin() {},
    ui: { postMessage: (value) => posts.push(plain(value)) }
  }
  const origin = 'http://127.0.0.1:49152',
    pluginId = 'owned.' + host
  const sessionId = 'b'.repeat(32),
    sessionToken = 'c'.repeat(64),
    callId = 'd'.repeat(32)
  let approvedContext
  let planResult = null
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
      else if (url.endsWith('/prepare')) {
        approvedContext = body.hostContext
        value = { protocol: 1, callId, status: 'awaiting-approval', expiresAt: time + 120_000 }
      } else if (url.endsWith('/plan/status')) {
        value = {
          protocol: 1,
          executionId: '8'.repeat(32),
          callId,
          state: approvePlan ? 'approved' : 'awaiting-approval',
          completed: 0,
          total: twoSteps ? 2 : 1,
          effect: 'none',
          updatedAt: time
        }
      } else if (url.endsWith('/plan/claim')) {
        const selected = approvedContext.nodes[0]
        value = {
          protocol: 1,
          status: 'ready',
          intent: {
            protocol: 1,
            purpose: 'execute-host-plan',
            executionId: '8'.repeat(32),
            callId,
            pluginId,
            host,
            documentId: approvedContext.documentId,
            scopeId: approvedContext.scopeId,
            captureId: approvedContext.captureId,
            plan: {
              schemaVersion: 2,
              kind: 'host-plan',
              captureId: approvedContext.captureId,
              steps: plannedSteps()
            },
            planSha256: '9'.repeat(64),
            expiresAt: time + 120000,
            adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
            actionId: '8'.repeat(32)
          }
        }
      } else if (url.endsWith('/plan/progress')) {
        value = {
          protocol: 1,
          executionId: '8'.repeat(32),
          callId,
          state: body.phase,
          completed: body.completed,
          total: body.total,
          effect: body.effect,
          updatedAt: time
        }
      } else if (url.endsWith('/plan/result')) {
        planResult = body
        value = {
          protocol: 1,
          executionId: '8'.repeat(32),
          status: {
            protocol: 1,
            executionId: '8'.repeat(32),
            callId,
            state: body.status === 'completed' ? 'completed' : 'failed',
            completed: body.completed,
            total: body.total,
            effect: body.effect,
            updatedAt: time,
            ...(body.visualEvidence ? { visualEvidence: body.visualEvidence } : {})
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
            return callback()
          }
        },
        imaging: {
          async getPixels(request) {
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
  new Script(read('shared/visual-evidence.js')).runInContext(vm)
  new Script(read('shared/plan-preview.js')).runInContext(vm)
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
    vm,
    posts,
    element,
    planResult: () => planResult,
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
