import { registerTeamApprovalSurface } from './teamApprovalSurface'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MagicAgentApprovalCenter from './MagicAgentApprovalCenter'

const platformApi = vi.hoisted(() => ({
  listPendingApprovals: vi.fn(),
  resolvePendingApproval: vi.fn()
}))

vi.mock('../utils/windowUtils', () => ({
  api: () => ({ svcMagicAgentPlatform: platformApi })
}))

describe('MagicAgentApprovalCenter', () => {
  it('shows matching members inline with complete payload and falls back after unregister',async()=>{
    const host=document.createElement('div');document.body.append(host)
    const route={channel:'canvas',scopeType:'thread',scopeId:'project',threadId:'pane'}
    const waiting=vi.fn()
    const pending={approvalId:'inline',revision:9,request:{request:{sessionId:'member',route,target:{id:'shell.execute'},input:{command:'x'.repeat(600)+'END_OF_COMMAND'}}}}
    platformApi.listPendingApprovals.mockResolvedValue({approvals:[pending]})
    const unregister=registerTeamApprovalSurface({element:host,route,members:new Map([['member','文案']]),onWaiting:waiting})
    const view=render(<MagicAgentApprovalCenter/> )
    try{
      expect(await screen.findByText('文案 请求操作')).toBeVisible()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(host.querySelector('details pre')?.textContent).toContain('END_OF_COMMAND')
      await waitFor(()=>expect(waiting).toHaveBeenCalledWith(new Set(['member'])))
      await act(async()=>{unregister()})
      expect(await screen.findByRole('dialog')).toBeVisible()
      platformApi.resolvePendingApproval.mockResolvedValue({})
      platformApi.listPendingApprovals.mockResolvedValue({approvals:[]})
      fireEvent.click(screen.getByRole('button',{name:'允许这次操作'}))
      await waitFor(()=>expect(platformApi.resolvePendingApproval).toHaveBeenCalledWith({approvalId:'inline',expectedRevision:9,approved:true}))
    }finally{await act(async()=>{unregister()});view.unmount();host.remove()}
  })
  it('only shows the redacted request in an inline approval, never unrelated envelope fields', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const pending = {
      approvalId: 'inline-redacted', revision: 2,
      request: { request: { sessionId: 'member', route, target: { id: 'shell.execute' }, input: { command: 'echo fixture' } } },
      rawInput: { token: 'unrelated-envelope-secret' }
    }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [pending] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText('文案 请求操作')).toBeVisible()
      fireEvent.click(screen.getByText('详情'))
      expect(host.textContent).toContain('echo fixture')
      expect(host.textContent).not.toContain('unrelated-envelope-secret')
      expect(host.textContent).not.toContain('rawInput')
    } finally {
      await act(async () => { unregister() })
      view.unmount(); host.remove()
    }
  })

  it('binds each inline card identity and revision to the decision for that card', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const request = { request: { sessionId: 'member', route, target: { id: 'shell.execute' }, input: { command: 'same fixture' } } }
    const first = { approvalId: 'inline-first', revision: 7, request }
    const second = { approvalId: 'inline-second', revision: 8, request }
    platformApi.listPendingApprovals.mockResolvedValueOnce({ approvals: [first, second] }).mockResolvedValue({ approvals: [] })
    platformApi.resolvePendingApproval.mockResolvedValue({})
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      await waitFor(() => expect(host.querySelectorAll('[data-approval-id]')).toHaveLength(2))
      const cards = [...host.querySelectorAll<HTMLElement>('[data-approval-id]')]
      expect(cards.map(card => [card.dataset.approvalId, card.dataset.approvalRevision])).toEqual([
        ['inline-first', '7'], ['inline-second', '8']
      ])
      fireEvent.click(within(cards[1]).getByRole('button', { name: '批准' }))
      await waitFor(() => expect(platformApi.resolvePendingApproval).toHaveBeenCalledExactlyOnceWith({
        approvalId: 'inline-second', expectedRevision: 8, approved: true
      }))
    } finally {
      await act(async () => { unregister() })
      view.unmount(); host.remove()
    }
  })

  it.each([true, false])('resolves the selected inline approval using only its id and revision (approved=%s)', async approved => {
    const host = document.createElement('div')
    document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const pending = {
      approvalId: 'inline-decision', revision: 7,
      request: { request: { sessionId: 'member', route, target: { id: 'shell.execute' }, input: { command: 'echo fixture' } } }
    }
    platformApi.listPendingApprovals.mockResolvedValueOnce({ approvals: [pending] }).mockResolvedValue({ approvals: [] })
    platformApi.resolvePendingApproval.mockResolvedValue({})
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText('文案 请求操作')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: approved ? '批准' : '拒绝' }))
      await waitFor(() => expect(platformApi.resolvePendingApproval).toHaveBeenCalledExactlyOnceWith({
        approvalId: 'inline-decision', expectedRevision: 7, approved
      }))
    } finally {
      await act(async () => { unregister() })
      view.unmount(); host.remove()
    }
  })

  it.each([true, false])('routes a suspended mock member tool through inline approval (approved=%s)', async (approved) => {
    const host = document.createElement('div')
    document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const waiting = vi.fn()
    const approval = { approvalId: 'mock-tool', revision: 3, request: { request: {
      sessionId: 'member', route, action: 'memory.note.write', target: { id: 'scratchpad' },
      input: { conversationId: 'member', action: 'set', key: 'fixture', value: 'example', expectedRevision: 0 }
    } } }
    let decision: ((value: boolean) => void) | undefined
    const toolEffect = vi.fn()
    const mockMemberRequest = async () => {
      const allowed = await new Promise<boolean>((resolve) => { decision = resolve })
      if (allowed) toolEffect()
      return allowed ? 'continued' : 'denied'
    }
    const pending = mockMemberRequest()
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [approval] })
    platformApi.resolvePendingApproval.mockImplementation(async (input) => {
      expect(input).toEqual({ approvalId: 'mock-tool', expectedRevision: 3, approved })
      platformApi.listPendingApprovals.mockResolvedValue({ approvals: [] })
      decision!(input.approved)
      return {}
    })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', 'Writer']]), onWaiting: waiting })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText('Writer 想保存一条笔记')).toBeVisible()
      expect(toolEffect).not.toHaveBeenCalled()
      await waitFor(() => expect(waiting).toHaveBeenCalledWith(new Set(['member'])))
      fireEvent.click(screen.getByRole('button', { name: approved ? '批准' : '拒绝' }))
      expect(await pending).toBe(approved ? 'continued' : 'denied')
      expect(toolEffect).toHaveBeenCalledTimes(approved ? 1 : 0)
      await waitFor(() => expect(waiting).toHaveBeenLastCalledWith(new Set()))
    } finally {
      await act(async () => { unregister() })
      view.unmount()
      host.remove()
    }
  })

  it.each([{ action: 'set', value: '<script>fixture</script>\n' + 'x'.repeat(700), title: '文案 想保存一条笔记' }, { action: 'set', value: undefined, title: '文案 想保存一条笔记' }, { action: 'delete', value: 'fixture', title: '文案 请求操作' }])('shows note snapshot safely for $action', async ({ action, value, title }) => {
    const host = document.createElement('div'); document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const request = { request: { sessionId: 'member', route, target: { id: 'scratchpad' }, input: { action, value, key: 'secret-key', expectedRevision: 7 } } }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'note', revision: 8, request }] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText(title)).toBeVisible()
      const details = host.querySelector('details')!
      expect(details.open).toBe(false)
      expect(details.querySelector('pre')?.textContent).toBe(JSON.stringify(request, null, 2))
      expect(host.querySelector('script')).toBeNull()
      if (action === 'set') expect(value ? host.querySelector('[title]')?.textContent : screen.getByText('笔记内容未提供').textContent).toBe(value || '笔记内容未提供')
      else expect(screen.queryByText('文案 想保存一条笔记')).toBeNull()
      fireEvent.click(screen.getByText('详情')); expect(details.open).toBe(true)
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })

  it.each([
    { tool: 'shell.execute', input: { command: 'echo visible', conversationId: 'private-session', expectedRevision: 7 }, expected: '命令: echo visible' },
    { tool: 'files.write', input: { targetPath: '/tmp/fixture.txt', content: 'sample-content', operationId: 'internal-op' }, expected: '目标路径: /tmp/fixture.txt' }
  ])('shows substantive $tool parameters before details open', async ({ tool, input, expected }) => {
    const host = document.createElement('div'); document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const request = { request: { sessionId: 'member', route, target: { id: tool }, input } }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'summary', revision: 3, request }] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText('文案 请求操作')).toBeVisible()
      expect(screen.getByText(expected)).toBeVisible()
      expect(host.querySelector('details')?.open).toBe(false)
      expect(host.querySelector('details pre')?.textContent).toBe(JSON.stringify(request, null, 2))
      if (tool === 'files.write') expect(screen.getByText('文件完整内容: sample-content')).toBeVisible()
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })

  beforeEach(() => {
    platformApi.listPendingApprovals.mockReset()
    platformApi.resolvePendingApproval.mockReset()
  })

  it.each([
    null,
    'not-a-request',
    { request: [] },
    { request: { target: null, input: null } },
    { request: { target: { id: 42 }, input: [] } }
  ])('handles a missing or malformed redacted request without crashing: %j', async (request) => {
    platformApi.listPendingApprovals.mockResolvedValue({
      approvals: [{ approvalId: 'approval-malformed', revision: 0, request }]
    })

    render(<MagicAgentApprovalCenter />)
    expect(await screen.findByText('待确认操作')).toBeInTheDocument()
    expect(screen.getByText('工具：未提供工具名称')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()
    expect(platformApi.resolvePendingApproval).not.toHaveBeenCalled()
  })

  it.each([true, false])('renders a scratchpad mutation snapshot inertly and resolves only its approval id/revision (approved=%s)', async approved => {
    const value = '<script>UNTRUSTED_WORKING_NOTE</script>\n' + 'long value '.repeat(60)
    const approval = { approvalId: 'notes-approval', revision: 2, request: { request: { action: 'memory.note.write', target: { id: 'scratchpad' }, input: { action: 'set', conversationId: 'current-notes', key: 'preference', value, expectedRevision: 7 } }, requestDigest: 'main-authored', redactedPaths: [] } }
    platformApi.listPendingApprovals.mockResolvedValueOnce({ approvals: [approval] }).mockResolvedValue({ approvals: [] })
    platformApi.resolvePendingApproval.mockResolvedValue({ approval })
    render(<MagicAgentApprovalCenter />)
    expect(await screen.findByText('修改当前会话草稿笔记')).toBeInTheDocument()
    expect(screen.getByText('工具：scratchpad')).toBeInTheDocument()
    expect(screen.getByText('set')).toBeInTheDocument(); expect(screen.getByText('preference')).toBeInTheDocument(); expect(screen.getByText('current-notes')).toBeInTheDocument(); expect(screen.getByText('7')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('details pre')?.textContent).toContain(value.replaceAll('\n', '\\n'))
    fireEvent.click(screen.getByRole('button', { name: approved ? '允许这次操作' : '拒绝' }))
    await waitFor(() => expect(platformApi.resolvePendingApproval).toHaveBeenCalledExactlyOnceWith({ approvalId: 'notes-approval', expectedRevision: 2, approved }))
    expect(JSON.stringify(platformApi.resolvePendingApproval.mock.calls)).not.toMatch(/grant|permit|approver|value|main-authored/)
  })

  it.each([true, false])('renders an exact memory-file approval including full inert content and creation/preimage tuple (approved=%s)', async approved => {
    const content = '<script>UNTRUSTED_PERSISTENT_MEMORY</script>\n' + 'full memory line '.repeat(80)
    const approval = { approvalId: 'file-memory-approval', revision: 3, request: { request: { action: 'memory.file.write', target: { id: 'memory_write' }, input: { path: './memory/facts.md', namespace: 'D:/isolated/route/memory/.agent-memory-v1', namespaceGeneration: 'generation-main-only', namespaceCreation: true, preimage: null, content, create: true, conversationId: 'file-conversation', routeIdentity: ['canvas', 'thread', 'project', 'pane'], workspaceId: 'main-workspace', bindingRevision: 'binding-main-only', operationId: 'main-operation' } }, requestDigest: 'main-file-digest', redactedPaths: [] } }
    platformApi.listPendingApprovals.mockResolvedValueOnce({ approvals: [approval] }).mockResolvedValue({ approvals: [] })
    platformApi.resolvePendingApproval.mockResolvedValue({ approval })
    render(<MagicAgentApprovalCenter />)
    expect(await screen.findByText('修改持久记忆文件（独立审批）')).toBeInTheDocument()
    expect(screen.getByText('工具：memory_write')).toBeInTheDocument()
    expect(screen.getByText('文件完整内容')).toBeInTheDocument(); expect(screen.getByText('创建目录及归属标记')).toBeInTheDocument(); expect(screen.getByText('此前完整文件 SHA-256（null 表示不存在）')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('details pre')?.textContent).toContain(content.replaceAll('\n', '\\n'))
    fireEvent.click(screen.getByRole('button', { name: approved ? '允许这次操作' : '拒绝' }))
    await waitFor(() => expect(platformApi.resolvePendingApproval).toHaveBeenCalledExactlyOnceWith({ approvalId: 'file-memory-approval', expectedRevision: 3, approved }))
    expect(JSON.stringify(platformApi.resolvePendingApproval.mock.calls)).not.toMatch(/content|namespace|binding|operation|grant|permit|main-file-digest/)
  })

  it('shows the actual creative action and only the redacted parameters', async () => {
    platformApi.listPendingApprovals.mockResolvedValue({
      approvals: [
        {
          approvalId: 'approval-image',
          revision: 2,
          request: {
            request: {
              target: { id: 'creative.image.create' },
              input: { prompt: 'A cozy garden', token: '[redacted]' }
            }
          },
          rawInput: { token: 'do-not-display-this-secret' }
        }
      ]
    })

    render(<MagicAgentApprovalCenter />)
    expect(await screen.findByText('生成或编辑图片')).toBeInTheDocument()
    expect(screen.getByText('A cozy garden')).toBeInTheDocument()
    expect(screen.getByText('工具：image.create')).toBeInTheDocument()
    expect(screen.queryByText(/do-not-display-this-secret/)).not.toBeInTheDocument()
    expect(screen.getByText('查看完整请求（敏感信息已隐藏）')).toBeInTheDocument()
    expect(screen.queryByText(/controlled terminal action/)).not.toBeInTheDocument()
  })

  it('approves the displayed request with its expected revision', async () => {
    const approval = {
      approvalId: 'approval-terminal',
      revision: 4,
      request: {
        request: { target: { id: 'agent.terminal.run' }, input: { command: 'git status' } }
      }
    }
    platformApi.listPendingApprovals
      .mockResolvedValueOnce({ approvals: [approval] })
      .mockResolvedValue({ approvals: [] })
    platformApi.resolvePendingApproval.mockResolvedValue({ approval })

    render(<MagicAgentApprovalCenter />)
    expect(await screen.findByText('运行受控终端命令')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '允许这次操作' }))

    await waitFor(() =>
      expect(platformApi.resolvePendingApproval).toHaveBeenCalledWith({
        approvalId: 'approval-terminal',
        expectedRevision: 4,
        approved: true
      })
    )
    expect(JSON.stringify(platformApi.resolvePendingApproval.mock.calls)).not.toMatch(
      /grant|permit|approver/i
    )
  })

  it('denies the displayed request without supplying any authorization grant', async () => {
    const approval = {
      approvalId: 'approval-2',
      revision: 0,
      request: {
        request: { target: { id: 'creative.canvas.export' }, input: { path: 'canvas.png' } }
      }
    }
    platformApi.listPendingApprovals
      .mockResolvedValueOnce({ approvals: [approval] })
      .mockResolvedValue({ approvals: [] })
    platformApi.resolvePendingApproval.mockResolvedValue({ approval })

    render(<MagicAgentApprovalCenter />)
    expect(await screen.findByText('导出画布')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))

    await waitFor(() =>
      expect(platformApi.resolvePendingApproval).toHaveBeenCalledWith({
        approvalId: 'approval-2',
        expectedRevision: 0,
        approved: false
      })
    )
    expect(JSON.stringify(platformApi.resolvePendingApproval.mock.calls)).not.toMatch(
      /grant|permit|approver/i
    )
  })
})
