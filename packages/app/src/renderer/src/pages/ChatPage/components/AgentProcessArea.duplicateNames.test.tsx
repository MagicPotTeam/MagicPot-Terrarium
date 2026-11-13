import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentProcessArea, { type ProcessEntry } from './AgentProcessArea'

describe('AgentProcessArea duplicate action names', () => {
  it('distinguishes same-kind running jobs and keeps actions bound to the intended entry after reorder', () => {
    const stopFirst = vi.fn()
    const stopSecond = vi.fn()
    const first: ProcessEntry = { id: 'first', kind: 'job', name: 'explore', status: 'running', detail: 'first task', onStop: stopFirst }
    const second: ProcessEntry = { id: 'second', kind: 'job', name: 'explore', status: 'running', detail: 'second task', onStop: stopSecond }
    const { rerender } = render(<AgentProcessArea entries={[first, second]} />)

    fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），展开：explore 详情' }))
    expect(screen.getByText('first task')).toBeVisible()
    expect(screen.getByText('second task')).not.toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '当前列表第 2 项（位置随列表变化），停止：explore' }))
    expect(stopFirst).not.toHaveBeenCalled()
    expect(stopSecond).toHaveBeenCalledTimes(1)

    rerender(<AgentProcessArea entries={[second, first]} />)
    fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），停止：explore' }))
    fireEvent.click(screen.getByRole('button', { name: '当前列表第 2 项（位置随列表变化），停止：explore' }))
    expect(stopFirst).toHaveBeenCalledTimes(1)
    expect(stopSecond).toHaveBeenCalledTimes(2)
    expect(screen.getByText('first task')).toBeVisible()
    expect(screen.getByText('second task')).not.toBeVisible()
  })

  it('distinguishes member and job actions with the same name without changing callbacks', () => {
    const openMember = vi.fn()
    const stopMember = vi.fn()
    const stopJob = vi.fn()
    render(<AgentProcessArea entries={[
      { id: 'member', kind: 'member', name: 'explore', status: 'running', onOpen: openMember, onStop: stopMember, detail: 'member detail' },
      { id: 'job', kind: 'job', name: 'explore', status: 'running', onStop: stopJob, detail: 'job detail' }
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 explore' }))
    fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），展开：explore 详情' }))
    expect(screen.getByText('member detail')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），停止：explore' }))
    expect(openMember).toHaveBeenCalledOnce()
    expect(stopMember).toHaveBeenCalledOnce()
    expect(stopJob).not.toHaveBeenCalled()
  })

  it('keeps the actionable row name when its namesake has no available action', () => {
    const stop = vi.fn()
    render(<AgentProcessArea entries={[
      { id: 'passive', kind: 'job', name: 'explore', status: 'running' },
      { id: 'active', kind: 'job', name: 'explore', status: 'running', detail: 'active detail', onStop: stop }
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '展开 explore 详情' }))
    expect(screen.getByText('active detail')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '停止 explore' }))
    expect(stop).toHaveBeenCalledOnce()
  })

  it('retains existing names for unique rows and does not expose entry IDs', () => {
    const stop = vi.fn()
    render(<AgentProcessArea entries={[
      { id: 'internal-id', kind: 'job', name: 'single', status: 'running', detail: 'detail', onStop: stop }
    ]} />)
    const list = screen.getByRole('list', { name: '进程列表' })
    expect(within(list).getByRole('button', { name: '展开 single 详情' })).toBeVisible()
    fireEvent.click(within(list).getByRole('button', { name: '停止 single' }))
    expect(stop).toHaveBeenCalledOnce()
    expect(list).not.toHaveTextContent('internal-id')
  })
})
