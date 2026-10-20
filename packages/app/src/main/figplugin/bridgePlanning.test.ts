import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import type { HostContext } from '@shared/figplugin/hostPlan'
import type { FigPluginBridgePrepareRequest } from '@shared/figplugin/bridge'
import { FigPluginBridgeController } from './bridgeController'
import type { startFigPluginBridgeServer } from './bridgeServer'
import type { FigPluginRuntimeDescriptor } from './centerStore'

const capture = (executable = false): HostContext => ({
  version: 1,
  host: 'figma',
  documentId: 'doc',
  scopeId: 'page',
  captureId: 'a'.repeat(32),
  nodes: [
    {
      id: '1:2',
      type: 'TEXT',
      name: 'Owned layer',
      parentId: 'page',
      ancestors: [],
      locked: false,
      visible: true,
      opacity: 1,
      children: [],
      text: 'Owned text',
      commands: ['node.rename', 'node.opacity', 'text.content']
    }
  ],
  ...(executable
    ? {
        selectedIds: ['1:2'],
        execution: {
          mode: 'native-write' as const,
          adapterVersion: 'figma-native-1',
          supports: ['node.rename' as const, 'node.opacity' as const, 'text.content' as const],
          rollback: 'verified-in-place' as const,
          visualAudit: 'unavailable' as const
        }
      }
    : {})
})
const proposal = () => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: 'a'.repeat(32),
  steps: [{ command: 'node.rename', targetId: '1:2', name: 'Reviewed layer' }]
})
const planningRequest = (executable = false) => ({
  protocol: 1 as const,
  requestId: 'owned-request',
  sequence: 1,
  prompt: 'Rename the selected layer',
  context: {
    selectionRevision: 'a'.repeat(32),
    nodes: [{ id: '1:2', type: 'TEXT', name: 'Owned layer', locked: false }]
  },
  featureId: 'plan-preview' as const,
  hostContext: capture(executable)
})
const all: FigPluginBridgeController[] = []
afterEach(async () => {
  for (const c of all.splice(0)) await c.dispose()
})
async function fixture(
  input: unknown = planningRequest(),
  capabilities: NonNullable<FigPluginRuntimeDescriptor['capabilities']> = [
    'dialogue',
    'asset-transfer',
    'result-transfer'
  ]
) {
  const revision = 'd'.repeat(64)
  let runtime!: Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
  const model = {
    listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
      profiles: [
        {
          id: 'owned-model',
          model_name: 'Owned model',
          model_use: 'chat',
          configurationRevision: revision,
          context_budget_tokens: 16000
        }
      ]
    }),
    chat: vi
      .fn<LLMProxySvc['chat']>()
      .mockResolvedValue({ content: JSON.stringify(proposal()), finishReason: 'stop' }),
    cancelConversation: vi
      .fn<LLMProxySvc['cancelConversation']>()
      .mockResolvedValue({ cancelled: true }),
    isProfileRevisionCurrent: () => true,
    onProfileConfigurationChanged: () => () => undefined
  }
  const controller = new FigPluginBridgeController(
    {
      getRuntimeDescriptor: async () => ({
        pluginId: 'owned.figma',
        host: 'figma',
        generation: 1,
        artifactSha256: 'b'.repeat(64),
        signerFingerprint: 'c'.repeat(64),
        manifestSha256: 'e'.repeat(64),
        bridgeOrigin: 'http://127.0.0.1:41234',
        profileId: 'owned-model',
        capabilities,
        limits: {
          maxPayloadBytes: 65536,
          maxResultBytes: 32768,
          maxConfigBytes: 1024,
          maxCallTimeoutMs: 30000,
          maxConcurrentCalls: 1
        }
      }),
      onRuntimeInvalidated: () => () => undefined
    },
    model,
    {
      startServer: async (options) => {
        runtime = options.runtime
        return { origin: options.origin, close: async () => undefined }
      }
    }
  )
  all.push(controller)
  const binding = await controller.resolveBinding(
    { pluginId: 'owned.figma', expectedGeneration: 1 },
    'owned-project'
  )
  const ticket = await controller.createPairing(binding)
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'f'.repeat(32)
  })
  const start = () =>
    runtime.prepare(session.sessionId, session.sessionToken, input as FigPluginBridgePrepareRequest)
  const status = (callId: string) => runtime.status(session.sessionId, session.sessionToken, callId)
  return { controller, runtime, model, session, start, status }
}
async function finished(f: Awaited<ReturnType<typeof fixture>>, callId: string) {
  for (let i = 0; i < 30; i++) {
    const result = await f.status(callId)
    if (
      result.status === 'completed' ||
      result.status === 'failed' ||
      result.status === 'cancelled'
    )
      return result
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw Error('owned fixture did not settle')
}

describe('approved read-only host planning through the production Bridge', () => {
  it('requires desktop consent before model planning and returns a validated non-executable preview', async () => {
    const f = await fixture()
    const request = await f.start()
    expect(f.model.chat).not.toHaveBeenCalled()
    const preview = f.controller.desktopState().previews[0]
    expect(preview).toMatchObject({ featureId: 'plan-preview', hostContext: capture() })
    await f.controller.approve(request.callId, preview.payloadSha256)
    const result = await finished(f, request.callId)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw Error('expected preview result')
    const output = JSON.parse(result.content)
    expect(output).toMatchObject({
      kind: 'host-plan-preview',
      executable: false,
      plan: proposal(),
      risk: 'low'
    })
    expect(output.differences).toEqual([
      { targetId: '1:2', command: 'node.rename', before: 'Owned layer', after: 'Reviewed layer' }
    ])
    const prompt = JSON.stringify(f.model.chat.mock.calls[0][0].messages)
    expect(prompt).toContain('additionalProperties')
    expect(prompt).toContain('Owned text')
    expect(f.model.chat.mock.calls[0][0]).not.toHaveProperty('tools')
    await expect(f.controller.preparePlan(proposal())).resolves.toMatchObject({
      ok: false,
      code: 'UNAVAILABLE'
    })
    expect(capture().nodes[0].name).toBe('Owned layer')
  })
  it('rejects reuse of the same request ID with changed feature/context', async () => {
    const f = await fixture()
    await f.start()
    const changed = planningRequest()
    changed.hostContext.nodes[0].text = 'Changed private data'
    await expect(
      f.runtime.prepare(
        f.session.sessionId,
        f.session.sessionToken,
        changed as FigPluginBridgePrepareRequest
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.model.chat).not.toHaveBeenCalled()
  })
  it('creates a separate native write preview only when the signed package grants result transfer', async () => {
    const f = await fixture(planningRequest(true))
    const request = await f.start()
    const preview = f.controller.desktopState().previews[0]
    await f.controller.approve(request.callId, preview.payloadSha256)
    const result = await finished(f, request.callId)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw Error('expected preview result')
    expect(JSON.parse(result.content)).toMatchObject({
      executable: true,
      risk: 'low',
      execution: {
        mode: 'native-write',
        adapterVersion: 'figma-native-1',
        requiresWriteApproval: true
      }
    })
    expect(f.controller.planState().previews).toHaveLength(1)
    expect(f.controller.planState().previews[0]).toMatchObject({
      callId: request.callId,
      state: 'awaiting-approval',
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })
  it('rejects a native execution context when result-transfer is absent', async () => {
    const f = await fixture(planningRequest(true), ['dialogue', 'asset-transfer'])
    await expect(f.start()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.model.chat).not.toHaveBeenCalled()
  })
  it.each(['outside', 'stale', 'unsupported', 'truncated', 'prose'])(
    'rejects %s model plans without retrying or executing',
    async (kind) => {
      const f = await fixture()
      const req = await f.start()
      const preview = f.controller.desktopState().previews[0]
      const p = proposal()
      if (kind === 'outside') p.steps[0].targetId = 'another-document'
      let content = JSON.stringify(p)
      if (kind === 'unsupported') content = content.replace('node.rename', 'eval')
      if (kind === 'stale')
        content = content.replace(
          '"captureId":"' + p.captureId + '"',
          '"captureId":"' + 'b'.repeat(32) + '"'
        )
      if (kind === 'prose') content += ' Looks good.'
      f.model.chat.mockResolvedValue({
        content,
        finishReason: kind === 'truncated' ? 'length' : 'stop'
      })
      await f.controller.approve(req.callId, preview.payloadSha256)
      expect(await finished(f, req.callId)).toMatchObject({
        status: 'failed',
        errorCode: 'UPSTREAM_FAILED'
      })
      expect(f.model.chat).toHaveBeenCalledTimes(1)
    }
  )
  it('denial performs no planning or host actions', async () => {
    const f = await fixture()
    const req = await f.start()
    f.controller.deny(req.callId)
    expect(await f.status(req.callId)).toMatchObject({ status: 'cancelled', errorCode: 'DENIED' })
    expect(f.model.chat).not.toHaveBeenCalled()
  })
  it.each([
    { ...planningRequest(), hostContext: undefined },
    { ...planningRequest(), featureId: undefined },
    { ...planningRequest(), featureId: 'run-script' },
    { ...planningRequest(), hostContext: { ...capture(), host: 'photoshop' } },
    {
      ...planningRequest(),
      context: { ...planningRequest().context, selectionRevision: 'different' }
    }
  ])('rejects inconsistent feature snapshots %# before provider dispatch', async (input) => {
    const f = await fixture(input)
    await expect(f.start()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.model.chat).not.toHaveBeenCalled()
  })
})
