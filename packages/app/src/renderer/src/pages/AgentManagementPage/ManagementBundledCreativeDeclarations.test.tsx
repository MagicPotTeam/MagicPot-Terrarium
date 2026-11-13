import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { HashRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import ManagementBundledCreativeDeclarations from './ManagementBundledCreativeDeclarations'

const h = vi.hoisted(() => ({ api: vi.fn(() => { throw new Error('Static declarations must never access services') }), language: 'en' }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: h.language } }) }))
function Navigation() {
  const navigate = useNavigate()
  return <><button onClick={() => navigate('/agent-management#other')}>Inner hash departure</button><button onClick={() => navigate('/agent-management', { replace: true })}>Return management</button><button onClick={() => navigate('/settings')}>Leave management</button></>
}
function Surface() { return <HashRouter><Navigation /><ManagementBundledCreativeDeclarations /></HashRouter> }
const show = () => screen.getByRole('button', { name: 'Show bundled declarations' })
const hide = () => screen.getByRole('button', { name: 'Hide bundled declarations' })
const region = () => screen.getByRole('region', { name: 'Bundled creative-tool declarations' })
function mount(strict = false) { return render(strict ? <React.StrictMode><Surface /></React.StrictMode> : <Surface />) }
beforeEach(() => { h.api.mockClear(); h.language = 'en'; window.history.replaceState(null, '', '/#/agent-management') })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('manual bundled creative declaration preview, never a live tool probe', () => {
  it('keeps strings hidden across mount/StrictMode/rerender/language/time without services or storage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
    vi.useFakeTimers(); const view = mount(true)
    expect(show()).toHaveAttribute('aria-expanded', 'false'); expect(within(region()).queryByText('comfyui.status')).toBeNull()
    view.rerender(<React.StrictMode><Surface /></React.StrictMode>)
    expect(show()).toHaveAttribute('aria-expanded', 'false'); expect(within(region()).queryByRole('list')).toBeNull()
    h.language = 'zh-CN'; view.rerender(<React.StrictMode><Surface /></React.StrictMode>)
    expect(screen.getByRole('heading', { name: '随构建提供的创作工具声明' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '显示内置声明' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(screen.getByRole('button', { name: '显示内置声明' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).toBeNull(); expect(screen.queryByText('comfyui.status')).toBeNull()
    expect(h.api).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  })
  it('shows exactly the bundled 21 names/categories/descriptions only after a click', () => {
    const { container } = mount(); fireEvent.click(show())
    const list = within(region()).getByRole('list'), entries = within(list).getAllByRole('listitem')
    expect(entries).toHaveLength(21)
    for (const [index, row] of Object.values(bundledCreativeDeclarations).entries()) {
      expect(within(entries[index]).getByText(row.name)).toBeInTheDocument(); expect(within(entries[index]).getByText('Category: ' + row.category)).toBeInTheDocument(); expect(within(entries[index]).getByText(row.description)).toBeInTheDocument()
    }
    expect(hide()).toHaveAttribute('aria-expanded', 'true'); expect(screen.getByText('21 bundled declarations')).toBeInTheDocument()
    expect(container.querySelector('img,script,a,input,textarea,select')).toBeNull(); expect(screen.queryByRole('status')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull(); expect(h.api).not.toHaveBeenCalled()
  })
  it('hides synchronously and reveals a fresh local projection without calls or fake loading', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem')
    mount(); fireEvent.click(show()); expect(within(region()).getAllByRole('listitem')).toHaveLength(21)
    fireEvent.click(hide()); expect(within(region()).queryByRole('list')).toBeNull(); expect(show()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(show()); expect(within(region()).getAllByRole('listitem')).toHaveLength(21)
    expect(h.api).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(screen.queryByRole('status')).toBeNull()
  })
  it('retains an explicit display across ordinary rerenders and resets on unmount/remount', () => {
    const view = mount(true); fireEvent.click(show()); view.rerender(<React.StrictMode><Surface /></React.StrictMode>)
    expect(hide()).toHaveAttribute('aria-expanded', 'true'); view.unmount(); mount(true)
    expect(show()).toHaveAttribute('aria-expanded', 'false'); expect(within(region()).queryByRole('list')).toBeNull(); expect(h.api).not.toHaveBeenCalled()
  })
  it('real retained-instance HashRouter inner-hash departure/return resets without native events or auto reveal', () => {
    const hash = vi.fn(), pop = vi.fn(); window.addEventListener('hashchange', hash); window.addEventListener('popstate', pop)
    try {
      mount(); fireEvent.click(show()); expect(within(region()).getAllByRole('listitem')).toHaveLength(21)
      fireEvent.click(screen.getByRole('button', { name: 'Inner hash departure' })); expect(window.location.hash).toBe('#/agent-management#other'); expect(within(region()).queryByRole('list')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Return management' })); expect(window.location.hash).toBe('#/agent-management'); expect(show()).toHaveAttribute('aria-expanded', 'false')
      expect(hash).not.toHaveBeenCalled(); expect(pop).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled()
      fireEvent.click(show()); expect(within(region()).getAllByRole('listitem')).toHaveLength(21)
    } finally { window.removeEventListener('hashchange', hash); window.removeEventListener('popstate', pop) }
  })
  it('ordinary router departure clears displayed declarations even when the test retains the component', () => {
    mount(); fireEvent.click(show()); fireEvent.click(screen.getByRole('button', { name: 'Leave management' }))
    expect(window.location.hash).toBe('#/settings'); expect(within(region()).queryByRole('list')).toBeNull(); expect(h.api).not.toHaveBeenCalled()
  })
  it('labels static declarations honestly without live status badges, schema or execution actions', () => {
    mount(); expect(screen.getByRole('heading',{name:'Bundled creative-tool declarations'})).toBeInTheDocument()
    fireEvent.click(show()); const text = region().textContent || ''
    expect(text).not.toMatch(/inputSchema|dependency|permissionLevel|disabledByDefault|unavailableReason|131072|available tools|installed tools/)
    expect(within(region()).getAllByRole('button')).toHaveLength(1); expect(screen.queryByRole('button', { name: /execute|install|run tool/i })).toBeNull(); expect(h.api).not.toHaveBeenCalled()
  })
  it('shows Chinese labels and explicit hide without affecting the bundled data or reading services', () => {
    h.language = 'zh-CN'; mount(); fireEvent.click(screen.getByRole('button', { name: '显示内置声明' }))
    expect(screen.getByText('21 条随构建提供的声明')).toBeInTheDocument(); expect(screen.getAllByRole('listitem')).toHaveLength(21)
    expect(screen.getByText('分类: terminal')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '隐藏内置声明' })); expect(screen.queryByRole('list')).toBeNull(); expect(h.api).not.toHaveBeenCalled()
  })
})
