import { registerTeamApprovalSurface } from './teamApprovalSurface'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import MagicAgentApprovalCenter from './MagicAgentApprovalCenter'

const platformApi = vi.hoisted(() => ({
  listPendingApprovals: vi.fn(),
  resolvePendingApproval: vi.fn()
}))

vi.mock('../utils/windowUtils', () => ({
  api: () => ({ svcMagicAgentPlatform: platformApi })
}))

describe('MagicAgentApprovalCenter', () => {
  // The texts come from the locale files; the assertions below read the zh-CN copy.
  beforeAll(async () => { await i18n.changeLanguage('zh-CN') })
  afterEach(async () => { if (i18n.language !== 'zh-CN') await i18n.changeLanguage('zh-CN') })

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
      // Since SEC-1b the note is shown in the capped form of its row, not raw in a one-line span.
      if (action === 'set') expect(value ? host.querySelector('[data-approval-note]')?.textContent : screen.getByText('笔记内容未提供').textContent).toBe(value ? `${value.slice(0, 480)}…（完整内容见详情）` : '笔记内容未提供')
      else expect(screen.queryByText('文案 想保存一条笔记')).toBeNull()
      expect(host.querySelector('[title]')).toBeNull()
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
      // A row's label and value are separate elements; match the whole row.
      const row = (text: string) => screen.getByText((_, element) => element?.hasAttribute('data-approval-parameter') === true && element.textContent === text)
      expect(row(expected)).toBeVisible()
      expect(host.querySelector('details')?.open).toBe(false)
      expect(host.querySelector('details pre')?.textContent).toBe(JSON.stringify(request, null, 2))
      if (tool === 'files.write') expect(row('文件完整内容: sample-content')).toBeVisible()
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

  it('shows English copy without Chinese text or raw keys when the app language is en-US', async () => {
    await act(async () => { await i18n.changeLanguage('en-US') })
    const host = document.createElement('div')
    document.body.append(host)
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const inline = { approvalId: 'inline-en', revision: 1, request: { request: { sessionId: 'member', route, target: { id: 'scratchpad' }, input: { action: 'set', key: 'k', expectedRevision: 1 } } } }
    const dialog = { approvalId: 'dialog-en', revision: 2, graphContext: { runId: 'run-1', nodeId: 'node-1' }, request: { request: { target: { id: 'files.write' }, input: { path: './a.txt', content: 'x'.repeat(600), create: true, preimage: null } } } }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [dialog, inline] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', 'Writer']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(screen.getByText('Confirm the action the AI requested')).toBeVisible()
      expect(screen.getByText('Write a file')).toBeVisible()
      expect(screen.getByText('Tool: files.write')).toBeVisible()
      expect(screen.getByText('Task run-1 · Step node-1')).toBeVisible()
      expect(screen.getByText('Full file content')).toBeVisible()
      expect(screen.getByText(/^x{480}… \(full content in Details\)$/)).toBeVisible()
      expect(screen.getByRole('button', { name: 'Allow this action' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
      expect(within(host).getByText('Writer wants to save a note')).toBeVisible()
      expect(within(host).getByText('No note content provided')).toBeVisible()
      expect(within(host).getByRole('button', { name: 'Approve', hidden: true })).toBeVisible()
      expect(within(host).getByText('Details')).toBeVisible()
      const shown = `${document.body.textContent ?? ''} ${host.textContent ?? ''}`
      expect(shown).not.toMatch(/[\u3400-\u9fff]/)
      expect(shown).not.toMatch(/agent_workspace\./)
    } finally {
      await act(async () => { unregister() })
      view.unmount(); host.remove()
    }
  })
})

// An approval must never hide one of its parameters: field names that are also members of
// Object.prototype, a JSON "__proto__" field, fields past the sixth and technical fields are all
// listed with their values before the person decides.
describe('MagicAgentApprovalCenter shows every parameter of the request', () => {
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
  // JSON.parse keeps "__proto__" as an own field, as a request decoded from a tool call does.
  const prototypeNamedInput = () => JSON.parse(JSON.stringify({
    command: 'echo visible',
    constructor: 'CONSTRUCTOR-VALUE',
    toString: 'TO-STRING-VALUE',
    valueOf: 'VALUE-OF-VALUE',
    hasOwnProperty: 'HAS-OWN-VALUE',
    conversationId: 'conversation-fixture',
    path: './fixture.txt'
  }).replace(/}$/, ',"__proto__":{"nested":"PROTO-VALUE"}}')) as Record<string, unknown>
  const label = (key: string) => i18n.t(`agent_workspace.approval.parameters.${key}` as never) as string
  // Known fields first in their display order (conversationId, path, command), then the rest in
  // the order they were sent.
  const expectedRows = () => [
    [label('conversation_id'), 'conversation-fixture'],
    [label('path'), './fixture.txt'],
    [label('command'), 'echo visible'],
    ['constructor', 'CONSTRUCTOR-VALUE'],
    ['toString', 'TO-STRING-VALUE'],
    ['valueOf', 'VALUE-OF-VALUE'],
    ['hasOwnProperty', 'HAS-OWN-VALUE'],
    ['__proto__', '{"nested":"PROTO-VALUE"}']
  ]
  const dialogRows = () =>
    [...screen.getByRole('dialog').querySelectorAll('dl > dt')].map(term => [term.textContent, term.nextElementSibling?.textContent])
  const cardRows = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-testid="chat-prompt-card-detail"] > span')].map(row => row.textContent)

  beforeEach(() => {
    platformApi.listPendingApprovals.mockReset()
    platformApi.resolvePendingApproval.mockReset()
  })
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('zh-CN') }) })

  it('builds the fixture with own prototype-named fields, including __proto__', () => {
    const input = prototypeNamedInput()
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) expect(Object.hasOwn(input, key)).toBe(true)
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
  })

  it.each(['zh-CN', 'en-US'])('lists every field with its value in the dialog (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'dialog-proto', revision: 1, request: { request: { target: { id: 'shell.execute' }, input: prototypeNamedInput() } } }] })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(dialogRows()).toEqual(expectedRows())
      expect(label('path')).not.toBe('path')
      expect(platformApi.resolvePendingApproval).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it.each(['zh-CN', 'en-US'])('lists every field with its value in the inline member card (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const host = document.createElement('div'); document.body.append(host)
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'inline-proto', revision: 1, request: { request: { sessionId: 'member', route, target: { id: 'shell.execute' }, input: prototypeNamedInput() } } }] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', 'Writer']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      await waitFor(() => expect(host.querySelector('[data-testid="team-approval-card"]')).not.toBeNull())
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(cardRows(host)).toEqual(expectedRows().map(([name, value]) => `${name}: ${value}`))
      expect(host.querySelector('details')?.open).toBe(false)
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })

  it('lists the other fields of a note under the note in the inline card', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const input = JSON.parse('{"action":"set","key":"note-key","value":"note text","expectedRevision":3,"constructor":"CTOR","__proto__":"PROTO"}')
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'inline-note', revision: 1, request: { request: { sessionId: 'member', route, target: { id: 'scratchpad' }, input } } }] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText('文案 想保存一条笔记')).toBeVisible()
      expect(host.querySelector('[data-approval-note]')?.textContent).toBe('note text')
      expect(cardRows(host)).toEqual(['操作: set', '笔记键: note-key', '预期笔记版本: 3', 'constructor: CTOR', '__proto__: PROTO'])
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })

  it('lists every field of a request with more than six fields, known ones in their order', async () => {
    const input = { content: 'body', path: './memory/facts.md', namespace: 'ns', create: true, preimage: null, namespaceGeneration: 'gen', namespaceCreation: true, operationId: 'op', conversationId: 'conv', routeIdentity: ['canvas', 'thread'], workspaceId: 'ws', bindingRevision: 'rev' }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'many', revision: 1, request: { request: { target: { id: 'memory_write' }, input } } }] })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(dialogRows()).toEqual([
        [label('content'), 'body'], [label('namespace'), 'ns'], [label('namespace_generation'), 'gen'],
        [label('namespace_creation'), 'true'], [label('preimage'), 'null'], [label('create'), 'true'],
        [label('operation_id'), 'op'], [label('conversation_id'), 'conv'], [label('path'), './memory/facts.md'],
        ['routeIdentity', '["canvas","thread"]'], ['workspaceId', 'ws'], ['bindingRevision', 'rev']
      ])
    } finally { view.unmount() }
  })

  it('shows a long value of a prototype-named field in the truncated form that points to the details', async () => {
    const input = JSON.parse(JSON.stringify({ valueOf: 'v'.repeat(600) + 'TAIL' }))
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'long', revision: 1, request: { request: { target: { id: 'shell.execute' }, input } } }] })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(dialogRows()).toEqual([['valueOf', i18n.t('agent_workspace.approval.truncated', { text: 'v'.repeat(480) })]])
      expect(document.querySelector('details pre')?.textContent).toContain('TAIL')
    } finally { view.unmount() }
  })

  it('quotes a field name that could be misread and shows names and values only as text', async () => {
    const input = JSON.parse(JSON.stringify({
      path: './real.txt',
      '路径': './spoofed.txt',
      '': 'empty-name',
      'cmd​': 'zero-width',
      ' padded ': 'spaces',
      'line\nbreak': 'newline',
      '"quoted"': 'quotes',
      '<b>bold</b>': '[link](https://example.invalid) <img src=x onerror=alert(1)> $t(agent_workspace.approval.deny) {{text}}'
    }))
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'names', revision: 1, request: { request: { target: { id: 'shell.execute' }, input } } }] })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(dialogRows()).toEqual([
        ['路径', './real.txt'],
        ['"路径"', './spoofed.txt'],
        ['""', 'empty-name'],
        ['"cmd\\u{200b}"', 'zero-width'],
        ['" padded "', 'spaces'],
        ['"line\\u{a}break"', 'newline'],
        ['"\\"quoted\\""', 'quotes'],
        ['<b>bold</b>', '[link](https://example.invalid) <img src=x onerror=alert(1)> $t(agent_workspace.approval.deny) {{text}}']
      ])
      const dialog = screen.getByRole('dialog')
      expect(dialog.querySelector('b, a, img')).toBeNull()
    } finally { view.unmount() }
  })
})

