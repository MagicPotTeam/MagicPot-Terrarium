import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { FigPluginCheckpointStore } from './checkpointStore'
import { NOW, binding as baseBinding, ownedCodec } from './checkpointTestUtils'
import { encodeContextPng } from '@shared/figplugin/pixelAuditRuntime'
import { stepValue, type HostContext, type HostPlan } from '@shared/figplugin/hostPlan'
import type {
  FigPluginExecutionPreview,
  FigPluginExecutionResultRequest
} from '@shared/figplugin/execution'
import type { FigPluginPairResponse } from '@shared/figplugin/bridge'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
type Host = HostContext['host']
type RuntimeOptions = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const runtimes: FigPluginBridgeRuntime[] = []
const roots: string[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  const parent = fs.realpathSync(os.tmpdir())
  for (const dir of roots.splice(0)) {
    const resolved = fs.realpathSync(dir)
    if (
      !resolved.startsWith(`${parent}${path.sep}`) ||
      !path.basename(resolved).startsWith('mp-image-recovery-')
    )
      throw new Error('Unexpected test cleanup target')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

const contextFor = (host: Host, count: number): HostContext => {
  const command = host === 'figma' ? 'image.fill' : 'image.pixels'
  return {
    version: 1,
    host,
    documentId: host === 'figma' ? 'owned-document' : '7',
    scopeId: host === 'figma' ? 'owned-page' : '7',
    captureId: '1'.repeat(32),
    recoveryIdentity: '2'.repeat(32),
    selectedIds: Array.from({ length: count }, (_, index) => `node-${index}`),
    execution: {
      mode: 'native-write',
      adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
      supports: [command, 'node.rename'],
      rollback: 'verified-in-place',
      visualAudit: 'hash-only'
    },
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `node-${index}`,
      type: host === 'figma' ? 'RECTANGLE' : 'pixel',
      parentId: host === 'figma' ? 'owned-page' : '7',
      ancestors: [],
      name: 'Original',
      locked: false,
      visible: true,
      commands: [command, 'node.rename'],
      ...(host === 'figma'
        ? { imageFill: { status: 'available' as const, fingerprint: '3'.repeat(64) } }
        : {
            imagePixels: {
              status: 'available' as const,
              historyStateId: 17,
              width: 2,
              height: 2,
              bounds: { left: -10, top: 20, right: -8, bottom: 22 }
            }
          })
    }))
  }
}
const imageBytes = (seed = 17) =>
  Buffer.from(
    encodeContextPng(
      2,
      2,
      new Uint8Array([seed, 20, 30, 255, 40, seed, 60, 255, 70, 80, seed, 255, 0, 0, 0, 0]),
      4
    )!
  )

