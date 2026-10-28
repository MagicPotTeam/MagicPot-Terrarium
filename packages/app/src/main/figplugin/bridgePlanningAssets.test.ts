import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMListProfilesResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  type FigPluginBridgePrepareRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { planningAssetMetadata } from '@shared/figplugin/hostPlanningAssets'
import {
  figPluginPlanningAuditEventSchema,
  type FigPluginPlanningAuditEvent
} from '@shared/figplugin/planningAudit'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import { encodeContextPng } from '@shared/figplugin/pixelAuditRuntime'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { FigPluginBridgeController } from './bridgeController'
import { buildBridgeApprovalDetails } from './bridgeApprovalDetails'
import { FigPluginPlanningAuditStore } from './planningAudit'
import type { FigPluginRuntimeDescriptor } from './centerStore'

type Host = FigPluginRuntimeBinding['host']
type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const now = 1_800_000_000_000
const hash = (input: unknown) =>
  createHash('sha256').update(canonicalFigPluginJson(input)).digest('hex')
const binding = (host: Host): FigPluginRuntimeBinding => ({
  pluginId: `owned.${host}`,
  host,
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'owned-project',
  profileId: 'metadata-nonvision',
  profileRevision: 'd'.repeat(64)
})
const request = (host: Host): FigPluginBridgePrepareRequest => {
  const id = host === 'figma' ? '1:2' : '42'
  const type = host === 'figma' ? 'RECTANGLE' : 'pixel'
  const scopeId = host === 'figma' ? 'page' : '7'
  return {
    protocol: 1,
    sequence: 1,
    requestId: 'owned-planning-assets',
    prompt: 'Rename the selected object; image metadata is not permission to write pixels',
    context: {
      selectionRevision: 'e'.repeat(32),
      nodes: [{ id, type, name: 'Owned fixture', locked: false }]
    },
    featureId: 'plan-preview',
    hostContext: {
      version: 1,
      host,
      documentId: host === 'figma' ? 'doc' : '7',
      scopeId,
      captureId: 'e'.repeat(32),
      selectedIds: [id],
      nodes: [
        {
          id,
          type,
          name: 'Owned fixture',
          parentId: scopeId,
          ancestors: [],
          locked: false,
          visible: true,
          commands: ['node.rename']
        }
      ]
    }
  }
}
const proposal = (host: Host) => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: 'e'.repeat(32),
  steps: [{ command: 'node.rename', targetId: host === 'figma' ? '1:2' : '42', name: 'Reviewed' }]
})
const reference = (asset: FigPluginSessionAsset) => ({
  assetId: asset.assetId,
  sha256: asset.sha256
})
const png = (red = 0) => {
  const encoded = encodeContextPng(1, 1, new Uint8Array([red, 0, 0, 255]), 4)
  if (!encoded) throw new Error('Synthetic PNG fixture exceeded budget')
  return encoded
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const pair = async (runtime: FigPluginBridgeRuntime, value: FigPluginRuntimeBinding) => {
  const ticket = await runtime.createPairing(value)
  return runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'f'.repeat(32)
  })
}
const targetFor = (session: FigPluginPairResponse, value: FigPluginRuntimeBinding) => ({
  sessionId: session.sessionId,
  pluginId: value.pluginId,
  projectId: value.projectId
})
const fixture = async (host: Host, options: Partial<Options> = {}) => {
  let allowed = true
  let maxBytes = FIGPLUGIN_ASSET_MAX_BYTES
  const validate = vi.fn<Options['validateBinding']>().mockResolvedValue(true)
  const events: FigPluginPlanningAuditEvent[] = []
  const audit = vi.fn()
  const nativeWrite = vi.fn(() => false)
  const writes = { reserve: vi.fn(() => true), owns: vi.fn(() => true), release: vi.fn() }
  const invoke = vi
    .fn<Options['invoke']>()
    .mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
      check()
      dispatched()
      return { content: 'Owned bounded response' }
    })
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: validate,
    invoke,
    planningAudit: (event) => events.push(structuredClone(event)),
    allowAssetTransfer: () => allowed,
    assetByteLimit: () => maxBytes,
    allowNativeWrite: nativeWrite,
    audit,
    writes,
    ...options
  })
  cleanups.push(() => {
    runtime.dispose()
    expect(audit).not.toHaveBeenCalled()
    expect(nativeWrite).not.toHaveBeenCalled()
    expect(writes.reserve).not.toHaveBeenCalled()
  })
  const value = binding(host)
  const session = await pair(runtime, value)
  const target = targetFor(session, value)
  const publish = async (red = 0) =>
    runtime.publishSessionAsset(await runtime.beginSessionAssetSelection(target), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes: png(red)
    })
  const prepare = (input: unknown = request(host)) =>
    runtime.prepare(session.sessionId, session.sessionToken, input as FigPluginBridgePrepareRequest)
  const status = (callId: string) => runtime.status(session.sessionId, session.sessionToken, callId)
  const revoke = (asset: FigPluginSessionAsset) =>
    runtime.revokeSessionAsset({ ...target, ...reference(asset) })
  return {
    runtime,
    invoke,
    validate,
    events,
    session,
    target,
    publish,
    prepare,
    status,
    revoke,
    setAllowed: (value: boolean) => {
      allowed = value
    },
    setMaxBytes: (value: number) => {
      maxBytes = value
    }
  }
}
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0)
}

