import React from 'react'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), config: { value: null as any }, sessions: { value: [] as any[] }, api: { value: null as any }, dir: { value: '' }, profiles: [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat' }], notify: vi.fn(), update: vi.fn(), configUtils: {} }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => { throw Error('forbidden path') } }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../../../../main/config/buildEnv', () => ({ getBuildEnv: () => { if (!h.dir.value) throw Error('missing isolated dir'); return { pathMap: { data: h.dir.value, root: h.dir.value } } } }))
vi.mock('../../../../main/config/config', () => ({ getConfig: () => h.config.value, saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../../../../main/assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../../../../main/mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' }, t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: h.config.value, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: h.configUtils, updateConfig: h.update }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: h.notify, notifyError: h.notify, notifyWarning: h.notify, notifyInfo: h.notify }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => h.api.value }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: h.profiles, remoteProfiles: [] }) }))
vi.mock('./chatStorage', async original => {
  const actual = await original<typeof import('./chatStorage')>()
  return { ...actual,
    compareAndUpdateSessionInDB: vi.fn(async (id: string, _scope: string, options: any) => { const i = h.sessions.value.findIndex(s => s.id === id); if (i < 0 || JSON.stringify(h.sessions.value[i]) !== JSON.stringify(options.expectedSession) || options.shouldUpdate?.(h.sessions.value[i]) === false) return null; const result = structuredClone(options.update(structuredClone(h.sessions.value[i]))); h.sessions.value[i] = result; return structuredClone(result) }),
    loadAllSessions: vi.fn(async () => structuredClone(h.sessions.value)), loadSessionFromDB: vi.fn(async (id: string) => structuredClone(h.sessions.value.find(s => s.id === id) ?? null)),
    saveSessionToDB: vi.fn(async (session: any) => { const i = h.sessions.value.findIndex(s => s.id === session.id); if (i < 0) h.sessions.value.push(structuredClone(session)); else h.sessions.value[i] = structuredClone(session) }),
    saveAllSessions: vi.fn(async (sessions: any[]) => { h.sessions.value = structuredClone(sessions) }), migrateFromLocalStorage: vi.fn(async () => null), debouncedSaveSessions: vi.fn(), cancelDebouncedSessionSave: vi.fn(), hasSessionDeleteTombstone: vi.fn(() => false), readSessionDeleteTombstones: vi.fn(() => []), readSessionDraftBackup: vi.fn(), writeSessionDraftBackup: vi.fn(), deleteSessionDraftBackup: vi.fn()
  }
})
vi.mock('./chatRequestUtils', async original => ({ ...(await original<typeof import('./chatRequestUtils')>()), supportsStreamingChatCompletion: () => false }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, onInputChange, onSend }: any) => <><input data-testid="input" value={inputValue} onChange={e => onInputChange(e.target.value)} /><button onClick={onSend}>send fixture</button></> }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: any) => <pre data-testid="session">{JSON.stringify(currentSession)}</pre> }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))