// A value made of line breaks must not push the other parameters out of view or plant text that
// reads like a further "label: value" row; a long name must not push them out of view either.
describe('MagicAgentApprovalCenter keeps every parameter in view', () => {
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
  const label = (key: string) => i18n.t(`agent_workspace.approval.parameters.${key}` as never) as string
  const truncated = (text: string) => i18n.t('agent_workspace.approval.truncated', { text }) as string
  const escaped = (text: string) => i18n.t('agent_workspace.approval.escaped', { text }) as string
  // A model-written value: a forged row for a field listed after it, then 400 blank lines.
  const stuffedInput = () => ({
    content: `first line\n${label('path')}: ./forged.txt` + '\n'.repeat(400),
    path: './real.txt',
    namespace: 'real-namespace'
  })
  const expectedRows = () => [
    [label('content'), truncated(`first line\n${label('path')}: ./forged.txt`)],
    [label('namespace'), 'real-namespace'],
    [label('path'), './real.txt']
  ]
  const dialogRows = () =>
    [...screen.getByRole('dialog').querySelectorAll('dl > dt')].map(term => [term.textContent, term.nextElementSibling?.textContent])
  const pendingFor = (approvalId: string, input: unknown, sessionId?: string) => ({
    approvalId, revision: 1,
    request: { request: { ...(sessionId ? { sessionId, route } : {}), target: { id: 'memory_write' }, input } }
  })
  const renderDialog = async (input: unknown) => {
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [pendingFor('dialog-view', input)] })
    const view = render(<MagicAgentApprovalCenter />)
    expect(await screen.findByRole('dialog')).toBeVisible()
    return view
  }

  beforeEach(() => {
    platformApi.listPendingApprovals.mockReset()
    platformApi.resolvePendingApproval.mockReset()
  })
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('zh-CN') }) })

  it.each(['zh-CN', 'en-US'])('cuts a value made of line breaks in the dialog and keeps the next rows right after it (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const view = await renderDialog(stuffedInput())
    try {
      expect(dialogRows()).toEqual(expectedRows())
      for (const value of screen.getByRole('dialog').querySelectorAll('dl > dd')) expect(value.textContent!.split('\n').length).toBeLessThanOrEqual(6)
      // The only term that reads as the path label is the real one, and its value is the real path.
      const terms = [...screen.getByRole('dialog').querySelectorAll('dl > dt')].filter(term => term.textContent?.startsWith(label('path')))
      expect(terms.map(term => term.nextElementSibling?.textContent)).toEqual(['./real.txt'])
      expect(document.querySelector('details pre')?.textContent).toContain('\\n\\n\\n')
      expect(platformApi.resolvePendingApproval).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it.each(['zh-CN', 'en-US'])('cuts a value made of line breaks in the inline card and keeps labels apart from values (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const host = document.createElement('div'); document.body.append(host)
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [pendingFor('inline-view', stuffedInput(), 'member')] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', 'Writer']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      await waitFor(() => expect(host.querySelector('[data-testid="team-approval-card"]')).not.toBeNull())
      expect(screen.queryByRole('dialog')).toBeNull()
      const rows = [...host.querySelectorAll('[data-testid="chat-prompt-card-detail"] > span')]
      expect(rows.map(row => row.textContent)).toEqual(expectedRows().map(([name, value]) => `${name}: ${value}`))
      expect(rows.map(row => row.getAttribute('data-approval-parameter'))).toEqual(['content', 'namespace', 'path'])
      // Labels are their own elements; text inside a value never becomes a label.
      expect([...host.querySelectorAll('[data-approval-parameter-label]')].map(name => name.textContent)).toEqual(expectedRows().map(([name]) => name))
      expect([...host.querySelectorAll('[data-approval-parameter-value]')].map(value => value.textContent)).toEqual(expectedRows().map(([, value]) => value))
      for (const row of rows) expect(row.textContent!.split('\n').length).toBeLessThanOrEqual(6)
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })

  it('keeps a value of six lines whole and cuts one of seven, counting every kind of line break', async () => {
    const view = await renderDialog({
      content: 'a\nb\nc\nd\ne\nf',
      namespace: 'a\r\nb\rc d e\vf\fg\u0085h',
      path: 'a\nb\nc\nd\ne\nf\ng'
    })
    try {
      expect(dialogRows()).toEqual([
        [label('content'), 'a\nb\nc\nd\ne\nf'],
        [label('namespace'), truncated('a\nb\nc\nd\ne\nf')],
        [label('path'), truncated('a\nb\nc\nd\ne\nf')]
      ])
    } finally { view.unmount() }
  })

  it('cuts a long value between characters, never inside a surrogate pair', async () => {
    const view = await renderDialog({ content: 'a' + '😀'.repeat(600) })
    try {
      expect(dialogRows()).toEqual([[label('content'), truncated('a' + '😀'.repeat(479))]])
    } finally { view.unmount() }
  })

  it('shows bidi controls inside a value escaped', async () => {
    const view = await renderDialog({ path: './safe‮txt.exe', content: 'x⁦y‏z' })
    try {
      expect(dialogRows()).toEqual([
        // Since SEC-1b a row that shows characters as codes also points to the full request.
        [label('content'), escaped('x\\u{2066}y\\u{200f}z')],
        [label('path'), escaped('./safe\\u{202e}txt.exe')]
      ])
    } finally { view.unmount() }
  })

  it('quotes a name with a colon and cuts a very long name', async () => {
    const view = await renderDialog({
      command: 'echo real',
      [`${label('command')}: rm -rf ~`]: 'x',
      'full：width': 'y',
      ['n'.repeat(5000)]: 'long-name-value'
    })
    try {
      expect(dialogRows()).toEqual([
        [label('command'), 'echo real'],
        [`"${label('command')}: rm -rf ~"`, 'x'],
        ['"full：width"', 'y'],
        [truncated('n'.repeat(120)), 'long-name-value']
      ])
    } finally { view.unmount() }
  })

  it('lists the value of a note that is not text in the inline card', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const input = { action: 'set', key: 'k', value: { secret: 'NONSTRING-VALUE' } }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'inline-note-object', revision: 1, request: { request: { sessionId: 'member', route, target: { id: 'scratchpad' }, input } } }] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', '文案']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      expect(await screen.findByText('文案 想保存一条笔记')).toBeVisible()
      expect([...host.querySelectorAll('[data-testid="chat-prompt-card-detail"] > span')].map(row => row.textContent))
        .toEqual(['操作: set', '笔记键: k', '笔记内容: {"secret":"NONSTRING-VALUE"}'])
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })
})

