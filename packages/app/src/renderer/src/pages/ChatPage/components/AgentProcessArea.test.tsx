import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import AgentProcessArea, { type ProcessEntry } from './AgentProcessArea'

// Helper jobs and background processes only: the team is listed in the thread list.
const entries: ProcessEntry[] = [
  { id: 'e', kind: 'job', name: ' explore ', status: 'running' },
  { id: 'j', kind: 'job', name: '导出', status: 'completed' }
]

describe('AgentProcessArea', () => {
  it('hides the empty area without exposing old rows or menu content', () => {
    const { container } = render(<AgentProcessArea entries={[]} />)
    expect(screen.queryByRole('region', { name: '进程区' })).not.toBeInTheDocument()
    const area = container.querySelector('section')
    expect(area).toHaveAttribute('hidden')
    expect(area).toBeEmptyDOMElement()
  })

  it('keeps the same hidden host and collapsed state across an empty poll', () => {
    const { rerender } = render(<AgentProcessArea entries={entries} />)
    const area = screen.getByRole('region', { name: '进程区' })
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    rerender(<AgentProcessArea entries={[]} />)
    expect(area.isConnected).toBe(true)
    expect(area).toHaveAttribute('hidden')
    expect(area).toBeEmptyDOMElement()
    rerender(<AgentProcessArea entries={[{ id: 'new', kind: 'job', name: '新任务', status: 'running' }]} />)
    expect(screen.getByRole('region', { name: '进程区' })).toBe(area)
    expect(screen.getByRole('button', { name: /进程 ·/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('explore')).not.toBeInTheDocument()
  })

  it('exposes only explicit static content when empty and retains its host and collapse state', () => {
    const { rerender } = render(<AgentProcessArea entries={entries} />)
    const area = screen.getByRole('region', { name: '进程区' })
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    rerender(<AgentProcessArea entries={[]} showStaticWhenEmpty staticSlot={<p>状态未知</p>} footerSlot={<p>页脚</p>}><p>活动明细</p></AgentProcessArea>)
    expect(screen.getByRole('region', { name: '进程区' })).toBe(area)
    expect(screen.getByText('状态未知')).toBeVisible()
    expect(screen.queryByRole('button', { name: /进程 ·/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /停止/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
    expect(screen.queryByText('页脚')).not.toBeInTheDocument()
    expect(screen.queryByText('活动明细')).not.toBeInTheDocument()
    rerender(<AgentProcessArea entries={[]} staticSlot={<p>状态未知</p>} />)
    expect(area).toHaveAttribute('hidden')
    expect(area).toBeEmptyDOMElement()
    rerender(<AgentProcessArea entries={entries} />)
    expect(screen.getByRole('region', { name: '进程区' })).toBe(area)
    expect(screen.getByRole('button', { name: /进程 ·/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('counts only running items in its header: no member or approval counts and no stop-all button', () => {
    render(<AgentProcessArea entries={entries} />)
    expect(screen.getByRole('button', { name: '进程 · 运行项 1' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('explore')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.queryByText(/成员/)).not.toBeInTheDocument()
    expect(screen.queryByText(/待审批/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部停止成员' })).not.toBeInTheDocument()
  })

  it('exposes each row status through an independent polite live region', () => {
    const { rerender } = render(<AgentProcessArea entries={[{ id: 'explore', kind: 'job', name: 'explore', status: 'running', detail: '结果' }]} />)
    const liveStatus = screen.getByRole('status', { name: 'explore：状态：运行中' })
    expect(liveStatus).toHaveAttribute('aria-live', 'polite')
    expect(liveStatus).toHaveAttribute('aria-atomic', 'true')
    expect(liveStatus).toHaveTextContent('explore：状态：运行中')
    expect(screen.getByRole('button', { name: '展开 explore 详情' })).toHaveAccessibleDescription('explore 运行中')

    rerender(<AgentProcessArea entries={[{ id: 'explore', kind: 'job', name: 'explore', status: 'completed' }]} />)
    expect(screen.getByRole('status', { name: 'explore：状态：已完成' })).toBe(liveStatus)
    expect(liveStatus).toHaveTextContent('explore：状态：已完成')
  })

  it('keeps visually hidden text at one pixel so it can never stretch or scroll the chat pane', () => {
    // In MUI `sx`, a bare `1` for width or height means 100%. A full-size, absolutely positioned
    // live region overflowed the chat pane, which then scrolled the list out of view.
    render(<AgentProcessArea entries={[
      { id: 'explore', kind: 'job', name: 'explore', status: 'running', onStop: vi.fn() },
      { id: 'critic', kind: 'job', name: 'critic', status: 'running', onStop: vi.fn() }
    ]} />)
    const hiddenNodes = screen.getAllByRole('status')
    expect(hiddenNodes).toHaveLength(2)
    for (const node of hiddenNodes) {
      expect(node).toHaveStyle({ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden' })
    }
  })

  it('does not expose collapsed row statuses to assistive technology', () => {
    render(<AgentProcessArea entries={[{ id: 'explore', kind: 'job', name: 'explore', status: 'running' }]} />)
    expect(screen.getByRole('status', { name: 'explore：状态：运行中' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    expect(screen.queryByRole('status', { name: 'explore：状态：运行中' })).not.toBeInTheDocument()
  })

  it('collapses the list, retains the footer slot and respects defaultExpanded', () => {
    render(<AgentProcessArea entries={entries} defaultExpanded={false} footerSlot={<div>页脚内容</div>} />)
    const toggle = screen.getByRole('button', { name: /进程 ·/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
    expect(screen.getByText('页脚内容')).toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByRole('list', { name: '进程列表' })).toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByText('页脚内容')).toBeVisible()
  })

  it('keeps static and activity slots mounted while only activity follows collapse', () => {
    const { container } = render(<AgentProcessArea entries={entries} staticSlot={<div>状态说明</div>}><div>活动明细</div></AgentProcessArea>)
    const activity = screen.getByText('活动明细')
    expect(activity).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    expect(activity).not.toBeVisible()
    expect(container.contains(activity)).toBe(true)
    expect(screen.getByText('状态说明')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    expect(activity).toBeVisible()
  })

  it('keeps the running total accurate while collapsed and supports keyboard actions', async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    const row: ProcessEntry = { ...entries[0], onStop: stop, detail: '详情' }
    const view = render(<AgentProcessArea entries={[row, entries[1]]} />)
    const toggle = screen.getByRole('button', { name: '进程 · 运行项 1' })
    await user.tab()
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '展开 explore 详情' })).not.toBeInTheDocument()
    view.rerender(<AgentProcessArea entries={[{ ...row, status: 'completed' }, { ...entries[1], status: 'running' }]} />)
    expect(screen.getByRole('button', { name: '进程 · 运行项 1' })).toHaveAttribute('aria-expanded', 'false')
    view.rerender(<AgentProcessArea entries={[row, entries[1]]} />)
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.tab()
    expect(screen.getByRole('button', { name: '展开 explore 详情' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('详情')).toBeVisible()
    await user.tab()
    expect(screen.getByRole('button', { name: '停止 explore' })).toHaveFocus()
    await user.keyboard(' ')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('counts running jobs and observed helper calls, including when collapsed', async () => {
    const user = userEvent.setup()
    const mixed: ProcessEntry[] = [
      { id: 'j', kind: 'job', name: '后台任务', status: 'running' },
      { id: 'h', kind: 'job', name: '内置调用', status: 'running' },
      { id: 'u', kind: 'job', name: '未知调用', status: 'unknown' }
    ]
    render(<AgentProcessArea entries={mixed} />)
    const toggle = screen.getByRole('button', { name: '进程 · 运行项 2' })
    expect(screen.getByText('未知')).toBeVisible()
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: '进程列表' })).toBeVisible()
  })

  it('allows stopping running but not completed entries', () => {
    const stop = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={[{ ...entries[0], onStop: stop }]} />)
    fireEvent.click(screen.getByRole('button', { name: '停止 explore' }))
    expect(stop).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[0], status: 'completed', onStop: stop }]} />)
    expect(screen.queryByRole('button', { name: '停止 explore' })).not.toBeInTheDocument()
  })

  it('uses optional status text and explicit stop capability without inferring activity', () => {
    const stop = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={[{ ...entries[0], status: 'unknown', statusText: '准备中', canStop: true, onStop: stop }]} />)
    expect(screen.getByText('准备中')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '停止 explore' }))
    expect(stop).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[0], status: 'running', statusText: ' ', canStop: false, onStop: stop }]} />)
    expect(screen.getByText('运行中')).toBeVisible()
    expect(screen.queryByRole('button', { name: '停止 explore' })).not.toBeInTheDocument()
  })

  it('wraps long names and opens detail from the main row', () => {
    const long = '很长的名称'.repeat(40)
    render(<AgentProcessArea entries={[{ id: 'long', kind: 'job', name: long, status: 'failed', detail: '任务结果' }]} />)
    const text = screen.getByText(long)
    expect(text).toHaveStyle({ overflowWrap: 'anywhere' })
    const button = screen.getByRole('button', { name: `展开 ${long} 详情` })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(screen.getByText('任务结果')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: `收起 ${long} 详情` }))
    expect(screen.getByText('任务结果')).not.toBeVisible()
  })

  it('keeps a long name and localized status shrinkable and accessible alongside actions', async () => {
    const user = userEvent.setup()
    const name = '任务'.repeat(50), status = 'localized-status'.repeat(80)
    const stop = vi.fn()
    render(<div style={{ width: 180 }}><AgentProcessArea entries={[{ id: 'long', kind: 'job', name, status: 'running', statusText: status, onStop: stop, detail: '详情' }]} /></div>)
    const row = screen.getByRole('button', { name: `展开 ${name} 详情` })
    const state = screen.getByText(status)
    expect(screen.getByText(name)).toHaveStyle({ minWidth: '0', overflowWrap: 'anywhere' })
    expect(state).toHaveStyle({ minWidth: '0', flexShrink: '1', overflowWrap: 'anywhere' })
    expect(row).toHaveAccessibleDescription(`${name} ${status}`)
    await user.click(row)
    await user.click(screen.getByRole('button', { name: `停止 ${name}` }))
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.getByText('详情')).toBeVisible()
    expect(state).toHaveTextContent(status)
  })
})
