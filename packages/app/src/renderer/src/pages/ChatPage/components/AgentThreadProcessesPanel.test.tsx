import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProcessJob } from '@shared/api/agentThreadProcessJob'
import { getAgentThreadProcessScope, useAgentThreadProcesses } from './AgentThreadProcessesPanel'
const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), stop: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentProcesses: mocks.list, readAgentProcess: mocks.read, stopAgentProcess: mocks.stop } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const job = (status: AgentProcessJob['status'] = 'running'): AgentProcessJob => ({ id: 'owned', kind: 'python', status, createdAt: Date.now(), expiresAt: Date.now() + 60000, outcome: status === 'completed' ? 'known' : 'unknown', stdoutBytes: 5, stderrBytes: 0, truncated: false, operationSettled: ['completed', 'unknown', 'stopped'].includes(status), cancellationRequested: false })
// The /jobs card of the Agent column reads logs and stops processes through this hook; the harness shows its list.
let processes!: ReturnType<typeof useAgentThreadProcesses>
const Harness = ({ conversationId, active = true }: { conversationId: string; active?: boolean }) => {
  processes = useAgentThreadProcesses(getAgentThreadProcessScope(route, conversationId, active))
  return <ul>{processes.jobs.map((item) => <li key={item.id}>{`${item.id}:${item.status}`}</li>)}</ul>
}
const mount = async (item = job()) => { mocks.list.mockResolvedValue({ jobs: [item] }); const view = render(<Harness conversationId="chat" />); await act(async () => { await Promise.resolve() }); return view }
beforeEach(() => { vi.useFakeTimers(); Object.values(mocks).forEach((m) => m.mockReset()); mocks.stop.mockResolvedValue({ job: job('stopped') }); mocks.read.mockResolvedValue({ job: job(), data: 'first', nextCursor: 5, eof: false, truncated: false }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('owned background processes of a thread', () => {
  it('polls only metadata and reads a whole log on demand with byte cursors and no new turns', async () => {
    await mount(); expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'chat' })
    mocks.read.mockResolvedValueOnce({ job: job(), data: 'first', nextCursor: 5, eof: false, truncated: false })
      .mockResolvedValueOnce({ job: job(), data: 'second', nextCursor: 11, eof: true, truncated: false })
    let log: Awaited<ReturnType<typeof processes.readLog>>
    await act(async () => { log = await processes.readLog('owned', 'stdout') })
    expect(mocks.read).toHaveBeenNthCalledWith(1, { route, conversationId: 'chat', jobId: 'owned', stream: 'stdout', cursor: 0, maxBytes: 16384 })
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 5 }))
    expect(log!).toEqual({ text: 'firstsecond', truncated: false })
  })
  it('does not report stopped before a poll saw it and keeps an unknown closure stoppable', async () => {
    await mount()
    await act(async () => { await processes.stop(processes.jobs[0]) })
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'chat', jobId: 'owned' })
    expect(screen.getByText('owned:running')).toBeTruthy()
    mocks.list.mockResolvedValue({ jobs: [job('unknown')] })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(screen.getByText('owned:unknown')).toBeTruthy()
    await act(async () => { await processes.stop(processes.jobs[0]) })
    expect(mocks.stop).toHaveBeenCalledTimes(2)
  })
  it('discards a log read that finishes after a scope switch', async () => {
    const view = await mount()
    let finish!: (value: unknown) => void
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = processes.readLog('owned', 'stdout')
    view.rerender(<Harness conversationId="other" />)
    await act(async () => { finish({ job: job(), data: 'OLD_SECRET', nextCursor: 10, eof: true, truncated: false }); await Promise.resolve() })
    await expect(pending).resolves.toBeUndefined()
  })
  it('keeps only the end of a long log, as plain text', async () => {
    await mount(job('completed'))
    let cursor = 0
    mocks.read.mockImplementation(async () => { cursor += 16000; return { job: job('completed'), data: '<script>not executed</script>' + 'x'.repeat(16000), nextCursor: cursor, eof: false, truncated: false } })
    let log: Awaited<ReturnType<typeof processes.readLog>>
    await act(async () => { log = await processes.readLog('owned', 'stdout') })
    expect(log!.text.length).toBeLessThanOrEqual(32768)
    expect(log!.truncated).toBe(true)
    expect(document.querySelector('script')).toBeNull()
  })
  it('exposes the scoped hook without leaking late polls across scopes', async () => {
    let finishPoll!: (value: unknown) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve }))
    mocks.list.mockResolvedValue({ jobs: [job()] })
    const view = render(<Harness conversationId="old" />)
    view.rerender(<Harness conversationId="new" />)
    await act(async () => { await Promise.resolve(); finishPoll({ jobs: [{ ...job(), id: 'old-process' }] }); await Promise.resolve() })
    expect(screen.queryByText(/old-process/)).toBeNull()
    expect(screen.getByText(/owned/)).toBeTruthy()
    expect(getAgentThreadProcessScope(route, 'third', false)).toBeNull()
  })
  it('reads stderr of a settled shell process, which cannot be stopped any more', async () => {
    const shell = { ...job(), kind: 'shell' as const, operationSettled: true }
    await mount(shell)
    await expect(processes.stop(processes.jobs[0])).rejects.toThrow('Process is no longer stoppable in this scope')
    mocks.read.mockResolvedValueOnce({ job: shell, data: 'warning', nextCursor: 7, eof: true, truncated: false })
    let log: Awaited<ReturnType<typeof processes.readLog>>
    await act(async () => { log = await processes.readLog(shell.id, 'stderr') })
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: shell.id, stream: 'stderr', cursor: 0 }))
    expect(log!).toEqual({ text: 'warning', truncated: false })
    expect(mocks.stop).not.toHaveBeenCalled()
    await expect(processes.readLog('missing', 'stdout')).resolves.toBeUndefined()
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
    expect(screen.queryByRole('listitem')).toBeNull()
    view.rerender(<Harness conversationId="chat" active={false} />)
    const calls = mocks.list.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(mocks.list).toHaveBeenCalledTimes(calls)
  })
})
