import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { HashRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { createConfigObservationController, type ConfigObservationController } from '@renderer/hooks/configObservation'
import { ConfigObservationProvider } from '@renderer/hooks/configObservationContext'
import ManagementStartupStorageMetadata from './ManagementStartupStorageMetadata'

const h = vi.hoisted(() => ({ read: vi.fn(), api: vi.fn(), forbidden: vi.fn(() => { throw new Error('No extra service probe') }), language: 'en', ready: true }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: DEFAULT_CONFIG, isReady: h.ready, updateConfig: h.forbidden }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: h.language } }) }))
let controller: ConfigObservationController
const available = (source = 'persisted', legacyLayout = false) => ({ status: 'available', source, legacyLayout })
const unavailable = 'Startup storage metadata unavailable', idle = 'Not loaded — use Read startup storage metadata'
const read = () => screen.getByRole('button', { name: 'Read startup storage metadata' })
function deferred() { let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void; const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function Navigation() {
  const navigate = useNavigate()
  return <><button onClick={() => navigate('/agent-management#other')}>Inner hash departure</button><button onClick={() => navigate('/agent-management', { replace: true })}>Return management</button><button onClick={() => navigate('/settings')}>Leave management</button></>
}
function Surface({ owner = controller, observed = true }: { owner?: ConfigObservationController; observed?: boolean }) {
  const section = <HashRouter><Navigation /><ManagementStartupStorageMetadata /></HashRouter>
  return observed ? <ConfigObservationProvider value={owner.source}>{section}</ConfigObservationProvider> : section
}
const mount = (strict = false, observed = true) => render(strict ? <React.StrictMode><Surface observed={observed} /></React.StrictMode> : <Surface observed={observed} />)
beforeEach(() => {
  h.read.mockReset(); h.api.mockReset(); h.forbidden.mockClear(); h.language = 'en'; h.ready = true
  h.api.mockReturnValue({ svcState: { readStartupStorageMetadata: h.read, getConfig: h.forbidden, getBuildEnv: h.forbidden, watchConfig: h.forbidden, saveConfig: h.forbidden, getUserDataDirectoryState: h.forbidden, getStorageLocations: h.forbidden }, svcMagicAgentPlatform: { readInstalledCatalog: h.forbidden, getStatus: h.forbidden, getEnablement: h.forbidden, listPackages: h.forbidden } })
  h.read.mockResolvedValue(available()); controller = createConfigObservationController(); controller.advance(true)
  window.history.replaceState(null, '', '/#/agent-management')
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const noOthers = () => expect(h.forbidden).not.toHaveBeenCalled()

describe('independent explicit startup storage metadata display — observed config, not MAIN authority', () => {
  it('mount/StrictMode/rerender/locale/config updates/focus/visibility/time cause zero API, storage or polling', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
    vi.useFakeTimers(); const view = mount(true)
    expect(screen.getByText(idle)).toBeInTheDocument(); expect(read()).toBeEnabled()
    act(() => { controller.advance(true); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    h.language = 'zh-CN'; view.rerender(<React.StrictMode><Surface /></React.StrictMode>)
    expect(screen.getByRole('heading', { name: '启动存储元数据' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(h.api).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); noOthers()
  })
  it.each(['missing-provider', 'observer-unready', 'context-unready'] as const)('disables only this action for %s without a readiness/capability probe', kind => {
    if (kind === 'observer-unready') controller.advance(false)
    if (kind === 'context-unready') h.ready = false
    mount(false, kind !== 'missing-provider'); expect(read()).toBeDisabled(); fireEvent.click(read())
    expect(h.api).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled(); noOthers()
  })
  it.each([['default', false, 'Default startup source', 'No'], ['default', true, 'Default startup source', 'Yes'], ['persisted', false, 'Persisted startup source', 'No'], ['persisted', true, 'Persisted startup source', 'Yes'], ['env', false, 'Environment startup source', 'No'], ['env', true, 'Environment startup source', 'Yes']] as const)('one explicit click renders only %s/%s from exact {} without custom/health inference', async (source, legacy, label, legacyLabel) => {
    h.read.mockResolvedValueOnce(available(source, legacy)); const { container } = mount()
    expect(read()).toBeEnabled(); fireEvent.click(read()); expect(h.read).toHaveBeenCalledExactlyOnceWith({}); expect(h.api).toHaveBeenCalledOnce()
    const section = screen.getByRole('region', { name: 'Startup storage metadata' })
    expect(await within(section).findByText(`Source: ${label}`)).toBeInTheDocument()
    expect(within(section).getByText(`Legacy layout: ${legacyLabel}`)).toBeInTheDocument()
    expect(container.querySelector('img,script,a,input,textarea,select')).toBeNull()
    expect(container.innerHTML).not.toContain('isCustom'); expect(screen.getByRole('heading',{name:'Startup storage metadata'})).toBeInTheDocument(); noOthers()
  })
  it('does not infer effective MAIN disabled from the cached configured flag, which may be overridden in MAIN', async () => {
    expect(DEFAULT_CONFIG.magic_agent_platform_config?.enabled).toBe(false); mount(); expect(read()).toBeEnabled(); fireEvent.click(read())
    expect(await screen.findByText('Source: Persisted startup source')).toBeInTheDocument(); noOthers()
  })
  it('claims pending ownership synchronously and suppresses duplicate clicks', async () => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); mount(); fireEvent.click(read()); fireEvent.click(read())
    expect(h.read).toHaveBeenCalledOnce(); expect(read()).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('Reading startup storage metadata')
    await act(async () => pending.resolve(available())); expect(read()).toBeEnabled(); expect(screen.getByText('Source: Persisted startup source')).toBeInTheDocument()
  })
  it.each(['unavailable', 'rejected', 'missing-api', 'missing-service', 'missing-method', 'extra-path', 'extra-custom', 'extra-time', 'accessor', 'unknown-status', 'unknown-source', 'invalid-layout', 'catalog-result'] as const)('fails closed for %s with static unavailable and no fallback, field stripping or diagnostics', async kind => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_STORAGE_SECRET') })
    if (kind === 'unavailable') h.read.mockResolvedValueOnce({ status: 'unavailable', reason: 'unavailable' })
    if (kind === 'rejected') h.read.mockRejectedValueOnce(Object.defineProperty({}, 'message', { get: getter }))
    if (kind === 'missing-api') h.api.mockReturnValueOnce(undefined)
    if (kind === 'missing-service') h.api.mockReturnValueOnce({})
    if (kind === 'missing-method') h.api.mockReturnValueOnce({ svcState: {} })
    if (kind === 'extra-path') h.read.mockResolvedValueOnce({ ...available(), path: 'PRIVATE_STORAGE_SECRET' })
    if (kind === 'extra-custom') h.read.mockResolvedValueOnce({ ...available(), isCustom: true })
    if (kind === 'extra-time') h.read.mockResolvedValueOnce({ ...available(), observedAt: 'PRIVATE_STORAGE_SECRET' })
    if (kind === 'accessor') h.read.mockResolvedValueOnce(Object.defineProperty(available(), 'source', { get: getter, enumerable: true }))
    if (kind === 'unknown-status') h.read.mockResolvedValueOnce({ status: 'ready', source: 'persisted', legacyLayout: false })
    if (kind === 'unknown-source') h.read.mockResolvedValueOnce(available('PRIVATE_STORAGE_SECRET'))
    if (kind === 'invalid-layout') h.read.mockResolvedValueOnce({ status: 'available', source: 'persisted', legacyLayout: 'false' })
    if (kind === 'catalog-result') h.read.mockResolvedValueOnce({ status: 'available', entries: [] })
    const { container } = mount(); expect(read()).toBeEnabled(); fireEvent.click(read())
    expect(await screen.findByRole('alert')).toHaveTextContent(unavailable); expect(screen.queryByText(/Source:/)).toBeNull()
    expect(container.innerHTML).not.toContain('PRIVATE_STORAGE_SECRET'); expect(getter).not.toHaveBeenCalled(); expect(read()).toBeEnabled(); noOthers()
  })
  it('discards the previous DTO immediately on reread and does not restore it after failure', async () => {
    mount(); expect(read()).toBeEnabled(); fireEvent.click(read()); expect(await screen.findByText('Source: Persisted startup source')).toBeInTheDocument()
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); fireEvent.click(read())
    expect(screen.queryByText('Source: Persisted startup source')).toBeNull(); expect(read()).toBeDisabled()
    await act(async () => pending.reject(new Error('PRIVATE_STORAGE_SECRET'))); expect(screen.getByRole('alert')).toHaveTextContent(unavailable); expect(screen.queryByText(/Source:/)).toBeNull()
  })
  it.each(['resolve', 'reject'] as const)('synchronous observed config ABA drops late %s while a newer request retains pending ownership', async outcome => {
    const old = deferred(), next = deferred(); h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise); mount(); expect(read()).toBeEnabled(); fireEvent.click(read())
    act(() => { controller.advance(true); controller.advance(true) }) // Same ready value/object reference may hide configured disable-enable from React.
    expect(read()).toBeEnabled(); expect(screen.getByText(idle)).toBeInTheDocument(); expect(h.read).toHaveBeenCalledOnce()
    fireEvent.click(read()); await act(async () => { if (outcome === 'resolve') old.resolve(available('env', true)); else old.reject(new Error('PRIVATE_STORAGE_SECRET')) })
    expect(screen.queryByText('Source: Environment startup source')).toBeNull(); expect(screen.queryByText(unavailable)).toBeNull(); expect(read()).toBeDisabled()
    await act(async () => next.resolve(available())); expect(screen.getByText('Source: Persisted startup source')).toBeInTheDocument(); expect(read()).toBeEnabled(); expect(h.read).toHaveBeenCalledTimes(2)
  })
  it('checks captured observation identity even when config invalidation and promise resolution are batched together', async () => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); mount(); expect(read()).toBeEnabled(); fireEvent.click(read())
    await act(async () => { controller.advance(true); pending.resolve(available('env', true)) })
    expect(screen.queryByText(/Source:/)).toBeNull(); expect(screen.getByText(idle)).toBeInTheDocument(); expect(h.read).toHaveBeenCalledOnce()
  })
  it('clears already displayed data on config change, marks unready, then reenables without automatic retry', async () => {
    mount(); expect(read()).toBeEnabled(); fireEvent.click(read()); expect(await screen.findByText('Source: Persisted startup source')).toBeInTheDocument()
    act(() => controller.advance(false)); expect(screen.queryByText(/Source:/)).toBeNull(); expect(read()).toBeDisabled()
    act(() => controller.advance(true)); expect(read()).toBeEnabled(); expect(screen.getByText(idle)).toBeInTheDocument(); expect(h.read).toHaveBeenCalledOnce()
  })
  it('context readiness loss clears displayed data even if passive observation remains ready', async () => {
    const view = mount(); expect(read()).toBeEnabled(); fireEvent.click(read()); expect(await screen.findByText('Source: Persisted startup source')).toBeInTheDocument()
    h.ready = false; view.rerender(<Surface />); expect(read()).toBeDisabled(); expect(screen.queryByText(/Source:/)).toBeNull(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('source replacement retires old %s and old notifications cannot mutate the successor', async outcome => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); const view = mount(); expect(read()).toBeEnabled(); fireEvent.click(read()); const previous = controller
    controller = createConfigObservationController(); controller.advance(true); view.rerender(<Surface />)
    await act(async () => { previous.advance(false); if (outcome === 'resolve') pending.resolve(available()); else pending.reject(new Error('PRIVATE_STORAGE_SECRET')) })
    expect(read()).toBeEnabled(); expect(screen.getByText(idle)).toBeInTheDocument(); expect(screen.queryByText(/Source:/)).toBeNull(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('unmount/remount drops old %s and never automatically reloads', async outcome => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); const first = mount(true); expect(read()).toBeEnabled(); fireEvent.click(read()); first.unmount(); mount(true)
    await act(async () => { if (outcome === 'resolve') pending.resolve(available()); else pending.reject(new Error('PRIVATE_STORAGE_SECRET')) })
    expect(screen.getByText(idle)).toBeInTheDocument(); expect(screen.queryByText(/Source:/)).toBeNull(); expect(read()).toBeEnabled(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('native observed departure-return fences old %s even when the final route is management again', async outcome => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); mount(); expect(read()).toBeEnabled(); fireEvent.click(read())
    act(() => { window.history.replaceState(null, '', '/#/settings'); window.dispatchEvent(new HashChangeEvent('hashchange')); window.history.replaceState(null, '', '/#/agent-management'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await act(async () => { if (outcome === 'resolve') pending.resolve(available()); else pending.reject(new Error('PRIVATE_STORAGE_SECRET')) })
    expect(screen.queryByText(/Source:/)).toBeNull(); expect(read()).toBeEnabled(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('actual retained HashRouter instance fences inner-hash departure→return old %s without native events', async outcome => {
    const pending = deferred(), next = deferred(); h.read.mockReturnValueOnce(pending.promise).mockReturnValueOnce(next.promise); const event = vi.fn(); window.addEventListener('hashchange', event); window.addEventListener('popstate', event)
    try {
      mount(); expect(read()).toBeEnabled(); fireEvent.click(read()); fireEvent.click(screen.getByRole('button', { name: 'Inner hash departure' })); fireEvent.click(screen.getByRole('button', { name: 'Return management' }))
      expect(event).not.toHaveBeenCalled(); expect(read()).toBeEnabled(); fireEvent.click(read())
      await act(async () => { if (outcome === 'resolve') pending.resolve(available('env', true)); else pending.reject(new Error('PRIVATE_STORAGE_SECRET')) })
      expect(screen.queryByText(/Source:/)).toBeNull(); expect(screen.queryByText(unavailable)).toBeNull(); expect(read()).toBeDisabled()
      await act(async () => next.resolve(available())); expect(screen.getByText('Source: Persisted startup source')).toBeInTheDocument(); expect(h.read).toHaveBeenCalledTimes(2)
    } finally { window.removeEventListener('hashchange', event); window.removeEventListener('popstate', event) }
  })
  it.each(['/#/agent-management/', '/#/AGENT-MANAGEMENT', '/#/%61gent-management', '/#/agent-management?claim=1', '/#/agent-management#other', '/#/settings', '/?claim=1#/agent-management', '/?#/agent-management'] as const)('never normalizes nonexact raw URL %s into read authority', route => {
    window.history.replaceState(null, '', route); mount(); fireEvent.click(read()); expect(h.api).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled(); expect(screen.queryByText(/Source:/)).toBeNull()
  })
  it('rechecks raw URL before adopting a pending reply even without an observed native event', async () => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); mount(); expect(read()).toBeEnabled(); fireEvent.click(read())
    window.history.replaceState(null, '', '/?#/agent-management'); await act(async () => pending.resolve(available()))
    expect(screen.queryByText(/Source:/)).toBeNull(); expect(h.read).toHaveBeenCalledOnce(); noOthers()
  })
  it('shows Chinese manual snapshot, static failure and allowlisted source/layout labels without diagnostics', async () => {
    h.language = 'zh-CN'; h.read.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_SECRET')); mount(); const button = () => screen.getByRole('button', { name: '读取启动存储元数据' })
    expect(button()).toBeEnabled(); fireEvent.click(button()); expect(await screen.findByRole('alert')).toHaveTextContent('启动存储元数据不可用')
    h.read.mockResolvedValueOnce(available('persisted', true)); fireEvent.click(button())
    expect(await screen.findByText('来源：已保存的启动来源')).toBeInTheDocument(); expect(screen.getByText('旧版布局：是')).toBeInTheDocument(); expect(document.body.innerHTML).not.toContain('PRIVATE_STORAGE_SECRET')
  })
})
