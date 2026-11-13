import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProcessJob } from '@shared/api/agentThreadProcessJob'
import AgentThreadProcessesPanel, { AgentProcessDetails, getAgentThreadProcessScope, useAgentThreadProcesses } from './AgentThreadProcessesPanel'
const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), stop: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentProcesses: mocks.list, readAgentProcess: mocks.read, stopAgentProcess: mocks.stop } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const job = (status: AgentProcessJob['status'] = 'running'): AgentProcessJob => ({ id: 'owned', kind: 'python', status, createdAt: Date.now(), expiresAt: Date.now() + 60000, outcome: status === 'completed' ? 'known' : 'unknown', stdoutBytes: 5, stderrBytes: 0, truncated: false, operationSettled: ['completed', 'unknown', 'stopped'].includes(status), cancellationRequested: false })
const mount = async (item = job()) => { mocks.list.mockResolvedValue({ jobs: [item] }); const view = render(<AgentThreadProcessesPanel route={route} conversationId="chat" active />); await act(async () => { await Promise.resolve() }); return view }
beforeEach(() => { vi.useFakeTimers(); Object.values(mocks).forEach((m) => m.mockReset()); mocks.stop.mockResolvedValue({ job: job('stopped') }); mocks.read.mockResolvedValue({ job: job(), data: 'first', nextCursor: 5, eof: false, truncated: false }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('owned background process UI', () => {
  it('polls only metadata and reads logs on demand with byte cursors and no new turns', async () => {
    await mount(); expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'chat' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stdout' })))
    expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'chat', jobId: 'owned', stream: 'stdout', cursor: 0, maxBytes: 16384 })
    mocks.read.mockResolvedValueOnce({ job: job(), data: 'second', nextCursor: 11, eof: true })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.more' })))
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 5 }))
    expect(screen.getByText('firstsecond')).toBeTruthy()
  })
  it('does not report stopped before refreshed actual status and labels unknown closure', async () => {
    await mount()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stop' })))
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'chat', jobId: 'owned' })
    expect(screen.getByText(/status_running/)).toBeTruthy()
    mocks.list.mockResolvedValue({ jobs: [job('unknown')] })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(screen.getByText('chat.agent_process.unknown_notice')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'chat.agent_process.stop' })).toBeTruthy()
  })
  it('discards old log replies and old polls after a scope switch', async () => {
    const view = await mount()
    let finish!: (value: unknown) => void
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stdout' }))
    view.rerender(<AgentThreadProcessesPanel route={route} conversationId="other" active />)
    await act(async () => { finish({ job: job(), data: 'OLD_SECRET', nextCursor: 10, eof: true }); await Promise.resolve() })
    expect(screen.queryByText('OLD_SECRET')).toBeNull()
    expect(screen.getByRole('button', { name: 'chat.agent_process.stdout' })).not.toBeDisabled()
  })
  it('shows plain text only and bounds retained preview', async () => {
    await mount(job('completed'))
    mocks.read.mockResolvedValue({ job: job('completed'), data: '<script>not executed</script>' + 'x'.repeat(16000), nextCursor: 16000, eof: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stdout' })))
    expect(document.querySelector('script')).toBeNull()
    for (let i = 0; i < 3; i++) await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.more' })))
    expect(document.querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(32768)
    expect(screen.queryByRole('button', { name: 'chat.agent_process.stop' })).toBeNull()
  })
  it('exposes scoped hook and keyed detail without leaking late polls or logs across scopes', async () => {
    let finishPoll!: (value: unknown) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve }))
    mocks.list.mockResolvedValue({ jobs: [job()] })
    const Consumer = ({ conversationId }: { conversationId: string }) => {
      const scope = getAgentThreadProcessScope(route, conversationId, true)
      const { jobs, error } = useAgentThreadProcesses(scope)
      return <><span>{error ? 'error' : 'ok'}</span>{scope && jobs.map((item) => <AgentProcessDetails key={item.id} job={item} scope={scope} />)}</>
    }
    const view = render(<Consumer conversationId="old" />)
    view.rerender(<Consumer conversationId="new" />)
    await act(async () => { await Promise.resolve(); finishPoll({ jobs: [{ ...job(), id: 'old-process' }] }); await Promise.resolve() })
    expect(screen.queryByText(/old-process/)).toBeNull()
    expect(screen.getByText(/owned/)).toBeTruthy()
    let finishRead!: (value: unknown) => void
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stderr' }))
    view.rerender(<Consumer conversationId="third" />)
    await act(async () => { finishRead({ data: 'OLD_OUTPUT', nextCursor: 10, eof: true }); await Promise.resolve() })
    expect(screen.queryByText('OLD_OUTPUT')).toBeNull()
    expect(screen.getByRole('button', { name: 'chat.agent_process.stdout' })).not.toBeDisabled()
    expect(getAgentThreadProcessScope(route, 'third', false)).toBeNull()
  })
  it('supports shell stderr, pagination and settled versus unknown stop semantics in exported detail', async () => {
    const shell = { ...job(), kind: 'shell' as const, operationSettled: true }
    const scope = JSON.stringify({ route, conversationId: 'chat' })
    const view = render(<AgentProcessDetails job={shell} scope={scope} />)
    expect(screen.queryByRole('button', { name: 'chat.agent_process.stop' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stderr' })))
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: shell.id, stream: 'stderr', cursor: 0 }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.more' })))
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ stream: 'stderr', cursor: 5 }))
    view.rerender(<AgentProcessDetails job={{ ...shell, status: 'unknown' }} scope={scope} />)
    expect(screen.getByText('chat.agent_process.unknown_notice')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stop' })))
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'chat', jobId: shell.id })
    expect(screen.getByText(/status_unknown/)).toBeTruthy()
  })
  it('validates controller stop scope and current job and propagates IPC errors', async () => {
    const unknown = job('unknown')
    mocks.list.mockResolvedValue({ jobs: [unknown] })
    let controller!: ReturnType<typeof useAgentThreadProcesses>
    const Consumer = ({ scope }: { scope: string | null }) => { controller = useAgentThreadProcesses(scope); return null }
    const scope = JSON.stringify({ route, conversationId: 'chat' })
    const view = render(<Consumer scope={scope} />)
    await act(async () => { await Promise.resolve() })
    const current = controller.jobs[0], oldStop = controller.stop
    await expect(controller.stop({ ...current })).rejects.toThrow()
    await act(async () => { await controller.stop(current) })
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'chat', jobId: current.id })
    mocks.stop.mockRejectedValueOnce(new Error('stop failed'))
    await expect(controller.stop(current)).rejects.toThrow('stop failed')
    view.rerender(<Consumer scope={null} />)
    await expect(oldStop(current)).rejects.toThrow()
    await expect(controller.stop(current)).rejects.toThrow()
    expect(mocks.stop).toHaveBeenCalledTimes(2)
    view.unmount()
    await expect(oldStop(current)).rejects.toThrow()
  })
  it('rejects old stop across A-B-A even for the same job object and fences a late A poll', async () => {
    const shared = job()
    let finishOld!: (value: unknown) => void
    mocks.list.mockResolvedValue({ jobs: [shared] })
    let controller!: ReturnType<typeof useAgentThreadProcesses>
    const Consumer = ({ scope }: { scope: string }) => { controller = useAgentThreadProcesses(scope); return null }
    const a = JSON.stringify({ route, conversationId: 'a' }), b = JSON.stringify({ route, conversationId: 'b' })
    const view = render(<React.StrictMode><Consumer scope={a} /></React.StrictMode>)
    await act(async () => { await Promise.resolve() })
    const oldStop = controller.stop
    expect(controller.jobs[0]).toBe(shared)
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(finishOld).toBeDefined()
    view.rerender(<React.StrictMode><Consumer scope={b} /></React.StrictMode>)
    await act(async () => { await Promise.resolve() })
    view.rerender(<React.StrictMode><Consumer scope={a} /></React.StrictMode>)
    await act(async () => { await Promise.resolve() })
    expect(controller.jobs[0]).toBe(shared)
    await expect(oldStop(shared)).rejects.toThrow('Process is no longer stoppable in this scope')
    expect(mocks.stop).not.toHaveBeenCalled()
    await act(async () => { finishOld({ jobs: [{ ...shared, id: 'late-old' }] }); await Promise.resolve() })
    expect(controller.jobs).toEqual([shared])
    await act(async () => { await controller.stop(shared) })
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', jobId: shared.id })
    view.unmount()
  })

  it('keeps committed A polling and stopping when a transition to B suspends without committing', async () => {
    const shared = job()
    mocks.list.mockResolvedValue({ jobs: [shared] })
    let committed!: ReturnType<typeof useAgentThreadProcesses>
    let setScope!: React.Dispatch<React.SetStateAction<string>>
    let renderedB = false
    const never = new Promise<void>(() => {})
    const a = JSON.stringify({ route, conversationId: 'a' }), b = JSON.stringify({ route, conversationId: 'b' })
    const Consumer = ({ scope }: { scope: string }) => {
      const controller = useAgentThreadProcesses(scope)
      React.useLayoutEffect(() => { committed = controller })
      if (scope === b) { renderedB = true; throw never }
      return <span>committed A</span>
    }
    const App = () => {
      const [scope, update] = React.useState(a)
      setScope = update
      return <React.Suspense fallback={<span>fallback</span>}><Consumer scope={scope} /></React.Suspense>
    }
    const view = render(<React.StrictMode><App /></React.StrictMode>)
    await act(async () => { await Promise.resolve() })
    const oldStop = committed.stop
    expect(committed.jobs[0]).toBe(shared)
    await act(async () => { React.startTransition(() => setScope(b)); await Promise.resolve() })
    expect(renderedB).toBe(true)
    expect(screen.getByText('committed A')).toBeVisible()
    expect(screen.queryByText('fallback')).toBeNull()
    const count = mocks.list.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(mocks.list.mock.calls.length).toBeGreaterThan(count)
    expect(mocks.list).toHaveBeenLastCalledWith({ route, conversationId: 'a' })
    await act(async () => { await oldStop(shared) })
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', jobId: shared.id })
    view.unmount()
  })

  it('expires stale metadata even if IPC is unavailable and never polls an inactive surface', async () => {
    const view = await mount(); mocks.list.mockRejectedValue(new Error('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(61000))
    expect(screen.queryByRole('region')).toBeNull()
    view.rerender(<AgentThreadProcessesPanel route={route} conversationId="chat" active={false} />)
    const calls = mocks.list.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(mocks.list).toHaveBeenCalledTimes(calls)
  })
})
