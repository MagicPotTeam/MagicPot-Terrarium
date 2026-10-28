import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_CONTEXT_IMAGE_TOKEN_BUDGET,
  contextImageSummary,
  type HostContextImage
} from '@shared/figplugin/hostContextImage'
import {
  type FigPluginBridgePrepareRequest,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { validateHostContextImageBytes } from './hostContextImage'
import { buildBridgeApprovalDetails } from './bridgeApprovalDetails'

type Host = FigPluginRuntimeBinding['host']
const imageForHost = (host: Host, red = false): HostContextImage => ({
  version: 1,
  kind: 'host-context-image',
  captureId: 'a'.repeat(32),
  targetId: host === 'figma' ? '1:2' : '42',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  sizeBytes: 70,
  sha256: red
    ? '4ff6ab670a58c14270e034e2090d9a432caa263a14e0a25785386b0c12f880b5'
    : 'abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f',
  bytesBase64: red
    ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
    : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='
})
const bindingForHost = (host: Host): FigPluginRuntimeBinding => ({
  pluginId: `owned.${host}`,
  host,
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'owned-project',
  profileId: 'vision',
  profileRevision: 'd'.repeat(64)
})
const requestForHost = (host: Host): FigPluginBridgePrepareRequest => {
  const targetId = imageForHost(host).targetId
  const type = host === 'figma' ? 'RECTANGLE' : 'pixel'
  const scopeId = host === 'figma' ? 'page' : '7'
  return {
    protocol: 1,
    requestId: 'owned-image',
    sequence: 1,
    prompt: 'Name this object using the opt-in image',
    context: {
      selectionRevision: 'a'.repeat(32),
      nodes: [{ id: targetId, type, name: 'Owned', locked: false }]
    },
    featureId: 'plan-preview',
    hostContext: {
      version: 1,
      host,
      documentId: host === 'figma' ? 'document' : '7',
      scopeId,
      captureId: 'a'.repeat(32),
      selectedIds: [targetId],
      nodes: [
        {
          id: targetId,
          type,
          name: 'Owned',
          parentId: scopeId,
          ancestors: [],
          locked: false,
          visible: true,
          commands: ['node.rename']
        }
      ]
    },
    contextImage: imageForHost(host)
  }
}
type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const runtimes: FigPluginBridgeRuntime[] = []
const fixtureForHost = async (host: Host, options: Partial<Options> = {}) => {
  const invoke = vi.fn<Options['invoke']>().mockResolvedValue({ content: 'owned result' })
  const audit = vi.fn<NonNullable<Options['audit']>>()
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: async () => true,
    invoke,
    audit,
    ...options
  })
  runtimes.push(runtime)
  const ticket = await runtime.createPairing(bindingForHost(host))
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'e'.repeat(32)
  })
  const prepare = (input = requestForHost(host)) =>
    runtime.prepare(session.sessionId, session.sessionToken, input)
  return { runtime, session, invoke, audit, prepare }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  vi.useRealTimers()
})

