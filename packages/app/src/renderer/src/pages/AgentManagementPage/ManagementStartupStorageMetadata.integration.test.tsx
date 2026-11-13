import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HashRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { ConfigProvider } from '@renderer/hooks/useConfig'
import layoutSlice from '@renderer/store/slices/layoutSlice'
import projectConfigSlice from '@renderer/store/slices/projectConfigSlice'
import AgentManagementPage from './AgentManagementPage'

const h = vi.hoisted(() => ({ api: vi.fn(), get: vi.fn(), build: vi.fn(), watch: vi.fn(), save: vi.fn(), read: vi.fn(), forbidden: vi.fn(() => { throw new Error('EXTRA_CAPABILITY_OR_STORAGE_PROBE') }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
vi.mock('@renderer/store', async () => { const redux = await import('react-redux'); return { useAppDispatch: redux.useDispatch, useAppSelector: redux.useSelector } })
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }))
let onData: ((data: { config: Config }) => void) | undefined
const read = () => screen.getByRole('button', { name: 'Read startup storage metadata' })
function deferred() { let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void; const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const available = { status: 'available', source: 'persisted', legacyLayout: true }
const sentinel = 'PRIVATE_STORAGE_ACCOUNT_CREDENTIAL_PATH_MUST_NOT_RENDER'
const fixture = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), download_dir: sentinel, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] }, magic_agent_platform_config: { enabled: false } })
function mount(strict = false) {
  const store = configureStore({ reducer: { layout: layoutSlice.reducer, projectConfig: projectConfigSlice.reducer } })
  const tree = <Provider store={store}><ConfigProvider><HashRouter><AgentManagementPage /></HashRouter></ConfigProvider></Provider>
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
}
const initialized = async () => { await waitFor(() => expect(h.watch).toHaveBeenCalledOnce()); await act(async () => { await Promise.resolve() }) }
beforeEach(() => {
  vi.clearAllMocks(); onData = undefined; window.history.replaceState(null, '', '/#/agent-management'); h.read.mockReset(); h.read.mockResolvedValue(available)
  h.get.mockResolvedValue({ config: fixture() }); h.build.mockResolvedValue({ buildEnv: DEFAULT_BUILD_ENV })
  h.watch.mockImplementation((_request, response) => { onData = response.onData; return new Promise(() => {}) })
  h.api.mockReturnValue({ svcState: { getConfig: h.get, getBuildEnv: h.build, watchConfig: h.watch, saveConfig: h.save, readStartupStorageMetadata: h.read, getUserDataDirectoryState: h.forbidden, getStorageLocations: h.forbidden }, svcMagicAgentPlatform: { readInstalledCatalog: h.forbidden, listPackages: h.forbidden, listAgents: h.forbidden, getStatus: h.forbidden, getEnablement: h.forbidden } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('actual existing ConfigProvider + real management composition + separate startup metadata action', () => {
  it('mounts its independent section without new init/watch/read/save and keeps Persistence/account/runtime unavailable and both Settings handoffs', async () => {
    const { container } = mount(); await initialized()
    expect(screen.getByRole('heading', { name: 'Startup storage metadata' })).toBeInTheDocument(); expect(read()).toBeEnabled()
    expect(h.get).toHaveBeenCalledExactlyOnceWith({}); expect(h.build).toHaveBeenCalledExactlyOnceWith({}); expect(h.watch.mock.calls[0][0]).toEqual({}); expect(h.api).toHaveBeenCalledTimes(3)
    expect(h.read).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open skill-source settings' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Open model-profile settings' })).toBeEnabled()
    for (const name of ['Persistence', 'Account identity', 'Runtime and deployment']) expect(within(screen.getByRole('region', { name })).getByText('Unavailable in this local-config view')).toBeInTheDocument()
    for (const name of ['Installed catalogs', 'Bundled creative-tool declarations', 'Sessions']) expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    expect(container.innerHTML).not.toContain(sentinel)
  })
  it.each(['resolve', 'reject'] as const)('existing watch batched disable→reenable ABA clears old %s without another config/capability probe and preserves successor pending', async outcome => {
    const old = deferred(), next = deferred(); h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const { container } = mount(); await initialized(); expect(read()).toBeEnabled(); fireEvent.click(read()); expect(h.read).toHaveBeenCalledExactlyOnceWith({})
    const same = fixture(); act(() => { same.magic_agent_platform_config = { enabled: false }; onData?.({ config: same }); same.magic_agent_platform_config = { enabled: true }; onData?.({ config: same }) })
    expect(read()).toBeEnabled(); expect(screen.getByText('Not loaded — use Read startup storage metadata')).toBeInTheDocument()
    expect(h.get).toHaveBeenCalledOnce(); expect(h.build).toHaveBeenCalledOnce(); expect(h.watch).toHaveBeenCalledOnce(); expect(h.api).toHaveBeenCalledTimes(4); expect(h.read).toHaveBeenCalledOnce()
    fireEvent.click(read()); await act(async () => { if (outcome === 'resolve') old.resolve({ status: 'available', source: 'env', legacyLayout: false }); else old.reject(new Error(sentinel)) })
    expect(screen.queryByText(/Source:/)).toBeNull(); expect(screen.queryByText('Startup storage metadata unavailable')).toBeNull(); expect(read()).toBeDisabled()
    await act(async () => next.resolve(available)); expect(screen.getByText('Source: Persisted startup source')).toBeInTheDocument(); expect(screen.getByText('Legacy layout: Yes')).toBeInTheDocument()
    expect(h.read.mock.calls).toEqual([[{}], [{}]]); expect(h.api).toHaveBeenCalledTimes(5); expect(h.save).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled(); expect(container.innerHTML).not.toContain(sentinel)
    expect(within(screen.getByRole('region', { name: 'Persistence' })).getByText('Unavailable in this local-config view')).toBeInTheDocument()
  })
  it('watch commit revokes already displayed metadata even when the same object is delivered twice; no automatic reread/save', async () => {
    mount(); await initialized(); expect(read()).toBeEnabled(); fireEvent.click(read()); expect(await screen.findByText('Source: Persisted startup source')).toBeInTheDocument()
    const same = fixture(); act(() => { onData?.({ config: same }); onData?.({ config: same }) })
    expect(screen.queryByText(/Source:/)).toBeNull(); expect(screen.getByText('Not loaded — use Read startup storage metadata')).toBeInTheDocument(); expect(read()).toBeEnabled()
    expect(h.read).toHaveBeenCalledOnce(); expect(h.api).toHaveBeenCalledTimes(4); expect(h.save).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled()
  })
  it('StrictMode preserves only the existing provider initialization replay and one current watch; no automatic metadata read', async () => {
    mount(true); await initialized(); expect(read()).toBeEnabled(); expect(h.get).toHaveBeenCalledTimes(2); expect(h.build).toHaveBeenCalledTimes(2); expect(h.watch).toHaveBeenCalledOnce(); expect(h.api).toHaveBeenCalledTimes(5)
    expect(h.read).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled()
  })
})
