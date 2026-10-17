import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  type FigPluginBridgeDesktopState,
  type FigPluginBridgePreview,
  type FigPluginDesktopPairTicket
} from '@shared/figplugin/bridge'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import type { ProjectRecord } from '../MainPage/projectStore'
import PluginBridgePanel from './PluginBridgePanel'
import source from './PluginBridgePanel.tsx?raw'

const mocks = vi.hoisted(() => ({
  center: {
    createPairing: vi.fn<FigPluginCenterSvc['createPairing']>(),
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    approveBridge: vi.fn<FigPluginCenterSvc['approveBridge']>(),
    denyBridge: vi.fn<FigPluginCenterSvc['denyBridge']>(),
    revokeBridge: vi.fn<FigPluginCenterSvc['revokeBridge']>()
  },
  profiles: vi.fn<() => Promise<LLMListProfilesResp>>(),
  projects: vi.fn<() => ProjectRecord[]>(),
  project: vi.fn<(id: string) => ProjectRecord | undefined>(),
  translate: vi.fn<(key: string, values?: Record<string, unknown>) => string>()
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: mocks.center, svcLLMProxy: { listProfiles: mocks.profiles } })
}))
vi.mock('../MainPage/projectStore', () => ({
  listProjects: mocks.projects,
  getProjectById: mocks.project,
  PROJECTS_CHANGED_EVENT: 'app:projects-changed'
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }))

