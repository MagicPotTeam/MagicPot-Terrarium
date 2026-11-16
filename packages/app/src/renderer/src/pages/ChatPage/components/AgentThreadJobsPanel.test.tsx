import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'
import { useAgentThreadJobs, type AgentThreadJobsController } from './AgentThreadJobsPanel'

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), stop: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentJobs: mocks.list, readAgentJob: mocks.read, stopAgentJob: mocks.stop } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const job = (id = 'job-a', status: AgentThreadJob['status'] = 'running'): AgentThreadJob => ({ id, kind: 'explore', task: 'Inspect readme.md', status, createdAt: Date.now(), expiresAt: Date.now() + 60000 })
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(1000) })

// The /jobs card of the Agent column reads and stops through this hook; the harness shows its list.
let controller!: AgentThreadJobsController
const Harness = ({ conversationId, active = true, withRoute = true }: { conversationId: string; active?: boolean; withRoute?: boolean }) => {
  controller = useAgentThreadJobs({ route: withRoute ? route : undefined, conversationId, active })
  return <ul>
    {controller.error ? <li role="alert">refresh failed</li> : null}
    {controller.jobs.map((item) => <li key={item.id}>{`${item.id}:${item.status}`}</li>)}
  </ul>
}
const mount = async (item = job()) => {
  mocks.list.mockResolvedValue({ jobs: [item] })
  const view = render(<Harness conversationId="a" />)
  await act(async () => { await Promise.resolve() })
  return view
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.list.mockReset(); mocks.read.mockReset(); mocks.stop.mockReset()
  mocks.read.mockResolvedValue({ job: job(), text: 'Evidence from file', nextOffset: 18, totalCharacters: 18 })
  mocks.stop.mockResolvedValue({ job: job('job-a', 'cancelled') })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('background helper jobs of a thread', () => {
  it('polls metadata and reads a result only when asked', async () => {
    await mount(job('job-a', 'completed'))
    mocks.read.mockResolvedValue({ job: job('job-a', 'completed'), text: 'Evidence from file', nextOffset: 18, totalCharacters: 18 })
    expect(screen.getByText('job-a:completed')).toBeInTheDocument()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'a' })
    let result: Awaited<ReturnType<AgentThreadJobsController['readAll']>>
    await act(async () => { result = await controller.readAll('job-a') })
    expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'a', jobId: 'job-a', offset: 0, limit: 16000 })
    expect(result!).toEqual({ text: 'Evidence from file', job: job('job-a', 'completed') })
  })
  it('stops one job and reports the new status only after a poll saw it', async () => {
    await mount()
    let stopped = false
    await act(async () => { stopped = await controller.stop('job-a') })
    expect(stopped).toBe(true)
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'a', jobId: 'job-a' })
    expect(screen.getByText('job-a:running')).toBeInTheDocument()
    mocks.list.mockResolvedValue({ jobs: [job('job-a', 'cancelled')] })
    await poll()
    expect(screen.getByText('job-a:cancelled')).toBeInTheDocument()
    // A job that no longer runs is not stopped again.
    await act(async () => { stopped = await controller.stop('job-a') })
    expect(stopped).toBe(false)
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })
  it('drops a read that finishes after the conversation changed, also when it fails', async () => {
    const view = await mount(job('job-a', 'completed'))
    let finish!: (value: unknown) => void
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = controller.readAll('job-a')
    mocks.list.mockResolvedValue({ jobs: [job('job-b')] })
    view.rerender(<Harness conversationId="b" />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { finish({ job: job('job-a', 'completed'), text: 'OLD SECRET', nextOffset: 10, totalCharacters: 10 }) })
    await expect(pending).resolves.toBeUndefined()
    let reject!: (reason: Error) => void
    mocks.list.mockResolvedValue({ jobs: [job('job-b', 'completed')] })
    await poll()
    mocks.read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const failing = controller.readAll('job-b')
    view.rerender(<Harness conversationId="c" />)
    await act(async () => { reject(new Error('old')); await Promise.resolve() })
    await expect(failing).resolves.toBeUndefined()
  })
  it('ignores old poll responses and unmount stops polling without stopping a live task', async () => {
    let finish!: (value: { jobs: AgentThreadJob[] }) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue({ jobs: [] })
    const view = render(<Harness conversationId="a" />)
    view.rerender(<Harness conversationId="b" />)
    await act(async () => { finish({ jobs: [job()] }); await Promise.resolve() })
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    view.unmount()
    const calls = mocks.list.mock.calls.length
    await poll()
    expect(mocks.list).toHaveBeenCalledTimes(calls)
    expect(mocks.stop).not.toHaveBeenCalled()
  })
  it('reports refresh errors without inventing completion and returns a result as plain text', async () => {
    await mount(job('job-a', 'completed'))
    mocks.list.mockRejectedValue(new Error('temporary'))
    await poll()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('job-a:completed')).toBeInTheDocument()
    mocks.read.mockResolvedValue({ job: job('job-a', 'completed'), text: '<img src="https://owned.invalid/tracker">', nextOffset: 41, totalCharacters: 41 })
    let result: Awaited<ReturnType<AgentThreadJobsController['readAll']>>
    await act(async () => { result = await controller.readAll('job-a') })
    expect(result!.text).toBe('<img src="https://owned.invalid/tracker">')
  })
  it('reads every page of a long result', async () => {
    await mount(job('job-a', 'completed'))
    mocks.read.mockResolvedValueOnce({ job: job('job-a', 'completed'), text: 'first-part', nextOffset: 10, totalCharacters: 21 })
      .mockResolvedValueOnce({ job: job('job-a', 'completed'), text: 'second-part', nextOffset: 21, totalCharacters: 21 })
    let result: Awaited<ReturnType<AgentThreadJobsController['readAll']>>
    await act(async () => { result = await controller.readAll('job-a') })
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 }))
    expect(result!.text).toBe('first-partsecond-part')
  })
  it('does not return a late result after the same job was revoked', async () => {
    await mount(job('job-a', 'completed'))
    let finish!: (value: unknown) => void
    mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = controller.readAll('job-a')
    mocks.list.mockResolvedValue({ jobs: [job('job-a', 'cancelled')] })
    await poll()
    await act(async () => { finish({ job: job('job-a', 'completed'), text: 'REVOKED REPORT', nextOffset: 14, totalCharacters: 14 }) })
    await expect(pending).resolves.toBeUndefined()
  })
  it('forgets jobs at their local expiry even when every status poll fails', async () => {
    const item = { ...job('job-a', 'completed'), expiresAt: Date.now() + 1500 }
    await mount(item)
    expect(screen.getByText('job-a:completed')).toBeInTheDocument()
    mocks.list.mockRejectedValue(new Error('revoked'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.queryByText('job-a:completed')).not.toBeInTheDocument()
    await expect(controller.readAll('job-a')).resolves.toBeUndefined()
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('lists several independent jobs and keeps completed metadata', async () => {
    mocks.list.mockResolvedValue({ jobs: [job('first', 'running'), job('second', 'completed')] })
    render(<Harness conversationId="a" />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('first:running')).toBeInTheDocument()
    expect(screen.getByText('second:completed')).toBeInTheDocument()
    await poll()
    expect(screen.getByText('second:completed')).toBeInTheDocument()
  })
  it('passes on the failure of an action in the current conversation', async () => {
    await mount()
    mocks.stop.mockRejectedValueOnce(new Error('current'))
    await expect(controller.stop('job-a')).rejects.toThrow('current')
  })
  it('does not poll inactive or plain chats', () => {
    const view = render(<Harness conversationId="a" active={false} />)
    view.rerender(<Harness conversationId="a" withRoute={false} />)
    window.dispatchEvent(new CustomEvent('chat:job-completed', { detail: job() }))
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})
