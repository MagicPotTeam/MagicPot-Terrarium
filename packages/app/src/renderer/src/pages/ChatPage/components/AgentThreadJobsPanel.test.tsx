import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'
import AgentThreadJobsPanel from './AgentThreadJobsPanel'

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), stop: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentJobs: mocks.list, readAgentJob: mocks.read, stopAgentJob: mocks.stop } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const job = (id = 'job-a', status: AgentThreadJob['status'] = 'running'): AgentThreadJob => ({ id, kind: 'explore', task: 'Inspect readme.md', status, createdAt: Date.now(), expiresAt: Date.now() + 60000 })
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(1000) })
const mount = async (item = job()) => {
  mocks.list.mockResolvedValue({ jobs: [item] })
  const view = render(<AgentThreadJobsPanel route={route} conversationId="a" active />)
  await act(async () => { await Promise.resolve() })
  return view
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.list.mockReset(); mocks.read.mockReset(); mocks.stop.mockReset()
  mocks.read.mockResolvedValue({ job: job(), text: 'Evidence from file', nextOffset: 18, totalCharacters: 18 })
  mocks.stop.mockResolvedValue({ job: job('job-a', 'cancelled') })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('background read-only job panel', () => {
  it('polls metadata after parent completion and reads results only on explicit action', async () => {
    await mount(job('job-a', 'completed'))
    mocks.read.mockResolvedValue({ job: job('job-a', 'completed'), text: 'Evidence from file', nextOffset: 18, totalCharacters: 18 })
    expect(screen.getByText('chat.agent_jobs.status_completed', { exact: false })).toBeInTheDocument()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'a' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'a', jobId: 'job-a', offset: 0, limit: 16000 })
    expect(screen.getByText('Evidence from file')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chat.agent_jobs.stop' })).not.toBeInTheDocument()
  })
  it('stops one job and waits for real refreshed status rather than claiming success early', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.stop' })) })
    expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'a', jobId: 'job-a' })
    expect(screen.getByText('chat.agent_jobs.status_running', { exact: false })).toBeInTheDocument()
    mocks.list.mockResolvedValue({ jobs: [job('job-a', 'cancelled')] })
    await poll()
    expect(screen.getByText('chat.agent_jobs.status_cancelled', { exact: false })).toBeInTheDocument()
  })
  it('does not reuse old results or errors after switching away and back', async () => {
    const view = await mount()
    let finish!: (value: unknown) => void
    mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
    mocks.list.mockResolvedValue({ jobs: [job('job-b')] })
    view.rerender(<AgentThreadJobsPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { finish({ text: 'OLD SECRET' }) })
    expect(screen.queryByText('OLD SECRET')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.agent_jobs.read' })).not.toBeDisabled()
  })
  it('ignores old poll responses and unmount stops polling without stopping a live task', async () => {
    let finish!: (value: { jobs: AgentThreadJob[] }) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue({ jobs: [] })
    const view = render(<AgentThreadJobsPanel route={route} conversationId="a" active />)
    view.rerender(<AgentThreadJobsPanel route={route} conversationId="b" active />)
    await act(async () => { finish({ jobs: [job()] }); await Promise.resolve() })
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    view.unmount()
    const calls = mocks.list.mock.calls.length
    await poll()
    expect(mocks.list).toHaveBeenCalledTimes(calls)
    expect(mocks.stop).not.toHaveBeenCalled()
  })
  it('shows refresh errors without inventing completion and renders result HTML only as text', async () => {
    await mount()
    mocks.list.mockRejectedValue(new Error('temporary'))
    await poll()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('chat.agent_jobs.status_running', { exact: false })).toBeInTheDocument()
    mocks.read.mockResolvedValue({ job: job(), text: '<img src="https://owned.invalid/tracker">', nextOffset: 0, totalCharacters: 0 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src="https://owned.invalid/tracker">')).toBeInTheDocument()
  })
  it('reads the next page and clears a previously displayed report on revocation', async () => {
    await mount(job('job-a', 'completed'))
    mocks.read.mockResolvedValueOnce({ job: job('job-a', 'completed'), text: 'first-part', nextOffset: 10, totalCharacters: 20 })
      .mockResolvedValueOnce({ job: job('job-a', 'completed'), text: 'second-part', nextOffset: 20, totalCharacters: 20 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.more' })) })
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 }))
    expect(screen.getByText('first-partsecond-part')).toBeInTheDocument()
    mocks.list.mockResolvedValue({ jobs: [job('job-a', 'cancelled')] })
    await poll()
    expect(screen.queryByText('first-partsecond-part')).not.toBeInTheDocument()
  })
  it('does not resurrect a late result after the same job is revoked', async () => {
    await mount(job('job-a', 'completed'))
    let finish!: (value: unknown) => void
    mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
    mocks.list.mockResolvedValue({ jobs: [job('job-a', 'cancelled')] })
    await poll()
    await act(async () => { finish({ job: job('job-a', 'completed'), text: 'REVOKED REPORT', nextOffset: 14, totalCharacters: 14 }) })
    expect(screen.queryByText('REVOKED REPORT')).not.toBeInTheDocument()
  })
  it('clears loaded reports at local expiry even when every status poll fails', async () => {
    const item = { ...job('job-a', 'completed'), expiresAt: Date.now() + 1500 }
    await mount(item)
    mocks.read.mockResolvedValue({ job: item, text: 'TEMPORARY REPORT', nextOffset: 16, totalCharacters: 16 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' })) })
    expect(screen.getByText('TEMPORARY REPORT')).toBeInTheDocument()
    mocks.list.mockRejectedValue(new Error('revoked'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.queryByText('TEMPORARY REPORT')).not.toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it('renders multiple independent jobs and retains completed metadata', async () => {
    mocks.list.mockResolvedValue({ jobs: [job('first', 'running'), job('second', 'completed')] })
    render(<AgentThreadJobsPanel route={route} conversationId="a" active />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/first/)).toBeInTheDocument()
    expect(screen.getByText(/second/)).toBeInTheDocument()
    expect(screen.getByText('chat.agent_jobs.status_completed', { exact: false })).toBeInTheDocument()
    await poll()
    expect(screen.getByText(/second/)).toBeInTheDocument()
  })
  it('ignores old-scope read failures and reports current action failures', async () => {
    const view = await mount()
    let reject!: (reason: Error) => void
    mocks.read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
    view.rerender(<AgentThreadJobsPanel route={route} conversationId="b" active />)
    await act(async () => { reject(new Error('old')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    mocks.stop.mockRejectedValueOnce(new Error('current'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.stop' })) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
  it('does not poll inactive/plain chats or process external window events', () => {
    const view = render(<AgentThreadJobsPanel route={route} conversationId="a" active={false} />)
    view.rerender(<AgentThreadJobsPanel conversationId="a" active />)
    window.dispatchEvent(new CustomEvent('chat:job-completed', { detail: job() }))
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
})
