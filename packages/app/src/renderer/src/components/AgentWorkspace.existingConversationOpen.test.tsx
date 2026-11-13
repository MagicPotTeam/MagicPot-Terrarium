import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentWorkspace from './AgentWorkspace'
import { createExistingConversationOpenCoordinator, type ExistingConversationProtection } from '@renderer/utils/existingConversationOpen'
import type { ExistingConversationOpenInput } from '@renderer/pages/ChatPage/useExistingConversationOpen'
import { readExistingWorkspacePanes, type ExistingConversationWorkspaceAdapter } from './existingConversationWorkspace'
import { PROJECTS_STORAGE_KEY } from '@renderer/pages/MainPage/projectStore'

const f = vi.hoisted(() => ({ load: vi.fn(async () => []), children: [] as Child[] }))
type Child = { storageScope: string; active: boolean; acceptExternalInput: boolean; existingConversationProtection?: ExistingConversationProtection; existingConversationOpen?: ExistingConversationOpenInput }
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyError: vi.fn(), notifyInfo: vi.fn() }) }))
vi.mock('@renderer/pages/ChatPage/ChatPage', () => ({ default: (props: Child) => { f.children.push(props); return <div data-testid={props.storageScope} data-active={String(props.active)} data-guard={String(props.existingConversationProtection?.isProtected() ?? false)} data-open={String(!!props.existingConversationOpen)} /> } }))
vi.mock('@renderer/pages/ChatPage/chatStorage', () => ({ loadAllSessions: () => f.load() }))
vi.mock('@renderer/features/projectTrace/projectTraceCapture', () => ({ finalizeActiveProjectTraceCapture: vi.fn() }))
vi.mock('@renderer/features/projectTrace/ProjectTraceManagerPanel', () => ({ default: () => null }))
const projectId = 'tab-project-p', storageKey = `agent.workspace.${projectId}`, scope = `${projectId}.agent-2`
const target = { projectId, paneId: 'agent-2', storageScope: scope, sessionId: 'target' }
const initial = [{ id: 'agent-1', enabled: true }, { id: 'agent-2', enabled: true }, { id: 'disabled', enabled: false, retainedUnknownField: 'must remain' }]
const latest = (key = scope) => f.children.filter(child => child.storageScope === key).at(-1)!
const wrap = (adapter?: ExistingConversationWorkspaceAdapter, strict = false) => { const child = <ThemeProvider theme={createTheme()}><AgentWorkspace projectId={projectId} existingConversationOpen={adapter} /></ThemeProvider>; return strict ? <StrictMode>{child}</StrictMode> : child }
async function request() {
  const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true })
  const handle = coordinator.start(target)!
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const presentation = coordinator.attachPresentation(handle, () => true)!
  return { coordinator, handle, adapter: { coordinator, request: { handle, presentation } } }
}
beforeEach(() => {
  localStorage.clear(); f.children = []; f.load.mockClear()
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: projectId, name: 'Project', chatStorageScopePrefix: projectId }]))
  localStorage.setItem(storageKey, JSON.stringify(initial)); localStorage.setItem(`agent.workspace.active.${projectId}`, 'agent-1')
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('actual AgentWorkspace optional existing-only Open adapter; no Layout/UI caller', () => {
  it('activates only the exact existing enabled pane, protects every mounted sibling, and preserves full raw pane records', async () => {
    const { coordinator, handle, adapter } = await request(); const raw = localStorage.getItem(storageKey)
    render(wrap(adapter))
    await waitFor(() => expect(screen.getByTestId(scope)).toHaveAttribute('data-open', 'true'))
    expect(screen.getByTestId(scope)).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId(`${projectId}.agent-1`)).toHaveAttribute('data-active', 'false')
    expect(screen.getAllByTestId(/tab-project-p\.agent-/)).toHaveLength(2)
    expect(f.children.every(child => child.existingConversationProtection?.isProtected() === true)).toBe(true)
    expect(localStorage.getItem(storageKey)).toBe(raw)
    expect(latest().existingConversationOpen?.handle).toBe(handle)
    expect(coordinator.getSnapshot().result).toBeNull()
    coordinator.cancel(handle)
  })
  it.each([null, '{', '[]', '[{"id":"agent-2","enabled":false}]', '[{"id":"agent-2"}]'] as const)('rejects invalid/missing/empty/disabled raw pane membership %s without defaults or persistence', async raw => {
    if (raw === null) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, raw)
    const { coordinator, adapter } = await request(); render(wrap(adapter))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    expect(f.children).toHaveLength(0); expect(localStorage.getItem(storageKey)).toBe(raw)
    expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('retains sibling policy after terminal rejection, prop removal, and StrictMode replay until actual departure', async () => {
    const { coordinator, handle, adapter } = await request(); const rendered = render(wrap(adapter, true))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    await act(async () => { coordinator.cancel(handle) })
    rendered.rerender(wrap({ coordinator }, true))
    expect(f.children.slice(-2).every(child => child.existingConversationProtection?.isProtected() === true)).toBe(true)
    const stalePolicy = latest().existingConversationProtection!
    rendered.unmount(); expect(stalePolicy.isProtected()).toBe(true)
    const visit = coordinator.getSnapshot().visits.find(visit => visit.projectId === projectId)!
    coordinator.depart(visit); expect(stalePolicy.isProtected()).toBe(false)
  })
  it('invalidates pane membership before final acknowledgment when persisted enablement changes', async () => {
    const { coordinator, adapter } = await request(); render(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const input = latest().existingConversationOpen!
    const consumer = coordinator.attachConsumer(input.pane)!
    const load = coordinator.beginLoad(consumer, { scopeEpoch: 1, readSequence: 1, activationGeneration: 1 })!
    coordinator.commitLoad(consumer, load, { storageScope: scope, hasTarget: true, loadError: false, pendingDeletion: false })
    const selection = await coordinator.validateSelection(consumer, load, () => true)
    expect(selection).not.toBeNull()
    localStorage.setItem(storageKey, JSON.stringify(initial.map(pane => pane.id === 'agent-2' ? { ...pane, enabled: false } : pane)))
    expect(await coordinator.confirmCommittedSelection(consumer, selection!, () => true)).toBe(false)
    expect(coordinator.getSnapshot().result?.status).not.toBe('succeeded')
    coordinator.cancel(adapter.request!.handle)
  })
  it('does not keep an exact-pane lease after a different pane is committed active', async () => {
    const { coordinator, handle, adapter } = await request(); render(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const prior = latest().existingConversationOpen!.pane
    const other = document.querySelector(`[data-agent-workspace-scope="${projectId}.agent-1"][role="button"]`)!
    fireEvent.click(other)
    await waitFor(() => expect(screen.getByTestId(`${projectId}.agent-1`)).toHaveAttribute('data-active', 'true'))
    expect(coordinator.attachConsumer(prior)).toBeNull()
    expect(coordinator.isGuarded(projectId)).toBe(true); coordinator.cancel(handle)
  })
  it('persists an explicit ordinary pane reorder during a guarded visit without losing disabled raw fields', async () => {
    const { coordinator, handle, adapter } = await request(); render(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const source = document.querySelector(`[data-agent-workspace-scope="${projectId}.agent-1"][draggable="true"]`)!
    const destination = document.querySelector(`[data-agent-workspace-scope="${scope}"][draggable="true"]`)!
    const dataTransfer = { types: ['application/x-magicpot-agent-thread-reorder'], setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: 'move', dropEffect: 'move' }
    fireEvent.dragStart(source, { dataTransfer }); fireEvent.drop(destination, { dataTransfer })
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey)!)[0].id).toBe('agent-2'))
    expect(JSON.parse(localStorage.getItem(storageKey)!).at(-1)).toEqual(initial.at(-1))
    expect(coordinator.isGuarded(projectId)).toBe(true); coordinator.cancel(handle)
  })
  it('uses the full strict raw pane array when an Open arrives on an already mounted ordinary Workspace', async () => {
    const rendered = render(wrap())
    await waitFor(() => expect(latest()).toBeDefined())
    localStorage.setItem(storageKey, JSON.stringify(initial))
    const { coordinator, handle, adapter } = await request()
    rendered.rerender(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const add = document.querySelector('[data-testid="AddIcon"]')!.parentElement!
    fireEvent.click(add)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey)!)).toHaveLength(4))
    expect(JSON.parse(localStorage.getItem(storageKey)!).find((pane: { id: string }) => pane.id === 'disabled')).toEqual(initial.at(-1))
    coordinator.cancel(handle)
  })
  it('invalidates a lease while a trace dialog covers the pane and does not acknowledge the hidden target', async () => {
    const { coordinator, handle, adapter } = await request(); render(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const prior = latest().existingConversationOpen!.pane
    fireEvent.click(screen.getByTestId('agent-workspace-trace-button'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(coordinator.attachConsumer(prior)).toBeNull()
    expect(latest()?.existingConversationOpen).toBeUndefined()
    coordinator.cancel(handle)
  })
  it('fails closed synchronously for a wrong-project request before default children or preference writes', async () => {
    const { coordinator, adapter } = await request()
    const wrongProject = 'tab-project-other'
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([
      { id: projectId, name: 'Project', chatStorageScopePrefix: projectId },
      { id: wrongProject, name: 'Other', chatStorageScopePrefix: wrongProject }
    ]))
    render(<ThemeProvider theme={createTheme()}><AgentWorkspace projectId={wrongProject} existingConversationOpen={adapter} /></ThemeProvider>)
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    expect(f.children).toHaveLength(0)
    expect(localStorage.getItem(`agent.workspace.${wrongProject}`)).toBeNull()
    expect(localStorage.getItem(`agent.workspace.active.${wrongProject}`)).toBeNull()
    expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('does not release a prior coordinator visit when an idle replacement coordinator is supplied', async () => {
    const { coordinator, handle, adapter } = await request(); const rendered = render(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const priorPolicy = latest().existingConversationProtection!
    await act(async () => { coordinator.cancel(handle) })
    const replacement = createExistingConversationOpenCoordinator({ validate: async () => true })
    rendered.rerender(wrap({ coordinator: replacement }))
    expect(priorPolicy.isProtected()).toBe(true)
    expect(f.children.slice(-2).every(child => child.existingConversationProtection?.isProtected() === true)).toBe(true)
    rendered.unmount(); expect(priorPolicy.isProtected()).toBe(true)
    coordinator.depart(coordinator.getSnapshot().visits[0])
    expect(priorPolicy.isProtected()).toBe(false)
  })
  it('retains every replacement coordinator visit independently until each actually departs', async () => {
    const first = await request(); const rendered = render(wrap(first.adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    await act(async () => { first.coordinator.cancel(first.handle) })
    const second = await request()
    rendered.rerender(wrap(second.adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen?.coordinator).toBe(second.coordinator))
    const policy = latest().existingConversationProtection!
    await act(async () => { second.coordinator.cancel(second.handle) })
    first.coordinator.depart(first.coordinator.getSnapshot().visits[0])
    expect(policy.isProtected()).toBe(true)
    second.coordinator.depart(second.coordinator.getSnapshot().visits[0])
    expect(policy.isProtected()).toBe(false)
  })
  it('wrong-project rejection cannot resume ordinary initialization on prop removal before the actual source visit departs', async () => {
    const { coordinator, adapter } = await request(); const rendered = render(wrap(adapter))
    await waitFor(() => expect(latest()?.existingConversationOpen).toBeDefined())
    const wrongProject = 'tab-project-wrong'
    const wrong = (supplied?: ExistingConversationWorkspaceAdapter) => <ThemeProvider theme={createTheme()}><AgentWorkspace projectId={wrongProject} existingConversationOpen={supplied} /></ThemeProvider>
    f.children = []
    rendered.rerender(wrong(adapter))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    rendered.rerender(wrong())
    expect(f.children).toHaveLength(0)
    expect(localStorage.getItem(`agent.workspace.${wrongProject}`)).toBeNull()
    expect(localStorage.getItem(`agent.workspace.active.${wrongProject}`)).toBeNull()
  })
  it('does not treat foreign request supersession as departure or persist blocked empty panes after adapter removal', async () => {
    const { coordinator, adapter } = await request()
    const wrongProject = 'tab-project-wrong-supersession'
    const wrong = (supplied?: ExistingConversationWorkspaceAdapter) => <ThemeProvider theme={createTheme()}><AgentWorkspace projectId={wrongProject} existingConversationOpen={supplied} /></ThemeProvider>
    const rendered = render(wrong(adapter))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    const oldVisit = coordinator.getSnapshot().visits[0]
    const replacement = coordinator.start(target)!
    try {
      expect(coordinator.getSnapshot().visits[0]).not.toBe(oldVisit)
      expect(coordinator.isGuarded(projectId)).toBe(true)
      rendered.rerender(wrong())
      expect(localStorage.getItem(`agent.workspace.${wrongProject}`)).toBeNull()
      expect(localStorage.getItem(`agent.workspace.active.${wrongProject}`)).toBeNull()
      expect(f.children).toHaveLength(0)
    } finally { coordinator.cancel(replacement) }
  })
  it('accepts targetless canonical all-disabled panes without reconstructing them from enabled-only owners', () => {
    const disabled = [{ id: 'retained', enabled: false, extra: 'unchanged' }]
    const raw = JSON.stringify(disabled)
    localStorage.setItem(storageKey, raw)
    expect(readExistingWorkspacePanes(projectId)).toEqual({ raw, panes: disabled })
  })
  it('rejects targetless raw pane arrays that the canonical reader did not validate', () => {
    localStorage.setItem(PROJECTS_STORAGE_KEY, '[]')
    localStorage.setItem(storageKey, '[null]')
    expect(readExistingWorkspacePanes(projectId)).toBeNull()
  })
  it('keeps an orphan retained visit unloaded without crashing, repairing, or persisting its pane array', async () => {
    const { coordinator, handle } = await request(); coordinator.cancel(handle)
    localStorage.setItem(PROJECTS_STORAGE_KEY, '[]'); localStorage.setItem(storageKey, '[null]')
    render(wrap({ coordinator }))
    expect(f.children).toHaveLength(0); expect(localStorage.getItem(storageKey)).toBe('[null]')
    expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('ordinary Workspace without Open keeps existing default behavior and supplies no protection/input', async () => {
    localStorage.removeItem(storageKey); render(wrap())
    await waitFor(() => expect(screen.getByTestId(`${projectId}.agent-1`)).toBeInTheDocument())
    expect(latest(`${projectId}.agent-1`).existingConversationProtection).toBeUndefined()
    expect(latest(`${projectId}.agent-1`).existingConversationOpen).toBeUndefined()
    expect(localStorage.getItem(storageKey)).toBe('[{"id":"agent-1","enabled":true}]')
  })
})