function fixture(host: Host, count = 1) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-image-recovery-'))
  roots.push(dir)
  const codec = ownedCodec()
  let now = NOW
  const binding = { ...baseBinding, host, pluginId: `owned.image.${host}` }
  const context = contextFor(host, count)
  let output = ''
  const make = (options: Partial<RuntimeOptions> = {}) => {
    const store = new FigPluginCheckpointStore(dir, codec, () => now)
    const opened: Buffer[] = []
    const read = store.openRecoveryImages.bind(store)
    vi.spyOn(store, 'openRecoveryImages').mockImplementation((...args) => {
      const result = read(...args)
      opened.push(...result.map((item) => item.bytes))
      return result
    })
    const invoke = vi.fn(async () => ({ content: output }))
    const runtime = new FigPluginBridgeRuntime({
      now: () => now,
      validateBinding: async () => true,
      allowNativeWrite: () => true,
      allowAssetTransfer: () => true,
      checkpoints: store,
      invoke,
      ...options
    })
    runtimes.push(runtime)
    return { runtime, store, invoke, opened }
  }
  const pair = async (runtime: FigPluginBridgeRuntime, revision = binding.profileRevision) => {
    const ticket = await runtime.createPairing({ ...binding, profileRevision: revision })
    return runtime.redeem({
      protocol: 1,
      ticketId: ticket.ticketId,
      pairingSecret: ticket.pairingSecret,
      pluginId: binding.pluginId,
      host,
      artifactSha256: binding.artifactSha256,
      clientNonce: '9'.repeat(32)
    })
  }
  const result = (
    execution: FigPluginExecutionPreview,
    captured: HostContext
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
      steps: execution.plan.steps.map((step) => {
        const accepted = execution.recovery?.images?.manifest.targets.find(
          (target) => target.targetId === step.targetId && target.command === step.command
        )?.acceptedEvidence
        const node = captured.nodes.find((node) => node.id === step.targetId)!
        const pixels = node.imagePixels?.status === 'available' ? node.imagePixels : undefined
        return {
          targetId: step.targetId,
          command: step.command,
          observation: 'requested',
          value: stepValue(step),
          ...('sha256' in step
            ? {
                imageEvidence:
                  host === 'figma'
                    ? {
                        kind: 'figma-image-fill' as const,
                        sourceSha256: step.sha256,
                        nativeImageHash: accepted ? 'fresh-native-image' : 'accepted-native-image',
                        fillsSha256: (accepted ? 'd' : '4').repeat(64)
                      }
                    : (accepted ?? {
                        kind: 'photoshop-pixels' as const,
                        sourceSha256: step.sha256,
                        pixelSha256: '5'.repeat(64),
                        width: pixels!.width,
                        height: pixels!.height,
                        bounds: pixels!.bounds
                      })
              }
            : {})
        }
      })
    },
    visualEvidence: captured.nodes.map((node) => ({
      targetId: node.id,
      before: { sha256: '6'.repeat(64), width: 2, height: 2 },
      after: { sha256: '7'.repeat(64), width: 2, height: 2 },
      changed: true
    }))
  })
  const accept = async (first = make()) => {
    const session = await pair(first.runtime)
    const sources = [] as Array<{ assetId: string; sha256: string; bytes: Buffer }>
    for (let index = 0; index < count; index++) {
      const bytes = imageBytes(index + 17)
      const asset = await first.runtime.publishSessionAsset(
        await first.runtime.beginSessionAssetSelection({
          sessionId: session.sessionId,
          pluginId: binding.pluginId,
          projectId: binding.projectId
        }),
        { bytes, mimeType: 'image/png', width: 2, height: 2 }
      )
      sources.push({ assetId: asset.assetId, sha256: asset.sha256, bytes })
    }
    const plan: HostPlan = {
      schemaVersion: 2,
      kind: 'host-plan',
      captureId: context.captureId,
      steps: [
        ...sources.map((source, index) =>
          host === 'figma'
            ? {
                command: 'image.fill' as const,
                targetId: `node-${index}`,
                assetId: source.assetId,
                sha256: source.sha256,
                scaleMode: 'FIT' as const
              }
            : {
                command: 'image.pixels' as const,
                targetId: `node-${index}`,
                assetId: source.assetId,
                sha256: source.sha256
              }
        ),
        { command: 'node.rename', targetId: 'node-0', name: 'Accepted task title' }
      ]
    }
    output = JSON.stringify({ plan })
    const receipt = await first.runtime.prepare(session.sessionId, session.sessionToken, {
      protocol: 1,
      requestId: 'owned-image-plan',
      sequence: 1,
      prompt: 'Apply owned image and title',
      featureId: 'plan-preview',
      hostContext: context,
      context: {
        selectionRevision: context.captureId,
        nodes: context.nodes.map(({ id, type, name, locked }) => ({ id, type, name, locked }))
      },
      assetReferences: sources.map(({ assetId, sha256 }) => ({ assetId, sha256 }))
    })
    await first.runtime.approve(receipt.callId, first.runtime.listPreviews()[0].payloadSha256)
    for (let index = 0; index < 30 && !first.runtime.listPlanExecutions().length; index++)
      await new Promise((resolve) => setTimeout(resolve, 0))
    const execution = first.runtime.listPlanExecutions()[0]
    expect(execution).toBeDefined()
    await first.runtime.approvePlan(execution.executionId, execution.planSha256)
    const claim = await first.runtime.claimPlan(session.sessionId, session.sessionToken, {
      protocol: 1,
      callId: execution.callId
    })
    expect(claim.status).toBe('ready')
    const completed = first.runtime.planResult(
      session.sessionId,
      session.sessionToken,
      result(execution, context)
    )
    const baseline = await first.runtime.acceptVisualBaseline(
      execution.executionId,
      completed.status.visualEvidenceSha256!
    )
    return { ...first, session, execution, baseline, sources }
  }
  const freshContext = (serial = 2) => {
    const fresh = structuredClone(context)
    fresh.captureId = serial.toString(16).padStart(32, '0')
    fresh.recoveryIdentity = 'a'.repeat(32)
    for (const node of fresh.nodes) {
      node.name = 'Unrelated later edit'
      if (node.imageFill?.status === 'available') node.imageFill.fingerprint = 'b'.repeat(64)
      if (node.imagePixels?.status === 'available') {
        node.imagePixels.historyStateId = 100
        node.imagePixels.width = 3
        node.imagePixels.height = 1
        node.imagePixels.bounds = { left: 100, top: -50, right: 103, bottom: -49 }
      }
    }
    return fresh
  }
  const prepare = async (
    runtime: FigPluginBridgeRuntime,
    session: FigPluginPairResponse,
    baselineId: string,
    fresh = freshContext()
  ) => {
    const response = await runtime.prepareTaskRecovery(session.sessionId, session.sessionToken, {
      protocol: 1,
      requestId: fresh.captureId,
      sequence: Number.parseInt(fresh.captureId, 16),
      rebindBaselineId: baselineId,
      hostContext: fresh
    })
    if (response.status !== 'prepared')
      throw new Error('Expected image recovery, never metadata-only unchanged')
    const execution = runtime
      .listPlanExecutions()
      .find((item) => item.executionId === response.executionId)!
    return { response, execution, context: fresh }
  }
  return {
    dir,
    binding,
    context,
    make,
    pair,
    accept,
    prepare,
    result,
    freshContext,
    advance: (milliseconds: number) => {
      now += milliseconds
    }
  }
}

