import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FigPluginBridgeError,
  type FigPluginBridgePrepareRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { executionAssetFromSessionAsset } from '@shared/figplugin/hostExecutionAssets'
import { planningAssetMetadata } from '@shared/figplugin/hostPlanningAssets'
import {
  createHostPlanReadback,
  nodeValue,
  stepValue,
  type HostContext,
  type HostPlan
} from '@shared/figplugin/hostPlan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  type FigPluginExecutionIntent,
  type FigPluginExecutionPreview,
  type FigPluginExecutionResultRequest
} from '@shared/figplugin/execution'
import { figPluginExecutionAuditEventSchema } from '@shared/figplugin/executionAudit'
import type { FigPluginExecutionAuditEvent } from './executionAudit'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { MemoryNativeWriteCoordinator } from './nativeWriteCoordinator'
import type { SavedCheckpoint } from './checkpointStore'

type Host = FigPluginRuntimeBinding['host']
type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const initialTime = 1_800_000_000_000
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalFigPluginJson(value)).digest('hex')
const reference = ({ assetId, sha256 }: FigPluginSessionAsset) => ({ assetId, sha256 })
const bindingFor = (host: Host): FigPluginRuntimeBinding => ({
  pluginId: `owned.${host}`,
  host,
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'image-project',
  profileId: 'synthetic-no-provider',
  profileRevision: 'd'.repeat(64)
})
const contextFor = (host: Host, width = 2, height = 2): HostContext => {
  const imageCommand = host === 'figma' ? 'image.fill' : 'image.pixels'
  return {
    version: 1,
    host,
    documentId: host === 'figma' ? 'document' : '7',
    scopeId: host === 'figma' ? 'page' : '7',
    captureId: 'e'.repeat(32),
    recoveryIdentity: 'f'.repeat(32),
    selectedIds: ['node'],
    execution: {
      mode: 'native-write',
      adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
      supports: [imageCommand, 'node.rename'],
      rollback: 'verified-in-place',
      visualAudit: 'hash-only'
    },
    nodes: [
      {
        id: 'node',
        type: host === 'figma' ? 'RECTANGLE' : 'pixel',
        name: 'Synthetic target',
        parentId: host === 'figma' ? 'page' : '7',
        ancestors: [],
        locked: false,
        visible: true,
        commands: [imageCommand, 'node.rename'],
        ...(host === 'figma'
          ? { imageFill: { status: 'available' as const, fingerprint: '1'.repeat(64) } }
          : {
              imagePixels: {
                status: 'available' as const,
                historyStateId: 7,
                bounds: { left: -10, top: 20, right: width - 10, bottom: height + 20 },
                width,
                height
              }
            })
      }
    ]
  }
}
const imagePlan = (context: HostContext, asset: FigPluginSessionAsset): HostPlan => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: context.captureId,
  steps: [
    context.host === 'figma'
      ? { command: 'image.fill', targetId: 'node', ...reference(asset), scaleMode: 'FIT' }
      : { command: 'image.pixels', targetId: 'node', ...reference(asset) }
  ]
})
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
const pngChunk = (type: string, data: Buffer) => {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}
const png = (width = 2, height = 2, red = 40) => {
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  let seed = red + 1
  // Deterministic high-entropy synthetic pixels exercise multiple transfer chunks.
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = row * (width * 4 + 1) + 1 + column * 4
      for (let channel = 0; channel < 3; channel++) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        pixels[offset + channel] = seed & 255
      }
      pixels[offset + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const runtimes: FigPluginBridgeRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

const fixture = async (host: Host, options: Partial<Options> = {}) => {
  let now = initialTime
  let allowed = true
  let nativeWrite = true
  let ceiling = FIGPLUGIN_ASSET_MAX_BYTES
  let validate: Options['validateBinding'] = async () => true
  let response = ''
  const invoked: Parameters<Options['invoke']>[1][] = []
  const audit: FigPluginExecutionAuditEvent[] = []
  const writes = new MemoryNativeWriteCoordinator(() => now)
  const runtime = new FigPluginBridgeRuntime({
    now: () => now,
    validateBinding: (binding) => validate(binding),
    allowAssetTransfer: () => allowed,
    assetByteLimit: () => ceiling,
    allowNativeWrite: () => nativeWrite,
    writes,
    audit: (event) => audit.push(structuredClone(event)),
    invoke: async (_binding, preview, _signal, _correlation, dispatched, check) => {
      check()
      dispatched()
      invoked.push(structuredClone(preview))
      return { content: response }
    },
    ...options
  })
  runtimes.push(runtime)
  const binding = bindingFor(host)
  const pair = async (value = binding): Promise<FigPluginPairResponse> => {
    const ticket = await runtime.createPairing(value)
    return runtime.redeem({
      protocol: 1,
      ticketId: ticket.ticketId,
      pairingSecret: ticket.pairingSecret,
      pluginId: ticket.pluginId,
      host: ticket.host,
      artifactSha256: ticket.artifactSha256,
      clientNonce: '2'.repeat(32)
    })
  }
  const session = await pair()
  const target = {
    sessionId: session.sessionId,
    pluginId: binding.pluginId,
    projectId: binding.projectId
  }
  const context = contextFor(host)
  let sequence = 0
  const publish = async (width = 2, height = 2, red = 40) => {
    const bytes = png(width, height, red)
    const asset = await runtime.publishSessionAsset(
      await runtime.beginSessionAssetSelection(target),
      {
        mimeType: 'image/png',
        width,
        height,
        bytes
      }
    )
    return { asset, bytes }
  }
  const prepare = async (
    asset?: FigPluginSessionAsset,
    options: {
      context?: HostContext
      plan?: HostPlan
      content?: unknown
      assets?: FigPluginSessionAsset[]
    } = {}
  ) => {
    const captured = options.context ?? context
    const plan = options.plan ?? imagePlan(captured, asset!)
    response = JSON.stringify(options.content ?? { plan })
    const references = options.assets ?? (asset ? [asset] : [])
    const input: FigPluginBridgePrepareRequest = {
      protocol: 1,
      sequence: ++sequence,
      requestId: `synthetic-image-${sequence}`,
      prompt: 'Apply only the reviewed image to the selected native target',
      context: {
        selectionRevision: captured.captureId,
        nodes: captured.nodes.map(({ id, type, name, locked }) => ({ id, type, name, locked }))
      },
      featureId: 'plan-preview',
      hostContext: captured,
      ...(references.length ? { assetReferences: references.map(reference) } : {})
    }
    const receipt = await runtime.prepare(session.sessionId, session.sessionToken, input)
    const approval = runtime.listPreviews().find((preview) => preview.callId === receipt.callId)!
    return { receipt, approval, input, plan, context: captured }
  }
  const finishPlanning = async (prepared: Awaited<ReturnType<typeof prepare>>) => {
    await runtime.approve(prepared.receipt.callId, prepared.approval.payloadSha256)
    for (let tries = 0; tries < 20; tries++) {
      const result = await runtime.status(
        session.sessionId,
        session.sessionToken,
        prepared.receipt.callId
      )
      if (result.status === 'completed' || result.status === 'failed') return result
    }
    throw new Error('Synthetic planning did not settle')
  }
  const planned = async (
    asset: FigPluginSessionAsset,
    options: Parameters<typeof prepare>[1] = {}
  ) => {
    const prepared = await prepare(asset, options)
    expect((await finishPlanning(prepared)).status).toBe('completed')
    const execution = runtime
      .listPlanExecutions()
      .find((entry) => entry.callId === prepared.receipt.callId)
    if (!execution) throw new Error('Expected independently approved native image preview')
    return { ...prepared, execution }
  }
  const claim = (execution: FigPluginExecutionPreview) =>
    runtime.claimPlan(session.sessionId, session.sessionToken, {
      protocol: 1,
      callId: execution.callId,
      executionId: execution.executionId
    })
  const claimed = async (
    execution: FigPluginExecutionPreview
  ): Promise<FigPluginExecutionIntent> => {
    await runtime.approvePlan(execution.executionId, execution.planSha256)
    const result = await claim(execution)
    if (result.status !== 'ready') throw new Error(`Expected ready claim, got ${result.status}`)
    return result.intent
  }
  const readRequest = (
    execution: FigPluginExecutionPreview,
    asset: FigPluginSessionAsset,
    index = 0
  ) => ({
    protocol: 1,
    purpose: 'host-plan-execution',
    callId: execution.callId,
    executionId: execution.executionId,
    actionId: execution.executionId,
    planSha256: execution.planSha256,
    ...reference(asset),
    index
  })
  const read = (execution: FigPluginExecutionPreview, asset: FigPluginSessionAsset, index = 0) =>
    runtime.planAssetChunk(
      session.sessionId,
      session.sessionToken,
      readRequest(execution, asset, index)
    )
  const status = (execution: FigPluginExecutionPreview) =>
    runtime.planStatus(session.sessionId, session.sessionToken, {
      protocol: 1,
      callId: execution.callId,
      executionId: execution.executionId
    })
  const progress = (execution: FigPluginExecutionPreview) => ({
    protocol: 1 as const,
    executionId: execution.executionId,
    actionId: execution.executionId,
    sequence: 2,
    phase: 'executing' as const,
    index: 0,
    completed: execution.plan.steps.length,
    total: execution.plan.steps.length,
    effect: 'applied' as const,
    at: now
  })
  const pixelEvidence = (captured: HostContext, sourceSha256: string) => {
    const pixels = captured.nodes[0].imagePixels
    if (pixels?.status !== 'available') throw new Error('Synthetic pixel context unavailable')
    return {
      kind: 'photoshop-pixels' as const,
      sourceSha256,
      pixelSha256: '3'.repeat(64),
      width: pixels.width,
      height: pixels.height,
      bounds: pixels.bounds
    }
  }
  const result = (
    execution: FigPluginExecutionPreview,
    captured = context
  ): FigPluginExecutionResultRequest => ({
    protocol: 1,
    executionId: execution.executionId,
    actionId: execution.executionId,
    status: 'completed',
    effect: 'applied',
    completed: execution.plan.steps.length,
    total: execution.plan.steps.length,
    readback: {
      version: 1,
      kind: 'host-plan-readback',
      host,
      documentId: captured.documentId,
      scopeId: captured.scopeId,
      captureId: captured.captureId,
      steps: execution.plan.steps.map((step) => ({
        command: step.command,
        targetId: step.targetId,
        observation: 'requested',
        value: stepValue(step),
        ...('assetId' in step
          ? {
              imageEvidence:
                host === 'figma'
                  ? {
                      kind: 'figma-image-fill' as const,
                      sourceSha256: step.sha256,
                      nativeImageHash: 'synthetic-native-image',
                      fillsSha256: '3'.repeat(64)
                    }
                  : pixelEvidence(captured, step.sha256)
            }
          : {})
      }))
    },
    visualEvidence: [
      {
        targetId: 'node',
        before: { sha256: '4'.repeat(64), width: 2, height: 2 },
        after: { sha256: '5'.repeat(64), width: 2, height: 2 },
        changed: true
      }
    ]
  })
  return {
    runtime,
    binding,
    session,
    target,
    context,
    pair,
    publish,
    prepare,
    finishPlanning,
    planned,
    claim,
    claimed,
    readRequest,
    read,
    status,
    progress,
    result,
    invoked,
    audit,
    writes,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    setAllowed: (value: boolean) => {
      allowed = value
    },
    setNativeWrite: (value: boolean) => {
      nativeWrite = value
    },
    setCeiling: (value: number) => {
      ceiling = value
    },
    setValidation: (value: Options['validateBinding']) => {
      validate = value
    },
    revoke: (asset: FigPluginSessionAsset) =>
      runtime.revokeSessionAsset({ ...target, ...reference(asset) })
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const outcome = async (operation: () => unknown) => {
  try {
    return { value: await operation() }
  } catch (error) {
    return { error }
  }
}
const terminalEvents = (f: Fixture, execution: FigPluginExecutionPreview) =>
  f.audit.filter(
    (event) =>
      event.executionId === execution.executionId &&
      ['cancelled', 'expired', 'failed', 'denied'].includes(event.state)
  )

describe.each(['figma', 'photoshop'] as const)('%s runtime image execution integration', (host) => {
  it('uses real owned bytes, recomputes independent high-risk approval and requires the exact active claim', async () => {
    const f = await fixture(host)
    const { asset, bytes } = await f.publish(128, 100)
    const omitted = await f.publish()
    const context = contextFor(host, 128, 100)
    const plan = imagePlan(context, asset)
    const prepared = await f.prepare(asset, {
      context,
      assets: [omitted.asset, asset],
      content: {
        plan,
        executable: true,
        risk: 'low',
        differences: [],
        executionAssets: [omitted.asset],
        execution: { rollback: 'none' }
      }
    })
    expect(asset.chunkCount).toBeGreaterThan(1)
    expect(f.runtime.listPlanExecutions()).toEqual([])
    expect(f.invoked).toEqual([])
    expect(prepared.approval.assetCatalog?.assets).toEqual([
      planningAssetMetadata(omitted.asset),
      planningAssetMetadata(asset)
    ])
    expect(JSON.stringify(prepared.approval)).not.toContain(bytes.toString('base64'))
    expect((await f.finishPlanning(prepared)).status).toBe('completed')
    const execution = f.runtime.listPlanExecutions()[0]
    expect(execution).toMatchObject({
      state: 'awaiting-approval',
      risk: 'high',
      requiresWriteApproval: true,
      plan,
      rollback: host === 'photoshop' ? 'native-history' : 'verified-in-place',
      planSha256: digest(plan),
      contextSha256: digest(context),
      executionAssets: [executionAssetFromSessionAsset(asset, { ...f.target, host }, f.now())],
      differences: [
        {
          targetId: 'node',
          command: plan.steps[0].command,
          before: nodeValue(context.nodes[0], plan.steps[0].command),
          after: stepValue(plan.steps[0])
        }
      ]
    })
    const original = structuredClone(execution)
    execution.executionAssets![0].sha256 = '9'.repeat(64)
    Object.assign(execution.differences[0].after as object, { sha256: '8'.repeat(64) })
    Object.assign(execution.differences[0].before as object, { fingerprint: '7'.repeat(64) })
    execution.differences[0].after = 'forged desktop copy'
    expect(f.runtime.listPlanExecutions()[0]).toEqual(original)
    expect(await f.claim(original)).toMatchObject({ status: 'pending', state: 'awaiting-approval' })
    await expect(f.read(original, asset)).rejects.toMatchObject({ code: 'DENIED' })
    await expect(f.runtime.approvePlan(original.executionId, '9'.repeat(64))).rejects.toMatchObject(
      { code: 'INVALID_REQUEST' }
    )
    await f.runtime.approvePlan(original.executionId, original.planSha256)
    await expect(f.read(original, asset)).rejects.toMatchObject({ code: 'DENIED' })
    const claim = await f.claim(original)
    if (claim.status !== 'ready') throw new Error('Missing approved intent')
    expect(claim.intent.executionAssets).toEqual(original.executionAssets)
    expect(claim.intent.plan).toEqual(plan)
    expect(await f.claim(original)).toEqual(claim)
    const chunks: Buffer[] = []
    for (let index = 0; index < asset.chunkCount; index++) {
      const chunk = await f.read(original, asset, index)
      expect(chunk).toMatchObject({
        purpose: 'host-plan-execution',
        callId: original.callId,
        executionId: original.executionId,
        actionId: claim.intent.actionId,
        planSha256: original.planSha256,
        assetId: asset.assetId,
        sessionId: f.session.sessionId,
        chunk: { sha256: asset.sha256, index, chunkCount: asset.chunkCount }
      })
      chunks.push(Buffer.from(chunk.chunk.bytesBase64, 'base64'))
    }
    expect(Buffer.concat(chunks)).toEqual(bytes)
    expect(sha256(Buffer.concat(chunks))).toBe(asset.sha256)
    await expect(f.read(original, omitted.asset)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(
      f.runtime.planProgress(f.session.sessionId, f.session.sessionToken, f.progress(original))
    ).toMatchObject({ state: 'executing', effect: 'applied', completed: 1 })
    const request = f.result(original, context)
    const result = f.runtime.planResult(f.session.sessionId, f.session.sessionToken, request)
    expect(result.status).toMatchObject({ state: 'completed', effect: 'applied' })
    expect(f.runtime.planResult(f.session.sessionId, f.session.sessionToken, request)).toEqual(
      result
    )
    expect(await f.claim(original)).toMatchObject({ status: 'terminal', state: 'completed' })
    await expect(f.read(original, asset)).rejects.toMatchObject({ code: 'DENIED' })
    expect(f.audit.map((event) => event.state)).toEqual([
      'awaiting-approval',
      'approved',
      'claimed',
      'executing',
      'completed'
    ])
    expect(f.audit.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(f.audit.map((event) => event.correlationId)).size).toBe(1)
    for (const event of f.audit)
      expect(figPluginExecutionAuditEventSchema.safeParse(event).success).toBe(true)
    expect(JSON.stringify(f.audit)).not.toMatch(
      /bytesBase64|executionAssets|Synthetic target|synthetic-native-image/
    )
    expect(f.audit[0].previewSha256).toBe(
      digest({
        plan: original.plan,
        differences: original.differences,
        risk: original.risk,
        planSha256: original.planSha256,
        contextSha256: original.contextSha256,
        adapterVersion: original.adapterVersion,
        rollback: original.rollback,
        visualAudit: original.visualAudit,
        executionAssets: original.executionAssets
      })
    )
  })

  it.each([
    'unselected',
    'wrong-hash',
    'missing-catalog',
    'url',
    'path',
    'unsupported-target'
  ] as const)(
    'does not mint execution authority for a %s model image proposal',
    async (variation) => {
      const f = await fixture(host)
      const { asset } = await f.publish()
      const other = await f.publish(2, 2, 90)
      const context = structuredClone(f.context)
      const plan = imagePlan(context, variation === 'unselected' ? other.asset : asset)
      if (variation === 'wrong-hash') Object.assign(plan.steps[0], { sha256: '9'.repeat(64) })
      if (variation === 'url')
        Object.assign(plan.steps[0], { url: 'https://untrusted.invalid/source.png' })
      if (variation === 'path') Object.assign(plan.steps[0], { path: 'C:/untrusted/source.png' })
      if (variation === 'unsupported-target') context.nodes[0].commands = ['node.rename']
      const prepared = await f.prepare(asset, {
        context,
        plan,
        assets: variation === 'missing-catalog' ? [] : [asset]
      })
      await f.finishPlanning(prepared)
      expect(f.runtime.listPlanExecutions()).toEqual([])
      expect(f.audit).toEqual([])
    }
  )

  it('keeps source receipts, catalogs, reads, progress and results bound to their exact owning session', async () => {
    const f = await fixture(host)
    const { asset } = await f.publish()
    const other = await f.pair()
    const selection = await f.runtime.beginSessionAssetSelection(f.target)
    await expect(
      f.runtime.publishSessionAsset(
        { ...selection },
        { mimeType: 'image/png', width: 2, height: 2, bytes: png() }
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const prepared = await f.prepare(asset)
    await expect(
      f.runtime.prepare(other.sessionId, other.sessionToken, prepared.input)
    ).rejects.toMatchObject({ code: 'EXPIRED' })
    await f.finishPlanning(prepared)
    const execution = f.runtime.listPlanExecutions()[0]
    await f.claimed(execution)
    await expect(
      f.runtime.planAssetChunk(other.sessionId, other.sessionToken, f.readRequest(execution, asset))
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.planAssetChunk(
        f.session.sessionId,
        other.sessionToken,
        f.readRequest(execution, asset)
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.claimPlan(other.sessionId, other.sessionToken, {
        protocol: 1,
        callId: execution.callId
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.planStatus(other.sessionId, other.sessionToken, {
        protocol: 1,
        callId: execution.callId
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(() =>
      f.runtime.planProgress(other.sessionId, other.sessionToken, f.progress(execution))
    ).toThrow(FigPluginBridgeError)
    expect(() =>
      f.runtime.planResult(other.sessionId, other.sessionToken, f.result(execution))
    ).toThrow(FigPluginBridgeError)
    expect(await f.status(execution)).toMatchObject({ state: 'claimed' })
  })

  it('rejects wrong action, call, execution, asset, hash, index, purpose and extra read fields without invalidating the real grant', async () => {
    const f = await fixture(host)
    const { asset, bytes } = await f.publish()
    const { execution } = await f.planned(asset)
    await f.claimed(execution)
    for (const changes of [
      { actionId: '9'.repeat(32) },
      { callId: '9'.repeat(32) },
      { executionId: '9'.repeat(32) },
      { assetId: '9'.repeat(32) },
      { sha256: '9'.repeat(64) },
      { planSha256: '9'.repeat(64) },
      { index: -1 },
      { index: 0.5 },
      { index: asset.chunkCount },
      { purpose: 'local-preview' },
      { purpose: 'model-planning-metadata' },
      { sessionId: f.session.sessionId },
      { approved: true },
      { bytesBase64: bytes.toString('base64') }
    ]) {
      await expect(
        f.runtime.planAssetChunk(f.session.sessionId, f.session.sessionToken, {
          ...f.readRequest(execution, asset),
          ...changes
        })
      ).rejects.toBeInstanceOf(FigPluginBridgeError)
    }
    const reply = await f.read(execution, asset)
    expect(Buffer.from(reply.chunk.bytesBase64, 'base64')).toEqual(bytes)
    expect(await f.status(execution)).toMatchObject({ state: 'claimed' })
  })

  it('does not splice valid independent claims or assets even when both belong to the same session', async () => {
    const f = await fixture(host)
    const first = await f.publish()
    const second = await f.publish(2, 2, 90)
    const firstPlan = await f.planned(first.asset)
    await f.claimed(firstPlan.execution)
    const otherContext = structuredClone(f.context)
    otherContext.documentId = '8'
    otherContext.scopeId = '8'
    otherContext.nodes[0].parentId = '8'
    const secondPlan = await f.planned(second.asset, { context: otherContext })
    await f.claimed(secondPlan.execution)
    const firstRequest = f.readRequest(firstPlan.execution, first.asset)
    const secondRequest = f.readRequest(secondPlan.execution, second.asset)
    for (const request of [
      { ...firstRequest, callId: secondRequest.callId },
      { ...firstRequest, executionId: secondRequest.executionId },
      { ...firstRequest, actionId: secondRequest.actionId },
      { ...firstRequest, planSha256: secondRequest.planSha256 },
      { ...secondRequest, ...reference(first.asset) }
    ]) {
      await expect(
        f.runtime.planAssetChunk(f.session.sessionId, f.session.sessionToken, request)
      ).rejects.toBeInstanceOf(FigPluginBridgeError)
    }
    expect(
      Buffer.from((await f.read(firstPlan.execution, first.asset)).chunk.bytesBase64, 'base64')
    ).toEqual(first.bytes)
    expect(
      Buffer.from((await f.read(secondPlan.execution, second.asset)).chunk.bytesBase64, 'base64')
    ).toEqual(second.bytes)
  })

  it('copies published bytes and emits one descriptor when several approved image steps share the source', async () => {
    const f = await fixture(host)
    const { asset, bytes } = await f.publish()
    const expected = Buffer.from(bytes)
    bytes.fill(0)
    const context = structuredClone(f.context)
    context.nodes.push({ ...structuredClone(context.nodes[0]), id: 'second' })
    context.selectedIds!.push('second')
    const plan = imagePlan(context, asset)
    plan.steps.push({ ...plan.steps[0], targetId: 'second' })
    const { execution } = await f.planned(asset, { context, plan })
    expect(execution.differences).toHaveLength(2)
    expect(execution.executionAssets).toHaveLength(1)
    const intent = await f.claimed(execution)
    expect(intent.executionAssets).toHaveLength(1)
    expect(Buffer.from((await f.read(execution, asset)).chunk.bytesBase64, 'base64')).toEqual(
      expected
    )
  })

  it('revokes only source-dependent plans and retains unrelated image and property previews', async () => {
    const f = await fixture(host)
    const first = await f.publish()
    const second = await f.publish(2, 2, 90)
    const dependent = await f.planned(first.asset)
    const unrelated = await f.planned(second.asset)
    const property: HostPlan = {
      schemaVersion: 2,
      kind: 'host-plan',
      captureId: f.context.captureId,
      steps: [{ command: 'node.rename', targetId: 'node', name: 'Unrelated property' }]
    }
    const staticPlan = await f.prepare(undefined, { plan: property })
    await f.finishPlanning(staticPlan)
    await f.revoke(first.asset)
    const states = f.runtime.listPlanExecutions()
    expect(
      states.find((entry) => entry.executionId === dependent.execution.executionId)?.state
    ).toBe('cancelled')
    expect(
      states.find((entry) => entry.executionId === unrelated.execution.executionId)?.state
    ).toBe('awaiting-approval')
    expect(states.find((entry) => entry.callId === staticPlan.receipt.callId)?.state).toBe(
      'awaiting-approval'
    )
    await expect(
      f.runtime.approvePlan(dependent.execution.executionId, dependent.execution.planSha256)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await f.claimed(unrelated.execution)
    expect(
      Buffer.from((await f.read(unrelated.execution, second.asset)).chunk.bytesBase64, 'base64')
    ).toEqual(second.bytes)
  })

  it('does not expose bytes for an approved image blocked on the real document-write reservation', async () => {
    const f = await fixture(host)
    const { asset } = await f.publish()
    const first = await f.planned(asset)
    const second = await f.planned(asset)
    await f.claimed(first.execution)
    await f.runtime.approvePlan(second.execution.executionId, second.execution.planSha256)
    expect(await f.claim(second.execution)).toMatchObject({ status: 'pending', state: 'approved' })
    await expect(f.read(second.execution, asset)).rejects.toMatchObject({ code: 'DENIED' })
    f.runtime.cancelPlan(first.execution.executionId)
    expect(await f.claim(second.execution)).toMatchObject({ status: 'pending', state: 'approved' })
    await expect(f.read(first.execution, asset)).rejects.toMatchObject({ code: 'DENIED' })
    await expect(f.read(second.execution, asset)).rejects.toMatchObject({ code: 'DENIED' })
  })

  it('caps all downstream lifetimes at the original selected-resource receipt and does not renew them on activity', async () => {
    const f = await fixture(host)
    const selection = await f.runtime.beginSessionAssetSelection(f.target)
    f.advance(90_000)
    await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)
    const asset = await f.runtime.publishSessionAsset(selection, {
      mimeType: 'image/png',
      width: 2,
      height: 2,
      bytes: png()
    })
    expect(asset.expiresAt).toBe(initialTime + FIGPLUGIN_ASSET_TTL_MS)
    expect(asset.expiresAt - asset.createdAt).toBe(30_000)
    const prepared = await f.planned(asset)
    const intent = await f.claimed(prepared.execution)
    expect(prepared.receipt.expiresAt).toBe(asset.expiresAt)
    expect(prepared.execution.expiresAt).toBe(asset.expiresAt)
    expect(intent.expiresAt).toBe(asset.expiresAt)
    f.advance(29_999)
    await f.read(prepared.execution, asset)
    expect((await f.runtime.listSessionAssets(f.target)).assets[0].expiresAt).toBe(asset.expiresAt)
    f.advance(1)
    await expect(f.read(prepared.execution, asset)).rejects.toBeInstanceOf(FigPluginBridgeError)
    expect(terminalEvents(f, prepared.execution)).toMatchObject([
      { state: 'expired', errorCode: 'EXPIRED' }
    ])
  })

  it('caps resource and execution leases at the absolute session expiry even with keepalive', async () => {
    const f = await fixture(host)
    for (let count = 0; count < 5; count++) {
      f.advance(100_000)
      await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)
    }
    f.advance(80_000)
    await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)
    const { asset } = await f.publish()
    expect(asset.expiresAt).toBe(f.session.expiresAt)
    const { execution } = await f.planned(asset)
    const intent = await f.claimed(execution)
    expect(intent.expiresAt).toBe(f.session.expiresAt)
    expect(intent.expiresAt - f.now()).toBe(20_000)
  })

  it.each(['source-hash', 'requested-value', 'original-observation'] as const)(
    'quarantines %s image success claims instead of trusting supplied result flags',
    async (variation) => {
      const f = await fixture(host)
      const { asset } = await f.publish()
      const { execution } = await f.planned(asset)
      await f.claimed(execution)
      const request = f.result(execution)
      const row = request.readback.steps[0]
      if (variation === 'source-hash') row.imageEvidence!.sourceSha256 = '9'.repeat(64)
      if (variation === 'requested-value')
        row.value = { ...(row.value as object), sha256: '9'.repeat(64) }
      if (variation === 'original-observation') {
        row.observation = 'original'
        row.value = nodeValue(f.context.nodes[0], row.command)
        delete row.imageEvidence
      }
      expect(() =>
        f.runtime.planResult(f.session.sessionId, f.session.sessionToken, request)
      ).toThrow(FigPluginBridgeError)
      expect(await f.status(execution)).toMatchObject({
        state: 'failed',
        errorCode: 'QUARANTINED',
        effect: 'unknown'
      })
      await expect(f.read(execution, asset)).rejects.toMatchObject({ code: 'DENIED' })
    }
  )

  it('refuses stale document-write ownership even when all resource descriptors still match', async () => {
    const f = await fixture(host)
    const { asset } = await f.publish()
    const { execution } = await f.planned(asset)
    const intent = await f.claimed(execution)
    f.writes.release({
      resourceKey: digest(['native-document-write-v1', host, f.context.documentId]),
      actionId: intent.actionId,
      fingerprint: digest(intent),
      expiresAt: intent.expiresAt
    })
    await expect(f.read(execution, asset)).rejects.toMatchObject({ code: 'DENIED' })
    expect(await f.status(execution)).toMatchObject({
      state: 'failed',
      errorCode: 'QUARANTINED',
      effect: 'unknown'
    })
  })

  it('refuses metadata-only image checkpoints and image correction when an older property baseline exists', async () => {
    const saved: SavedCheckpoint[] = []
    const f = await fixture(host, {
      checkpoints: {
        save: (record) => {
          saved.push(structuredClone(record))
        },
        find: () => undefined,
        findForRebind: () => undefined,
        listSummaries: () => [],
        consume: () => {
          throw new Error('Image must never consume durable recovery')
        },
        removeWhere: (predicate) => {
          for (let index = saved.length - 1; index >= 0; index--)
            if (predicate(saved[index])) saved.splice(index, 1)
        }
      }
    })
    const { asset } = await f.publish()
    const property: HostPlan = {
      schemaVersion: 2,
      kind: 'host-plan',
      captureId: f.context.captureId,
      steps: [{ command: 'node.rename', targetId: 'node', name: 'Property baseline' }]
    }
    const prepared = await f.prepare(undefined, { plan: property })
    await f.finishPlanning(prepared)
    const propertyExecution = f.runtime.listPlanExecutions()[0]
    await f.claimed(propertyExecution)
    const after = structuredClone(f.context)
    after.nodes[0].name = 'Property baseline'
    const propertyRequest = f.result(propertyExecution)
    propertyRequest.readback = createHostPlanReadback(f.context, after, property)
    const propertyResult = f.runtime.planResult(
      f.session.sessionId,
      f.session.sessionToken,
      propertyRequest
    )
    const baseline = await f.runtime.acceptVisualBaseline(
      propertyExecution.executionId,
      propertyResult.status.visualEvidenceSha256!
    )
    const { execution } = await f.planned(asset, { context: after })
    await f.claimed(execution)
    const request = f.result(execution, after)
    request.visualEvidence![0].after.sha256 = '6'.repeat(64)
    const result = f.runtime.planResult(f.session.sessionId, f.session.sessionToken, request)
    expect(result.status.visualBaselineComparison).toBeUndefined()
    await expect(
      f.runtime.acceptVisualBaseline(execution.executionId, result.status.visualEvidenceSha256!)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      f.runtime.authorizeVisualCorrection(
        execution.executionId,
        baseline.baselineId,
        result.status.visualEvidenceSha256!
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      f.runtime.prepareVisualCorrection(f.session.sessionId, f.session.sessionToken, {
        protocol: 1,
        sourceExecutionId: execution.executionId
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.runtime.listVisualBaselines()).toEqual([baseline])
    expect(f.runtime.listVisualCorrectionAuthorizations()).toEqual([])
    expect(saved).toHaveLength(1)
    expect(saved[0].recoveryPlan.steps).toEqual(property.steps)
    expect(JSON.stringify(saved)).not.toMatch(
      /executionAssets|image\.fill|image\.pixels|bytesBase64/
    )
    expect(
      f.runtime.listPlanExecutions().find((value) => value.executionId === execution.executionId)
    ).not.toHaveProperty('recovery')
  })
})

type Boundary = 'approve' | 'claim' | 'status' | 'read' | 'progress' | 'result'
type Invalidation =
  'cancel' | 'revoke' | 'expiry' | 'asset-capability' | 'byte-ceiling' | 'write-capability'
const invalidate = async (
  f: Fixture,
  execution: FigPluginExecutionPreview,
  asset: FigPluginSessionAsset,
  reason: Invalidation
) => {
  if (reason === 'cancel') f.runtime.cancelPlan(execution.executionId)
  if (reason === 'revoke') await f.revoke(asset)
  if (reason === 'expiry') f.advance(FIGPLUGIN_ASSET_TTL_MS)
  if (reason === 'asset-capability') f.setAllowed(false)
  if (reason === 'byte-ceiling') f.setCeiling(asset.sizeBytes - 1)
  if (reason === 'write-capability') f.setNativeWrite(false)
}
const boundaryOperation = (
  f: Fixture,
  execution: FigPluginExecutionPreview,
  asset: FigPluginSessionAsset,
  boundary: Boundary
) => {
  if (boundary === 'approve')
    return () => f.runtime.approvePlan(execution.executionId, execution.planSha256)
  if (boundary === 'claim') return () => f.claim(execution)
  if (boundary === 'status') return () => f.status(execution)
  if (boundary === 'read') return () => f.read(execution, asset)
  if (boundary === 'progress')
    return () =>
      f.runtime.planProgress(f.session.sessionId, f.session.sessionToken, f.progress(execution))
  return () =>
    f.runtime.planResult(f.session.sessionId, f.session.sessionToken, f.result(execution))
}
const expectStopped = (
  f: Fixture,
  execution: FigPluginExecutionPreview,
  result: Awaited<ReturnType<typeof outcome>>
) => {
  if ('error' in result) expect(result.error).toBeInstanceOf(FigPluginBridgeError)
  else {
    expect(result.value).toBeDefined()
    expect(result.value).not.toHaveProperty('intent')
    expect(result.value).not.toHaveProperty('chunk')
    expect(result.value).toMatchObject({
      state: expect.stringMatching(/^(cancelled|expired|failed|denied)$/)
    })
  }
  expect(terminalEvents(f, execution)).toHaveLength(1)
  expect(
    f.audit.filter((event) => event.executionId === execution.executionId).at(-1)?.state
  ).not.toMatch(/completed|approved|claimed|executing|readback/)
}

describe.each(['figma', 'photoshop'] as const)('%s image authority revocation', (host) => {
  describe.each(['approve', 'claim', 'status', 'read', 'progress', 'result'] as const)(
    '%s boundary',
    (boundary) => {
      it.each([
        'cancel',
        'revoke',
        'expiry',
        'asset-capability',
        'byte-ceiling',
        'write-capability'
      ] as const)('blocks %s without issuing bytes or recording success', async (reason) => {
        const f = await fixture(host)
        const { asset } = await f.publish()
        const { execution } = await f.planned(asset)
        if (boundary === 'claim')
          await f.runtime.approvePlan(execution.executionId, execution.planSha256)
        else if (boundary !== 'approve') await f.claimed(execution)
        await invalidate(f, execution, asset, reason)
        expectStopped(f, execution, await outcome(boundaryOperation(f, execution, asset, boundary)))
      })
    }
  )

  describe.each(['approve', 'claim', 'status', 'read'] as const)(
    '%s asynchronous validation fence',
    (boundary) => {
      it.each([
        'cancel',
        'revoke',
        'expiry',
        'asset-capability',
        'byte-ceiling',
        'write-capability',
        'session-close',
        'binding-change'
      ] as const)('cannot outlive %s while binding validation is pending', async (reason) => {
        const f = await fixture(host)
        const { asset } = await f.publish()
        const { execution } = await f.planned(asset)
        if (boundary === 'claim')
          await f.runtime.approvePlan(execution.executionId, execution.planSha256)
        else if (boundary !== 'approve') await f.claimed(execution)
        const entered = deferred<void>()
        const gate = deferred<boolean>()
        f.setValidation(() => {
          entered.resolve()
          return gate.promise
        })
        const pending = outcome(boundaryOperation(f, execution, asset, boundary))
        await entered.promise
        if (reason === 'session-close')
          f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
        else if (reason !== 'binding-change') await invalidate(f, execution, asset, reason)
        gate.resolve(reason !== 'binding-change')
        expectStopped(f, execution, await pending)
      })
    }
  )

  it.each(['asset-capability', 'byte-ceiling', 'write-capability'] as const)(
    'reports terminal rather than pending when %s is removed before write approval',
    async (reason) => {
      const f = await fixture(host)
      const { asset } = await f.publish()
      const { execution } = await f.planned(asset)
      await invalidate(f, execution, asset, reason)
      expectStopped(f, execution, await outcome(() => f.claim(execution)))
    }
  )
})

it('validates Photoshop full-layer dimensions against the published image, not model-supplied metadata', async () => {
  const f = await fixture('photoshop')
  const { asset } = await f.publish(2, 2)
  const context = contextFor('photoshop', 3, 2)
  const plan = imagePlan(context, asset)
  const prepared = await f.prepare(asset, {
    context,
    content: {
      plan,
      executionAssets: [{ ...asset, width: 3 }],
      assetCatalog: { assets: [{ ...planningAssetMetadata(asset), width: 3 }] }
    }
  })
  await f.finishPlanning(prepared)
  expect(f.runtime.listPlanExecutions()).toEqual([])
  expect(f.audit).toEqual([])
})
