import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { HashRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ManagementInstalledCatalog from './ManagementInstalledCatalog'

const h = vi.hoisted(() => ({ read: vi.fn(), api: vi.fn(), forbidden: vi.fn(() => { throw new Error('No other service') }), language: 'en' }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: h.language } }) }))
const row = { id: 'demo', name: '<img src=x onerror="SECRET=1">', version: '1.2.3', installedAt: '2026-01-01T00:00:00.000Z' }
const available = (name = row.name) => ({ status: 'available', entries: [{ ...row, name }] })
const unavailable = 'Installed catalog unavailable', empty = 'No installed packages in the validated catalog snapshot'
function deferred() { let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void; const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function Navigation() {
  const navigate = useNavigate()
  return <><button onClick={() => navigate('/agent-management#other')}>Inner hash departure</button><button onClick={() => navigate('/agent-management', { replace: true })}>Return management</button><button onClick={() => navigate('/settings')}>Leave management</button></>
}
function Surface() { return <HashRouter><Navigation /><ManagementInstalledCatalog /></HashRouter> }
function mount(strict = false) { return render(strict ? <React.StrictMode><Surface /></React.StrictMode> : <Surface />) }
const read = () => screen.getByRole('button', { name: 'Read installed catalog' })
const assertNoOtherActivity = () => { expect(h.forbidden).not.toHaveBeenCalled() }
beforeEach(() => {
  h.read.mockReset(); h.api.mockReset(); h.forbidden.mockClear(); h.language = 'en'
  h.api.mockReturnValue({ svcMagicAgentPlatform: { readInstalledCatalog: h.read, getStatus: h.forbidden, listPackages: h.forbidden }, svcApp: { getConfig: h.forbidden }, svcAuth: { getIdentity: h.forbidden } })
  h.read.mockResolvedValue(available())
  window.history.replaceState(null, '', '/#/agent-management')
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('explicit installed catalog renderer view', () => {
  it('mounts/StrictMode/rerenders/language change and time progression with zero API, storage or polling', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
    vi.useFakeTimers(); const view = mount(true)
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument(); expect(read()).toBeEnabled()
    h.language = 'zh-CN'; view.rerender(<React.StrictMode><Surface /></React.StrictMode>)
    expect(screen.getByRole('heading', { name: '已安装目录' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(h.api).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); assertNoOtherActivity()
  })
  it('one explicit click uses only the typed empty payload and renders four bounded public fields as inert text', async () => {
    const { container } = mount()
    fireEvent.click(read()); expect(h.read).toHaveBeenCalledExactlyOnceWith({}); expect(h.api).toHaveBeenCalledOnce()
    const region = screen.getByRole('region', { name: 'Installed catalogs' })
    expect(await within(region).findByText(row.name)).toBeInTheDocument()
    expect(within(region).getByText('ID: demo')).toBeInTheDocument(); expect(within(region).getByText('Version: 1.2.3')).toBeInTheDocument(); expect(within(region).getByText('Installed at: 2026-01-01T00:00:00.000Z')).toBeInTheDocument()
    expect(container.querySelector('img,script,a,input,textarea,select')).toBeNull(); expect(screen.getByRole('heading',{name:'Installed catalogs'})).toBeInTheDocument(); assertNoOtherActivity()
  })
  it('acquires pending ownership synchronously and suppresses duplicate clicks without extra calls', async () => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); mount()
    fireEvent.click(read()); expect(screen.getByRole('status')).toHaveTextContent('Reading installed catalog'); expect(read()).toBeDisabled()
    fireEvent.click(read()); expect(h.read).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(available())); expect(screen.getByText(row.name)).toBeInTheDocument(); expect(read()).toBeEnabled()
  })
  it('displays empty only for a validated available-empty response', async () => {
    h.read.mockResolvedValueOnce({ status: 'available', entries: [] }); mount(); fireEvent.click(read())
    expect(await screen.findByText(empty)).toBeInTheDocument(); expect(screen.queryByText(unavailable)).toBeNull(); assertNoOtherActivity()
  })
  it.each(['unavailable', 'rejected', 'missing-api', 'missing-method', 'extra-path', 'accessor', 'duplicate', 'limit', 'unknown-status'] as const)('fails closed for %s with static unavailable, no empty, raw error or fallback', async kind => {
    const getter = vi.fn(() => 'PRIVATE_SECRET_PATH')
    if (kind === 'unavailable') h.read.mockResolvedValueOnce({ status: 'unavailable', reason: 'unavailable' })
    if (kind === 'rejected') h.read.mockRejectedValueOnce(new Error('PRIVATE_SECRET_PATH'))
    if (kind === 'missing-api') h.api.mockReturnValueOnce(undefined)
    if (kind === 'missing-method') h.api.mockReturnValueOnce({ svcMagicAgentPlatform: {} })
    if (kind === 'extra-path') h.read.mockResolvedValueOnce({ ...available(), sourcePath: 'PRIVATE_SECRET_PATH' })
    if (kind === 'accessor') h.read.mockResolvedValueOnce(Object.defineProperty(available(), 'sourcePath', { get: getter, enumerable: true }))
    if (kind === 'duplicate') h.read.mockResolvedValueOnce({ status: 'available', entries: [row, row] })
    if (kind === 'limit') h.read.mockResolvedValueOnce({ status: 'available', entries: Array.from({ length: 65 }, (_, index) => ({ ...row, id: 'item-' + index })) })
    if (kind === 'unknown-status') h.read.mockResolvedValueOnce({ status: 'ready', entries: [row], error: 'PRIVATE_SECRET_PATH' })
    const { container } = mount(); fireEvent.click(read())
    expect(await screen.findByRole('alert')).toHaveTextContent(unavailable); expect(screen.queryByText(empty)).toBeNull(); expect(screen.queryByText(row.name)).toBeNull()
    expect(container.innerHTML).not.toContain('PRIVATE_SECRET_PATH'); expect(getter).not.toHaveBeenCalled(); expect(read()).toBeEnabled(); assertNoOtherActivity()
  })
  it('clears the old snapshot immediately on reread and never restores it after failure', async () => {
    mount(); fireEvent.click(read()); expect(await screen.findByText(row.name)).toBeInTheDocument()
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); fireEvent.click(read())
    expect(screen.queryByText(row.name)).toBeNull(); expect(screen.getByRole('status')).toHaveTextContent('Reading installed catalog')
    await act(async () => pending.reject(new Error('PRIVATE_SECRET_PATH')))
    expect(screen.getByRole('alert')).toHaveTextContent(unavailable); expect(screen.queryByText(row.name)).toBeNull()
  })
  it.each(['resolve', 'reject'] as const)('unmount/remount late %s cannot publish into or change the successor instance', async outcome => {
    const old = deferred(); h.read.mockReturnValueOnce(old.promise); const first = mount(true); fireEvent.click(read()); first.unmount()
    mount(true); expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument()
    await act(async () => { if (outcome === 'resolve') old.resolve(available()); else old.reject(new Error('PRIVATE_SECRET_PATH')) })
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument(); expect(screen.queryByText(row.name)).toBeNull(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('native observed departure-return releases old pending ownership and ignores late %s', async outcome => {
    const old = deferred(); h.read.mockReturnValueOnce(old.promise); mount(); fireEvent.click(read())
    act(() => { window.history.replaceState(null, '', '/#/settings'); window.dispatchEvent(new HashChangeEvent('hashchange')); window.history.replaceState(null, '', '/#/agent-management'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(read()).toBeEnabled(); expect(screen.queryByText(row.name)).toBeNull(); expect(h.read).toHaveBeenCalledOnce()
    await act(async () => { if (outcome === 'resolve') old.resolve(available()); else old.reject(new Error('PRIVATE_SECRET_PATH')) })
    expect(screen.queryByText(row.name)).toBeNull(); expect(screen.queryByText(empty)).toBeNull(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['resolve', 'reject'] as const)('real HashRouter retained-instance inner-hash departure-return fences old %s after a new request without native events', async outcome => {
    const old = deferred(), next = deferred(); h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const hashEvent = vi.fn(), popEvent = vi.fn(); window.addEventListener('hashchange', hashEvent); window.addEventListener('popstate', popEvent)
    try {
      mount(); fireEvent.click(read())
      fireEvent.click(screen.getByRole('button', { name: 'Inner hash departure' })); expect(window.location.hash).toBe('#/agent-management#other')
      fireEvent.click(screen.getByRole('button', { name: 'Return management' })); expect(window.location.hash).toBe('#/agent-management')
      expect(hashEvent).not.toHaveBeenCalled(); expect(popEvent).not.toHaveBeenCalled(); expect(read()).toBeEnabled(); expect(h.read).toHaveBeenCalledOnce()
      fireEvent.click(read()); expect(h.read).toHaveBeenCalledTimes(2)
      await act(async () => { if (outcome === 'resolve') old.resolve(available('OLD_FORBIDDEN')); else old.reject(new Error('PRIVATE_SECRET_PATH')) })
      expect(screen.queryByText('OLD_FORBIDDEN')).toBeNull(); expect(screen.queryByText(unavailable)).toBeNull(); expect(read()).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('Reading installed catalog')
      await act(async () => next.resolve(available('NEW_CURRENT')))
      expect(screen.getByText('NEW_CURRENT')).toBeInTheDocument(); expect(read()).toBeEnabled(); assertNoOtherActivity()
    } finally { window.removeEventListener('hashchange', hashEvent); window.removeEventListener('popstate', popEvent) }
  })
  it('real HashRouter in-place departure clears an already rendered snapshot and return never auto-reads', async () => {
    mount(); fireEvent.click(read()); expect(await screen.findByText(row.name)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Inner hash departure' })); expect(screen.queryByText(row.name)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Return management' })); expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument(); expect(h.read).toHaveBeenCalledOnce()
  })
  it.each(['/agent-management/', '/AGENT-MANAGEMENT', '/%61gent-management', '/agent-management?claim=1', '/agent-management#other', '/settings'] as const)('never normalizes nonexact raw route %s into read authority', async route => {
    window.history.replaceState(null, '', '/#' + route); mount(); fireEvent.click(read())
    expect(await screen.findByRole('alert')).toHaveTextContent(unavailable); expect(h.api).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled()
  })
  it('checks the exact route again when an awaited response settles even before a native departure event is observed', async () => {
    const pending = deferred(); h.read.mockReturnValueOnce(pending.promise); mount(); fireEvent.click(read())
    window.history.replaceState(null, '', '/#/settings')
    await act(async () => pending.resolve(available()))
    expect(screen.queryByText(row.name)).toBeNull(); expect(screen.queryByText(empty)).toBeNull(); expect(screen.getByRole('alert')).toHaveTextContent(unavailable)
  })
  it('shows Chinese idle, static unavailable and empty without dumping error details', async () => {
    h.language = 'zh-CN'; h.read.mockRejectedValueOnce(new Error('PRIVATE_SECRET_PATH')); mount()
    expect(screen.getByText('尚未读取 — 请点击读取已安装目录')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '读取已安装目录' })); expect(await screen.findByRole('alert')).toHaveTextContent('已安装目录不可用')
    h.read.mockResolvedValueOnce({ status: 'available', entries: [] }); fireEvent.click(screen.getByRole('button', { name: '读取已安装目录' }))
    expect(await screen.findByText('已验证的目录快照中没有已安装包')).toBeInTheDocument()
  })
})