describe.each(['figma', 'photoshop'] as const)(
  '%s main-owned planning metadata selection',
  (host) => {
    it('does not implicitly include any available assets or audit fields without exact opt-in', async () => {
      const f = await fixture(host)
      await f.publish()
      const receipt = await f.prepare()
      const preview = f.runtime.listPreviews()[0]
      expect(preview).not.toHaveProperty('assetReferences')
      expect(preview).not.toHaveProperty('assetCatalog')
      await f.runtime.approve(receipt.callId, preview.payloadSha256)
      await settle()
      expect(f.invoke).toHaveBeenCalledOnce()
      expect(f.invoke.mock.calls[0][1]).not.toHaveProperty('assetCatalog')
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
      for (const event of f.events) {
        expect(event).not.toHaveProperty('assetCount')
        expect(event).not.toHaveProperty('assetCatalogSha256')
      }
    })

    it('binds the exact subset, order, hashes and profile to immutable approval and bounded audit', async () => {
      const f = await fixture(host)
      const first = await f.publish(1)
      const omitted = await f.publish(2)
      const last = await f.publish(3)
      const input = { ...request(host), assetReferences: [reference(last), reference(first)] }
      const receipt = await f.prepare(input)
      const preview = f.runtime.listPreviews()[0]
      const catalog = {
        version: 1,
        kind: 'planning-asset-catalog',
        purpose: 'model-planning-metadata',
        ...f.target,
        host,
        assets: [planningAssetMetadata(last), planningAssetMetadata(first)]
      }
      expect(preview.assetReferences).toEqual(input.assetReferences)
      expect(preview.assetCatalog).toEqual(catalog)
      const digestInput = {
        binding: binding(host),
        prompt: input.prompt,
        context: input.context,
        featureId: input.featureId,
        hostContext: input.hostContext,
        assetReferences: input.assetReferences,
        assetCatalog: catalog
      }
      expect(preview.payloadSha256).toBe(hash(digestInput))
      expect(preview.estimatedInputTokens).toBe(
        Math.ceil(Buffer.byteLength(canonicalFigPluginJson(digestInput)) / 4)
      )
      expect(receipt.expiresAt).toBeLessThanOrEqual(Math.min(first.expiresAt, last.expiresAt))
      expect(await f.prepare(input)).toEqual(receipt)
      await expect(
        f.prepare({ ...input, assetReferences: [...input.assetReferences].reverse() })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      const { assetCatalog: _catalog, ...withoutCatalog } = digestInput
      await expect(f.runtime.approve(receipt.callId, hash(withoutCatalog))).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      expect(f.invoke).not.toHaveBeenCalled()
      input.assetReferences[0].sha256 = '0'.repeat(64)
      preview.assetReferences![0].assetId = '0'.repeat(32)
      preview.assetCatalog!.assets[0].width = 999
      await f.runtime.approve(receipt.callId, preview.payloadSha256)
      await settle()
      expect(f.invoke.mock.calls[0][1].assetCatalog).toEqual(catalog)
      expect(f.invoke.mock.calls[0][1].assetReferences).toEqual([reference(last), reference(first)])
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
      expect(f.runtime.listPlanExecutions()).toEqual([])
      expect(f.events.map((event) => event.state)).toEqual([
        'awaiting-approval',
        'running',
        'provider-dispatched',
        'completed'
      ])
      for (const event of f.events) {
        expect(figPluginPlanningAuditEventSchema.parse(event)).toEqual(event)
        expect(event).toMatchObject({
          assetCount: 2,
          assetCatalogSha256: hash(catalog),
          imageCount: 0,
          imageBytes: 0
        })
      }
      const auditText = JSON.stringify(f.events)
      for (const secret of [
        first.assetId,
        last.assetId,
        omitted.assetId,
        first.sha256,
        'assetReferences',
        'bytesBase64',
        'chunkCount',
        'mimeType',
        input.prompt
      ])
        expect(auditText).not.toContain(secret)
      expect(JSON.stringify(catalog)).not.toContain(omitted.assetId)
      expect(JSON.stringify(await f.status(receipt.callId))).not.toContain(first.assetId)

      // The suite's existing memfs setup exercises the real store without touching user files.
      const prefix = path.resolve('.figplugin-planning-metadata-audit-test')
      const root = path.join(prefix, receipt.callId)
      cleanups.push(async () => {
        if (path.dirname(path.resolve(root)) !== prefix)
          throw new Error('Invalid audit fixture root')
        await fs.rm(root, { recursive: true, force: true })
      })
      const store = new FigPluginPlanningAuditStore(root, () => Date.now())
      for (const event of f.events) store.record(event)
      await store.flush()
      const reopened = new FigPluginPlanningAuditStore(root, () => Date.now())
      expect(await reopened.list()).toEqual(f.events)
      const persisted = await fs.readFile(path.join(root, 'planning-audit.jsonl'), 'utf8')
      expect(persisted).toContain('"assetCount":2')
      expect(persisted).toContain(hash(catalog))
      for (const secret of [
        first.assetId,
        last.assetId,
        first.sha256,
        'bytesBase64',
        'assetReferences',
        '"assetCatalog"'
      ])
        expect(persisted).not.toContain(secret)
    })

    it('snapshots mutable request references before an asynchronous configuration check', async () => {
      const f = await fixture(host)
      const first = await f.publish(1)
      const second = await f.publish(2)
      const input = { ...request(host), assetReferences: [reference(first)] }
      const gate = deferred<boolean>()
      f.validate.mockReturnValueOnce(gate.promise)
      const preparing = f.prepare(input)
      input.assetReferences[0] = reference(second)
      input.prompt = 'unapproved mutation'
      gate.resolve(true)
      await preparing
      const preview = f.runtime.listPreviews()[0]
      expect(preview.assetReferences).toEqual([reference(first)])
      expect(preview.assetCatalog!.assets).toEqual([planningAssetMetadata(first)])
      expect(preview.prompt).toBe(request(host).prompt)
    })

    it('rejects unknown fields, forged hashes and source substitution without consuming valid replay identity', async () => {
      const f = await fixture(host)
      const asset = await f.publish()
      const peer = await pair(f.runtime, binding(host))
      const peerTarget = targetFor(peer, binding(host))
      const foreign = await f.runtime.publishSessionAsset(
        await f.runtime.beginSessionAssetSelection(peerTarget),
        {
          mimeType: 'image/png',
          width: 1,
          height: 1,
          bytes: png(12)
        }
      )
      const base = { ...request(host), assetReferences: [reference(asset)] }
      for (const invalid of [
        { ...base, assetReferences: [{ ...reference(asset), sha256: '0'.repeat(64) }] },
        { ...base, assetReferences: [reference(foreign)] },
        { ...base, assetReferences: [reference(asset), reference(asset)] },
        {
          ...base,
          assetReferences: [{ ...reference(asset), url: 'https://example.invalid/private.png' }]
        },
        { ...base, assetCatalog: { assets: [planningAssetMetadata(asset)] } },
        { ...base, featureId: undefined, hostContext: undefined },
        { ...base, ...request(host === 'figma' ? 'photoshop' : 'figma') }
      ]) {
        await expect(f.prepare(invalid)).rejects.toBeDefined()
        expect(f.runtime.listPreviews()).toEqual([])
        expect(f.invoke).not.toHaveBeenCalled()
      }
      await expect(f.prepare(base)).resolves.toMatchObject({ status: 'awaiting-approval' })
    })

    it('rechecks selected asset authority after pending prepare validation', async () => {
      const f = await fixture(host)
      const asset = await f.publish()
      const gate = deferred<boolean>()
      f.validate.mockReturnValueOnce(gate.promise)
      const preparing = f.prepare({ ...request(host), assetReferences: [reference(asset)] })
      const rejected = expect(preparing).rejects.toBeDefined()
      await f.revoke(asset)
      gate.resolve(true)
      await rejected
      expect(f.runtime.listPreviews()).toEqual([])
      expect(f.events).toEqual([])
      expect(f.invoke).not.toHaveBeenCalled()
    })

    it.each(['revoke', 'capability-drop', 'budget-drop'] as const)(
      'does not approve stale references after %s during asynchronous validation',
      async (change) => {
        const f = await fixture(host)
        const asset = await f.publish()
        const receipt = await f.prepare({ ...request(host), assetReferences: [reference(asset)] })
        const preview = f.runtime.listPreviews()[0]
        const gate = deferred<boolean>()
        f.validate.mockReturnValueOnce(gate.promise)
        const approving = f.runtime.approve(receipt.callId, preview.payloadSha256)
        const rejected = expect(approving).rejects.toBeDefined()
        if (change === 'revoke') await f.revoke(asset)
        else if (change === 'capability-drop') f.setAllowed(false)
        else f.setMaxBytes(asset.sizeBytes - 1)
        gate.resolve(true)
        await rejected
        expect(f.invoke).not.toHaveBeenCalled()
        expect(f.runtime.listPreviews()).toEqual([])
        expect(['cancelled', 'failed']).toContain((await f.status(receipt.callId)).status)
      }
    )

    it('bounds approval lifetime by source TTL and expires without borrowing renewed session authority', async () => {
      const f = await fixture(host)
      const asset = await f.publish()
      await vi.advanceTimersByTimeAsync(FIGPLUGIN_ASSET_TTL_MS - 100)
      const receipt = await f.prepare({ ...request(host), assetReferences: [reference(asset)] })
      const preview = f.runtime.listPreviews()[0]
      expect(receipt.expiresAt).toBe(asset.expiresAt)
      await vi.advanceTimersByTimeAsync(100)
      await expect(f.runtime.approve(receipt.callId, preview.payloadSha256)).rejects.toBeDefined()
      expect(await f.status(receipt.callId)).toMatchObject({
        status: 'failed',
        errorCode: 'EXPIRED'
      })
      expect(f.invoke).not.toHaveBeenCalled()
      expect(f.runtime.listPreviews()).toEqual([])
    })

    it('expires an in-flight selection at its source TTL and ignores the later model result', async () => {
      const f = await fixture(host)
      const asset = await f.publish()
      await vi.advanceTimersByTimeAsync(FIGPLUGIN_ASSET_TTL_MS - 100)
      const response = deferred<{ content: string }>()
      f.invoke.mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
        check()
        dispatched()
        return response.promise
      })
      const receipt = await f.prepare({ ...request(host), assetReferences: [reference(asset)] })
      await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
      await vi.advanceTimersByTimeAsync(100)
      expect(f.invoke.mock.calls[0][2].aborted).toBe(true)
      expect(await f.status(receipt.callId)).toMatchObject({
        status: 'failed',
        errorCode: 'EXPIRED'
      })
      response.resolve({ content: 'Expired metadata result' })
      await settle()
      expect(await f.status(receipt.callId)).toMatchObject({
        status: 'failed',
        errorCode: 'EXPIRED'
      })
      expect(f.events.some((event) => event.state === 'completed')).toBe(false)
    })

    it.each(['revoke', 'capability-drop', 'budget-drop'] as const)(
      'checks %s synchronously immediately before provider dispatch',
      async (change) => {
        const f = await fixture(host)
        const asset = await f.publish()
        const gate = deferred<void>()
        const provider = vi.fn()
        f.invoke.mockImplementation(async (_b, _p, _signal, _c, dispatched, check) => {
          await gate.promise
          check()
          provider()
          dispatched()
          return { content: 'Late forbidden result' }
        })
        const receipt = await f.prepare({ ...request(host), assetReferences: [reference(asset)] })
        await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
        if (change === 'revoke') await f.revoke(asset)
        else if (change === 'capability-drop') f.setAllowed(false)
        else f.setMaxBytes(asset.sizeBytes - 1)
        gate.resolve()
        await settle()
        expect(provider).not.toHaveBeenCalled()
        expect(['failed', 'cancelled']).toContain((await f.status(receipt.callId)).status)
        expect(f.events.some((event) => event.state === 'provider-dispatched')).toBe(false)
      }
    )

    it('monotonically cancels selected in-flight references and discards an abort-ignoring late provider response', async () => {
      const f = await fixture(host)
      const asset = await f.publish()
      const response = deferred<{ content: string }>()
      f.invoke.mockImplementation(async (_b, _p, _signal, _c, dispatched, check) => {
        check()
        dispatched()
        return response.promise
      })
      const receipt = await f.prepare({ ...request(host), assetReferences: [reference(asset)] })
      await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
      expect(f.invoke).toHaveBeenCalledOnce()
      const signal = f.invoke.mock.calls[0][2]
      await f.revoke(asset)
      expect(signal.aborted).toBe(true)
      const terminal = await f.status(receipt.callId)
      expect(terminal).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
      response.resolve({ content: JSON.stringify(proposal(host)) })
      await settle()
      expect(await f.status(receipt.callId)).toEqual(terminal)
      expect(f.runtime.listPlanExecutions()).toEqual([])
      expect(
        f.events.filter((event) => ['completed', 'cancelled', 'failed'].includes(event.state))
      ).toHaveLength(1)
    })

    it('rechecks selected references after provider response while final configuration validation is pending', async () => {
      const f = await fixture(host)
      const asset = await f.publish()
      const response = deferred<{ content: string }>()
      f.invoke.mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
        check()
        dispatched()
        return response.promise
      })
      const receipt = await f.prepare({ ...request(host), assetReferences: [reference(asset)] })
      await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
      const gate = deferred<boolean>()
      f.validate.mockReturnValueOnce(gate.promise)
      const previousChecks = f.validate.mock.calls.length
      response.resolve({ content: 'Do not publish this stale result' })
      await settle()
      expect(f.validate).toHaveBeenCalledTimes(previousChecks + 1)
      await f.revoke(asset)
      gate.resolve(true)
      await settle()
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'cancelled' })
      expect(f.events.some((event) => event.state === 'completed')).toBe(false)
    })

    it('does not cancel a call when an unselected asset is revoked before or after dispatch', async () => {
      const f = await fixture(host)
      const selected = await f.publish(1)
      const unused = await f.publish(2)
      const unusedLater = await f.publish(3)
      const response = deferred<{ content: string }>()
      f.invoke.mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
        check()
        dispatched()
        return response.promise
      })
      const receipt = await f.prepare({ ...request(host), assetReferences: [reference(selected)] })
      const preview = f.runtime.listPreviews()[0]
      await f.revoke(unused)
      expect(f.runtime.listPreviews()[0]).toEqual(preview)
      await f.runtime.approve(receipt.callId, preview.payloadSha256)
      await f.revoke(unusedLater)
      expect(f.invoke.mock.calls[0][2].aborted).toBe(false)
      response.resolve({ content: 'Still authorized metadata result' })
      await settle()
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
    })

    it('keeps ordinary native writes behind a separate exact approval and revokes a pending derived plan', async () => {
      const executionAudit = vi.fn()
      const f = await fixture(host, { allowNativeWrite: () => true, audit: executionAudit })
      const asset = await f.publish()
      const input = { ...request(host), assetReferences: [reference(asset)] }
      input.hostContext!.execution = {
        mode: 'native-write',
        adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
        supports: ['node.rename'],
        rollback: 'verified-in-place',
        visualAudit: 'unavailable'
      }
      const plan = proposal(host)
      f.invoke.mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
        check()
        dispatched()
        return {
          content: JSON.stringify(
            createHostPlanningPreview(JSON.stringify(plan), input.hostContext!)
          )
        }
      })
      const receipt = await f.prepare(input)
      await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
      await settle()
      const [execution] = f.runtime.listPlanExecutions()
      expect(execution).toMatchObject({ state: 'awaiting-approval', plan })
      for (const value of [execution, executionAudit.mock.calls]) {
        expect(JSON.stringify(value)).not.toContain(asset.assetId)
        expect(JSON.stringify(value)).not.toContain('assetCatalog')
      }
      expect(
        await f.runtime.claimPlan(f.session.sessionId, f.session.sessionToken, {
          protocol: 1,
          callId: receipt.callId,
          executionId: execution.executionId
        })
      ).toMatchObject({ status: 'pending', state: 'awaiting-approval' })
      await f.revoke(asset)
      expect(f.runtime.listPlanExecutions()[0]).toMatchObject({ state: 'cancelled' })
      await expect(
        f.runtime.approvePlan(execution.executionId, execution.planSha256)
      ).rejects.toBeDefined()
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
      expect(f.events.filter((event) => event.state === 'completed')).toHaveLength(1)
    })
  }
)

