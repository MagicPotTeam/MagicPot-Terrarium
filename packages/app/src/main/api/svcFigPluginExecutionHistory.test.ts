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

  it.each([{ path: 'C:/PRIVATE' }, { limit: 257 }, { limit: 0 }, { sessionToken: 'PRIVATE' }])(
    'rejects renderer-controlled paths, authority and excess budget: %j',
    async (input) => {
      const f = fixture()
      await expect(f.service.executionHistory(input, invocation())).rejects.toBeDefined()
      expect(f.audit.list).not.toHaveBeenCalled()
      const validator = figPluginCenterSvcDef.executionHistory.request
      if (typeof validator !== 'function') throw new Error('Expected IPC request validator')
      expect(() => validator(input)).toThrow()
    }
  )

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