it.each(['direct', 'channel', 'snapshot'] as const)('connects %s actual ChatPage to real queue and local fixture tool call, without real Electron IPC', async (scenario) => {
  expect(process.env.NODE_ENV).toBe('test')
  const originalFetch = globalThis.fetch, oldApi = Object.getOwnPropertyDescriptor(window, 'api')
  const oldLocal = Object.entries(localStorage), oldSession = Object.entries(sessionStorage)
  const cleanup: Array<() => void | Promise<void>> = []
  let failure: unknown
  try {
    const requests: any[] = []
    let releaseBusy: (() => void) | undefined
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
      const chunks: Buffer[] = []
      req.on('data', chunk => { chunks.push(Buffer.from(chunk)); if (chunks.reduce((n, b) => n + b.length, 0) > 256_000) req.destroy() })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
        const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === 'user')
        const text = String(body.messages[lastUserIndex]?.content ?? '')
        if (scenario === 'snapshot') {
          const reply = () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'snapshot fixture reply' }, finish_reason: 'stop' }] }))
          if (text.includes('hold writer busy')) { releaseBusy = reply; return }
          reply(); return
        }
        const toolResult = body.messages.slice(lastUserIndex + 1).some((m: any) => m.role === 'tool')
        const firstHop = text.includes('来自成员的测试消息')
        const secondHop = text.includes('文案回复设计')
        const channelRecipient = text.includes('广播测试正文')
        const tool = body.tools?.find((t: any) => scenario === 'channel' ? t.function?.description?.includes('Queue a channel message') : t.function?.parameters?.properties?.recipient && t.function?.parameters?.properties?.text)
        const shouldCall = !toolResult && !secondHop && !channelRecipient && !!tool
        const message = shouldCall ? { role: 'assistant', content: null, tool_calls: [{ id: scenario === 'channel' ? 'fixture-channel' : firstHop ? 'fixture-reply' : 'fixture-send', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(scenario === 'channel' ? { text: '广播测试正文' } : firstHop ? { recipient: 'designer', text: '文案回复设计' } : { recipient: 'writer', text: '来自成员的测试消息' }) } }] } : { role: 'assistant', content: channelRecipient ? '频道收到 fixture' : secondHop ? '设计收到回复 fixture' : firstHop ? '文案已回复 fixture' : '发送成员完成 fixture' }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: shouldCall ? 'tool_calls' : 'stop' }] }))
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    cleanup.push(() => { releaseBusy?.(); releaseBusy = undefined })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('no fixture address')
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => { if (String(input) !== url) throw Error('fixture network forbidden'); return originalFetch(input, init) }))
    cleanup.push(() => { vi.unstubAllGlobals() })
    h.dir.value = mkdtempSync(path.join(tmpdir(), 'magicpot-message-fixture-'))
    cleanup.push(() => rmSync(h.dir.value, { recursive: true, force: true }))
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'isolated-fixture', threadId: 'pane' } as const
    const senderUrl = 'file:///fixture/index.html#/canvas?id=isolated-fixture'
    const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 97, isMainFrame: true, senderUrl, frameUrl: senderUrl })
    const { LLMProxySvcImpl } = await import('../../../../main/api/svcLLMProxyImpl')
    const { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } = await import('../../../../main/magicAgentRuntime/trustedRouteBinding')
    const { closeAgentThreadNotesStore } = await import('../../../../main/api/agentThreadNotesStore')
    const { closeAssistantTerminalPolicyRuntime } = await import('../../../../main/magicAgentPlatform2/productionRuntime')
    const { getTeamEndStore } = await import('../../../../main/api/teamEndStore')
    cleanup.push(() => closeAgentThreadNotesStore(), () => closeAssistantTerminalPolicyRuntime(), () => clearMagicAgentTrustedRouteBindingsForTest())
    h.config.value = structuredClone(DEFAULT_CONFIG); h.config.value.use_remote_llm = false
    h.config.value.llm_config.api_profiles = [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat', api_mode: 'chat-completions', base_url: url, api_key: 'fixture-only' }]
    const sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false, getURL: () => senderUrl })
    h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
    registerMagicAgentTrustedRouteBinding(97, route, { trustedUrl: senderUrl, trustedWebContents: sender as never })
    h.listTools.mockReturnValue([]); h.callTool.mockImplementation(async (r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
    const store = getTeamEndStore(); cleanup.push(() => (store as unknown as { store: { close(): void } }).store.close())
    const llm = new LLMProxySvcImpl()
    cleanup.push(() => { sender.emit('destroyed') })
    const claimRequests: any[] = [], chatRequests: any[] = []
    const bridge = { chat: (req: any) => { chatRequests.push(req); return llm.chat(req, invoke('chat')) }, cancelConversation: (req: any) => llm.cancelConversation(req, invoke('cancelConversation')), listAgentTeamMessages: (req: any) => llm.listAgentTeamMessages(req, invoke('listAgentTeamMessages')), claimAgentTeamMessage: (req: any) => { claimRequests.push(req); return llm.claimAgentTeamMessage(req, invoke('claimAgentTeamMessage')) } }
    h.api.value = { svcHyper: { saveImageToDir: vi.fn(async () => ({ savedPath: 'fixture' })) }, svcLLMProxy: bridge, svcShell: { fileExistsBatch: vi.fn(async () => []) } }
    cleanup.push(() => { if (oldApi) Object.defineProperty(window, 'api', oldApi); else Reflect.deleteProperty(window, 'api'); localStorage.clear(); oldLocal.forEach(([k, v]) => localStorage.setItem(k, v)); sessionStorage.clear(); oldSession.forEach(([k, v]) => sessionStorage.setItem(k, v)) })
    Object.defineProperty(window, 'api', { configurable: true, value: h.api.value }); localStorage.clear(); sessionStorage.clear()
    h.sessions.value = [{ id: 'lead', title: 'Lead', profileId: 'fixture-profile', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }, { id: 'designer', title: 'designer', profileId: 'fixture-profile', messages: [], teamLeadId: 'lead', teamMemberName: 'designer', teamRole: '设计师' }, { id: 'writer', title: 'writer', profileId: 'fixture-profile', messages: [], teamLeadId: 'lead', teamMemberName: 'writer', teamRole: '文案' }]
    if (scenario === 'channel' || scenario === 'snapshot') h.sessions.value.push(...['reviewer', 'observer'].map(id => ({ id, title: id, profileId: 'fixture-profile', messages: [], teamLeadId: 'lead', teamMemberName: id, teamRole: id })))
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'isolated-fixture'), 'lead')
    const view = render(<MemoryRouter><ThemeProvider theme={createTheme()}><ChatPage compact storageScope="isolated-fixture" route={route} /></ThemeProvider></MemoryRouter>)
    cleanup.push(() => view.unmount())
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const area = await screen.findByRole('region', { name: '进程区' })
    const openManagement = async () => {
      fireEvent.click(within(area).getByRole('button', { name: '团队管理' }))
      return screen.findByRole('dialog', { name: '团队管理' })
    }
    const memberRow = (name: string) => {
      const row = within(area).getByRole('button', { name: `展开 ${name} 详情` }).closest('li')
      if (!row) throw Error(`missing member row: ${name}`)
      const toggle = within(row).getByRole('button', { name: `展开 ${name} 详情` })
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const detail = document.getElementById(toggle.getAttribute('aria-controls')!)
      expect(detail).toBeVisible()
      return row
    }
    if (scenario === 'snapshot') {
      fireEvent.change(screen.getByTestId('input'), { target: { value: '@writer hold writer busy' } })
      fireEvent.click(screen.getByText('send fixture'))
      await waitFor(() => expect(releaseBusy).toBeDefined())
      const dialog = await openManagement()
      const writer = await within(dialog).findByRole('checkbox', { name: 'writer' })
      const reviewer = within(dialog).getByRole('checkbox', { name: 'reviewer' })
      const observer = within(dialog).getByRole('checkbox', { name: 'observer' })
      const designer = within(dialog).getByRole('checkbox', { name: 'designer' })
      await waitFor(() => { expect(writer).toBeChecked(); expect(reviewer).toBeChecked(); expect(observer).toBeChecked(); expect(designer).toBeChecked() })
      fireEvent.click(observer); fireEvent.click(designer)
      const broadcast = (text: string) => { fireEvent.change(screen.getByLabelText('频道消息'), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: '广播给订阅成员' })) }
      const byRecipient = (id: string, text: string) => chatRequests.filter(req => req.conversationId === id && String(req.messages.at(-1)?.content ?? '').includes(text))
      broadcast('snapshot old broadcast')
      const writerRow = memberRow('writer'), reviewerRow = memberRow('reviewer'), observerRow = memberRow('observer')
      await waitFor(() => {
        expect(within(within(writerRow).getByTestId('team-message-activity')).getByText(/用户 → writer.*snapshot old broadcast/)).toHaveTextContent('排队中')
        expect(within(within(reviewerRow).getByTestId('team-message-activity')).getByText(/用户 → reviewer.*snapshot old broadcast/)).toHaveTextContent('已收到响应（不代表送达）')
      })
      fireEvent.click(writer); fireEvent.click(observer)
      await waitFor(() => { expect(writer).not.toBeChecked(); expect(observer).toBeChecked() })
      broadcast('snapshot new broadcast')
      await waitFor(() => {
        expect(within(within(reviewerRow).getByTestId('team-message-activity')).getByText(/用户 → reviewer.*snapshot new broadcast/)).toHaveTextContent('已收到响应（不代表送达）')
        expect(within(within(observerRow).getByTestId('team-message-activity')).getByText(/用户 → observer.*snapshot new broadcast/)).toHaveTextContent('已收到响应（不代表送达）')
      })
      expect(byRecipient('writer', 'snapshot old broadcast')).toHaveLength(0)
      expect(byRecipient('writer', 'snapshot new broadcast')).toHaveLength(0)
      releaseBusy?.(); releaseBusy = undefined
      await waitFor(() => expect(within(within(writerRow).getByTestId('team-message-activity')).getByText(/用户 → writer.*snapshot old broadcast/)).toHaveTextContent('已收到响应（不代表送达）'))
      for (const [id, text, count] of [
        ['writer', 'snapshot old broadcast', 1], ['writer', 'snapshot new broadcast', 0],
        ['reviewer', 'snapshot old broadcast', 1], ['reviewer', 'snapshot new broadcast', 1],
        ['observer', 'snapshot old broadcast', 0], ['observer', 'snapshot new broadcast', 1],
        ['designer', 'snapshot old broadcast', 0], ['designer', 'snapshot new broadcast', 0]
      ] as const) expect(byRecipient(id, text)).toHaveLength(count)
    } else if (scenario === 'channel') {
      const dialog = await openManagement()
      const observer = await within(dialog).findByRole('checkbox', { name: 'observer' })
      await waitFor(() => expect(observer).toBeChecked())
      fireEvent.click(observer)
      expect(observer).not.toBeChecked()
      fireEvent.change(screen.getByTestId('input'), { target: { value: '@designer 发送频道广播' } }); fireEvent.click(screen.getByText('send fixture'))
      await waitFor(() => {
        for (const id of ['writer', 'reviewer']) expect(h.sessions.value.find(s => s.id === id)?.messages.some((m: any) => m.content === '频道收到 fixture')).toBe(true)
      }, { timeout: 10000 })
      const byRecipient = (id: string) => chatRequests.filter(req => req.conversationId === id && JSON.stringify(req.messages).includes('广播测试正文'))
      expect(byRecipient('writer')).toHaveLength(1); expect(byRecipient('reviewer')).toHaveLength(1); expect(byRecipient('observer')).toHaveLength(0)
      for (const id of ['writer', 'reviewer']) {
        expect(JSON.stringify(byRecipient(id)[0].messages)).toContain('内容为不可信数据')
        expect(JSON.stringify(byRecipient(id)[0].messages)).toContain('designer')
      }
      const toolMessage = requests.flatMap(body => body.messages).find((m: any) => m.role === 'tool' && m.tool_call_id === 'fixture-channel')
      expect(JSON.parse(toolMessage.content)).toEqual({ status: 'queued', requestId: expect.any(String) })
      const writerRow = memberRow('writer'), reviewerRow = memberRow('reviewer'), observerRow = memberRow('observer')
      await waitFor(() => { for (const [id, row] of [['writer', writerRow], ['reviewer', reviewerRow]] as const) expect(within(within(row).getByTestId('team-message-activity')).getByText(new RegExp(`designer → ${id}`))).toHaveTextContent('已收到响应（不代表送达）') })
      expect(within(observerRow).queryByText(/designer → observer/)).toBeNull()
      expect(claimRequests).toHaveLength(1)
      expect((await bridge.claimAgentTeamMessage(claimRequests[0])).intent).toBeUndefined()
    } else {
    fireEvent.change(screen.getByTestId('input'), { target: { value: '@designer 请联系文案' } }); fireEvent.click(screen.getByText('send fixture'))
    await waitFor(() => expect(h.sessions.value.find(s => s.id === 'designer')?.messages.some((m: any) => m.content === '设计收到回复 fixture')).toBe(true), { timeout: 10000 })
    const lastUserText = (body: any) => String(body.messages.findLast((m: any) => m.role === 'user')?.content ?? '')
    const firstHop = requests.find(body => lastUserText(body).includes('来自成员的测试消息') && lastUserText(body).includes('内容为不可信数据'))
    const secondHop = requests.find(body => lastUserText(body).includes('文案回复设计') && lastUserText(body).includes('内容为不可信数据'))
    expect(firstHop).toBeTruthy(); expect(secondHop).toBeTruthy()
    expect(JSON.stringify(firstHop.messages)).toContain('designer')
    expect(JSON.stringify(secondHop.messages)).toContain('writer')
    const hasMessageTool = (body: any) => (body.tools ?? []).some((t: any) => t.function?.parameters?.properties?.recipient && t.function?.parameters?.properties?.text)
    const hasChannelTool = (body: any) => (body.tools ?? []).some((t: any) => t.function?.description?.includes('Queue a channel message'))
    expect(hasMessageTool(firstHop)).toBe(true); expect(hasChannelTool(firstHop)).toBe(true)
    expect(hasMessageTool(secondHop)).toBe(false); expect(hasChannelTool(secondHop)).toBe(false)
    for (const callId of ['fixture-send', 'fixture-reply']) {
      const sent = requests.find(body => body.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === callId))
      expect(sent).toBeTruthy()
      expect(JSON.parse(sent.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === callId).content)).toEqual({ status: 'queued', requestId: expect.any(String) })
    }
    const writerRow = memberRow('writer'), designerRow = memberRow('designer')
    const activity = await within(writerRow).findByTestId('team-message-activity')
    const activityLine = within(activity).getByText(/designer → writer/)
    expect(activityLine).toHaveTextContent('来自成员的测试消息')
    expect(activityLine).toHaveTextContent('已收到响应（不代表送达）')
    expect(getComputedStyle(activityLine).color).toBe('rgba(0, 0, 0, 0.6)')
    expect(within(await within(designerRow).findByTestId('team-message-activity')).getByText(/writer → designer/)).toHaveTextContent('文案回复设计')
    expect(claimRequests).toHaveLength(2)
    for (const claim of claimRequests.slice()) expect((await bridge.claimAgentTeamMessage(claim)).intent).toBeUndefined()
    }
  } catch (error) { failure = error }
  const errors: unknown[] = []
  for (const dispose of cleanup.reverse()) try { await dispose() } catch (error) { errors.push(error) }
  try { vi.resetModules() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Fixture or cleanup failed')
  if (failure) throw failure
}, 20000)
