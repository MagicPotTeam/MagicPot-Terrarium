import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import AgentProcessArea, { type ProcessEntry } from './AgentProcessArea'

const entries: ProcessEntry[] = [
  { id: 'm', kind: 'member', name: ' writer ', role: ' writer ', status: 'running' },
  { id: 'n', kind: 'member', name: 'designer', role: '设计', status: 'approval' },
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
    const { rerender } = render(<AgentProcessArea entries={entries} managementSlot={<button>菜单</button>} />)
    const area = screen.getByRole('region', { name: '进程区' })
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    rerender(<AgentProcessArea entries={[]} managementSlot={<button>菜单</button>} />)
    expect(area.isConnected).toBe(true)
    expect(area).toHaveAttribute('hidden')
    expect(area).toBeEmptyDOMElement()
    rerender(<AgentProcessArea entries={[{ id: 'new', kind: 'job', name: '新任务', status: 'running' }]} />)
    expect(screen.getByRole('region', { name: '进程区' })).toBe(area)
    expect(screen.getByRole('button', { name: /进程 ·/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('writer')).not.toBeInTheDocument()
  })

  it('exposes only explicit static content when empty and retains its host and collapse state', () => {
    const stopAll = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={entries} onStopAllMembers={stopAll} />)
    const area = screen.getByRole('region', { name: '进程区' })
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    rerender(<AgentProcessArea entries={[]} showStaticWhenEmpty staticSlot={<p>状态未知</p>} managementSlot={<button>菜单</button>} onStopAllMembers={stopAll} footerSlot={<p>页脚</p>}><p>活动明细</p></AgentProcessArea>)
    expect(screen.getByRole('region', { name: '进程区' })).toBe(area)
    expect(screen.getByText('状态未知')).toBeVisible()
    expect(screen.queryByRole('button', { name: /进程 ·/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /停止/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
    expect(screen.queryByText('菜单')).not.toBeInTheDocument()
    expect(screen.queryByText('页脚')).not.toBeInTheDocument()
    expect(screen.queryByText('活动明细')).not.toBeInTheDocument()
    rerender(<AgentProcessArea entries={[]} staticSlot={<p>状态未知</p>} />)
    expect(area).toHaveAttribute('hidden')
    expect(area).toBeEmptyDOMElement()
    rerender(<AgentProcessArea entries={entries} />)
    expect(screen.getByRole('region', { name: '进程区' })).toBe(area)
    expect(screen.getByRole('button', { name: /进程 ·/ })).toHaveAttribute('aria-expanded', 'false')
    expect(stopAll).not.toHaveBeenCalled()
  })

  it('merges members and jobs, preserves status and suppresses identical name and role', () => {
    render(<AgentProcessArea entries={entries} />)
    expect(screen.getByRole('button', { name: '进程 · 成员 2 · 运行项 1 · 待审批项 1' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('writer')).toBeVisible()
    expect(screen.queryByText('writer · writer')).not.toBeInTheDocument()
    expect(screen.getByText('designer · 设计')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
  })

  it('exposes each row status through an independent polite live region', () => {
    const { rerender } = render(<AgentProcessArea entries={[{ id: 'writer', kind: 'member', name: 'writer', status: 'running', onOpen: vi.fn() }]} />)
    const liveStatus = screen.getByRole('status', { name: 'writer：状态：运行中' })
    expect(liveStatus).toHaveAttribute('aria-live', 'polite')
    expect(liveStatus).toHaveAttribute('aria-atomic', 'true')
    expect(liveStatus).toHaveTextContent('writer：状态：运行中')
    expect(screen.getByRole('button', { name: '打开 writer' })).toHaveAccessibleDescription('writer 运行中')

    rerender(<AgentProcessArea entries={[{ id: 'writer', kind: 'member', name: 'writer', status: 'completed' }]} />)
    expect(screen.getByRole('status', { name: 'writer：状态：已完成' })).toBe(liveStatus)
    expect(liveStatus).toHaveTextContent('writer：状态：已完成')
  })

  it('keeps visually hidden text at one pixel so it can never stretch or scroll the chat pane', () => {
    // In MUI `sx`, a bare `1` for width or height means 100%. A full-size, absolutely positioned
    // live region overflowed the chat pane, which then scrolled the member list out of view.
    render(<AgentProcessArea entries={[
      { id: 'writer', kind: 'member', name: 'writer', status: 'running', onOpen: vi.fn(), onStop: vi.fn() },
      { id: 'designer', kind: 'member', name: 'designer', status: 'running', onOpen: vi.fn(), onStop: vi.fn() }
    ]} onStopAllMembers={vi.fn()} />)
    const hiddenNodes = [
      ...screen.getAllByRole('status'),
      ...Array.from(document.querySelectorAll<HTMLElement>('span[id]')).filter(node => getComputedStyle(node).position === 'absolute')
    ]
    expect(hiddenNodes.length).toBeGreaterThanOrEqual(5)
    for (const node of hiddenNodes) {
      expect(node).toHaveStyle({ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden' })
    }
  })

  it('does not expose collapsed row statuses to assistive technology', () => {
    render(<AgentProcessArea entries={[{ id: 'writer', kind: 'member', name: 'writer', status: 'running' }]} />)
    expect(screen.getByRole('status', { name: 'writer：状态：运行中' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    expect(screen.queryByRole('status', { name: 'writer：状态：运行中' })).not.toBeInTheDocument()
  })

  it('collapses the list, retains footer and management slots and respects defaultExpanded', () => {
    render(<AgentProcessArea entries={entries} defaultExpanded={false} managementSlot={<button>菜单</button>} footerSlot={<div>成员表单</div>} />)
    const toggle = screen.getByRole('button', { name: /进程 ·/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
    expect(screen.getByText('成员表单')).toBeVisible()
    expect(screen.getByRole('button', { name: '菜单' })).toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByRole('list', { name: '进程列表' })).toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByText('成员表单')).toBeVisible()
  })

  it('keeps static and activity slots mounted while only activity follows collapse', () => {
    const { container } = render(<AgentProcessArea entries={entries} staticSlot={<div>审批承载</div>}><div>活动明细</div></AgentProcessArea>)
    const activity = screen.getByText('活动明细')
    expect(activity).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    expect(activity).not.toBeVisible()
    expect(container.contains(activity)).toBe(true)
    expect(screen.getByText('审批承载')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    expect(activity).toBeVisible()
  })

  it('keeps active and approval totals accurate while collapsed and supports keyboard actions', async () => {
    const user = userEvent.setup()
    const open = vi.fn(), stop = vi.fn(), stopAll = vi.fn()
    const row: ProcessEntry = { ...entries[0], onOpen: open, onStop: stop }
    const view = render(<AgentProcessArea entries={[row, entries[1], entries[2]]} onStopAllMembers={stopAll} />)
    const toggle = screen.getByRole('button', { name: '进程 · 成员 2 · 运行项 1 · 待审批项 1' })
    await user.tab()
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '打开 writer' })).not.toBeInTheDocument()
    view.rerender(<AgentProcessArea entries={[{ ...row, status: 'completed' }, { ...entries[1], status: 'running' }, entries[2]]} onStopAllMembers={stopAll} />)
    expect(screen.getByRole('button', { name: '进程 · 成员 2 · 运行项 1 · 待审批项 0' })).toHaveAttribute('aria-expanded', 'false')
    view.rerender(<AgentProcessArea entries={[row, entries[1], entries[2]]} onStopAllMembers={stopAll} />)
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.tab()
    expect(screen.getByRole('button', { name: '全部停止成员' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '打开 writer' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(open).toHaveBeenCalledOnce()
    await user.tab()
    expect(screen.getByRole('button', { name: '停止 writer' })).toHaveFocus()
    await user.keyboard(' ')
    expect(stop).toHaveBeenCalledOnce()
    expect(stopAll).not.toHaveBeenCalled()
  })

  it('counts running and approval items across members, jobs and observed helper jobs, including when collapsed', async () => {
    const user = userEvent.setup()
    const mixed: ProcessEntry[] = [
      { id: 'm', kind: 'member', name: '成员', status: 'running' },
      { id: 'j', kind: 'job', name: '后台任务', status: 'approval' },
      { id: 'h', kind: 'job', name: '内置调用', status: 'running' },
      { id: 'u', kind: 'job', name: '未知调用', status: 'unknown' }
    ]
    render(<AgentProcessArea entries={mixed} />)
    const toggle = screen.getByRole('button', { name: '进程 · 成员 1 · 运行项 2 · 待审批项 1' })
    expect(screen.getByText('未知')).toBeVisible()
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: '进程列表' })).toBeVisible()
  })

  it('marks the selected member without changing selection or stop behavior', () => {
    const open = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={[{ ...entries[0], selected: true, onOpen: open }]} />)
    const member = screen.getByRole('button', { name: '打开 writer' })
    expect(member).toHaveAttribute('aria-current', 'page')
    fireEvent.click(member)
    expect(open).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[0], selected: false, onOpen: open }]} />)
    expect(screen.getByRole('button', { name: '打开 writer' })).not.toHaveAttribute('aria-current')
  })

  it('offers stop all only for active members, including when collapsed', () => {
    const stopAll = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={entries} onStopAllMembers={stopAll} />)
    fireEvent.click(screen.getByRole('button', { name: /进程 ·/ }))
    fireEvent.click(screen.getByRole('button', { name: '全部停止成员' }))
    expect(stopAll).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[0], status: 'completed' }, entries[2]]} onStopAllMembers={stopAll} />)
    expect(screen.queryByRole('button', { name: '全部停止成员' })).not.toBeInTheDocument()
  })

  it('explains that stopping members clears their queued messages but background jobs have separate controls', () => {
    const memberStop = vi.fn()
    const jobStop = vi.fn()
    const stopAll = vi.fn()
    render(<AgentProcessArea entries={[
      { ...entries[0], onStop: memberStop },
      { id: 'background', kind: 'job', name: '后台', status: 'running', onStop: jobStop }
    ]} onStopAllMembers={stopAll} />)
    const member = screen.getByRole('button', { name: '停止 writer' })
    const all = screen.getByRole('button', { name: '全部停止成员' })
    const background = screen.getByRole('button', { name: '停止 后台' })
    expect(member).toHaveAccessibleDescription('请求停止该成员，并清除其排队消息。')
    expect(all).toHaveAccessibleDescription('请求停止活跃成员并清除其排队消息，不影响后台任务。')
    expect(background).not.toHaveAccessibleDescription('请求停止该成员，并清除其排队消息。')
    expect(member).toHaveAttribute('title', '请求停止该成员，并清除其排队消息。')
    expect(all).toHaveAttribute('title', '请求停止活跃成员并清除其排队消息，不影响后台任务。')
    fireEvent.click(member)
    fireEvent.click(all)
    fireEvent.click(background)
    expect(memberStop).toHaveBeenCalledOnce()
    expect(stopAll).toHaveBeenCalledOnce()
    expect(jobStop).toHaveBeenCalledOnce()
  })

  it('allows stopping approval but not completed entries', () => {
    const stop = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={[{ ...entries[1], onStop: stop }]} />)
    fireEvent.click(screen.getByRole('button', { name: '停止 designer' }))
    expect(stop).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[1], status: 'completed', onStop: stop }]} />)
    expect(screen.queryByRole('button', { name: '停止 designer' })).not.toBeInTheDocument()
  })

  it('uses optional status text and explicit stop capability without inferring activity', () => {
    const stop = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={[{ ...entries[0], status: 'unknown', statusText: '准备中', canStop: true, onStop: stop }]} />)
    expect(screen.getByText('准备中')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '停止 writer' }))
    expect(stop).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[0], status: 'running', statusText: ' ', canStop: false, onStop: stop }]} />)
    expect(screen.getByText('运行中')).toBeVisible()
    expect(screen.queryByRole('button', { name: '停止 writer' })).not.toBeInTheDocument()
  })

  it('wraps long names and opens detail from the main row when no open action exists', () => {
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

  it('keeps long member, role and localized status shrinkable and accessible alongside actions', async () => {
    const user = userEvent.setup()
    const name = '成员'.repeat(50), role = 'long-role'.repeat(40), status = 'localized-status'.repeat(80)
    const open = vi.fn(), stop = vi.fn()
    render(<div style={{ width: 180 }}><AgentProcessArea entries={[{ id: 'long', kind: 'member', name, role, status: 'running', statusText: status, onOpen: open, onStop: stop, detail: '详情' }]} /></div>)
    const row = screen.getByRole('button', { name: `打开 ${name}` })
    const description = screen.getByText(`${name} · ${role}`)
    const state = screen.getByText(status)
    expect(description).toHaveStyle({ minWidth: '0', overflowWrap: 'anywhere' })
    expect(state).toHaveStyle({ minWidth: '0', flexShrink: '1', overflowWrap: 'anywhere' })
    expect(row).toHaveAccessibleDescription(`${name} · ${role} ${status}`)
    await user.click(row)
    await user.click(screen.getByRole('button', { name: `展开 ${name} 详情` }))
    await user.click(screen.getByRole('button', { name: `停止 ${name}` }))
    expect(open).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.getByText('详情')).toBeVisible()
    expect(state).toHaveTextContent(status)
  })

  it('offers independent open, details and running-only stop actions', () => {
    const open = vi.fn(), stop = vi.fn()
    const { rerender } = render(<AgentProcessArea entries={[{ ...entries[0], onOpen: open, onStop: stop, detail: '详情正文' }]} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 writer' }))
    expect(open).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '展开 writer 详情' }))
    expect(screen.getByText('详情正文')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '停止 writer' }))
    expect(stop).toHaveBeenCalledOnce()
    rerender(<AgentProcessArea entries={[{ ...entries[0], status: 'completed', onStop: stop }]} />)
    expect(screen.queryByRole('button', { name: '停止 writer' })).not.toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeVisible()
  })
})
