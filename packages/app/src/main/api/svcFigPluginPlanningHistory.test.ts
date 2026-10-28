import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { figPluginCenterSvcDef } from '@shared/api/svcFigPluginCenter'
import type {
  FigPluginPlanningAuditEvent,
  FigPluginPlanningHistoryRequest
} from '@shared/figplugin/planningAudit'
import { FigPluginPlanningAuditStore } from '../figplugin/planningAudit'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { FigPluginCenterSvcImpl, disposeFigPluginBridges } from './svcFigPluginCenterImpl'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const native = vi.hoisted(() => ({ getPath: vi.fn(), showMessageBox: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showMessageBox: native.showMessageBox },
  clipboard: {},
  shell: {}
}))
const URL = 'file:///app/index.html#/workshop/plugins'
const roots: string[] = []
const invocation = (
  overrides: Partial<ServiceInvocationContext> = {}
): ServiceInvocationContext => ({
  methodName: 'svcFigPluginCenter.planningHistory',
  senderId: 42,
  senderUrl: URL,
  frameUrl: URL,
  isMainFrame: true,
  ...overrides
})
const record = (index = 1): FigPluginPlanningAuditEvent => ({
  schemaVersion: 1,
  kind: 'planning',
  at: 1000 + index,
  callId: index.toString(16).padStart(32, '0'),
  correlationId: 'a'.repeat(32),
  sequence: 1,
  requestId: `request_${index}`,
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'project_1',
  profileId: 'owned-profile',
  profileRevision: 'b'.repeat(64),
  featureId: 'plan-preview',
  state: 'awaiting-approval',
  durationMs: 0,
  inputBytes: 1024,
  estimatedInputTokens: 256,
  nodeCount: 1,
  imageCount: 0,
  imageBytes: 0
})
function fixture(
  audit = {
    list: vi.fn<() => Promise<readonly FigPluginPlanningAuditEvent[]>>().mockResolvedValue([]),
    writeFailed: false
  }
) {
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => URL)
    })
  }
  let currentWindow: typeof window | null = window
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: URL,
    trustedWebContents: window.webContents
  })
  const bridge = vi.fn(async () => {
    throw new Error('Planning history must not construct Bridge')
  })
  const getAudit = vi.fn(() => audit)
  const executionAudit = vi.fn(() => {
    throw new Error('Planning history must not read execution history')
  })
  const checkpoints = vi.fn(() => {
    throw new Error('Planning history must not read recovery authority')
  })
  const service = new FigPluginCenterSvcImpl(
    undefined,
    () => currentWindow as unknown as BrowserWindow | null,
    bridge,
    executionAudit,
    checkpoints,
    getAudit
  )
  return {
    service,
    window,
    bridge,
    getAudit,
    audit,
    executionAudit,
    checkpoints,
    setWindow: (replacement: typeof window | null) => {
      currentWindow = replacement
    }
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  native.getPath.mockImplementation(() => {
    throw new Error('User data is outside this fixture')
  })
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  expect(native.getPath).not.toHaveBeenCalled()
  expect(native.showMessageBox).not.toHaveBeenCalled()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('trusted, read-only planning history', () => {
  it('has a strict validated IPC contract and reads/filter/bounds retained metadata without runtime authority', async () => {
    const f = fixture()
    f.audit.list.mockResolvedValue([
      record(1),
      { ...record(2), projectId: 'other' },
      record(3),
      record(4)
    ])
    const definition = figPluginCenterSvcDef.planningHistory
    expect(definition.type).toBe('unary')
    expect(definition.request).toBeDefined()
    expect(definition.response).toBeDefined()
    const result = await f.service.planningHistory(
      { pluginId: 'owned.figma', projectId: 'project_1', limit: 2 },
      invocation()
    )
    expect(result.records.map((entry) => entry.requestId)).toEqual(['request_4', 'request_3'])
    expect(result).toMatchObject({
      truncated: true,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxRecords: 256,
      maxBytes: 1048576,
      writeFailed: false
    })
    expect(f.bridge).not.toHaveBeenCalled()
    expect(f.executionAudit).not.toHaveBeenCalled()
    expect(f.checkpoints).not.toHaveBeenCalled()
  })

  it('filters exact call and correlation identities without inventing run or execution grants', async () => {
    const f = fixture()
    const selected = { ...record(), correlationId: 'c'.repeat(32) }
    f.audit.list.mockResolvedValue([selected, record(2), record(3)])
    for (const query of [{ callId: selected.callId }, { correlationId: selected.correlationId }])
      expect((await f.service.planningHistory(query, invocation())).records).toEqual([selected])
  })

  it('orders equal-clock events by transition sequence, immutable identity and a canonical final tie-breaker', async () => {
    const f = fixture()
    const base = record()
    const events: FigPluginPlanningAuditEvent[] = [
      { ...base, at: 1000, sequence: 1 },
      { ...base, at: 1000, sequence: 2, state: 'running' },
      { ...base, at: 1000, sequence: 3, state: 'provider-dispatched' },
      { ...record(2), at: 1000, sequence: 3, state: 'provider-dispatched' },
      { ...base, at: 1000, sequence: 4, state: 'completed', resultBytes: 12 },
      { ...base, at: 1000, sequence: 4, state: 'failed', errorCode: 'UPSTREAM_FAILED' }
    ]
    f.audit.list.mockResolvedValue(events)
    const first = await f.service.planningHistory({}, invocation())
    f.audit.list.mockResolvedValue([...events].reverse())
    const second = await f.service.planningHistory({}, invocation())
    expect(second.records).toEqual(first.records)
    expect(first.records.map((entry) => entry.sequence)).toEqual([4, 4, 3, 3, 2, 1])
    expect(
      first.records.filter((entry) => entry.sequence === 3).map((entry) => entry.callId)
    ).toEqual([base.callId, record(2).callId])
  })

  it.each([
    undefined,
    { senderId: 999 },
    { isMainFrame: false },
    { senderUrl: 'https://host.invalid', frameUrl: 'https://host.invalid' },
    { methodName: 'svcFigPluginCenter.executionHistory' }
  ])(
    'rejects absent/untrusted invocation before touching retained storage: %j',
    async (override) => {
      const f = fixture()
      await expect(
        f.service.planningHistory({}, override === undefined ? undefined : invocation(override))
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(f.getAudit).not.toHaveBeenCalled()
      expect(f.bridge).not.toHaveBeenCalled()
    }
  )

  it.each(['route', 'destroyed-window', 'destroyed-frame', 'unregistered', 'different-window'])(
    'rejects non-current desktop windows: %s',
    async (reason) => {
      const f = fixture()
      if (reason === 'route')
        f.window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
      if (reason === 'destroyed-window') f.window.isDestroyed.mockReturnValue(true)
      if (reason === 'destroyed-frame') f.window.webContents.isDestroyed.mockReturnValue(true)
      if (reason === 'unregistered') unregisterMagicAgentTrustedRouteBinding(42)
      if (reason === 'different-window') f.setWindow(null)
      await expect(f.service.planningHistory({}, invocation())).rejects.toMatchObject({
        code: 'PERMISSION_DENIED'
      })
      expect(f.getAudit).not.toHaveBeenCalled()
    }
  )

  it.each([
    { path: 'C:/PRIVATE' },
    { limit: 257 },
    { limit: 0 },
    { limit: 1.5 },
    { sessionToken: 'PRIVATE' },
    { retry: true },
    { approved: true },
    { callId: 'not-hex' },
    { correlationId: 'not-hex' },
    { runId: 'd'.repeat(32) }
  ])('rejects arbitrary paths, replay authority and malformed filter inputs: %j', async (input) => {
    const f = fixture()
    await expect(
      f.service.planningHistory(input as FigPluginPlanningHistoryRequest, invocation())
    ).rejects.toBeDefined()
    expect(f.audit.list).not.toHaveBeenCalled()
    const validate = figPluginCenterSvcDef.planningHistory.request
    if (typeof validate !== 'function') throw new Error('Expected IPC validator')
    expect(() => validate(input)).toThrow()
  })

  it.each(['reload', 'window-replacement', 'route-change', 'destroyed'])(
    'fences delayed history reads after %s',
    async (change) => {
      const f = fixture()
      let finish!: (value: FigPluginPlanningAuditEvent[]) => void
      f.audit.list.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      const pending = f.service.planningHistory({}, invocation())
      if (change === 'reload')
        f.window.webContents.emit('did-start-navigation', {}, URL, false, true)
      if (change === 'window-replacement') f.setWindow({ ...f.window })
      if (change === 'route-change')
        f.window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
      if (change === 'destroyed') f.window.isDestroyed.mockReturnValue(true)
      finish([record()])
      await expect(pending).rejects.toMatchObject({
        code: ['reload', 'window-replacement'].includes(change)
          ? 'CONFIGURATION_CHANGED'
          : 'PERMISSION_DENIED'
      })
      expect(f.bridge).not.toHaveBeenCalled()
    }
  )

  it('reports write loss but rejects sensitive stored payloads and sanitizes read failures', async () => {
    const f = fixture()
    f.audit.writeFailed = true
    f.audit.list.mockResolvedValue([record()])
    expect(await f.service.planningHistory({}, invocation())).toMatchObject({ writeFailed: true })
    for (const secret of [
      { prompt: 'PRIVATE' },
      { bytesBase64: 'PRIVATE' },
      { providerError: 'PRIVATE' }
    ]) {
      f.audit.list.mockResolvedValue([{ ...record(), ...secret } as FigPluginPlanningAuditEvent])
      await expect(f.service.planningHistory({}, invocation())).rejects.toMatchObject({
        code: 'IO_ERROR'
      })
    }
    f.audit.list.mockRejectedValue(new Error('PRIVATE C:/Users/secret-token'))
    const error = await f.service.planningHistory({}, invocation()).catch((failure) => failure)
    expect(error).toMatchObject({ code: 'IO_ERROR' })
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|Users|secret-token/)
  })

  it('reopens retained planning metadata without promoting an interrupted call or restoring authority', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-planning-history-ipc-'))
    roots.push(root)
    const first = new FigPluginPlanningAuditStore(root)
    first.record({ ...record(), at: Date.now(), sequence: 3, state: 'provider-dispatched' })
    await first.flush()
    const reopened = new FigPluginPlanningAuditStore(root)
    const f = fixture({ list: vi.fn(() => reopened.list()), writeFailed: false })
    const result = await f.service.planningHistory({}, invocation())
    expect(result.records).toEqual([expect.objectContaining({ state: 'provider-dispatched' })])
    expect(result.records.some((entry) => entry.state === 'completed')).toBe(false)
    expect(f.bridge).not.toHaveBeenCalled()
  })
})