// Characters that draw blank or nothing must never hide what is approved: long blank runs are
// collapsed into a visible marker, hidden characters are escaped, and Details shows them as JSON
// escapes (SEC-1b).
describe('MagicAgentApprovalCenter shows blank and hidden characters', () => {
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
  const label = (key: string) => i18n.t(`agent_workspace.approval.parameters.${key}` as never) as string
  const truncated = (text: string) => i18n.t('agent_workspace.approval.truncated', { text }) as string
  const escaped = (text: string) => i18n.t('agent_workspace.approval.escaped', { text }) as string
  const cp = (...codes: number[]) => String.fromCodePoint(...codes)
  const BRAILLE_BLANK = cp(0x2800)
  // The panel's input: blank padding pushes the real command past the visible part of the row.
  const shellCode = 'ls' + BRAILLE_BLANK.repeat(460) + '\nrm -rf ~'
  // As main builds a shell.execute approval (agentThreadShellHost.ts).
  const shellInput = () => ({ command: '/bin/bash', args: ['--noprofile', '--norc', '-c', shellCode], cwd: '/work', code: shellCode })
  // 'User prefers tea.' followed by 460 tag characters that spell out hidden text.
  const tagText = Array.from({ length: 460 }, (_, index) => cp(0xe0020 + (index % 95))).join('')
  const dialogRows = () =>
    [...screen.getByRole('dialog').querySelectorAll('dl > dt')].map(term => [term.textContent, term.nextElementSibling?.textContent])
  const cardRows = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-testid="chat-prompt-card-detail"] > span')].map(row => [
      row.querySelector('[data-approval-parameter-label]')?.textContent,
      row.querySelector('[data-approval-parameter-value]')?.textContent
    ])
  const pendingFor = (approvalId: string, tool: string, input: unknown, sessionId?: string) => ({
    approvalId, revision: 1,
    request: { request: { ...(sessionId ? { sessionId, route } : {}), target: { id: tool }, input } }
  })
  const renderDialog = async (tool: string, input: unknown) => {
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [pendingFor('dialog-hidden', tool, input)] })
    const view = render(<MagicAgentApprovalCenter />)
    expect(await screen.findByRole('dialog')).toBeVisible()
    return view
  }
  const renderCard = async (tool: string, input: unknown) => {
    const host = document.createElement('div'); document.body.append(host)
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [pendingFor('inline-hidden', tool, input, 'member')] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', 'Writer']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    await waitFor(() => expect(host.querySelector('[data-testid="team-approval-card"]')).not.toBeNull())
    return { host, cleanup: async () => { await act(async () => { unregister() }); view.unmount(); host.remove() } }
  }
  // Every character a row or Details shows draws something.
  const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u2800\u3164\uffa0\u115f\u1160\u00a0\u3000]|(?![\t\n])\p{Cc}/u

  beforeEach(() => {
    platformApi.listPendingApprovals.mockReset()
    platformApi.resolvePendingApproval.mockReset()
  })
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('zh-CN') }) })

  it.each(['zh-CN', 'en-US'])('shows the command after blank padding in the Code row of the dialog (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const view = await renderDialog('shell.execute', shellInput())
    try {
      const rows = dialogRows()
      const code = rows.find(([name]) => name === label('code'))
      expect(code).toEqual([label('code'), escaped('ls\u27e6460 \u00d7 U+2800\u27e7\nrm -rf ~')])
      expect(rows.find(([name]) => name === label('args'))?.[1]).toBe(escaped('["--noprofile","--norc","-c","ls\u27e6460 \u00d7 U+2800\u27e7\\nrm -rf ~"]'))
      for (const [, value] of rows) expect(value).not.toMatch(INVISIBLE)
      expect(platformApi.resolvePendingApproval).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it.each(['zh-CN', 'en-US'])('shows the command after blank padding in the Code row of the inline card (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const { host, cleanup } = await renderCard('shell.execute', shellInput())
    try {
      expect(screen.queryByRole('dialog')).toBeNull()
      const code = cardRows(host).find(([name]) => name === label('code'))
      expect(code?.[1]).toBe(escaped('ls\u27e6460 \u00d7 U+2800\u27e7\nrm -rf ~'))
      expect(host.querySelector('[data-testid="chat-prompt-card-detail"]')?.textContent).not.toMatch(INVISIBLE)
    } finally { await cleanup() }
  })

  it('collapses runs of other blank-drawing characters, mixed runs and runs broken up by spaces', async () => {
    const view = await renderDialog('shell.execute', {
      command: 'a' + cp(0x3164).repeat(40) + 'b',
      args: 'a' + cp(0xa0).repeat(10) + cp(0x3000).repeat(5) + 'b',
      cwd: 'a' + (BRAILLE_BLANK.repeat(3) + ' ').repeat(115) + 'b',
      code: 'a' + '\t'.repeat(6) + 'b' + cp(0xffa0, 0x115f, 0x1160, 0x17b4, 0x17b5) + 'c'
    })
    try {
      expect(dialogRows()).toEqual([
        [label('command'), escaped('a\u27e640 \u00d7 U+3164\u27e7b')],
        [label('args'), escaped('a\u27e615 \u00d7 U+00A0/U+3000\u27e7b')],
        [label('cwd'), escaped('a\u27e6460 \u00d7 U+2800/U+0020\u27e7b')],
        [label('code'), escaped('a\u27e66 \u00d7 U+0009\u27e7b\u27e65 \u00d7 U+FFA0/U+115F/U+1160/U+17B4/\u2026\u27e7c')]
      ])
    } finally { view.unmount() }
  })

  it.each(['zh-CN', 'en-US'])('shows tag characters and zero-width characters in a memory_write content as escapes (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const view = await renderDialog('memory_write', {
      content: 'User prefers tea.' + tagText,
      path: './memory/facts.md' + cp(0x200b, 0x2060, 0xfeff, 0xad),
      namespace: 'ns' + cp(0xfe0f) + cp(0xe0100) + cp(0xe000) + cp(0x1) + 'x'
    })
    try {
      const rows = dialogRows()
      const content = rows.find(([name]) => name === label('content'))![1]!
      expect(content.startsWith('User prefers tea.\\u{e0020}\\u{e0021}\\u{e0022}')).toBe(true)
      expect(content).toBe(truncated('User prefers tea.' + Array.from(tagText).slice(0, 51).map(c => `\\u{${c.codePointAt(0)!.toString(16)}}`).join('')))
      expect(rows.find(([name]) => name === label('path'))?.[1]).toBe(escaped('./memory/facts.md\\u{200b}\\u{2060}\\u{feff}\\u{ad}'))
      expect(rows.find(([name]) => name === label('namespace'))?.[1]).toBe(escaped('ns\\u{fe0f}\\u{e0100}\\u{e000}\\u{1}x'))
      for (const [, value] of rows) expect(value).not.toMatch(INVISIBLE)
    } finally { view.unmount() }
  })

  it('shows tag characters as escapes in the inline card too', async () => {
    const { host, cleanup } = await renderCard('memory_write', { content: 'User prefers tea.' + tagText.slice(0, 8), path: './memory/facts.md' })
    try {
      expect(cardRows(host).find(([name]) => name === label('content'))?.[1]).toBe(escaped('User prefers tea.\\u{e0020}\\u{e0021}\\u{e0022}\\u{e0023}'))
    } finally { await cleanup() }
  })

  it('escapes the Details JSON of the dialog and of the inline card with valid JSON escapes', async () => {
    const input = { content: 'User prefers tea.' + tagText.slice(0, 4) + BRAILLE_BLANK.repeat(5) + cp(0x202e, 0xa0, 0x3164), path: './a.txt' }
    const view = await renderDialog('memory_write', input)
    try {
      const shown = document.querySelector('[role="dialog"] details pre')!.textContent!
      expect(shown).not.toMatch(INVISIBLE)
      expect(shown).toContain('User prefers tea.\\udb40\\udc20\\udb40\\udc21')
      expect(shown).toContain('\\u2800\\u2800\\u2800\\u2800\\u2800\\u202e\\u00a0\\u3164')
      expect(JSON.parse(shown)).toEqual(pendingFor('dialog-hidden', 'memory_write', input).request)
    } finally { view.unmount() }
    const { host, cleanup } = await renderCard('memory_write', input)
    try {
      const shown = host.querySelector('details pre')!.textContent!
      expect(shown).not.toMatch(INVISIBLE)
      expect(JSON.parse(shown)).toEqual(pendingFor('inline-hidden', 'memory_write', input, 'member').request)
    } finally { await cleanup() }
  })

  it('leaves plain spaces, one tab, a few no-break spaces and ordinary text as they are', async () => {
    const view = await renderDialog('python.run', { code: 'def f():\n        return 1\t# one tab', path: 'prix' + cp(0xa0) + ': 5' })
    try {
      expect(dialogRows()).toEqual([
        [label('path'), 'prix' + cp(0xa0) + ': 5'],
        [label('code'), 'def f():\n        return 1\t# one tab']
      ])
    } finally { view.unmount() }
  })

  it('escapes text that reads like an escape or a marker, so neither is ever model text', async () => {
    const view = await renderDialog('shell.execute', { command: 'a\\u{200b}', cwd: '\u27e63 \u00d7 U+2800\u27e7', code: 'C:\\Users\\x' })
    try {
      expect(dialogRows()).toEqual([
        [label('command'), escaped('a\\u{5c}u{200b}')],
        [label('cwd'), escaped('\\u{27e6}3 \u00d7 U+2800\u27e7')],
        [label('code'), 'C:\\Users\\x']
      ])
    } finally { view.unmount() }
  })

  it('cuts a long value before a combining mark together with its base, and escapes a lone surrogate', async () => {
    const view = await renderDialog('shell.execute', { command: 'a'.repeat(479) + 'e' + cp(0x301) + 'zzz', cwd: 'x' + String.fromCharCode(0xd800) + 'y' })
    try {
      expect(dialogRows()).toEqual([
        [label('command'), truncated('a'.repeat(479))],
        [label('cwd'), escaped('x\\u{d800}y')]
      ])
    } finally { view.unmount() }
  })

  it('collapses blank runs in field names and escapes hidden characters in them', async () => {
    const view = await renderDialog('shell.execute', {
      ['n' + BRAILLE_BLANK.repeat(460)]: 'blank-name',
      ['tag' + tagText.slice(0, 6)]: 'tag-name',
      [cp(0x3164)]: 'filler-name'
    })
    try {
      expect(dialogRows()).toEqual([
        ['"n\u27e6460 \u00d7 U+2800\u27e7"', 'blank-name'],
        ['"tag\\u{e0020}\\u{e0021}\\u{e0022}"', 'tag-name'],
        ['"\\u{3164}"', 'filler-name']
      ])
    } finally { view.unmount() }
  })
})