const controllerFixture = async (
  host: Host,
  profileOverrides: Partial<LLMListProfilesResp['profiles'][number]> = {}
) => {
  let runtime!: FigPluginBridgeRuntime
  const value = binding(host)
  const events: FigPluginPlanningAuditEvent[] = []
  const audit = vi.fn()
  const descriptor: FigPluginRuntimeDescriptor = {
    ...value,
    capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
    limits: {
      maxPayloadBytes: 65536,
      maxResultBytes: 32768,
      maxConfigBytes: 1024,
      maxCallTimeoutMs: 30000,
      maxConcurrentCalls: 1
    }
  }
  const getDescriptor = vi.fn().mockImplementation(async () => descriptor)
  const model = {
    listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
      profiles: [
        {
          id: value.profileId,
          model_name: 'Synthetic text-only profile',
          model_use: 'chat',
          configurationRevision: value.profileRevision,
          context_budget_tokens: 16000,
          is_vision_model: false,
          ...profileOverrides
        }
      ]
    }),
    chat: vi
      .fn<LLMProxySvc['chat']>()
      .mockResolvedValue({ content: JSON.stringify(proposal(host)), finishReason: 'stop' }),
    cancelConversation: vi
      .fn<LLMProxySvc['cancelConversation']>()
      .mockResolvedValue({ cancelled: true }),
    isProfileRevisionCurrent: () => true,
    onProfileConfigurationChanged: () => () => undefined
  }
  const controller = new FigPluginBridgeController(
    {
      getRuntimeDescriptor: getDescriptor,
      onRuntimeInvalidated: () => () => undefined
    },
    model,
    {
      audit,
      planningAudit: (event) => events.push(structuredClone(event)),
      startServer: async (options) => {
        if (!(options.runtime instanceof FigPluginBridgeRuntime))
          throw new Error('Controller must supply the production runtime')
        runtime = options.runtime
        return { origin: options.origin, close: async () => undefined }
      }
    }
  )
  cleanups.push(async () => {
    await controller.dispose()
    expect(audit).not.toHaveBeenCalled()
  })
  const resolved = await controller.resolveBinding(
    { pluginId: value.pluginId, expectedGeneration: 1 },
    value.projectId
  )
  const ticket = await controller.createPairing(resolved)
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'f'.repeat(32)
  })
  const target = targetFor(session, value)
  const asset = await controller.publishSessionAsset(
    await controller.beginSessionAssetSelection(target),
    {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes: png(11)
    }
  )
  const input = { ...request(host), assetReferences: [reference(asset)] }
  const prepare = (change: Partial<FigPluginBridgePrepareRequest> = {}) =>
    runtime.prepare(session.sessionId, session.sessionToken, { ...input, ...change })
  const approve = async (callId: string) => {
    await controller.approve(callId, controller.desktopState().previews[0].payloadSha256)
    await settle()
  }
  const status = (callId: string) => runtime.status(session.sessionId, session.sessionToken, callId)
  return {
    controller,
    runtime,
    model,
    events,
    asset,
    target,
    prepare,
    approve,
    status,
    getDescriptor,
    descriptor
  }
}

