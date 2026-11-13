import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{
    id: 'vision-fixture', provider: 'openai', deployment: 'cloud', model_use: 'vision',
    model_name: 'fixture', base_url: 'https://fixture.invalid/v1', api_key: '',
    api_mode: 'chat-completions', attachment_transports: ['request-data-url']
  }] }
}
const image = { type: 'image' as const, url: 'local-media:///fixture/image.png', fileName: 'image.png', mimeType: 'image/png' }
const base = () => ({ config, profileId: 'vision-fixture', conversationId: 'fixture', messages: [{ role: 'user' as const, content: 'hello' }] })
const team = { teamMessageHop: 1 as const, teamMember: { scope: 'fixture-scope', thread: 'fixture-thread', lead: 'fixture-lead', member: 'fixture-member' } }
const withImage = () => ({ ...base(), ...team, messages: [{ role: 'user' as const, content: 'hello', attachments: [image] }] })
const installService = () => {
  const chat = vi.fn(async (_request: unknown) => ({ content: 'fixture response' }))
  const done = vi.fn()
  const chatStream = vi.fn(async (_request: unknown, response: { onData: (chunk: LLMChatStreamResp) => void }) => {
    await Promise.resolve()
    done()
    response.onData({ type: 'done', delta: '', done: true, fullContent: 'fixture response' })
  })
  vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream, cancelConversation: vi.fn() } })
  return { chat, chatStream, done }
}
const request = (streaming: boolean, input: Parameters<typeof requestChatCompletion>[0]) =>
  streaming ? requestChatCompletionStream({ ...input, onEvent: vi.fn() }) : requestChatCompletion(input)

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each([false, true])('local team dispatch callbacks, stream=%s', streaming => {
  it('forwards an opaque profile revision only to the local IPC', async () => {
    const service = installService()
    const revision = 'a'.repeat(64)
    await request(streaming, { ...base(), ...team, expectedProfileRevision: revision })
    const ipc = streaming ? service.chatStream : service.chat
    expect(ipc).toHaveBeenCalledOnce()
    expect(ipc.mock.calls[0][0]).toMatchObject({ profileId: 'vision-fixture', expectedProfileRevision: revision })
  })

  it.each(['remote', 'external-agent', 'missing-profile', 'invalid-revision'] as const)('rejects an unusable profile revision (%s) before any request', async reason => {
    const service = installService()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const externalAgentSkill = reason === 'external-agent' ? {
      id: 'fixture-agent', type: 'agent' as const, category: 'fixture', skillName: 'Fixture Agent',
      prompt: 'fixture', apiAddress: 'https://fixture.invalid/agent', apiKey: ''
    } : undefined
    await expect(request(streaming, { ...base(), config: { ...config, use_remote_llm: reason === 'remote' }, externalAgentSkill, profileId: reason === 'missing-profile' ? undefined : 'vision-fixture', expectedProfileRevision: reason === 'invalid-revision' ? 'bad' : 'a'.repeat(64) })).rejects.toThrow('Invalid local profile revision request')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
  })

  it('does not run an unpinned capability probe for a revision-bound report', async () => {
    localStorage.clear()
    const service = installService()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/manifest.json')) return { ok: true, text: async () => JSON.stringify({ version: 1, bundleId: 'fixture-report-revision', title: 'Fixture', createdAt: '2026-01-01T00:00:00.000Z', entries: [{ role: 'primary-report', fileName: 'report.md', relativePath: 'report.md' }] }) }
      if (url.endsWith('/report.md') || url.startsWith('data:text/markdown')) return { ok: true, text: async () => 'fixture report', blob: async () => new Blob(['fixture report'], { type: 'text/markdown' }) }
      throw new Error(`unexpected fixture URL ${url}`)
    }))
    const revision = 'a'.repeat(64)
    await request(streaming, { ...base(), expectedProfileRevision: revision, imageHistoryPolicy: 'all', messages: [
      { role: 'user', content: 'history', attachments: [{ type: 'file', url: 'local-media:///fixture/report.md', fileName: 'report.md', mimeType: 'text/markdown', reportBundleId: 'fixture-report-revision', reportBundleRole: 'primary-report', reportBundleRefName: 'report.md', reportBundleManifestUrl: 'local-media:///fixture/manifest.json' }] }
    ] })
    expect(service.chat).toHaveBeenCalledTimes(streaming ? 0 : 1)
    expect(service.chatStream).toHaveBeenCalledTimes(streaming ? 1 : 0)
    const ipc = streaming ? service.chatStream : service.chat
    expect(ipc.mock.calls[0][0]).toMatchObject({ expectedProfileRevision: revision })
  })

  it.each([
    { kind: 'team hop', routing: team },
    { kind: 'ordinary member', routing: { teamMember: team.teamMember } }
  ])('does not make a capability-probe request for a $kind report', async ({ routing }) => {
    localStorage.clear()
    const service = installService()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/manifest.json')) return { ok: true, text: async () => JSON.stringify({ version: 1, bundleId: 'fixture-report-member', title: 'Fixture', createdAt: '2026-01-01T00:00:00.000Z', entries: [{ role: 'primary-report', fileName: 'report.md', relativePath: 'report.md' }] }) }
      if (url.endsWith('/report.md') || url.startsWith('data:text/markdown')) return { ok: true, text: async () => 'fixture report', blob: async () => new Blob(['fixture report'], { type: 'text/markdown' }) }
      throw new Error(`unexpected fixture URL ${url}`)
    }))
    const before = vi.fn()
    await request(streaming, { ...base(), ...routing, beforeLocalDispatch: before, imageHistoryPolicy: 'all', messages: [
      { role: 'user', content: 'history', attachments: [{ type: 'file', url: 'local-media:///fixture/report.md', fileName: 'report.md', mimeType: 'text/markdown', reportBundleId: 'fixture-report-member', reportBundleRole: 'primary-report', reportBundleRefName: 'report.md', reportBundleManifestUrl: 'local-media:///fixture/manifest.json' }] }
    ] })
    expect(service.chat).toHaveBeenCalledTimes(streaming ? 0 : 1)
    expect(service.chatStream).toHaveBeenCalledTimes(streaming ? 1 : 0)
    expect(before).toHaveBeenCalledOnce()
  })

  it('does not invoke IPC or started when attachment preparation fails', async () => {
    const service = installService()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fixture preparation failed') }))
    const before = vi.fn(), started = vi.fn()
    await expect(request(streaming, { ...withImage(), beforeLocalDispatch: before, onLocalDispatch: started })).rejects.toThrow('fixture preparation failed')
    expect(before).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
  })

  it('denies IPC when the pre-dispatch gate rejects', async () => {
    const service = installService()
    const started = vi.fn(), before = vi.fn(() => { throw new Error('gate denied') })
    await expect(request(streaming, { ...base(), ...team, beforeLocalDispatch: before, onLocalDispatch: started })).rejects.toThrow('gate denied')
    expect(before).toHaveBeenCalledOnce()
    expect(started).not.toHaveBeenCalled()
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
  })

  it.each(['denied', 'aborted', 'allowed'] as const)('awaits an asynchronous pre-dispatch gate: %s', async outcome => {
    const service = installService()
    const controller = new AbortController()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = vi.fn()
    const before = vi.fn(async () => {
      enter()
      await gate
      if (outcome === 'denied') throw new Error('async gate denied')
    })
    const pending = request(streaming, { ...base(), ...team, signal: controller.signal, beforeLocalDispatch: before, onLocalDispatch: started })
    await entered
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    if (outcome === 'aborted') controller.abort()
    release()
    if (outcome === 'denied') await expect(pending).rejects.toThrow('async gate denied')
    else if (outcome === 'aborted') await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    else await expect(pending).resolves.toBeDefined()
    expect(service.chat).toHaveBeenCalledTimes(outcome === 'allowed' && !streaming ? 1 : 0)
    expect(service.chatStream).toHaveBeenCalledTimes(outcome === 'allowed' && streaming ? 1 : 0)
    expect(started).toHaveBeenCalledTimes(outcome === 'allowed' ? 1 : 0)
  })

  it('aborts promptly while the asynchronous gate remains unresolved and never invokes IPC', async () => {
    const service = installService()
    const controller = new AbortController()
    let entered!: () => void, release!: () => void
    const startedGate = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const before = vi.fn(async () => { entered(); await held })
    const started = vi.fn()
    const pending = request(streaming, { ...base(), ...team, signal: controller.signal, beforeLocalDispatch: before, onLocalDispatch: started })
    await startedGate
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    release()
    await Promise.resolve()
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
  })

  it('notifies once after IPC invocation without serializing callbacks; observer failure is isolated', async () => {
    const service = installService()
    const before = vi.fn(), started = vi.fn(() => { throw new Error('observer failed') })
    const result = await request(streaming, { ...base(), ...team, beforeLocalDispatch: before, onLocalDispatch: started })
    const ipc = streaming ? service.chatStream : service.chat
    expect(ipc).toHaveBeenCalledOnce()
    expect(before).toHaveBeenCalledOnce()
    expect(started).toHaveBeenCalledOnce()
    expect(before.mock.invocationCallOrder[0]).toBeLessThan(ipc.mock.invocationCallOrder[0])
    expect(ipc.mock.invocationCallOrder[0]).toBeLessThan(started.mock.invocationCallOrder[0])
    const payload = ipc.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('beforeLocalDispatch')
    expect(payload).not.toHaveProperty('onLocalDispatch')
    expect(JSON.stringify(payload)).not.toContain('onLocalDispatch')
    if (streaming) expect(started.mock.invocationCallOrder[0]).toBeLessThan(service.done.mock.invocationCallOrder[0])
    expect(payload).toMatchObject(team)
    expect(result).toBeDefined()
  })

  it.each([true, false])('report history: team hop=%s preserves probe semantics and does not start before preparation', async teamHop => {
    localStorage.clear()
    const service = installService()
    service.chat.mockResolvedValue({ content: '15000' })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const seen = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/manifest.json')) {
        entered(); await gate
        return { ok: true, text: async () => JSON.stringify({ version: 1, bundleId: 'fixture-report', title: 'Fixture', createdAt: '2026-01-01T00:00:00.000Z', entries: [{ role: 'primary-report', fileName: 'report.md', relativePath: 'report.md' }] }) }
      }
      if (url.endsWith('/report.md') || url.startsWith('data:text/markdown')) return { ok: true, text: async () => 'fixture report', blob: async () => new Blob(['fixture report'], { type: 'text/markdown' }) }
      throw new Error(`unexpected fixture URL ${url}`)
    }))
    const started = vi.fn(), before = vi.fn()
    const pending = request(streaming, { ...base(), imageHistoryPolicy: 'all', ...(teamHop ? team : {}), beforeLocalDispatch: before, onLocalDispatch: started, messages: [
      { role: 'user', content: 'history', attachments: [{ type: 'file', url: 'local-media:///fixture/report.md', fileName: 'report.md', mimeType: 'text/markdown', reportBundleId: 'fixture-report', reportBundleRole: 'primary-report', reportBundleRefName: 'report.md', reportBundleManifestUrl: 'local-media:///fixture/manifest.json' }] },
      { role: 'user', content: 'next request' }
    ] })
    await seen
    expect(started).not.toHaveBeenCalled()
    expect(before).not.toHaveBeenCalled()
    expect(service.chat).toHaveBeenCalledTimes(teamHop ? 0 : 1)
    release()
    await pending
    expect(before).toHaveBeenCalledOnce()
    expect(started).toHaveBeenCalledOnce()
    expect(service.chat).toHaveBeenCalledTimes(teamHop ? (streaming ? 0 : 1) : (streaming ? 1 : 2))
    expect(service.chatStream).toHaveBeenCalledTimes(streaming ? 1 : 0)
  })

  it.each(['remote', 'external-agent'])('rejects team hops over %s with zero requests', async transport => {
    const service = installService()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const started = vi.fn()
    const externalAgentSkill = transport === 'external-agent' ? {
      id: 'fixture-agent', type: 'agent' as const, category: 'fixture', skillName: 'Fixture Agent',
      prompt: 'fixture', apiAddress: 'https://fixture.invalid/agent', apiKey: ''
    } : undefined
    await expect(request(streaming, {
      ...base(), config: { ...config, use_remote_llm: transport === 'remote' },
      ...team, externalAgentSkill, onLocalDispatch: started
    })).rejects.toThrow('Team messages require local transport')
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
  })

  it.each(['end', 'scope change'])('rechecks the gate after delayed preparation on %s', async change => {
    const service = installService()
    let release!: (response: Response) => void
    let entered!: () => void
    const enteredFetch = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(() => { entered(); return new Promise<Response>(resolve => { release = resolve }) }))
    let active = true
    const before = vi.fn(() => { if (!active) throw new Error('no longer current') })
    const started = vi.fn()
    const pending = request(streaming, { ...withImage(), beforeLocalDispatch: before, onLocalDispatch: started })
    await enteredFetch
    expect(before).not.toHaveBeenCalled()
    active = false
    release(new Response(new Blob(['fixture-image'], { type: 'image/png' }), { status: 200 }))
    await expect(pending).rejects.toThrow('no longer current')
    expect(before).toHaveBeenCalledOnce()
    expect(started).not.toHaveBeenCalled()
    expect(service.chat).not.toHaveBeenCalled()
    expect(service.chatStream).not.toHaveBeenCalled()
  })
})
