import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { figPluginCenterSvcDef } from '@shared/api/svcFigPluginCenter'
import type { FigPluginExecutionAuditEvent } from '@shared/figplugin/executionAudit'
import { FigPluginExecutionAuditStore } from '../figplugin/executionAudit'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
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
  methodName: 'svcFigPluginCenter.executionHistory',
  senderId: 42,
  senderUrl: URL,
  frameUrl: URL,
  isMainFrame: true,
  ...overrides
})
const record = (index = 1): FigPluginExecutionAuditEvent => ({
  schemaVersion: 1,
  at: 1000 + index,
  executionId: index.toString(16).padStart(32, '0'),
  callId: 'a'.repeat(32),
  requestId: `request_${index}`,
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'project_1',
  state: 'completed',
  completed: 1,
  total: 1,
  effect: 'applied',
  risk: 'low',
  planSha256: 'b'.repeat(64),
  previewSha256: 'c'.repeat(64),
  adapterVersion: 'figma-native-1',
  rollback: 'verified-in-place',
  visualAudit: 'unavailable',
  durationMs: 12
})
function fixture(
  audit = {
    list: vi.fn<() => Promise<readonly FigPluginExecutionAuditEvent[]>>().mockResolvedValue([]),
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
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: URL,
    trustedWebContents: window.webContents
  })
  const bridge = vi.fn(async () => {
    throw new Error('History must not construct Bridge')
  })
  const getAudit = vi.fn(() => audit)
  const service = new FigPluginCenterSvcImpl(
    undefined,
    () => window as unknown as BrowserWindow,
    bridge,
    getAudit
  )
  return { service, window, bridge, getAudit, audit }
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