describe.each(['figma', 'photoshop'] as const)(
  '%s Controller metadata-only provider boundary',
  (host) => {
    it('sends the exact approved metadata as text to a nonvision profile, without pixels or implicit attachments', async () => {
      const f = await controllerFixture(host)
      const remotePixels = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Remote pixels are forbidden'))
      const receipt = await f.prepare()
      expect(f.model.chat).not.toHaveBeenCalled()
      const preview = f.controller.desktopState().previews[0]
      const details = buildBridgeApprovalDetails(preview)
      expect(details).toContain(JSON.stringify(preview.assetCatalog))
      expect(details).toContain(preview.payloadSha256)
      expect(details).toContain('separate model-metadata consent')
      expect(details).toContain(
        'Source image bytes, filenames, paths and embedded EXIF/location metadata are NOT sent'
      )
      expect(details).toContain('cannot recall metadata already sent')
      expect(details).not.toContain('actual PNG bytes will also be sent')
      await f.approve(receipt.callId)
      expect(f.model.chat).toHaveBeenCalledOnce()
      const outgoing = f.model.chat.mock.calls[0][0]
      expect(outgoing).toMatchObject({
        profileId: binding(host).profileId,
        expectedProfileRevision: binding(host).profileRevision
      })
      expect(outgoing.messages).toHaveLength(1)
      expect(outgoing.messages[0]).not.toHaveProperty('attachments')
      const text = JSON.parse(outgoing.messages[0].content as string)
      expect(text.assetCatalog).toEqual(preview.assetCatalog)
      expect(text.assetCatalog.assets).toEqual([planningAssetMetadata(f.asset)])
      for (const field of [
        'bytesBase64',
        'chunkCount',
        'chunkSize',
        'data:image',
        'https:',
        'C:\\'
      ])
        expect(JSON.stringify(outgoing.messages)).not.toContain(field)
      expect(text.assetCatalog.assets[0]).not.toHaveProperty('pixels')
      expect(remotePixels).not.toHaveBeenCalled()
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
      expect(f.runtime.listPlanExecutions()).toEqual([])
    })

    it('preserves independent contextImage vision and attachment checks even with metadata selected', async () => {
      const f = await controllerFixture(host)
      const bytes = Buffer.from(png(20))
      const receipt = await f.prepare({
        contextImage: {
          version: 1,
          kind: 'host-context-image',
          captureId: request(host).hostContext!.captureId,
          targetId: host === 'figma' ? '1:2' : '42',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytesBase64: bytes.toString('base64')
        }
      })
      await f.approve(receipt.callId)
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'failed' })
      expect(f.model.chat).not.toHaveBeenCalled()
    })

    it('keeps separately approved context PNG bytes independent from selected asset metadata', async () => {
      const f = await controllerFixture(host, {
        provider: 'openai',
        api_mode: 'responses',
        is_vision_model: true,
        attachment_transports: ['request-data-url']
      })
      const bytes = Buffer.from(png(20))
      const image = {
        version: 1 as const,
        kind: 'host-context-image' as const,
        captureId: request(host).hostContext!.captureId,
        targetId: host === 'figma' ? '1:2' : '42',
        mimeType: 'image/png' as const,
        width: 1,
        height: 1,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytesBase64: bytes.toString('base64')
      }
      expect(image.sha256).not.toBe(f.asset.sha256)
      const receipt = await f.prepare({ contextImage: image })
      const details = buildBridgeApprovalDetails(f.controller.desktopState().previews[0])
      expect(details).toContain('actual PNG bytes will also be sent')
      expect(details).toContain('separate model-metadata consent')
      await f.approve(receipt.callId)
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
      const outgoing = f.model.chat.mock.calls[0][0].messages[0]
      expect(outgoing.attachments).toHaveLength(1)
      expect(outgoing.attachments![0]).toMatchObject({
        type: 'image',
        url: `data:image/png;base64,${image.bytesBase64}`,
        imageDetail: 'low'
      })
      const text = JSON.parse(outgoing.content as string)
      expect(text.assetCatalog.assets).toEqual([planningAssetMetadata(f.asset)])
      expect(text.contextImage.sha256).toBe(image.sha256)
      expect(outgoing.content).not.toContain(image.bytesBase64)
      expect(JSON.stringify(outgoing.attachments)).not.toContain(f.asset.assetId)
      expect(f.events[0]).toMatchObject({
        assetCount: 1,
        imageCount: 1,
        imageBytes: image.sizeBytes
      })
    })

    it('stops metadata dispatch when the selected asset is revoked during the final descriptor await', async () => {
      const f = await controllerFixture(host)
      const receipt = await f.prepare()
      const gate = deferred<FigPluginRuntimeDescriptor>()
      f.getDescriptor.mockResolvedValueOnce(f.descriptor).mockReturnValueOnce(gate.promise)
      await f.controller.approve(
        receipt.callId,
        f.controller.desktopState().previews[0].payloadSha256
      )
      await f.controller.revokeSessionAsset({ ...f.target, ...reference(f.asset) })
      gate.resolve(f.descriptor)
      await settle()
      expect(f.model.chat).not.toHaveBeenCalled()
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'cancelled' })
    })

    it.each(['imageUrl', 'attachments', 'toolCalls', 'images'] as const)(
      'rejects provider %s without creating an image-write plan',
      async (field) => {
        const f = await controllerFixture(host)
        f.model.chat.mockResolvedValueOnce({
          content: JSON.stringify(proposal(host)),
          finishReason: 'stop',
          [field]:
            field === 'imageUrl'
              ? 'https://example.invalid/generated.png'
              : [{ url: 'https://example.invalid/generated.png' }]
        })
        const receipt = await f.prepare()
        await f.approve(receipt.callId)
        expect(f.model.chat).toHaveBeenCalledOnce()
        expect(await f.status(receipt.callId)).toMatchObject({
          status: 'failed',
          errorCode: 'UPSTREAM_FAILED'
        })
        expect(f.runtime.listPlanExecutions()).toEqual([])
      }
    )

    it.each(['image.replace', 'image.place', 'node.asset', 'image.url'])(
      'does not interpret %s or a source ID as a supported native command',
      async (command) => {
        const f = await controllerFixture(host)
        f.model.chat.mockResolvedValueOnce({
          content: JSON.stringify({
            ...proposal(host),
            steps: [
              {
                command,
                targetId: host === 'figma' ? '1:2' : '42',
                assetId: f.asset.assetId,
                sha256: f.asset.sha256,
                imageUrl: 'https://example.invalid/generated.png'
              }
            ]
          }),
          finishReason: 'stop'
        })
        const receipt = await f.prepare()
        await f.approve(receipt.callId)
        expect(await f.status(receipt.callId)).toMatchObject({ status: 'failed' })
        expect(f.runtime.listPlanExecutions()).toEqual([])
      }
    )

    it('does not treat a valid source asset ID as an authorized native target', async () => {
      const f = await controllerFixture(host)
      f.model.chat.mockResolvedValueOnce({
        content: JSON.stringify({
          ...proposal(host),
          steps: [
            {
              command: 'node.rename',
              targetId: f.asset.assetId,
              name: 'Out-of-scope asset target'
            }
          ]
        }),
        finishReason: 'stop'
      })
      const receipt = await f.prepare()
      await f.approve(receipt.callId)
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'failed' })
      expect(f.runtime.listPlanExecutions()).toEqual([])
    })
  }
)
