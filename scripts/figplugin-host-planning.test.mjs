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
    tamperRecovery = false
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
  const document = {
    id: nativeDocumentId,
    activeLayers: [],
    layers: [],
    width: 320,
    height: 180,
    resolution: 300,
    pixelAspectRatio: 1
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
  const app = Object.freeze({ activeDocument: document, documents: [document] })
  const figma = {
    root: rootNode,
    async loadFontAsync(font) {
      fontLoads.push(plain(font))
      if (fontGate) await fontGate({ node, font })
      loadedFonts.add(JSON.stringify(font))
    },
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
    ...(journalAvailable ? { localStorage } : {}),
    AbortController,
    ...(nativeTextEncoding ? { TextEncoder, TextDecoder } : {}),
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