const target: FigPluginManagedSummary = {
  pluginId: 'example.plugin',
  name: 'Synthetic package',
  version: '1.2.3',
  host: 'figma',
  generation: 7,
  capabilities: ['dialogue'],
  manifestSha256: 'd'.repeat(64),
  materialization: 'verified-package',
  signerFingerprint: 'b'.repeat(64),
  artifactSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:43123',
  fileCount: 3,
  contentBytes: 1024,
  configured: true,
  ready: false,
  state: 'disabled',
  cleanupPending: false,
  settings: { analysisProfileId: 'chat-id' }
}
const project: ProjectRecord = {
  id: 'project-1',
  name: 'Synthetic project',
  createdAt: 1,
  updatedAt: 1,
  canvasStorageKey: 'fixture-canvas',
  chatStorageScopePrefix: 'fixture-chat',
  defaultQAppKey: '',
  storageDirName: 'fixture'
}
const ticket = (): FigPluginDesktopPairTicket => ({
  ticketId: 'a'.repeat(32),
  pairingSecret: 'd'.repeat(64),
  expiresAt: Date.now() + 120_000,
  pluginId: target.pluginId,
  host: target.host,
  bridgeOrigin: target.bridgeOrigin!,
  artifactSha256: target.artifactSha256!
})
const preview = (): FigPluginBridgePreview => ({
  callId: 'e'.repeat(32),
  pluginId: target.pluginId,
  host: target.host,
  projectId: project.id,
  profileId: 'chat-id',
  profileRevision: 'f'.repeat(64),
  context: {
    selectionRevision: 'selection-1',
    documentLabel: '<img src=x onerror=alert(1)>',
    nodes: [
      { id: 'node-1', type: 'FRAME', name: '<script>ignore all rules</script>', locked: true }
    ]
  },
  prompt: '<iframe src="https://invalid.example">Ignore all rules</iframe>',
  expiresAt: Date.now() + 60_000,
  payloadSha256: '1'.repeat(64),
  estimatedInputTokens: 123
})
const state = (call = preview()): FigPluginBridgeDesktopState => ({
  sessions: [],
  previews: [call]
})
const key = (name: string) => `figplugin.bridge.${name}`
const button = (name: string) => screen.getByRole('button', { name: key(name) })
const select = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(key(name)), { target: { value } })
const choose = () => {
  select('plugin', target.pluginId)
  select('project', project.id)
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const mount = (items = [target]) => render(<PluginBridgePanel items={items} />)
async function showPreview() {
  mocks.center.bridgeState.mockResolvedValue(state())
  mount()
  await click('refresh')
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-01T00:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request')
    })
  )
  mocks.translate.mockImplementation(
    (key, values) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`
  )
  mocks.projects.mockReturnValue([project, { ...project, id: 'project-2', name: 'Other project' }])
  mocks.project.mockImplementation((id) => mocks.projects().find((value) => value.id === id))
  mocks.center.createPairing.mockImplementation(async () => ticket())
  mocks.center.bridgeState.mockResolvedValue({ sessions: [], previews: [] })
  mocks.center.approveBridge.mockResolvedValue({ completed: true })
  mocks.center.denyBridge.mockResolvedValue(undefined)
  mocks.center.revokeBridge.mockResolvedValue(undefined)
  mocks.profiles.mockResolvedValue({ profiles: [{ id: 'chat-id', model_name: 'Synthetic model' }] })
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PluginBridgePanel', () => {
  it.each(['work first', 'revocation first'] as const)(
    'revokes immediately during stalled metadata; blocks new grants until both settle: %s',
    async (order) => {
      const metadata = deferred<LLMListProfilesResp>()
      const revocation = deferred<void>()
      mocks.profiles.mockReturnValueOnce(metadata.promise)
      mocks.center.revokeBridge.mockReturnValueOnce(revocation.promise)
      mount()
      choose()
      await click('createTicket')
      expect(screen.getByLabelText(key('ticket'))).toBeInTheDocument()
      expect(button('revokeTicket')).toBeEnabled()
      await click('revokeTicket')
      expect(mocks.center.revokeBridge).toHaveBeenCalledExactlyOnceWith({
        pluginId: target.pluginId
      })
      expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
      expect(button('revokeSelected')).toBeDisabled()
      await click('revokeSelected')
      const settleWork = () =>
        metadata.resolve({ profiles: [{ id: 'chat-id', model_name: 'STALE' }] })
      await act(async () => {
        if (order === 'work first') settleWork()
        else revocation.resolve()
      })
      expect(button('createTicket')).toBeDisabled()
      await click('createTicket')
      expect(mocks.center.createPairing).toHaveBeenCalledTimes(1)
      await act(async () => {
        if (order === 'work first') revocation.resolve()
        else settleWork()
      })
      expect(button('createTicket')).toBeEnabled()
      expect(mocks.center.bridgeState).not.toHaveBeenCalled()
      expect(mocks.center.revokeBridge).toHaveBeenCalledTimes(1)
      expect(document.body).not.toHaveTextContent('STALE')
      expect(screen.getByText(key('revoked'))).toBeInTheDocument()
      await click('createTicket')
      expect(mocks.center.createPairing).toHaveBeenCalledTimes(2)
      expect(screen.getByLabelText(key('ticket'))).toBeInTheDocument()
    }
  )

  it.each([false, true])('revokes during stalled status, including after stop=%s', async (stop) => {
    mount()
    choose()
    await click('createTicket')
    const status = deferred<FigPluginBridgeDesktopState>()
    mocks.center.bridgeState.mockReturnValueOnce(status.promise)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    if (stop) await click('stopMonitor')
    const control = stop ? 'revokeSelected' : 'revokeTicket'
    expect(button(control)).toBeEnabled()
    await click(control)
    expect(mocks.center.revokeBridge).toHaveBeenCalledExactlyOnceWith({ pluginId: target.pluginId })
    expect(button('createTicket')).toBeDisabled()
    await act(async () => {
      status.resolve(state())
    })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(button('createTicket')).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(2)
  })

  it('revokes during native approval and suppresses its late accepted response', async () => {
    await showPreview()
    const approval = deferred<{ completed: boolean }>()
    mocks.center.approveBridge.mockReturnValueOnce(approval.promise)
    fireEvent.click(screen.getByRole('checkbox'))
    await click('approveOnce')
    expect(button('revoke')).toBeEnabled()
    await click('revoke')
    expect(mocks.center.revokeBridge).toHaveBeenCalledExactlyOnceWith({ pluginId: target.pluginId })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(button('createTicket')).toBeDisabled()
    await act(async () => {
      approval.resolve({ completed: true })
    })
    expect(screen.queryByText(key('approvalAccepted'))).not.toBeInTheDocument()
    expect(screen.getByText(key('revoked'))).toBeInTheDocument()
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
  })

  it('can revoke an in-flight pairing before any ticket exists without releasing its grant lock', async () => {
    const pairing = deferred<FigPluginDesktopPairTicket | null>()
    mocks.center.createPairing.mockReturnValueOnce(pairing.promise)
    mount()
    choose()
    await click('createTicket')
    expect(button('revokeSelected')).toBeEnabled()
    await click('revokeSelected')
    expect(mocks.center.revokeBridge).toHaveBeenCalledTimes(1)
    expect(button('createTicket')).toBeDisabled()
    const lateCleanup = deferred<void>()
    mocks.center.revokeBridge.mockReturnValueOnce(lateCleanup.promise)
    await act(async () => {
      pairing.resolve(ticket())
    })
    expect(mocks.center.revokeBridge).toHaveBeenCalledTimes(2)
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    await click('createTicket')
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(1)
    await act(async () => {
      lateCleanup.resolve()
    })
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(key('ticket'))).toBeInTheDocument()
  })

  it('allows an explicit revoke retry while unrelated metadata is still stalled', async () => {
    const metadata = deferred<LLMListProfilesResp>()
    mocks.profiles.mockReturnValueOnce(metadata.promise)
    mount()
    choose()
    await click('createTicket')
    mocks.center.revokeBridge.mockRejectedValueOnce(new Error('SECRET failure'))
    await click('revokeTicket')
    expect(screen.getByText(key('errors.UNKNOWN'))).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('SECRET')
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(button('revokeSelected')).toBeEnabled()
    await click('revokeSelected')
    expect(mocks.center.revokeBridge).toHaveBeenCalledTimes(2)
    expect(screen.getByText(key('revoked'))).toBeInTheDocument()
    await act(async () => {
      metadata.reject(new Error('STALE'))
    })
    expect(mocks.center.bridgeState).not.toHaveBeenCalled()
    expect(screen.getByText(key('revoked'))).toBeInTheDocument()
  })

  it('waits for old-scope revocation before creating a new ticket', async () => {
    mount()
    choose()
    await click('createTicket')
    const cleanupReply = deferred<void>()
    mocks.center.revokeBridge.mockReturnValueOnce(cleanupReply.promise)
    select('project', 'project-2')
    await act(async () => {})
    await click('createTicket')
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    await act(async () => {
      cleanupReply.resolve()
    })
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(2)
    expect(mocks.center.createPairing).toHaveBeenLastCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: target.generation,
      projectId: 'project-2'
    })
    expect(screen.getByLabelText(key('ticket'))).toBeInTheDocument()
  })

  it('publishes the new pairing revoke control after a deferred old-package cleanup', async () => {
    const other = { ...target, pluginId: 'other.plugin' }
    mount([target, other])
    choose()
    await click('createTicket')
    const cleanupReply = deferred<void>()
    const pairingReply = deferred<FigPluginDesktopPairTicket | null>()
    mocks.center.revokeBridge.mockReturnValueOnce(cleanupReply.promise)
    mocks.center.createPairing.mockReturnValueOnce(pairingReply.promise)
    select('plugin', other.pluginId)
    await click('createTicket')
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(1)
    await act(async () => {
      cleanupReply.resolve()
    })
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(2)
    expect(button('revokeSelected')).toBeEnabled()
    await click('revokeSelected')
    expect(mocks.center.revokeBridge).toHaveBeenLastCalledWith({ pluginId: other.pluginId })
    expect(button('createTicket')).toBeDisabled()
    await act(async () => {
      pairingReply.resolve({ ...ticket(), pluginId: other.pluginId })
    })
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(mocks.center.revokeBridge).toHaveBeenLastCalledWith({ pluginId: other.pluginId })
    expect(button('createTicket')).toBeEnabled()
  })

  it('rechecks a deleted project at approval even before a storage event arrives', async () => {
    await showPreview()
    fireEvent.click(screen.getByRole('checkbox'))
    mocks.project.mockReturnValue(undefined)
    await click('approveOnce')
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByText(key('errors.CONFIGURATION_CHANGED'))).toBeInTheDocument()
  })

  it('does no IPC, networking or polling on mount, selection, or StrictMode remount before consent', async () => {
    const view = render(
      <StrictMode>
        <PluginBridgePanel items={[target]} />
      </StrictMode>
    )
    expect(button('createTicket')).toBeDisabled()
    select('plugin', target.pluginId)
    expect(button('createTicket')).toBeDisabled()
    select('project', project.id)
    expect(button('createTicket')).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_001)
    })
    view.unmount()
    await act(async () => {})
    for (const method of Object.values(mocks.center)) expect(method).not.toHaveBeenCalled()
    expect(mocks.profiles).not.toHaveBeenCalled()
  })

  it('offers only eligible packages and bounded valid project IDs', () => {
    mocks.projects.mockReturnValue([project, { ...project, id: 'bad\n' }, project])
    mount([
      { ...target, bridgeOrigin: undefined },
      { ...target, pluginId: 'no.profile', settings: {} },
      { ...target, pluginId: 'no.config', configured: false },
      { ...target, pluginId: 'metadata.only', materialization: 'metadata-only' },
      { ...target, pluginId: 'pending.cleanup', cleanupPending: true },
      { ...target, pluginId: 'no.dialogue', capabilities: ['asset-transfer'] }
    ])
    expect(screen.getByText(key('noEligible'))).toBeInTheDocument()
    expect(within(screen.getByLabelText(key('plugin'))).getAllByRole('option')).toHaveLength(1)
    expect(within(screen.getByLabelText(key('project'))).getAllByRole('option')).toHaveLength(2)
    expect(button('createTicket')).toBeDisabled()
  })

  it('honors native pairing denial, serializes double clicks, and does not start metadata/polling', async () => {
    const result = deferred<FigPluginDesktopPairTicket | null>()
    mocks.center.createPairing.mockReturnValue(result.promise)
    mount()
    choose()
    act(() => {
      fireEvent.click(button('createTicket'))
      fireEvent.click(button('createTicket'))
    })
    expect(mocks.center.createPairing).toHaveBeenCalledTimes(1)
    expect(mocks.center.createPairing).toHaveBeenCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: 7,
      projectId: project.id
    })
    expect(screen.getByLabelText(key('plugin'))).toBeDisabled()
    await act(async () => {
      result.resolve(null)
    })
    expect(screen.getByText(key('declined'))).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.center.bridgeState).not.toHaveBeenCalled()
    expect(mocks.profiles).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
  })

  it('displays the exact short-lived ticket read-only without persisting or copying secrets', async () => {
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    const value = ticket()
    mount()
    choose()
    await click('createTicket')
    const field = screen.getByLabelText(key('ticket'))
    expect(JSON.parse((field as HTMLTextAreaElement).value)).toEqual(value)
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(mocks.profiles).toHaveBeenCalledTimes(1)
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
    expect(persist).not.toHaveBeenCalled()
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
    await click('revokeTicket')
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(screen.getByText(key('revoked'))).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['plugin mismatch', { pluginId: 'other.plugin' }],
    ['host mismatch', { host: 'photoshop' }],
    ['artifact mismatch', { artifactSha256: '2'.repeat(64) }],
    ['origin mismatch', { bridgeOrigin: 'http://127.0.0.1:43124' }],
    ['origin alias', { bridgeOrigin: 'http://localhost:43123' }],
    ['origin credentials', { bridgeOrigin: 'http://secret@127.0.0.1:43123' }],
    ['secret newline', { pairingSecret: `${'d'.repeat(64)}\n` }],
    ['bad ticket ID', { ticketId: 'SECRET' }],
    ['extra fields', { token: 'SECRET' }],
    ['expired', { expiresAt: 1 }],
    ['overlong lifetime', { expiresAt: Date.parse('2026-04-01T00:10:00Z') }]
  ])('rejects %s tickets, revoking the requested plugin only', async (_name, patch) => {
    mocks.center.createPairing.mockResolvedValue({
      ...ticket(),
      ...patch
    } as FigPluginDesktopPairTicket)
    mount()
    choose()
    await click('createTicket')
    expect(screen.getByText(key('errors.INVALID_REQUEST'))).toBeInTheDocument()
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
    expect(mocks.center.bridgeState).not.toHaveBeenCalled()
    expect(mocks.profiles).not.toHaveBeenCalled()
    expect(document.body).not.toHaveTextContent('SECRET')
  })

  it('rechecks project existence before creating a ticket', async () => {
    mount()
    choose()
    mocks.project.mockReturnValue(undefined)
    await click('createTicket')
    expect(mocks.center.createPairing).not.toHaveBeenCalled()
  })

  it.each(['generation', 'removal', 'project deletion'] as const)(
    'revokes late pairing replies after %s and never exposes their secrets',
    async (change) => {
      const result = deferred<FigPluginDesktopPairTicket | null>()
      mocks.center.createPairing.mockReturnValue(result.promise)
      const view = mount()
      choose()
      await click('createTicket')
      if (change === 'generation')
        view.rerender(<PluginBridgePanel items={[{ ...target, generation: 8 }]} />)
      else if (change === 'removal') view.rerender(<PluginBridgePanel items={[]} />)
      else {
        mocks.projects.mockReturnValue([])
        act(() => {
          window.dispatchEvent(new Event('app:projects-changed'))
        })
      }
      await act(async () => {
        result.resolve(ticket())
      })
      expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
      expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
      expect(mocks.center.bridgeState).not.toHaveBeenCalled()
      expect(mocks.profiles).not.toHaveBeenCalled()
      expect(button('refresh')).toBeEnabled()
    }
  )

  it.each(['plugin', 'project'] as const)(
    'clears secrets and revokes on %s selection changes',
    async (field) => {
      mount([target, { ...target, pluginId: 'other.plugin' }])
      choose()
      await click('createTicket')
      select(field, field === 'plugin' ? 'other.plugin' : 'project-2')
      await act(async () => {})
      expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
      expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
    }
  )

  it('revokes outstanding native pairing on unmount and again when its late reply arrives', async () => {
    const result = deferred<FigPluginDesktopPairTicket | null>()
    mocks.center.createPairing.mockReturnValue(result.promise)
    const view = mount()
    choose()
    await click('createTicket')
    view.unmount()
    await act(async () => {})
    expect(mocks.center.revokeBridge).toHaveBeenCalledTimes(1)
    await act(async () => {
      result.resolve(ticket())
    })
    expect(mocks.center.revokeBridge).toHaveBeenCalledTimes(2)
    expect(mocks.profiles).not.toHaveBeenCalled()
    expect(mocks.center.bridgeState).not.toHaveBeenCalled()
  })

  it('renders hostile prompt/context as inert text and sends only the exact reviewed call ID/hash once', async () => {
    await showPreview()
    const call = preview()
    expect(screen.getByLabelText(key('prompt')).textContent).toBe(call.prompt)
    expect(JSON.parse(screen.getByLabelText(key('context')).textContent!)).toEqual(call.context)
    expect(document.querySelector('img,script,iframe,a')).toBeNull()
    expect(screen.getByText(`${key('model')} Synthetic model`)).toBeInTheDocument()
    expect(screen.getByText(`${key('tokens')} 123`)).toBeInTheDocument()
    expect(
      screen.getByText(`${key('profileRevision')} ${call.profileRevision}`)
    ).toBeInTheDocument()
    expect(button('approveOnce')).toBeDisabled()
    await click('approveOnce')
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    const response = deferred<{ completed: boolean }>()
    mocks.center.approveBridge.mockReturnValue(response.promise)
    act(() => {
      fireEvent.click(button('approveOnce'))
      fireEvent.click(button('approveOnce'))
    })
    expect(mocks.center.approveBridge).toHaveBeenCalledTimes(1)
    expect(mocks.center.approveBridge).toHaveBeenCalledWith({
      callId: call.callId,
      payloadSha256: call.payloadSha256
    })
    await act(async () => {
      response.resolve({ completed: true })
    })
    expect(screen.getByText(key('approvalAccepted'))).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('honors native approval denial without a success message or automatic retry', async () => {
    await showPreview()
    mocks.center.approveBridge.mockResolvedValue({ completed: false })
    fireEvent.click(screen.getByRole('checkbox'))
    await click('approveOnce')
    expect(screen.getByText(key('declined'))).toBeInTheDocument()
    expect(screen.queryByText(key('approvalAccepted'))).not.toBeInTheDocument()
    expect(button('approveOnce')).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.center.approveBridge).toHaveBeenCalledTimes(1)
  })

  it('denies without consent and revokes observed sessions on unmount', async () => {
    const current = state()
    current.sessions = [
      {
        sessionId: '2'.repeat(32),
        pluginId: target.pluginId,
        host: target.host,
        projectId: project.id,
        expiresAt: Date.now() + 600_000,
        activeCalls: 1
      }
    ]
    mocks.center.bridgeState.mockResolvedValue(current)
    const view = mount()
    await click('refresh')
    await click('deny')
    expect(mocks.center.denyBridge).toHaveBeenCalledWith({ callId: current.previews[0].callId })
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
    expect(screen.getByText(key('denied'))).toBeInTheDocument()
    view.unmount()
    await act(async () => {})
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
  })

  it.each(['hash', 'prompt', 'context', 'profile revision', 'project', 'expiry'] as const)(
    'resets consent when the preview %s changes, even with the same server digest',
    async (field) => {
      await showPreview()
      fireEvent.click(screen.getByRole('checkbox'))
      const next = preview()
      if (field === 'hash') next.payloadSha256 = '2'.repeat(64)
      if (field === 'prompt') next.prompt = 'Changed prompt'
      if (field === 'context') next.context.selectionRevision = 'selection-2'
      if (field === 'profile revision') next.profileRevision = '3'.repeat(64)
      if (field === 'project') next.projectId = 'project-2'
      if (field === 'expiry') next.expiresAt += 1
      mocks.center.bridgeState.mockResolvedValue(state(next))
      await click('refresh')
      expect(screen.getByRole('checkbox')).not.toBeChecked()
      expect(button('approveOnce')).toBeDisabled()
      expect(mocks.center.approveBridge).not.toHaveBeenCalled()
    }
  )

  it('preserves exact review on an unchanged snapshot but blocks missing project/profile matches', async () => {
    await showPreview()
    fireEvent.click(screen.getByRole('checkbox'))
    await click('refresh')
    expect(screen.getByRole('checkbox')).toBeChecked()
    mocks.center.bridgeState.mockResolvedValue(state({ ...preview(), profileId: 'other-profile' }))
    await click('refresh')
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(button('approveOnce')).toBeDisabled()
    expect(button('deny')).toBeEnabled()
  })

  it.each([
    'unknown key',
    'bad hash',
    'duplicate calls',
    'oversized',
    'normalized prompt'
  ] as const)(
    'fails closed on %s desktop state, clears review/secrets, and stops polling',
    async (kind) => {
      mount()
      choose()
      await click('createTicket')
      let invalid: unknown = state()
      if (kind === 'unknown key') invalid = { ...state(), sessionToken: 'SECRET' }
      if (kind === 'bad hash') invalid = state({ ...preview(), payloadSha256: 'SECRET' })
      if (kind === 'duplicate calls') invalid = { sessions: [], previews: [preview(), preview()] }
      if (kind === 'oversized')
        invalid = { sessions: [], previews: Array.from({ length: 33 }, preview) }
      if (kind === 'normalized prompt') invalid = state({ ...preview(), prompt: ' leading space' })
      mocks.center.bridgeState.mockResolvedValue(invalid as FigPluginBridgeDesktopState)
      await click('refresh')
      expect(screen.getByText(key('errors.INVALID_REQUEST'))).toBeInTheDocument()
      expect(screen.queryByRole('article')).not.toBeInTheDocument()
      expect(document.body).not.toHaveTextContent('fixture-data')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(mocks.center.bridgeState).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['generation', 'project deletion', 'stop', 'unmount'] as const)(
    'ignores late state replies after %s without repopulating previews',
    async (change) => {
      const response = deferred<FigPluginBridgeDesktopState>()
      mocks.center.bridgeState.mockReturnValue(response.promise)
      const view = mount()
      choose()
      await click('enableMonitor')
      if (change === 'generation')
        view.rerender(<PluginBridgePanel items={[{ ...target, generation: 8 }]} />)
      else if (change === 'project deletion') {
        mocks.projects.mockReturnValue([])
        act(() => {
          window.dispatchEvent(new Event('storage'))
        })
      } else if (change === 'stop') await click('stopMonitor')
      else view.unmount()
      await act(async () => {
        response.resolve(state())
      })
      expect(screen.queryByRole('article')).not.toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
      if (change !== 'unmount') expect(button('refresh')).toBeEnabled()
    }
  )

  it('ignores late model metadata and approval feedback after package invalidation', async () => {
    const response = deferred<LLMListProfilesResp>()
    mocks.profiles.mockReturnValueOnce(response.promise)
    const view = mount()
    await click('refresh')
    view.rerender(<PluginBridgePanel items={[{ ...target, generation: 8 }]} />)
    await act(async () => {
      response.resolve({ profiles: [{ id: 'chat-id', model_name: 'STALE' }] })
    })
    expect(mocks.center.bridgeState).not.toHaveBeenCalled()
    mocks.center.bridgeState.mockResolvedValue(state())
    await click('refresh')
    fireEvent.click(screen.getByRole('checkbox'))
    const approval = deferred<{ completed: boolean }>()
    mocks.center.approveBridge.mockReturnValue(approval.promise)
    await click('approveOnce')
    view.rerender(<PluginBridgePanel items={[{ ...target, generation: 9 }]} />)
    await act(async () => {
      approval.resolve({ completed: true })
    })
    expect(screen.queryByText(key('approvalAccepted'))).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
  })

  it('expires previews and pairing secrets, including delayed clicks before timers run', async () => {
    const current = state({ ...preview(), expiresAt: Date.now() + 1000 })
    mocks.center.bridgeState.mockResolvedValue(current)
    mount()
    choose()
    await click('createTicket')
    fireEvent.click(screen.getByRole('checkbox'))
    vi.setSystemTime(Date.now() + 1001)
    await click('approveOnce')
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
  })

  it('clears a redeemed ticket when its session is observed and offers explicit revocation', async () => {
    mount()
    choose()
    await click('createTicket')
    mocks.center.bridgeState.mockResolvedValue({
      previews: [],
      sessions: [
        {
          sessionId: '2'.repeat(32),
          pluginId: target.pluginId,
          host: target.host,
          projectId: project.id,
          expiresAt: Date.now() + 600_000,
          activeCalls: 0
        }
      ]
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    await click('revoke')
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
    expect(screen.getByText(key('noSessions'))).toBeInTheDocument()
  })

  it('polls at most once at a time, stops at ten minutes, and ignores a reply crossing the deadline', async () => {
    mount()
    await click('enableMonitor')
    const late = deferred<FigPluginBridgeDesktopState>()
    mocks.center.bridgeState.mockReturnValue(late.promise)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(598_001)
    })
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(2)
    expect(screen.getByText(key('monitorStopped'))).toBeInTheDocument()
    await act(async () => {
      late.resolve(state())
    })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(2)
    expect(button('enableMonitor')).toBeEnabled()
  })

  it('manual refresh does not begin polling; explicit stop clears secrets without claiming revocation', async () => {
    mount()
    await click('refresh')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
    choose()
    await click('createTicket')
    await click('stopMonitor')
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(screen.getByText(key('monitorStopped'))).toBeInTheDocument()
    expect(mocks.center.revokeBridge).not.toHaveBeenCalled()
    await click('revokeSelected')
    expect(mocks.center.revokeBridge).toHaveBeenCalledWith({ pluginId: target.pluginId })
  })

  it.each([
    ['coded error', { code: 'EXPIRED', message: 'SECRET C:/fixture-data/token' }, 'EXPIRED'],
    [
      'Electron fixed message',
      new Error(`SECRET: ${FIGPLUGIN_BRIDGE_ERRORS.CONFIGURATION_CHANGED}`),
      'CONFIGURATION_CHANGED'
    ],
    ['raw error', new Error('SECRET C:/fixture-data/token'), 'UNKNOWN'],
    ['unknown code', { code: 'SECRET', message: 'SECRET' }, 'UNKNOWN']
  ])(
    'shows only safe fixed text for %s and never retries automatically',
    async (_name, failure, code) => {
      mocks.center.bridgeState.mockRejectedValue(failure)
      mount()
      await click('enableMonitor')
      expect(document.body).not.toHaveTextContent('fixture-data')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(mocks.center.bridgeState).toHaveBeenCalledTimes(1)
    }
  )

  it('does not report failed revocation as success; clears the secret and allows explicit retry', async () => {
    mount()
    choose()
    await click('createTicket')
    mocks.center.revokeBridge.mockRejectedValueOnce(new Error('SECRET'))
    await click('revokeTicket')
    expect(screen.queryByLabelText(key('ticket'))).not.toBeInTheDocument()
    expect(screen.getByText(key('errors.UNKNOWN'))).toBeInTheDocument()
    expect(screen.queryByText(key('revoked'))).not.toBeInTheDocument()
    await click('revokeSelected')
    expect(screen.getByText(key('revoked'))).toBeInTheDocument()
  })
})

describe('Bridge localization', () => {
  it('supplies matching EN/ZH keys, placeholders and every static UI/error key', () => {
    const flatten = (value: object, prefix = ''): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([name, text]) =>
          typeof text === 'string'
            ? [[`${prefix}${name}`, text]]
            : Object.entries(flatten(text, `${prefix}${name}.`))
        )
      )
    const english = flatten(en.figplugin.bridge)
    const chinese = flatten(zh.figplugin.bridge)
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort())
    for (const [name, text] of Object.entries(english)) {
      expect(text.trim()).not.toBe('')
      expect(chinese[name].trim()).not.toBe('')
      expect(text.match(/{{\w+}}/g)?.sort() ?? []).toEqual(
        chinese[name].match(/{{\w+}}/g)?.sort() ?? []
      )
    }
    for (const match of source.matchAll(/'figplugin\.bridge\.([A-Za-z.]+)'/g))
      expect(english[match[1]], match[1]).toBeTruthy()
    for (const code of [...Object.keys(FIGPLUGIN_BRIDGE_ERRORS), 'UNKNOWN'])
      expect(english[`errors.${code}`], code).toBeTruthy()
  })

  it.each([
    ['en', en],
    ['zh', zh]
  ] as const)('renders %s consent and bearer-capability limitations', async (lng, locale) => {
    const i18n = createInstance()
    await i18n.init({
      lng,
      fallbackLng: false,
      resources: { [lng]: { translation: locale } },
      interpolation: { escapeValue: false }
    })
    mocks.translate.mockImplementation((key, values) =>
      i18n.t(key, { ...(values ?? {}), defaultValue: key })
    )
    mount()
    expect(screen.getByRole('heading', { name: locale.figplugin.bridge.title })).toBeInTheDocument()
    expect(screen.getByText(locale.figplugin.bridge.secretWarning)).toBeInTheDocument()
    expect(screen.getByText(locale.figplugin.bridge.charges)).toBeInTheDocument()
    expect(screen.getByText(locale.figplugin.bridge.limits)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('figplugin.bridge.')
  })
})