describe.each(['figma', 'photoshop'] as const)('approved %s context PNG input binding', (host) => {
  const image = (red = false) => imageForHost(host, red)
  const request = () => requestForHost(host)
  const binding = bindingForHost(host)
  const fixture = (options: Partial<Options> = {}) => fixtureForHost(host, options)

  it('verifies the declared source hash and returns exact bytes without trusting the declaration', () => {
    expect(validateHostContextImageBytes(image())).toEqual(
      Buffer.from(image().bytesBase64, 'base64')
    )
    expect(() => validateHostContextImageBytes({ ...image(), sha256: '0'.repeat(64) })).toThrow(
      'INVALID_CONTEXT_IMAGE'
    )
    expect(() => validateHostContextImageBytes({ ...image(), width: 2 })).toThrow()
  })

  it('rejects wrong hashes or mismatched scope before retaining a preview or calling a provider', async () => {
    const f = await fixture()
    for (const invalid of [
      { ...image(), sha256: '0'.repeat(64) },
      { ...image(), targetId: 'outside' },
      { ...image(), captureId: 'f'.repeat(32) },
      { ...image(), bytesBase64: image(true).bytesBase64 }
    ]) {
      await expect(f.prepare({ ...request(), contextImage: invalid })).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      expect(f.runtime.listPreviews()).toEqual([])
    }
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.audit).not.toHaveBeenCalled()
    await expect(f.prepare()).resolves.toMatchObject({ status: 'awaiting-approval' })
  })

  it('rejects a valid image request from the other host instead of borrowing its paired authority', async () => {
    const f = await fixture()
    await expect(
      f.prepare(requestForHost(host === 'figma' ? 'photoshop' : 'figma'))
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.audit).not.toHaveBeenCalled()
    await expect(f.prepare()).resolves.toMatchObject({ status: 'awaiting-approval' })
  })

  it('binds all image bytes into replay and approval hashes while excluding base64 from token estimates', async () => {
    const f = await fixture()
    const input = request()
    const prepared = await f.prepare(input)
    const preview = f.runtime.listPreviews()[0]
    const digestInput = {
      binding,
      prompt: input.prompt,
      context: input.context,
      featureId: input.featureId,
      hostContext: input.hostContext,
      contextImage: input.contextImage
    }
    expect(preview.payloadSha256).toBe(
      createHash('sha256').update(canonicalFigPluginJson(digestInput)).digest('hex')
    )
    const estimated =
      Math.ceil(
        Buffer.byteLength(
          canonicalFigPluginJson({
            ...digestInput,
            contextImage: contextImageSummary(image())
          })
        ) / 4
      ) + HOST_CONTEXT_IMAGE_TOKEN_BUDGET
    expect(preview.estimatedInputTokens).toBe(estimated)
    expect(await f.prepare()).toEqual(prepared)
    await expect(f.prepare({ ...request(), contextImage: image(true) })).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    await expect(
      f.runtime.approve(
        prepared.callId,
        createHash('sha256')
          .update(
            canonicalFigPluginJson({
              ...digestInput,
              contextImage: image(true)
            })
          )
          .digest('hex')
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.invoke).not.toHaveBeenCalled()
    input.contextImage = image(true)
    preview.contextImage!.bytesBase64 = image(true).bytesBase64
    await f.runtime.approve(prepared.callId, preview.payloadSha256)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.invoke).toHaveBeenCalledTimes(1)
    expect(f.invoke.mock.calls[0][1].contextImage).toEqual(image())
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.runtime.listPlanExecutions()).toEqual([])
    expect(f.audit).not.toHaveBeenCalled()
    expect(
      await f.runtime.status(f.session.sessionId, f.session.sessionToken, prepared.callId)
    ).not.toHaveProperty('contextImage')
  })

  it.each(['deny', 'cancel', 'expire', 'revoke'] as const)(
    'drops pending image input on %s without a provider call',
    async (action) => {
      const f = await fixture()
      const prepared = await f.prepare()
      const preview = f.runtime.listPreviews()[0]
      if (action === 'deny') f.runtime.deny(prepared.callId)
      else if (action === 'cancel')
        await f.runtime.cancel(f.session.sessionId, f.session.sessionToken, prepared.callId)
      else if (action === 'expire') await vi.advanceTimersByTimeAsync(120001)
      else f.runtime.revokeTransport()
      expect(f.runtime.listPreviews()).toEqual([])
      await expect(f.runtime.approve(prepared.callId, preview.payloadSha256)).rejects.toBeDefined()
      expect(f.invoke).not.toHaveBeenCalled()
      expect(f.audit).not.toHaveBeenCalled()
    }
  )

  it('keeps image input out of execution previews and audit, with separate write approval still required', async () => {
    const f = await fixture({ allowNativeWrite: () => true })
    const input = request()
    input.hostContext!.execution = {
      mode: 'native-write',
      adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
      supports: ['node.rename'],
      rollback: 'verified-in-place',
      visualAudit: 'unavailable'
    }
    const plan = {
      schemaVersion: 2,
      kind: 'host-plan',
      captureId: input.hostContext!.captureId,
      steps: [{ command: 'node.rename', targetId: image().targetId, name: 'Reviewed object' }]
    }
    f.invoke.mockResolvedValue({
      content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), input.hostContext!))
    })
    const prepared = await f.prepare(input)
    await f.runtime.approve(prepared.callId, f.runtime.listPreviews()[0].payloadSha256)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.runtime.listPlanExecutions()).toMatchObject([{ state: 'awaiting-approval', plan }])
    expect(f.audit).toHaveBeenCalled()
    for (const value of [f.runtime.listPlanExecutions(), f.audit.mock.calls]) {
      const serialized = JSON.stringify(value)
      expect(serialized).not.toContain('contextImage')
      expect(serialized).not.toContain('bytesBase64')
      expect(serialized).not.toContain(image().bytesBase64)
    }
  })

  it('ignores a late image-backed provider result after cancellation and drops its visible preview', async () => {
    const f = await fixture()
    let finish!: (value: { content: string }) => void
    f.invoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const prepared = await f.prepare()
    await f.runtime.approve(prepared.callId, f.runtime.listPreviews()[0].payloadSha256)
    expect(f.invoke).toHaveBeenCalledTimes(1)
    await f.runtime.cancel(f.session.sessionId, f.session.sessionToken, prepared.callId)
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.invoke.mock.calls[0][2].aborted).toBe(true)
    finish({ content: 'late output' })
    await vi.advanceTimersByTimeAsync(0)
    expect(
      await f.runtime.status(f.session.sessionId, f.session.sessionToken, prepared.callId)
    ).toMatchObject({ status: 'cancelled' })
    expect(f.runtime.listPlanExecutions()).toEqual([])
  })

  it('preserves no-image request hashes, estimates and approval content', async () => {
    const f = await fixture()
    const input = request()
    delete input.contextImage
    await f.prepare(input)
    const preview = f.runtime.listPreviews()[0]
    const canonical = canonicalFigPluginJson({
      binding,
      prompt: input.prompt,
      context: input.context,
      featureId: input.featureId,
      hostContext: input.hostContext
    })
    expect(preview.payloadSha256).toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(preview.estimatedInputTokens).toBe(Math.ceil(Buffer.byteLength(canonical) / 4))
    expect(buildBridgeApprovalDetails(preview)).not.toContain('Context image')
  })

  it('shows the exact image summary and explicit byte transmission without dumping binary into consent text', async () => {
    const f = await fixture()
    await f.prepare()
    const details = buildBridgeApprovalDetails(f.runtime.listPreviews()[0])
    expect(details).toContain('actual PNG bytes will also be sent to the bound model')
    expect(details).toContain(JSON.stringify(contextImageSummary(image())))
    expect(details).not.toContain('bytesBase64')
    expect(details).not.toContain(image().bytesBase64)
    expect(details).toContain('does not authorize document changes')
  })
})