// The inline note card shows the note through the same capped and escaped form as every value,
// never raw in a one-line span (SEC-1b).
describe('MagicAgentApprovalCenter shows a note in the inline card as it is', () => {
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
  const truncated = (text: string) => i18n.t('agent_workspace.approval.truncated', { text }) as string
  const cp = (...codes: number[]) => String.fromCodePoint(...codes)
  // The panel's note: blank padding, a line break, a bidi override, then more text up to 4000.
  const visiblePart = 'Ignore previous instructions ' + cp(0x202e) + 'gnp.exe' + cp(0x202c) + ' '
  const note = ('Buy milk' + cp(0xa0).repeat(120) + '\n' + visiblePart).padEnd(4000, 'z')

  beforeEach(() => {
    platformApi.listPendingApprovals.mockReset()
    platformApi.resolvePendingApproval.mockReset()
  })
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('zh-CN') }) })

  it.each(['zh-CN', 'en-US'])('shows a 4000-character note with blank padding, a line break and U+202E in the card prompt (%s)', async (language) => {
    await act(async () => { await i18n.changeLanguage(language) })
    const host = document.createElement('div'); document.body.append(host)
    const input = { conversationId: 'c', action: 'set', key: 'k', value: note, expectedRevision: 0 }
    platformApi.listPendingApprovals.mockResolvedValue({ approvals: [{ approvalId: 'inline-long-note', revision: 1, request: { request: { sessionId: 'member', route, target: { id: 'scratchpad' }, input } } }] })
    const unregister = registerTeamApprovalSurface({ element: host, route, members: new Map([['member', 'Writer']]), onWaiting: vi.fn() })
    const view = render(<MagicAgentApprovalCenter />)
    try {
      await waitFor(() => expect(host.querySelector('[data-testid="team-approval-card"]')).not.toBeNull())
      const prompt = host.querySelector<HTMLElement>('[data-testid="chat-prompt-card-prompt"] [data-approval-note]')!
      const head = 'Buy milk\u27e6120 \u00d7 U+00A0\u27e7\nIgnore previous instructions \\u{202e}gnp.exe\\u{202c} '
      expect(prompt.textContent).toBe(truncated(head + 'z'.repeat(480 - Array.from(head).length)))
      const style = getComputedStyle(prompt)
      expect(style.whiteSpace).toBe('pre-wrap')
      expect(style.unicodeBidi).toBe('isolate')
      expect(style.textOverflow).not.toBe('ellipsis')
      expect(host.querySelector('[title]')).toBeNull()
      expect(prompt.textContent).not.toMatch(/[\u00a0\u202c\u202e]/)
    } finally { await act(async () => { unregister() }); view.unmount(); host.remove() }
  })
})