describe('trusted, read-only execution history', () => {
  it('reads, orders, filters and bounds retained events without constructing the Bridge', async () => {
    const f = fixture()
    f.audit.list.mockResolvedValue([
      record(1),
      { ...record(2), projectId: 'other' },
      record(3),
      record(4)
    ])
    const result = await f.service.executionHistory(
      { projectId: 'project_1', pluginId: 'owned.figma', limit: 2 },
      invocation()
    )
    expect(result.records.map((entry) => entry.requestId)).toEqual(['request_4', 'request_3'])
    expect(result).toMatchObject({
      truncated: true,
      maxRecords: 256,
      maxBytes: 1048576,
      writeFailed: false
    })
    expect(f.bridge).not.toHaveBeenCalled()
    expect(
      await f.service.planState({}, { ...invocation(), methodName: 'svcFigPluginCenter.planState' })
    ).toEqual({ previews: [], statuses: [], baselines: [], correctionAuthorizations: [] })
  })

  it('filters one attempt or run by the bounded audit lineage fields', async () => {
    const f = fixture()
    const correlationId = 'd'.repeat(32)
    const runId = 'e'.repeat(32)
    f.audit.list.mockResolvedValue([
      { ...record(1), at: 1001, correlationId, runId, sequence: 1 },
      { ...record(2), at: 1001, correlationId: 'f'.repeat(32), runId, sequence: 2 },
      { ...record(3), correlationId: 'a'.repeat(32), runId: 'a'.repeat(32), sequence: 1 }
    ])
    await expect(
      f.service.executionHistory({ correlationId }, invocation())
    ).resolves.toMatchObject({ records: [expect.objectContaining({ requestId: 'request_1' })] })
    await expect(f.service.executionHistory({ runId }, invocation())).resolves.toMatchObject({
      records: [
        expect.objectContaining({ requestId: 'request_2' }),
        expect.objectContaining({ requestId: 'request_1' })
      ]
    })
  })

  it('keeps equal-timestamp history order stable across append-order changes', async () => {
    const lineage = {
      correlationId: 'a'.repeat(32),
      runId: 'b'.repeat(32)
    }
    const events = [
      { ...record(1), at: 1000, ...lineage, sequence: 2 },
      {
        ...record(2),
        at: 1000,
        correlationId: 'c'.repeat(32),
        runId: 'd'.repeat(32),
        sequence: 2
      },
      { ...record(3), at: 1000, ...lineage, sequence: 1 }
    ]
    const f = fixture()
    f.audit.list.mockResolvedValue([...events].reverse())
    const first = await f.service.executionHistory({}, invocation())
    f.audit.list.mockResolvedValue(events)
    const second = await f.service.executionHistory({}, invocation())
    expect(first.records.map((entry) => entry.requestId)).toEqual([
      'request_1',
      'request_2',
      'request_3'
    ])
    expect(second.records.map((entry) => entry.requestId)).toEqual(
      first.records.map((entry) => entry.requestId)
    )
  })

  it('uses the canonical record as a final tie-breaker for duplicate lineage records', async () => {
    const shared = {
      ...record(1),
      at: 1000,
      correlationId: 'a'.repeat(32),
      runId: 'b'.repeat(32),
      sequence: 1
    }
    const completed = shared
    const failed = {
      ...shared,
      state: 'failed' as const,
      completed: 0,
      effect: 'none' as const,
      errorCode: 'EXECUTION_FAILED' as const
    }
    const f = fixture()
    f.audit.list.mockResolvedValue([failed, completed])
    const first = await f.service.executionHistory({}, invocation())
    f.audit.list.mockResolvedValue([completed, failed])
    const second = await f.service.executionHistory({}, invocation())
    expect(first.records.map((entry) => entry.state)).toEqual(['failed', 'completed'])
    expect(second.records.map((entry) => entry.state)).toEqual(['failed', 'completed'])
  })

  it.each([
    undefined,
    { senderId: 999 },
    { isMainFrame: false },
    { senderUrl: 'https://host.invalid', frameUrl: 'https://host.invalid' },
    { methodName: 'svcFigPluginCenter.approvePlanExecution' }
  ])('rejects absent/untrusted invocation before reading storage: %j', async (override) => {
    const f = fixture()
    await expect(
      f.service.executionHistory({}, override === undefined ? undefined : invocation(override))
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.getAudit).not.toHaveBeenCalled()
    expect(f.bridge).not.toHaveBeenCalled()
  })

  it.each([
    { path: 'C:/PRIVATE' },
    { limit: 257 },
    { limit: 0 },
    { sessionToken: 'PRIVATE' },
    { runId: 'not-a-hex-id' },
    { correlationId: 'not-a-hex-id' }
  ])('rejects renderer-controlled paths, authority and excess budget: %j', async (input) => {
    const f = fixture()
    await expect(f.service.executionHistory(input, invocation())).rejects.toBeDefined()
    expect(f.audit.list).not.toHaveBeenCalled()
    const validator = figPluginCenterSvcDef.executionHistory.request
    if (typeof validator !== 'function') throw new Error('Expected IPC request validator')
    expect(() => validator(input)).toThrow()
  })

  it('does not return a delayed history after a same-URL document reload', async () => {
    const f = fixture()
    let complete!: (events: FigPluginExecutionAuditEvent[]) => void
    f.audit.list.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const result = f.service.executionHistory({}, invocation())
    f.window.webContents.emit('did-start-navigation', {}, URL, false, true)
    complete([record()])
    await expect(result).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
  })

  it('sanitizes storage failures instead of returning paths or treating them as empty history', async () => {
    const f = fixture()
    f.audit.list.mockRejectedValue(new Error('PRIVATE C:/Users/secret-token'))
    const error = await f.service.executionHistory({}, invocation()).catch((failure) => failure)
    expect(error).toMatchObject({ code: 'IO_ERROR' })
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|Users|secret-token/)
  })

  it('reports write loss, and rejects unexpected stored payload fields', async () => {
    const f = fixture()
    f.audit.writeFailed = true
    f.audit.list.mockResolvedValue([record()])
    expect(await f.service.executionHistory({}, invocation())).toMatchObject({ writeFailed: true })
    f.audit.list.mockResolvedValue([
      { ...record(), plan: 'PRIVATE' } as FigPluginExecutionAuditEvent
    ])
    await expect(f.service.executionHistory({}, invocation())).rejects.toMatchObject({
      code: 'IO_ERROR'
    })
  })

  it('reads a reopened real file after all runtime state is gone, without replaying an incomplete write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-history-ipc-'))
    roots.push(root)
    const at = Date.now()
    const first = new FigPluginExecutionAuditStore(root)
    first.record({ ...record(), at, state: 'claimed', completed: 0, effect: 'none' })
    await first.flush()
    const reopened = new FigPluginExecutionAuditStore(root)
    const f = fixture({ list: vi.fn(() => reopened.list()), writeFailed: false })
    const result = await f.service.executionHistory({}, invocation())
    expect(result.records).toEqual([expect.objectContaining({ state: 'claimed', effect: 'none' })])
    expect(f.bridge).not.toHaveBeenCalled()
  })
})
