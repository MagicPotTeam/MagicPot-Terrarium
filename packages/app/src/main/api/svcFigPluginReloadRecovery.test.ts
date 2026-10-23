import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { figPluginCenterSvcDef } from '@shared/api/svcFigPluginCenter'
import type { FigPluginExecutionPreview } from '@shared/figplugin/execution'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { FigPluginCenterSvcImpl, disposeFigPluginBridges } from './svcFigPluginCenterImpl'
const native = vi.hoisted(() => ({ getPath: vi.fn(), showMessageBox: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showMessageBox: native.showMessageBox },
  clipboard: {},
  shell: {}
}))
const URL = 'file:///app/index.html#/workshop/plugins'
const invocation = (
  name: string,
  extra: Partial<ServiceInvocationContext> = {}
): ServiceInvocationContext => ({
  methodName: `svcFigPluginCenter.${name}`,
  senderId: 42,
  senderUrl: URL,
  frameUrl: URL,
  isMainFrame: true,
  ...extra
})
const rebind = { previousIdentity: 'a'.repeat(32), nextIdentity: 'b'.repeat(32) }
const preview: FigPluginExecutionPreview = {
  protocol: 1,
  executionId: '1'.repeat(32),
  callId: '2'.repeat(32),
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'owned-project',
  documentId: 'owned-doc',
  scopeId: 'owned-page',
  captureId: '3'.repeat(32),
  plan: {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: '3'.repeat(32),
    steps: [{ command: 'node.rename', targetId: 'node-1', name: 'Accepted' }]
  },
  planSha256: '4'.repeat(64),
  contextSha256: '5'.repeat(64),
  adapterVersion: 'figma-native-1',
  rollback: 'verified-in-place',
  visualAudit: 'hash-only',
  risk: 'low',
  differences: [
    { command: 'node.rename', targetId: 'node-1', before: 'Changed', after: 'Accepted' }
  ],
  state: 'awaiting-approval',
  requiresWriteApproval: true,
  createdAt: Date.now(),
  expiresAt: Date.now() + 120000,
  recovery: {
    baselineId: '6'.repeat(32),
    sourceExecutionId: '7'.repeat(32),
    requestId: '3'.repeat(32),
    round: 1,
    maxCorrectionRounds: 3,
    targetIds: ['node-1'],
    rebind
  }
}
const summary = {
  baselineId: '6'.repeat(32),
  pluginId: 'owned.figma',
  projectId: 'owned-project',
  host: 'figma' as const,
  documentId: 'owned-doc',
  scopeId: 'owned-page',
  targetIds: ['node-1'],
  acceptedAt: Date.now(),
  expiresAt: Date.now() + 86400000,
  correctionRoundsUsed: 0,
  maxCorrectionRounds: 3 as const
}
function fixture() {
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => URL)
    })
  }
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: URL,
    trustedWebContents: win.webContents
  })
  const bridge = {
    planState: vi.fn(() => ({
      previews: [structuredClone(preview)],
      statuses: [],
      baselines: [],
      correctionAuthorizations: []
    })),
    approvePlanExecution: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  }
  const make = vi.fn(async () => bridge as never),
    summaries = vi.fn(() => [structuredClone(summary)])
  const service = new FigPluginCenterSvcImpl(
    undefined,
    () => win as unknown as BrowserWindow,
    make,
    undefined,
    summaries
  )
  return { service, win, bridge, make, summaries }
}
beforeEach(() => {
  vi.resetAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  native.getPath.mockImplementation(() => {
    throw new Error('Outside fixture')
  })
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  expect(native.getPath).not.toHaveBeenCalled()
})
describe('trusted saved-checkpoint lookup and explicit rebind approval', () => {
  it('lists only read-only summaries without constructing Bridge or asking for write permission', async () => {
    const f = fixture()
    expect(await f.service.listSavedCheckpoints({}, invocation('listSavedCheckpoints'))).toEqual([
      summary
    ])
    expect(f.make).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })
  it.each([
    undefined,
    { senderId: 999 },
    { isMainFrame: false },
    { senderUrl: 'https://evil.invalid', frameUrl: 'https://evil.invalid' }
  ])('rejects untrusted summary access %j', async (extra) => {
    const f = fixture()
    await expect(
      f.service.listSavedCheckpoints(
        {},
        extra === undefined ? undefined : invocation('listSavedCheckpoints', extra)
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.summaries).not.toHaveBeenCalled()
  })
  it('does not accept renderer paths, tokens, or unexpected stored properties', async () => {
    const f = fixture(),
      validator = figPluginCenterSvcDef.listSavedCheckpoints.request
    if (typeof validator !== 'function') throw new Error('missing validator')
    expect(() => validator({ path: 'PRIVATE' })).toThrow()
    f.summaries.mockReturnValue([{ ...summary, plan: 'PRIVATE' } as typeof summary])
    await expect(
      f.service.listSavedCheckpoints({}, invocation('listSavedCheckpoints'))
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
  it('sanitizes a failed store read rather than silently returning an empty list', async () => {
    const f = fixture()
    f.summaries.mockImplementation(() => {
      throw new Error('PRIVATE path and secret')
    })
    const error = await f.service
      .listSavedCheckpoints({}, invocation('listSavedCheckpoints'))
      .catch((e) => e)
    expect(error).toMatchObject({ code: 'IO_ERROR' })
    expect(JSON.stringify(error)).not.toContain('PRIVATE')
  })
  it.each([
    { response: 1, checkboxChecked: true },
    { response: 0, checkboxChecked: false },
    { response: 0, checkboxChecked: true }
  ])('requires the native checkbox and approved response %j', async (answer) => {
    const f = fixture()
    await (f.service as unknown as { getBridge(): Promise<unknown> }).getBridge()
    native.showMessageBox.mockResolvedValue(answer)
    const result = await f.service.approvePlanExecution(
      { executionId: preview.executionId, planSha256: preview.planSha256 },
      invocation('approvePlanExecution')
    )
    const options = native.showMessageBox.mock.calls[0][1]
    expect(options).toMatchObject({ defaultId: 1, cancelId: 1, checkboxChecked: false })
    expect(options.detail).toContain('NOT proof that this is the original document')
    expect(options.checkboxLabel).toContain('current host document')
    const approved = answer.response === 0 && answer.checkboxChecked
    expect(result.completed).toBe(approved)
    if (approved)
      expect(f.bridge.approvePlanExecution).toHaveBeenCalledExactlyOnceWith(
        preview.executionId,
        preview.planSha256,
        true
      )
    else expect(f.bridge.approvePlanExecution).not.toHaveBeenCalled()
  })
  it('rejects a late native approval after navigation invalidates the desktop document', async () => {
    const f = fixture()
    await (f.service as unknown as { getBridge(): Promise<unknown> }).getBridge()
    let resolve!: (v: { response: number; checkboxChecked: boolean }) => void
    native.showMessageBox.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const pending = f.service.approvePlanExecution(
      { executionId: preview.executionId, planSha256: preview.planSha256 },
      invocation('approvePlanExecution')
    )
    await Promise.resolve()
    f.win.webContents.emit('did-start-navigation', {}, URL, false, true)
    resolve({ response: 0, checkboxChecked: true })
    await expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(f.bridge.approvePlanExecution).not.toHaveBeenCalled()
  })
})
