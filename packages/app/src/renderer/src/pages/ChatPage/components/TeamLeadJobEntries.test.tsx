import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TeamLeadJobEntries from './TeamLeadJobEntries'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), stop: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentJobs: mocks.list, readAgentJob: mocks.read, stopAgentJob: mocks.stop } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const job = (id = 'same'): AgentThreadJob => ({ id, kind: 'explore', task: 'task', status: 'running', createdAt: Date.now(), expiresAt: Date.now() + 60000 })
const renderEntries = ({ entries, error }: Parameters<React.ComponentProps<typeof TeamLeadJobEntries>['children']>[0]) => <>
  {error && <div role="alert">lead failure</div>}
  {entries.map((entry) => <section key={entry.key}><span>{entry.name}</span><button onClick={() => void entry.stop()}>outer stop</button>{entry.detail}</section>)}
</>
const view = (currentId = 'member', leadId = 'lead', activeTeamKey: string | null = 'generation-1', currentIds: ReadonlySet<string> = new Set()) => <TeamLeadJobEntries route={route} currentId={currentId} leadId={leadId} activeTeamKey={activeTeamKey} currentIds={currentIds}>{renderEntries}</TeamLeadJobEntries>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
beforeEach(() => { vi.useFakeTimers(); mocks.list.mockReset(); mocks.read.mockReset(); mocks.stop.mockReset(); mocks.list.mockResolvedValue({ jobs: [job()] }); mocks.stop.mockResolvedValue({ job: job() }); mocks.read.mockResolvedValue({ job: job(), text: 'lead output', nextOffset: 11, totalCharacters: 11 }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('TeamLeadJobEntries', () => {
  it('does not query invalid team or duplicate the current scope', async () => {
    const component = render(view('member', 'lead', null))
    component.rerender(view('lead', 'lead'))
    await flush()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByText('组长 · explore')).not.toBeInTheDocument()
  })
  it('uses only lead scope for list, detail read and stop', async () => {
    render(view()); await flush()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'lead' })
    expect(screen.getByText('组长 · explore')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'lead', jobId: 'same', offset: 0, limit: 16000 })
    expect(screen.getByText('lead output')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'outer stop' })) })
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'lead', jobId: 'same' })
  })
  it('discards late list on team change and deactivation even with same lead', async () => {
    let finish!: (value: { jobs: AgentThreadJob[] }) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue({ jobs: [] })
    const component = render(view())
    component.rerender(view('member', 'lead', 'generation-2'))
    await act(async () => { finish({ jobs: [job()] }); await Promise.resolve() })
    expect(screen.queryByText('组长 · explore')).not.toBeInTheDocument()
    component.rerender(view('member', 'lead', null))
    await flush()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('clears old detail for same job id across different leads and rejects delayed reads', async () => {
    let finish!: (value: unknown) => void
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const component = render(view()); await flush()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
    component.rerender(view('member', 'lead2'))
    await flush()
    await act(async () => { finish({ job: job(), text: 'OLD SECRET', nextOffset: 10, totalCharacters: 10 }) })
    expect(screen.getByText('组长 · explore')).toBeInTheDocument()
    expect(screen.queryByText('OLD SECRET')).not.toBeInTheDocument()
    expect(mocks.list).toHaveBeenLastCalledWith({ route, conversationId: 'lead2' })
  })
  it('suppresses matching current ids while keeping lead-only actions scoped to lead', async () => {
    mocks.list.mockResolvedValue({ jobs: [job('same'), job('lead-only')] })
    const component = render(view('member', 'lead', 'generation-1', new Set(['same'])))
    await flush()
    expect(screen.getAllByText('组长 · explore')).toHaveLength(1)
    expect(screen.queryByText(/same/)).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'outer stop' })) })
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'lead', jobId: 'lead-only' })
    component.rerender(view('member', 'lead', 'generation-1', new Set(['same', 'lead-only'])))
    expect(screen.queryByText('组长 · explore')).not.toBeInTheDocument()
  })
  it('invalidates captured actions on team switch and same-id suppression, including late stop rejection', async () => {
    let captured: (() => Promise<boolean>) | undefined
    let reject!: (error: Error) => void
    mocks.stop.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const capture = ({ entries }: Parameters<React.ComponentProps<typeof TeamLeadJobEntries>['children']>[0]) => { if (entries[0]) captured = entries[0].stop; return null }
    const element = (team: string | null, currentIds = new Set<string>()) => <TeamLeadJobEntries route={route} currentId="member" leadId="lead" activeTeamKey={team} currentIds={currentIds}>{capture}</TeamLeadJobEntries>
    const component = render(element('one')); await flush()
    const old = captured!
    const pending = old()
    component.rerender(element('two'))
    reject(new Error('late'))
    await expect(pending).resolves.toBe(false)
    expect(await old()).toBe(false)
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    await flush()
    const next = captured!
    component.rerender(element('two', new Set(['same'])))
    expect(await next()).toBe(false)
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    component.rerender(element('one'))
    expect(await old()).toBe(false)
  })
  it('keeps host identity and blocks captured stop and polling synchronously on live denial', async () => {
    let allowed = true
    let captured: (() => Promise<boolean>) | undefined
    const content = ({ entries }: Parameters<React.ComponentProps<typeof TeamLeadJobEntries>['children']>[0]) => {
      if (entries[0]) captured = entries[0].stop
      return <div data-testid="host">{entries.length}</div>
    }
    const element = (key: string | null) => <TeamLeadJobEntries route={route} currentId="member" leadId="lead" activeTeamKey={key} currentIds={new Set()} isLive={() => allowed}>{content}</TeamLeadJobEntries>
    const component = render(element('one'))
    await flush()
    const host = screen.getByTestId('host'), old = captured!
    allowed = false
    expect(await old()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(mocks.stop).not.toHaveBeenCalled()
    component.rerender(element(null))
    expect(screen.getByTestId('host')).toBe(host)
    allowed = true
    component.rerender(element('one'))
    await flush()
    expect(screen.getByTestId('host')).toBe(host)
    expect(await old()).toBe(false)
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
  it('denies read and discards in-flight read and stop results on synchronous revocation', async () => {
    let allowed = true, rejectRead!: (error: Error) => void, resolveStop!: (value: unknown) => void
    mocks.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject }))
    mocks.stop.mockImplementationOnce(() => new Promise((resolve) => { resolveStop = resolve }))
    const component = render(<TeamLeadJobEntries route={route} currentId="member" leadId="lead" activeTeamKey="one" currentIds={new Set()} isLive={() => allowed}>{renderEntries}</TeamLeadJobEntries>)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
    fireEvent.click(screen.getByRole('button', { name: 'outer stop' }))
    allowed = false
    await act(async () => { rejectRead(new Error('late')); resolveStop({ job: job() }); await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    component.rerender(<TeamLeadJobEntries route={route} currentId="member" leadId="lead" activeTeamKey={null} currentIds={new Set()} isLive={() => allowed}>{renderEntries}</TeamLeadJobEntries>)
    expect(screen.queryByText('组长 · explore')).not.toBeInTheDocument()
  })
  it.each(['resolve', 'reject'] as const)('discards late list %s after revocation and restores a new owner', async outcome => {
    let allowed = true
    let resolveOld!: (value: { jobs: AgentThreadJob[] }) => void
    let rejectOld!: (reason: Error) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
      .mockResolvedValue({ jobs: [job('fresh')] })
    const element = (key: string | null) => <TeamLeadJobEntries route={route} currentId="member" leadId="lead" activeTeamKey={key} currentIds={new Set()} isLive={() => allowed}>{renderEntries}</TeamLeadJobEntries>
    const component = render(element('one'))
    await flush()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'lead' })
    allowed = false
    component.rerender(element(null))
    allowed = true
    component.rerender(element('two'))
    await flush()
    expect(screen.getByText('组长 · explore')).toBeVisible()
    await act(async () => { if (outcome === 'resolve') resolveOld({ jobs: [job('old')] }); else rejectOld(new Error('late list')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('组长 · explore')).toBeVisible()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'lead', jobId: 'fresh', offset: 0, limit: 16000 })
    expect(screen.getByText('lead output')).toBeVisible()
    for (const [arg] of mocks.list.mock.calls) expect(arg).toEqual({ route, conversationId: 'lead' })
  })
  it('discards a successful stale read and rejected stale stop after revocation and permits the new owner', async () => {
    let allowed = true
    let resolveRead!: (value: unknown) => void
    let rejectStop!: (reason: Error) => void
    mocks.read.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
      .mockResolvedValue({ job: job(), text: 'fresh output', nextOffset: 12, totalCharacters: 12 })
    mocks.stop.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStop = reject }))
      .mockResolvedValue({ job: job() })
    const element = (key: string | null) => <TeamLeadJobEntries route={route} currentId="member" leadId="lead" activeTeamKey={key} currentIds={new Set()} isLive={() => allowed}>{renderEntries}</TeamLeadJobEntries>
    const component = render(element('one'))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
    fireEvent.click(screen.getByRole('button', { name: 'outer stop' }))
    expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'lead', jobId: 'same', offset: 0, limit: 16000 })
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'lead', jobId: 'same' })
    allowed = false
    component.rerender(element(null))
    allowed = true
    component.rerender(element('two'))
    await flush()
    await act(async () => { resolveRead({ job: job(), text: 'OLD SECRET', nextOffset: 10, totalCharacters: 10 }); rejectStop(new Error('late stop')); await Promise.resolve() })
    expect(screen.queryByText('OLD SECRET')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    expect(screen.getByText('fresh output')).toBeVisible()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'outer stop' })) })
    expect(mocks.stop).toHaveBeenCalledTimes(2)
    expect(mocks.stop).toHaveBeenLastCalledWith({ route, conversationId: 'lead', jobId: 'same' })
    expect(mocks.read).toHaveBeenLastCalledWith({ route, conversationId: 'lead', jobId: 'same', offset: 0, limit: 16000 })
    for (const [arg] of mocks.list.mock.calls) expect(arg).toEqual({ route, conversationId: 'lead' })
  })
  it('reports lead poll failure independently and never fabricates entries', async () => {
    mocks.list.mockRejectedValue(new Error('unavailable'))
    render(view()); await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('lead failure')
    expect(screen.queryByText('组长 · explore')).not.toBeInTheDocument()
  })
})