const readRequest = (execution: FigPluginExecutionPreview, index = 0) => ({
  protocol: 1,
  purpose: 'host-plan-execution',
  executionId: execution.executionId,
  callId: execution.callId,
  actionId: execution.executionId,
  planSha256: execution.planSha256,
  assetId: execution.executionAssets![index].assetId,
  sha256: execution.executionAssets![index].sha256,
  index: 0
})

describe.each(['figma', 'photoshop'] as const)('%s durable exact-image recovery', (host) => {
  it('commits real bytes, survives Desktop/plugin restart, requires new approval and restores accepted pixels/placement with fresh grants', async () => {
    const f = fixture(host)
    const first = await f.accept()
    const saved = first.store.find(f.binding, f.context)!
    expect(saved.recoveryImages?.sourcePlanSha256).toBe(first.execution.planSha256)
    expect(saved.recoveryImages?.targets[0].acceptedEvidence.sourceSha256).toBe(
      first.sources[0].sha256
    )
    expect(fs.readFileSync(first.store.file).includes(first.sources[0].bytes)).toBe(false)
    first.runtime.dispose()
    f.advance(121_000)
    const second = f.make()
    const session = await f.pair(second.runtime, 'e'.repeat(64))
    const prepared = await f.prepare(second.runtime, session, first.baseline.baselineId)
    expect(second.invoke).not.toHaveBeenCalled()
    expect(prepared.execution.risk).toBe('high')
    expect(prepared.execution.recovery).toEqual(prepared.response.recovery)
    const asset = prepared.execution.executionAssets![0]
    expect(asset.assetId).not.toBe(first.sources[0].assetId)
    expect(asset.purpose).toBe('host-plan-execution')
    expect(
      (
        await second.runtime.assetList(session.sessionId, session.sessionToken, {
          protocol: 1,
          purpose: 'local-preview'
        })
      ).assets
    ).toEqual([])
    await expect(
      second.runtime.planAssetChunk(
        session.sessionId,
        session.sessionToken,
        readRequest(prepared.execution)
      )
    ).rejects.toMatchObject({ code: 'DENIED' })
    await expect(
      second.runtime.assetChunk(session.sessionId, session.sessionToken, {
        protocol: 1,
        purpose: 'local-preview',
        assetId: asset.assetId,
        sha256: asset.sha256,
        index: 0
      })
    ).rejects.toBeDefined()
    const pending = await second.runtime.claimPlan(session.sessionId, session.sessionToken, {
      protocol: 1,
      callId: prepared.execution.callId
    })
    expect(pending.status).toBe('pending')
    expect(
      second.store.findForRebind(f.binding, prepared.context, first.baseline.baselineId)!.value
        .correctionRoundsUsed
    ).toBe(0)
    await expect(
      second.runtime.approvePlan(prepared.execution.executionId, prepared.execution.planSha256)
    ).rejects.toMatchObject({ code: 'DENIED' })
    await second.runtime.approvePlan(
      prepared.execution.executionId,
      prepared.execution.planSha256,
      true
    )
    const claimed = await second.runtime.claimPlan(session.sessionId, session.sessionToken, {
      protocol: 1,
      callId: prepared.execution.callId
    })
    expect(claimed.status).toBe('ready')
    if (claimed.status !== 'ready') throw new Error('Missing fresh claim')
    expect(claimed.intent.recovery).toEqual(prepared.response.recovery)
    const persisted = second.store.find(
      { ...f.binding, profileRevision: 'e'.repeat(64) },
      prepared.context
    )!
    expect(persisted.value.correctionRoundsUsed).toBe(1)
    expect(persisted.activeRecovery?.executionId).toBe(prepared.execution.executionId)
    const chunk = await second.runtime.planAssetChunk(
      session.sessionId,
      session.sessionToken,
      readRequest(prepared.execution)
    )
    expect(Buffer.from(chunk.chunk.bytesBase64, 'base64')).toEqual(first.sources[0].bytes)
    await expect(
      second.runtime.planAssetChunk(session.sessionId, session.sessionToken, {
        ...readRequest(prepared.execution),
        assetId: first.sources[0].assetId
      })
    ).rejects.toBeDefined()
    const reply = f.result(prepared.execution, prepared.context)
    if (host === 'photoshop') {
      expect(reply.readback.steps[0].imageEvidence).toMatchObject({
        width: 2,
        height: 2,
        bounds: { left: -10, top: 20, right: -8, bottom: 22 }
      })
      expect(prepared.execution.differences[0]).toMatchObject({
        before: { width: 3, height: 1, bounds: { left: 100, top: -50, right: 103, bottom: -49 } },
        after: {
          acceptedPixels: {
            width: 2,
            height: 2,
            bounds: { left: -10, top: 20, right: -8, bottom: 22 }
          }
        }
      })
    } else
      expect(reply.readback.steps[0].imageEvidence).toMatchObject({
        nativeImageHash: 'fresh-native-image'
      })
    const completed = second.runtime.planResult(session.sessionId, session.sessionToken, reply)
    expect(completed.status.state).toBe('completed')
    expect(second.opened.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expect(
      second.store.find({ ...f.binding, profileRevision: 'e'.repeat(64) }, prepared.context)
        ?.activeRecovery
    ).toBeUndefined()
    await expect(
      second.runtime.planAssetChunk(
        session.sessionId,
        session.sessionToken,
        readRequest(prepared.execution)
      )
    ).rejects.toBeDefined()
  })

  it.each(['cancel', 'expire', 'dispose', 'binding-change'] as const)(
    'zeroizes execution-only bytes after %s without audit support',
    async (reason) => {
      const f = fixture(host)
      const first = await f.accept()
      first.runtime.dispose()
      const second = f.make()
      const session = await f.pair(second.runtime)
      const prepared = await f.prepare(second.runtime, session, first.baseline.baselineId)
      expect(second.opened.some((bytes) => bytes.some((byte) => byte !== 0))).toBe(true)
      if (reason === 'cancel') second.runtime.cancelPlan(prepared.execution.executionId)
      if (reason === 'expire') {
        f.advance(121_000)
        second.runtime.listPlanExecutions()
      }
      if (reason === 'dispose') second.runtime.dispose()
      if (reason === 'binding-change') second.runtime.revokeInvalidBindings(() => false)
      expect(second.opened.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
      expect(second.store.listSummaries()).toHaveLength(reason === 'binding-change' ? 0 : 1)
    }
  )

  it('enforces session capacity in both directions and releases image slots on cancellation', async () => {
    const f = fixture(host, 4)
    const first = await f.accept()
    first.runtime.dispose()
    const second = f.make()
    const session = await f.pair(second.runtime)
    const target = {
      sessionId: session.sessionId,
      pluginId: f.binding.pluginId,
      projectId: f.binding.projectId
    }
    const prepared = await f.prepare(second.runtime, session, first.baseline.baselineId)
    await expect(second.runtime.beginSessionAssetSelection(target)).rejects.toMatchObject({
      code: 'BUSY'
    })
    second.runtime.cancelPlan(prepared.execution.executionId)
    const selection = await second.runtime.beginSessionAssetSelection(target)
    await second.runtime.publishSessionAsset(selection, {
      bytes: imageBytes(99),
      mimeType: 'image/png',
      width: 2,
      height: 2
    })
    await expect(
      f.prepare(second.runtime, session, first.baseline.baselineId, f.freshContext(3))
    ).rejects.toMatchObject({ code: 'BUSY' })
  })
})

it('rejects wrong accepted Photoshop pixel proof and releases bytes while retaining the consumed crash fence', async () => {
  const f = fixture('photoshop')
  const first = await f.accept()
  first.runtime.dispose()
  const second = f.make()
  const session = await f.pair(second.runtime)
  const prepared = await f.prepare(second.runtime, session, first.baseline.baselineId)
  await second.runtime.approvePlan(
    prepared.execution.executionId,
    prepared.execution.planSha256,
    true
  )
  await second.runtime.claimPlan(session.sessionId, session.sessionToken, {
    protocol: 1,
    callId: prepared.execution.callId
  })
  const reply = f.result(prepared.execution, prepared.context)
  const evidence = reply.readback.steps[0].imageEvidence
  if (evidence?.kind !== 'photoshop-pixels') throw new Error('Missing pixel proof')
  evidence.pixelSha256 = 'f'.repeat(64)
  expect(() => second.runtime.planResult(session.sessionId, session.sessionToken, reply)).toThrow()
  expect(second.runtime.listPlanExecutions()[0].state).toBe('failed')
  expect(second.opened.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  second.runtime.dispose()
  const third = f.make()
  const thirdSession = await f.pair(third.runtime)
  await expect(
    f.prepare(third.runtime, thirdSession, first.baseline.baselineId, f.freshContext(3))
  ).rejects.toMatchObject({ code: 'BUSY' })
})
