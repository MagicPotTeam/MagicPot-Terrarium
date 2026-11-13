import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({
  data: '', fromId: vi.fn(), parent: vi.fn(), fetch: vi.fn(), handle: vi.fn(), invoke: vi.fn(),
  runtime: undefined as import('../assistantRuntime/runtime').AssistantRuntime | undefined
}))
vi.mock('electron', () => ({ ipcMain: { handle: h.handle, on: vi.fn() }, ipcRenderer: { invoke: h.invoke }, MessagePortMain: class {}, net: {}, app: { getPath: () => h.data, getAppPath: () => process.cwd(), isReady: () => true }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ ...DEFAULT_BUILD_ENV, pathMap: { data: h.data, file: h.data, resources: '' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))

import { projectNativeToolTurns } from '@shared/llm/nativeTools'
import type { LLMChatParams, LLMChatResult } from '@shared/llm/types'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { llmProxySvcDef, type LLMChatStreamResp, type LLMChatReq, type LLMChatResp } from '@shared/api/svcLLMProxy'
import { registerIpcServer } from '@shared/api/createServer/registerIpcServer'
import { createIpcClient } from '@shared/api/createClient/createIpcClient'
import { IpcServiceError } from '@shared/api/apiUtils/unaryIpcResult'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import * as runtimeModule from '../assistantRuntime/runtime'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { ensureAssistantWorkspaceState } from '../assistantRuntime/workspace'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { getAssistantTerminalPolicyRuntime, closeAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { stopMcpClientManager } from '../mcp/runtime'
import { stopMagicPotMcpPlatformRuntime } from '../mcp/platform/runtime'
import { TOOL_AUDIT_STREAM_ID } from '../magicAgentPlatform2/toolHost/auditSink'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'file-edit-project', threadId: 'pane' } as const
const scope = { route, conversationId: 'file-edit-chat' }
const url = 'file:///D:/owned/app/index.html#/canvas?id=file-edit-project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 96, frameUrl: url, senderUrl: url, isMainFrame: true })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let sender: EventEmitter, root: string, store: AssistantSessionStore, service: LLMProxySvcImpl

beforeEach(async () => {
  h.data = await fs.realpath(await createNodeTestArtifactDir('proxy-file-edit'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.mcp_config.client.servers = []
  config.llm_config.api_profiles = [{ id: 'agent-profile', model_name: 'Agent Model', base_url: 'https://model.example/v1', api_key: 'not-used' }]
  vi.mocked(getConfig).mockReturnValue(config)
  vi.stubEnv('MAGICPOT_MCP_STDIO_SERVER', '')
  h.fetch.mockReset().mockRejectedValue(Error('This fixture must not use the network.'))
  vi.stubGlobal('fetch', h.fetch)
  sender = Object.assign(new EventEmitter(), { id: 96, isDestroyed: () => false, getURL: () => url })
  registerMagicAgentTrustedRouteBinding(96, route, { trustedUrl: url, trustedWebContents: sender as never })
  h.fromId.mockReturnValue(sender)
  h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  store = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
  h.runtime = new AssistantRuntime({ sessionStore: store, configProvider: getConfig, chatService: { chat: vi.fn() } })
  // Install after the runtime/proxy cycle has evaluated. An async partial mock's
  // importOriginal can let the proxy capture the real singleton during that cycle.
  vi.spyOn(runtimeModule, 'getAssistantRuntime').mockReturnValue(h.runtime)
  root = await fs.realpath((await ensureAssistantWorkspaceState(route)).workspaceRootDir)
  // Only the registry's test auto-grant branch is disabled. The real production
  // policy/coordinator was initialized in test mode and retains its isolated memory DB.
  getAssistantTerminalPolicyRuntime()
  vi.stubEnv('NODE_ENV', 'production')
  service = new LLMProxySvcImpl()
})
afterEach(async () => {
  sender?.emit('did-start-navigation')
  closeAssistantTerminalPolicyRuntime()
  await service?.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
  await h.runtime?.flush()
  await stopMcpClientManager()
  await stopMagicPotMcpPlatformRuntime()
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  h.runtime = undefined
  await fs.rm(h.data, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('file edit via existing thread, actual runtime/kernel/registry/host and formal approval (model/window stubs)', () => {
  it.each(
    (['chat', 'chatStream'] as const).flatMap(method =>
      [false, true].flatMap(native =>
        (['ask_user', 'show_card'] as const).flatMap(name =>
          [false, true].flatMap(alias =>
            (name === 'show_card' ? [false, true] : [false]).flatMap(withFields =>
              (name === 'show_card' ? [false, true] : [false]).flatMap(withSubtitle =>
                (name === 'show_card' ? [1, 2] : [0]).flatMap(actionCount =>
                  (name === 'show_card' ? [false, true] : [false]).flatMap(withFooter =>
                    (name === 'show_card' ? [false, true] : [false]).flatMap(withAccent =>
                      (name === 'show_card' ? [false, true] : [false]).flatMap(withActionStyle =>
                        (name === 'show_card' ? [false, true] : [false]).flatMap(withIcon =>
                          (name === 'show_card' ? [false, true] : [false]).map(withBody =>
                            ({ method, native, name, alias, withFields, withSubtitle, actionCount, withFooter, withAccent, withActionStyle, withIcon, withBody })
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )(
    'reads an interaction manual passively, still waits for $method native=$native tool=$name timeout_s=$alias fields=$withFields subtitle=$withSubtitle actions=$actionCount footer=$withFooter accent=$withAccent style=$withActionStyle icon=$withIcon body=$withBody and never turns its answer into edit approval', async ({ method, native, name, alias, withFields, withSubtitle, actionCount, withFooter, withAccent, withActionStyle, withIcon, withBody }) => {
      const before = 'original\n', file = path.join(root, 'interaction-feedback-not-approval.txt')
      await fs.writeFile(file, before)
      const edit = { path: 'interaction-feedback-not-approval.txt', expectedSha256: hash(before), replacements: [{ old: 'original', new: 'changed', expectedOccurrences: 1 }] }
      const fields = [{ label: 'Status', value: 'Read-only context, not authorization', inline: true }, { label: 'Next', value: 'A file edit requires separate formal approval', inline: false }]
      const body = '**Review only**\n\nBearer a**RAW_PROXY_SUFFIX**\n\n[Not authorization](https://external.invalid/no-open)\n\n- [x] No approval'
      const input = { ...(name === 'ask_user' ? { question: 'Reply for conversation only; not edit authorization.' } : { title: 'Conversation feedback only', ...(withBody ? { body } : {}), ...(withIcon ? { icon: '✓👩🏽‍💻' } : {}), actions: [{ id: 'approve', label: 'Feedback yes (not authorization)', ...(withActionStyle ? { style: 'primary' } : {}) }, { id: 'no', label: 'Feedback no', ...(withActionStyle ? { style: 'danger' } : {}) }].slice(0, actionCount) }), ...(alias ? { timeout_s: 17 } : {}), ...(withFields ? { fields } : {}), ...(withSubtitle ? { subtitle: 'Smaller context, never authorization for this edit' } : {}), ...(withFooter ? { footer: 'Closing context, never authorization for this edit' } : {}), ...(withAccent ? { accent: 'success' } : {}) }
      const answer = name === 'ask_user' ? { status: 'answered' as const, text: 'approve' } : { status: 'answered' as const, actionId: 'approve' }
      const script = [{ name: 'info', args: { name } }, { name, args: input }, { name: 'files.edit', args: edit }]
      const policy = getAssistantTerminalPolicyRuntime(), runtimeCalls = vi.spyOn(h.runtime!, 'callTool')
      const chat = vi.fn(async (params: LLMChatParams): Promise<LLMChatResult | string> => {
        const step = chat.mock.calls.length - 1
        expect(step).toBeLessThan(3)
        expect(await fs.readFile(file, 'utf8')).toBe(before)
        expect(policy.listPendingTerminalApprovals()).toEqual([])
        expect((await service.listAgentInteractions(scope, invoke('listAgentInteractions'))).interactions).toEqual([])
        expect(await fs.stat(path.join(root, '.magicpot', 'tool-host', 'snapshots')).then(() => true, () => false)).toBe(false)
        if (step > 0) {
          const raw = String(native ? params.toolTurns?.at(-1)?.results[0]?.output : params.messages.at(-1)?.content)
          if (!native) expect(raw).toMatch(/^\[Tool Result\]\ntoolName: /)
          const output = JSON.parse(native ? raw : raw.slice(raw.indexOf('\n\n') + 2))
          if (step === 1) expect(output).toMatchObject({ name, grantsPermission: false, documentation: { contract: 'magicpot-local-interaction-manual/v1', name, documentationOnly: true, grantsPermission: false, authority: { readingUnlocksTool: false, answersGrantPermission: false }, ...(alias ? { timeout: { alias: 'timeout_s', mutuallyExclusive: true } } : {}) } })
          else expect(output).toEqual(answer)
          if (step === 1 && withBody) {
            expect(output.documentation.behavior.bodyMarkdown).toContain('formatting-only Markdown')
            expect(output.documentation.behavior.bodyMarkdown).toContain('no links, no images, no task controls')
            expect(Buffer.byteLength(JSON.stringify(output.documentation), 'utf8')).toBeLessThan(10000)
          }
          if (step === 1 && withIcon) {
            expect(output.documentation.limits).toMatchObject({ iconSchemaCharacters: 64, iconUtf16Units: 64 })
            expect(output.documentation.behavior.historyDisplay).toContain('decorative')
            expect(output.documentation.behavior.choices).toContain('No field values, footer, accent, icon or permission extras')
          }
          if (step === 1 && withActionStyle) {
            expect(output.documentation.limits).toMatchObject({ actionStyles: ['primary', 'secondary', 'danger'] })
            expect(output.documentation.behavior.choices).toContain('never approval')
          }
          if (step === 1 && withAccent) {
            expect(output.documentation.limits).toMatchObject({ accents: ['primary', 'info', 'success', 'warning', 'danger', 'neutral'] })
            expect(output.documentation.behavior.input).toContain('never means business success, tool outcome')
          }
          if (step === 1 && withFooter) {
            expect(output.documentation.limits).toMatchObject({ footerSchemaCharacters: 200, footerUtf16Units: 200 })
            expect(output.documentation.behavior.input).toContain('read-only context, never an input value or answer')
          }
          if (step === 1 && actionCount === 1) {
            expect(output.documentation.limits).toMatchObject({ minimumInteractiveActions: 1, maximumActions: 4 })
            expect(output.documentation.behavior.choices).toContain('One action still waits for an explicit click')
          }
        }
        const call = script[step]
        if (!native) return JSON.stringify({ toolName: call.name, args: call.args })
        const index = params.tools!.findIndex(tool => tool.name === call.name)
        expect(index).toBeGreaterThanOrEqual(0)
        if (alias && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { timeout_s: { type: 'integer', minimum: 1, maximum: 600 } } })
        if (withBody && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { body: { type: 'string', maxLength: 4000 } } })
        if (withIcon && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { icon: { type: 'string', maxLength: 64 } } })
        if (withActionStyle && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { actions: { items: { properties: { style: { type: 'string', enum: ['primary', 'secondary', 'danger'] } } } } } })
        if (withAccent && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { accent: { type: 'string', enum: ['primary', 'info', 'success', 'warning', 'danger', 'neutral'] } } })
        if (withFooter && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { footer: { type: 'string', maxLength: 200 } } })
        if (withSubtitle && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { subtitle: { type: 'string', maxLength: 200 } } })
        if (withFields && step === 1) expect(params.tools!.at(index)!.inputSchema).toMatchObject({ properties: { fields: { type: 'array', maxItems: 8, items: { required: ['label', 'value'] } } } })
        return { content: '', toolCalls: [{ id: `manual-feedback-${step}`, name: call.name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(call.args) }] }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const onData = vi.fn<(event: LLMChatStreamResp) => void>(), request: LLMChatReq = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'Read the local interaction manual, collect conversational feedback, then submit the exact edit for separate formal approval.' }] }
      const pending = (method === 'chat' ? service.chat(request, invoke(method)) : service.chatStream(request, { onData }, invoke(method))).then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      let promptId = ''
      const startedAt = Date.now()
      await vi.waitFor(async () => {
        const prompts = (await service.listAgentInteractions(scope, invoke('listAgentInteractions'))).interactions
        expect(prompts).toHaveLength(1)
        expect(prompts[0].prompt.kind).toBe(name)
        if (actionCount === 1) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', actions: [{ id: 'approve', label: 'Feedback yes (not authorization)' }] })
        if (withBody) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', body })
        if (withIcon) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', icon: '✓👩🏽‍💻' })
        if (withActionStyle) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', actions: actionCount === 1 ? [{ id: 'approve', style: 'primary' }] : [{ id: 'approve', style: 'primary' }, { id: 'no', style: 'danger' }] })
        if (withAccent) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', accent: 'success' })
        if (withFooter) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', footer: input.footer })
        if (withSubtitle) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', subtitle: input.subtitle })
        if (withFields) expect(prompts[0].prompt).toMatchObject({ kind: 'show_card', fields })
        if (alias) {
          expect(prompts[0].expiresAt).toBeGreaterThanOrEqual(startedAt + 17000)
          expect(prompts[0].expiresAt).toBeLessThanOrEqual(Date.now() + 17000)
        }
        promptId = prompts[0].id
      })
      expect(chat).toHaveBeenCalledTimes(2)
      expect(runtimeCalls.mock.calls.map(call => call[1])).toEqual(['info', name])
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      if (withFields || withSubtitle || actionCount === 1 || withFooter || withAccent || withActionStyle || withIcon || withBody) {
        await expect(service.resolveAgentInteraction({ ...scope, conversationId: 'foreign-conversation', interactionId: promptId, answer }, invoke('resolveAgentInteraction'))).rejects.toThrow('not active')
        await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, values: { approved: true } } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
        if (withBody) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, body } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
        if (withIcon) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, icon: '✓' } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
        if (withActionStyle) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, style: 'primary' } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
        if (withAccent) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, accent: 'success' } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
        expect(chat).toHaveBeenCalledTimes(2)
        expect(policy.listPendingTerminalApprovals()).toEqual([])
      }
      if (actionCount === 1) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, approved: true } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
      if (withFooter) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, footer: input.footer } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
      if (withSubtitle) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer: { ...answer, subtitle: input.subtitle } as never }, invoke('resolveAgentInteraction'))).rejects.toThrow('Invalid')
      await service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer }, invoke('resolveAgentInteraction'))
      if (withFields || withSubtitle || actionCount === 1 || withFooter || withIcon || withBody) await expect(service.resolveAgentInteraction({ ...scope, interactionId: promptId, answer }, invoke('resolveAgentInteraction'))).rejects.toThrow('not active')
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      expect(chat).toHaveBeenCalledTimes(3)
      expect(runtimeCalls.mock.calls.map(call => call[1])).toEqual(['info', name, 'files.edit'])
      expect((await service.listAgentInteractions(scope, invoke('listAgentInteractions'))).interactions).toEqual([])
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toEqual(edit)
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: false })
      const outcome = await pending
      if (method === 'chat') expect(outcome.status).toBe('rejected')
      else expect(onData.mock.calls.filter(([event]) => event.type === 'done')).toEqual([[expect.objectContaining({ finishReason: 'error' })]])
      expect(chat).toHaveBeenCalledTimes(3)
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(await fs.stat(path.join(root, '.magicpot', 'tool-host', 'snapshots')).then(() => true, () => false)).toBe(false)
      await store.flush()
      const reopened = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
      const results = (await reopened.getSession(route))!.eventLog.map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(results).toHaveLength(3)
      expect(results[0]!.payload).toMatchObject({ ok: true, content: expect.stringContaining('magicpot-local-interaction-manual/v1') })
      expect(results[1]!.payload).toMatchObject({ ok: true, content: JSON.stringify(answer) })
      expect(results[2]!.payload.ok).toBe(false)
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it.each((['chat', 'chatStream'] as const).flatMap(method => [false, true].flatMap(native => [false, true].flatMap(emptyActions => [false, true].flatMap(withFields => [false, true].flatMap(withSubtitle => [false, true].flatMap(withFooter => [false, true].flatMap(withAccent => [false, true].flatMap(withIcon => [false, true].map(withBody => [method, native, emptyActions, withFields, withSubtitle, withFooter, withAccent, withIcon, withBody] as const)))))))))) (
    'provides a display-only card without input, effects or approval through %s native=%s emptyActions=%s fields=%s subtitle=%s footer=%s accent=%s icon=%s body=%s', async (method, native, emptyActions, withFields, withSubtitle, withFooter, withAccent, withIcon, withBody) => {
      const before = 'This file must stay untouched.\n', file = path.join(root, 'card-no-edit.txt')
      await fs.writeFile(file, before)
      const args = { title: 'Review only', ...(withIcon ? { icon: '✓👩🏽‍💻' } : {}), body: withBody ? '**Read-only body**\n\n[Label](https://external.invalid/no-open)\n\n![Alt](file:///private/no-load)\n\n- [x] Not consent\n\n<script>plain card data</script>' : '<script>plain card data</script>', ...(withSubtitle ? { subtitle: '<b>Smaller plain text, not permission</b>' } : {}), ...(withFooter ? { footer: '<b>Closing plain text, not permission</b>' } : {}), ...(withAccent ? { accent: 'danger' } : {}), ...(emptyActions ? { actions: [] } : {}), ...(withFields ? { fields: [{ label: 'Status', value: 'Supplied, not human seen', inline: true }, { label: 'Next', value: 'No authority', inline: false }] } : {}) }
      const expected = { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: args.title, ...(withIcon ? { icon: args.icon } : {}), ...(withSubtitle ? { subtitle: args.subtitle } : {}), body: args.body, ...(withFooter ? { footer: args.footer } : {}), ...(withAccent ? { accent: 'danger' } : {}), ...(withFields ? { fields: args.fields } : {}) }, untrustedData: true, grantsPermission: false }
      const policy = getAssistantTerminalPolicyRuntime(), runtimeCalls = vi.spyOn(h.runtime!, 'callTool')
      const chat = vi.fn(async (input: LLMChatParams): Promise<LLMChatResult | string> => {
        expect(policy.listPendingTerminalApprovals()).toEqual([])
        expect((await service.listAgentInteractions(scope, invoke('listAgentInteractions'))).interactions).toEqual([])
        if (chat.mock.calls.length === 1) {
          if (!native) return JSON.stringify({ toolName: 'show_card', args })
          const index = input.tools!.findIndex(tool => tool.name === 'show_card')
          expect(index).toBeGreaterThanOrEqual(0)
          if (withBody) { expect(input.tools!.at(index)!.description).toContain('formatting-only Markdown body'); expect(input.tools!.at(index)!.inputSchema).toMatchObject({ properties: { body: { type: 'string', maxLength: 4000 } } }) }
          if (withIcon) expect(input.tools!.at(index)!.inputSchema).toMatchObject({ properties: { icon: { type: 'string', maxLength: 64 } } })
          if (withAccent) expect(input.tools!.at(index)!.inputSchema).toMatchObject({ properties: { accent: { type: 'string', enum: ['primary', 'info', 'success', 'warning', 'danger', 'neutral'] } } })
          if (withFooter) expect(input.tools!.at(index)!.inputSchema).toMatchObject({ properties: { footer: { type: 'string', maxLength: 200 } } })
          if (withSubtitle) expect(input.tools!.at(index)!.inputSchema).toMatchObject({ properties: { subtitle: { type: 'string', maxLength: 200 } } })
          if (withFields) expect(input.tools!.at(index)!.inputSchema).toMatchObject({ properties: { fields: { type: 'array', maxItems: 8, items: { required: ['label', 'value'], additionalProperties: false } } } })
          return { content: '', toolCalls: [{ id: 'provided-card-call', name: 'show_card', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
        }
        expect(chat.mock.calls.length).toBe(2)
        const raw = String(native ? input.toolTurns?.at(-1)?.results[0]?.output : input.messages.at(-1)?.content)
        if (!native) expect(raw).toMatch(/^\[Tool Result\]\ntoolName: show_card\nargs:\n/)
        expect(JSON.parse(native ? raw : raw.slice(raw.indexOf('\n\n') + 2))).toEqual(expected)
        return { content: 'Read-only card content was provided; no answer or approval was collected.', finishReason: 'stop' }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const request: LLMChatReq = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'Provide a read-only status card; do not ask for a choice or change any file.' }] }, onData = vi.fn<(event: LLMChatStreamResp) => void>()
      let history: import('@shared/llm/types').ToolHistoryEntry[]
      if (method === 'chat') {
        const value = await service.chat(request, invoke(method))
        history = value.metadata!.toolHistory as typeof history
      } else {
        await service.chatStream(request, { onData }, invoke(method))
        const terminals = onData.mock.calls.map(([event]) => event).filter(event => event.type === 'done')
        expect(terminals).toHaveLength(1)
        expect(terminals[0].finishReason).toBe('stop')
        history = terminals[0].metadata!.toolHistory as typeof history
      }
      expect(chat).toHaveBeenCalledTimes(2)
      expect(runtimeCalls.mock.calls.map(call => call[1])).toEqual(['show_card'])
      expect(history!).toHaveLength(1)
      expect(history![0]).toMatchObject({ toolName: 'show_card', status: 'completed', args, content: JSON.stringify(expected) })
      expect(history![0]).not.toHaveProperty('error')
      expect((await service.listAgentInteractions(scope, invoke('listAgentInteractions'))).interactions).toEqual([])
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      expect(await fs.stat(path.join(root, '.magicpot', 'tool-host', 'snapshots')).then(() => true, () => false)).toBe(false)
      const actions = (await store.getSession(route))!.eventLog.map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(actions).toHaveLength(1)
      expect(actions[0]!.payload).toMatchObject({ ok: true, content: JSON.stringify(expected) })
      await store.flush()
      const reopened = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
      const retained = (await reopened.getSession(route))!.eventLog.map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).find(action => action?.type === 'tool.result')
      expect(retained!.payload).toMatchObject({ ok: true, content: JSON.stringify(expected) })
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it.each((['chat', 'chatStream'] as const).flatMap(method => [false, true].flatMap(native => ['approve', 'deny'].map(decision => [method, native, decision] as const))))(
    'reads local mutation manuals without approval/effects before %s native=%s decision=%s', async (method, native, decision) => {
      const before = 'a b a\n', file = path.join(root, 'manual-then-edit.txt')
      await fs.writeFile(file, before)
      const edit = { path: 'manual-then-edit.txt', expectedSha256: hash(before), replacements: [{ old: 'a', new: 'A', expectedOccurrences: 2 }] }
      const policy = getAssistantTerminalPolicyRuntime(), runtimeCalls = vi.spyOn(h.runtime!, 'callTool')
      const script: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: 'info', args: { name: 'files.edit' } },
        { name: 'info', args: { kind: 'tool', name: 'files.patch' } },
        { name: 'info', args: { kind: 'tool', name: 'files.multi-edit' } },
        { name: 'files.edit', args: edit }
      ]
      const chat = vi.fn(async (input: LLMChatParams): Promise<LLMChatResult | string> => {
        const index = chat.mock.calls.length - 1
        if (index <= 3) {
          expect(policy.listPendingTerminalApprovals()).toEqual([])
          expect(await fs.readFile(file, 'utf8')).toBe(before)
          expect(await fs.stat(path.join(root, '.magicpot', 'tool-host', 'snapshots')).then(() => true, () => false)).toBe(false)
          if (index > 0) {
            const previous = native ? input.toolTurns?.at(-1)?.results[0]?.output : input.messages.at(-1)?.content
            expect(typeof previous).toBe('string')
            const raw = String(previous)
            if (!native) expect(raw).toMatch(/^\[Tool Result\]\ntoolName: info\nargs:\n/)
            const manual = JSON.parse(native ? raw : raw.slice(raw.indexOf('\n\n') + 2))
            expect(manual).toMatchObject({ name: script[index - 1].args.name, grantsPermission: false, documentation: {
              contract: 'magicpot-local-file-mutation-manual/v1', name: script[index - 1].args.name,
              documentationOnly: true, grantsPermission: false, authority: { readingUnlocksTool: false, requiresFreshApproval: true }, failure: { automaticRetry: false }
            } })
          }
          const call = script[index]
          if (!native) return JSON.stringify({ toolName: call.name, args: call.args })
          const wire = input.tools!.findIndex(tool => tool.name === call.name)
          expect(wire).toBeGreaterThanOrEqual(0)
          return { content: '', toolCalls: [{ id: `manual-first-${index}`, name: call.name, wireName: `mp_tool_${wire}`, arguments: JSON.stringify(call.args) }] }
        }
        expect(decision).toBe('approve')
        return { content: 'The separately approved edit completed.', finishReason: 'stop' }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const onData = vi.fn<(event: LLMChatStreamResp) => void>(), request: LLMChatReq = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'Read current local edit manuals first; then submit the exact edit for separate approval.' }] }
      const pending = (method === 'chat' ? service.chat(request, invoke(method)) : service.chatStream(request, { onData }, invoke(method))).then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      expect(runtimeCalls.mock.calls.map(call => call[1])).toEqual(['info', 'info', 'info', 'files.edit'])
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toEqual(edit)
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: decision === 'approve' })
      const outcome = await pending
      expect(chat).toHaveBeenCalledTimes(decision === 'approve' ? 5 : 4)
      expect(await fs.readFile(file, 'utf8')).toBe(decision === 'approve' ? 'A b A\n' : before)
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      const actions = (await store.getSession(route))!.eventLog.map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(actions).toHaveLength(4)
      for (const action of actions.slice(0, 3)) expect(action!.payload).toMatchObject({ ok: true, content: expect.stringContaining('magicpot-local-file-mutation-manual/v1') })
      expect(actions[3]!.payload.ok).toBe(decision === 'approve')
      if (method === 'chat') expect(outcome.status).toBe(decision === 'approve' ? 'fulfilled' : 'rejected')
      else expect(onData.mock.calls.filter(([event]) => event.type === 'done')).toEqual([[expect.objectContaining({ finishReason: decision === 'approve' ? 'stop' : 'error' })]])
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it.each((['chat', 'chatStream'] as const).flatMap(method => [false, true].flatMap(native => (['strict', 'partial', 'best_effort'] as const).flatMap(mode => (method === 'chat' ? ['main', 'ipc'] as const : ['main'] as const).map(transport => [method, native, mode, transport] as const)))))('same-file %s native=%s mode=%s transport=%s preserves actual bytes, failed terminal and reopened receipt', async (method, native, mode, transport) => {
    const before = 'a b a\n', after = mode === 'strict' ? before : mode === 'partial' ? 'A b A\n' : 'Z b Z\n'
    const file = path.join(root, 'mode.txt')
    await fs.writeFile(file, before)
    const args = { path: 'mode.txt', expectedSha256: hash(before), mode, replacements: [
      { old: 'a', new: 'A', expectedOccurrences: 2 },
      { old: 'not present', new: 'never', expectedOccurrences: 1 },
      { old: 'A', new: 'Z', expectedOccurrences: 2 }
    ] }
    const chat = vi.fn().mockImplementation(async input => {
      expect(chat).toHaveBeenCalledTimes(1)
      if (!native) return JSON.stringify({ toolName: 'files.edit', args })
      const index = input.tools.findIndex((tool: { name: string }) => tool.name === 'files.edit')
      expect(index).toBeGreaterThanOrEqual(0)
      return { content: '', toolCalls: [
        { id: 'same-file-mode-call', name: 'files.edit', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) },
        { id: 'unstarted-same-file-call', name: 'files.edit', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }
      ] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const req: LLMChatReq = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'Apply the reviewed ordered edit; keep any match failure visible.' }] }
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const policy = getAssistantTerminalPolicyRuntime()
    let call: Promise<unknown>
    if (transport === 'ipc') {
      type Api = { svcLLMProxy: { chat(req: LLMChatReq): Promise<LLMChatResp> } }
      const definition = { svcLLMProxy: { chat: llmProxySvcDef.chat } }
      registerIpcServer<Api>(definition, { svcLLMProxy: service })
      const handler = h.handle.mock.calls.find(([name]) => name === 'svcLLMProxy.chat')![1]
      h.invoke.mockImplementation(async (name, request) => {
        expect(name).toBe('svcLLMProxy.chat')
        try { return structuredClone(await handler({ sender, senderFrame: { url, parent: null } }, structuredClone(request))) }
        catch (error) { throw new Error(error instanceof Error ? error.message : 'IPC handler failed') }
      })
      call = createIpcClient<Api>(definition).svcLLMProxy.chat(req)
    } else call = method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method))
    const pending = call.then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    const approval = policy.listPendingTerminalApprovals()[0]
    expect(approval.request.request.input).toEqual(args)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
    const outcome = await pending
    expect(policy.listPendingTerminalApprovals()).toEqual([])
    const expectedReport = { mode, failed: 1, applied: mode === 'best_effort' ? 2 : 1, skipped: mode === 'best_effort' ? 0 : 1, writeStatus: mode === 'strict' ? 'not-written' : 'committed', fileChanged: mode !== 'strict' }
    if (method === 'chat') {
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        if (transport === 'main') expect(outcome.reason).toBeInstanceOf(IpcServiceError)
        else { expect(outcome.reason).not.toBeInstanceOf(Error); expect(h.invoke).toHaveBeenCalledOnce() }
        expect(outcome.reason).toMatchObject({ code: 'MAGIC_AGENT_FILES_EDIT_FAILED', payload: { kind: 'agent-tool-failure/v1', toolResult: { metadata: { report: expectedReport } }, toolHistory: [expect.objectContaining({ status: 'failed', toolName: 'files.edit' })] } })
      }
    } else {
      expect(outcome).toEqual({ status: 'fulfilled', value: undefined })
      const terminals = onData.mock.calls.map(([event]) => event).filter(event => event.type === 'error' || event.type === 'done')
      expect(terminals.map(event => event.type)).toEqual(['error', 'done'])
      for (const event of terminals) expect(event).toMatchObject({ finishReason: 'error', metadata: { toolHistory: [expect.objectContaining({ status: 'failed', toolName: 'files.edit', metadata: expect.objectContaining({ report: expect.objectContaining(expectedReport) }) })] } })
    }
    const session = await store.getSession(route)
    const actions = (session?.eventLog ?? []).map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
    expect(actions).toHaveLength(1)
    const resultAction = actions[0]!
    expect(resultAction.payload).toMatchObject({ ok: false, error: { code: 'MAGIC_AGENT_FILES_EDIT_FAILED' }, metadata: { report: expectedReport } })
    const content = resultAction.payload.content!
    const receipt = JSON.parse(content)
    expect(resultAction.payload.metadata).toEqual(receipt)
    expect(await fs.readFile(file, 'utf8')).toBe(after)
    if (mode === 'strict') {
      expect(receipt).not.toHaveProperty('mutation')
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      const expectedDiff = `--- a/mode.txt\n+++ b/mode.txt\n@@ -1,1 +1,1 @@\n-${before}+${after}`
      expect(receipt.mutation).toMatchObject({ beforeSha256: hash(before), afterSha256: hash(after), path: 'mode.txt', diff: expectedDiff, diffBytes: Buffer.byteLength(expectedDiff), additions: 1, deletions: 1 })
      expect(await fs.readFile(path.join(root, '.magicpot', 'tool-host', 'snapshots', receipt.mutation.snapshotId, 'content'), 'utf8')).toBe(before)
    }
    expect(chat).toHaveBeenCalledOnce()
    expect(h.fetch).not.toHaveBeenCalled()
    await store.flush()
    const reopenedStore = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
    const reopenedRuntime = new AssistantRuntime({ sessionStore: reopenedStore, configProvider: getConfig, chatService: { chat: vi.fn() } })
    await expect(reopenedRuntime.callTool(route, 'files.edit', args, { runId: resultAction.correlationId, toolCallId: resultAction.payload.toolCallId, allowedToolNames: ['files.edit'] })).rejects.toMatchObject({ code: 'TOOL_EXECUTION_ALREADY_SETTLED', toolResult: { content, metadata: receipt } })
    expect((await reopenedStore.getSession(route))?.eventLog).toEqual(session!.eventLog)
    expect(policy.listPendingTerminalApprovals()).toEqual([])
    expect(await fs.readFile(file, 'utf8')).toBe(after)
    await reopenedRuntime.flush()
  })

  it.each((['chat', 'chatStream'] as const).flatMap(method => (['strict', 'partial', 'best_effort'] as const).map(mode => [method, mode] as const)))(
    'bounded native failed-edit feedback via %s mode=%s explains once without success or more execution', async (method, mode) => {
      const before = 'a b a\n', after = mode === 'strict' ? before : mode === 'partial' ? 'A b A\n' : 'Z b Z\n'
      const file = path.join(root, 'feedback.txt')
      await fs.writeFile(file, before)
      const args = { path: 'feedback.txt', expectedSha256: hash(before), mode, replacements: [
        { old: 'a', new: 'A', expectedOccurrences: 2 },
        { old: 'not present', new: 'never', expectedOccurrences: 1 },
        { old: 'A', new: 'Z', expectedOccurrences: 2 }
      ] }
      const expectedReport = { mode, failed: 1, applied: mode === 'best_effort' ? 2 : 1, skipped: mode === 'best_effort' ? 0 : 1, writeStatus: mode === 'strict' ? 'not-written' : 'committed', fileChanged: mode !== 'strict' }
      const explanation = 'The edit failed. Review the reported file state; no automatic retry was performed.'
      const chat = vi.fn(async (input: LLMChatParams): Promise<LLMChatResult> => {
        if (chat.mock.calls.length === 1) {
          const index = input.tools!.findIndex(tool => tool.name === 'files.edit')
          expect(index).toBeGreaterThanOrEqual(0)
          return { content: '', usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 }, toolCalls: [{ id: 'native-failed-feedback', name: 'files.edit', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
        }
        expect(chat).toHaveBeenCalledTimes(2)
        expect(input.tools).toBeUndefined()
        expect(input.disableProviderTools).toBe(true)
        expect(input.disableAutomaticImageGeneration).toBe(true)
        expect(input.retryCapacity).toBe(false)
        expect(input.sessionUrl).toBeUndefined()
        expect(input.imageRequest).toBeUndefined()
        expect(input.videoGenerationOptions).toBeUndefined()
        expect(input.imageGenerationOptions).toEqual({ enabled: false })
        expect(input.onDelta).toBeUndefined()
        expect(input.messages.every(message => !message.attachments?.length && !message.ocrResult && !message.hiddenContext)).toBe(true)
        const turns = input.toolTurns!
        expect(turns).toHaveLength(1)
        expect(turns[0].calls.map(call => call.id)).toEqual(['native-failed-feedback'])
        expect(turns[0].results.map(result => result.callId)).toEqual(['native-failed-feedback'])
        expect(JSON.parse(turns[0].results[0].output)).toMatchObject({ error: { code: 'MAGIC_AGENT_FILES_EDIT_FAILED' }, report: expectedReport })
        expect(projectNativeToolTurns(turns, 'chat-completions')).toHaveLength(2)
        expect(projectNativeToolTurns(turns, 'responses')).toHaveLength(2)
        return { content: explanation, finishReason: 'stop' as const, usage: { promptTokens: 20, completionTokens: 6, totalTokens: 26 } }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true, supportsIsolatedReadOnlyTurns: true } as never)
      const runtimeCalls = vi.spyOn(h.runtime!, 'callTool'), policy = getAssistantTerminalPolicyRuntime()
      const req = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Apply the reviewed edit once; if a match fails, explain the actual reported failure without retrying.' }] }
      const onData = vi.fn<(event: LLMChatStreamResp) => void>()
      const call = method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method))
      const pending = call.then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toEqual(args)
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
      const outcome = await pending
      // The model may explain a failed operation, never turn it into a success.
      expect(chat).toHaveBeenCalledTimes(2)
      expect(runtimeCalls).toHaveBeenCalledOnce()
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      if (method === 'chat') {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'MAGIC_AGENT_FILES_EDIT_FAILED', message: expect.stringContaining(explanation), payload: { kind: 'agent-tool-failure/v1', toolHistory: [expect.objectContaining({ status: 'failed', toolName: 'files.edit' })] } })
      } else {
        expect(outcome.status).toBe('fulfilled')
        expect(onData.mock.calls.filter(([event]) => event.type === 'tool-status').map(([event]) => event.toolStatus?.status)).toEqual(['running', 'failed'])
        const terminals = onData.mock.calls.map(([event]) => event).filter(event => event.type === 'error' || event.type === 'done')
        expect(terminals.map(event => event.type)).toEqual(['error', 'done'])
        for (const event of terminals) expect(event).toMatchObject({ finishReason: 'error', error: expect.stringContaining(explanation), metadata: { toolHistory: [expect.objectContaining({ status: 'failed', toolName: 'files.edit' })] } })
        expect(terminals.find(event => event.type === 'done')?.usage).toEqual({ promptTokens: 32, completionTokens: 9, totalTokens: 41 })
      }
      const session = await store.getSession(route)
      const results = (session?.eventLog ?? []).map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(results).toHaveLength(1)
      const result = results[0]!
      expect(result.payload).toMatchObject({ ok: false, error: { code: 'MAGIC_AGENT_FILES_EDIT_FAILED' }, metadata: { report: expectedReport } })
      const receipt = JSON.parse(result.payload.content!)
      expect(receipt).toEqual(result.payload.metadata)
      expect(receipt.error.message).not.toContain(explanation)
      if (mode === 'strict') expect(receipt).not.toHaveProperty('mutation')
      else {
        expect(receipt.mutation).toMatchObject({ beforeSha256: hash(before), afterSha256: hash(after) })
        expect(await fs.readFile(path.join(root, '.magicpot', 'tool-host', 'snapshots', receipt.mutation.snapshotId, 'content'), 'utf8')).toBe(before)
      }
      expect(await fs.readFile(file, 'utf8')).toBe(after)
      expect(h.fetch).not.toHaveBeenCalled()
      await store.flush()
      const reopenedStore = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
      const reopenedRuntime = new AssistantRuntime({ sessionStore: reopenedStore, configProvider: getConfig, chatService: { chat: vi.fn() } })
      await expect(reopenedRuntime.callTool(route, 'files.edit', args, { runId: result.correlationId, toolCallId: result.payload.toolCallId, allowedToolNames: ['files.edit'] })).rejects.toMatchObject({ code: 'TOOL_EXECUTION_ALREADY_SETTLED', toolResult: { content: result.payload.content, metadata: receipt } })
      expect((await reopenedStore.getSession(route))?.eventLog).toEqual(session!.eventLog)
      expect(await fs.readFile(file, 'utf8')).toBe(after)
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      await reopenedRuntime.flush()
    }
  )

  it.each((['chat', 'chatStream'] as const).flatMap(method => (['native-same', 'native-new', 'legacy', 'explicit', 'image', 'attachment', 'hosted', 'empty', 'too-large', 'length', 'provider-error', 'native-unsupported', 'stop-after-status', 'navigate-after-status', 'stop-in-model', 'navigate-in-model', 'document-url-changed', 'persist-failed', 'persist-after-write', 'audit-failed', 'multibatch', 'non-native', 'no-isolation', 'transcript-limit'] as const).map(kind => [method, kind] as const)))(
    'bounded failed-edit feedback refuses unsafe next step via %s kind=%s', async (method, kind) => {
      const before = 'original\n', file = path.join(root, 'feedback-guard.txt')
      await fs.writeFile(file, before)
      const args = { path: 'feedback-guard.txt', expectedSha256: hash(before), replacements: [{ old: 'absent', new: 'never', expectedOccurrences: 1 }] }
      const policy = getAssistantTerminalPolicyRuntime(), runtimeCalls = vi.spyOn(h.runtime!, 'callTool')
      if (kind === 'audit-failed') {
        const appendAudit = policy.eventStore.appendBatch.bind(policy.eventStore)
        vi.spyOn(policy.eventStore, 'appendBatch').mockImplementation((events, options) => {
          if (events.some(event => event.streamId === TOOL_AUDIT_STREAM_ID)) throw Error('injected host failure audit rejection')
          return appendAudit(events, options)
        })
      }
      const originalAppend = store.appendEvents.bind(store)
      const append = vi.spyOn(store, 'appendEvents').mockImplementation(async (...input) => {
        const hasFailure = input[1].some(event => {
          const action = event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined
          return action?.type === 'tool.result' && !action.payload.ok
        })
        if (hasFailure && kind === 'persist-failed') throw Error('injected failure journal write rejection')
        const result = await originalAppend(...input)
        if (hasFailure && kind === 'persist-after-write') throw Error('injected ambiguous failure journal publication')
        if (hasFailure && kind === 'stop-after-status' && method === 'chat')
          await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
        if (hasFailure && kind === 'navigate-after-status' && method === 'chat') sender.emit('did-start-navigation')
        return result
      })
      const originalCallId = 'feedback-guard-call'
      let failedWire = ''
      const chat = vi.fn(async (input: LLMChatParams): Promise<LLMChatResult | string> => {
        if (chat.mock.calls.length === 1) {
          if (kind === 'non-native') return JSON.stringify({ toolName: 'files.edit', args })
          const index = input.tools!.findIndex(tool => tool.name === 'files.edit')
          expect(index).toBeGreaterThanOrEqual(0)
          failedWire = `mp_tool_${index}`
          const call = { id: originalCallId, name: 'files.edit', wireName: failedWire, arguments: JSON.stringify(args) }
          return { content: '', toolCalls: kind === 'multibatch' ? [call, { ...call, id: 'must-not-start' }] : [call],
            ...(kind === 'transcript-limit' ? { toolResponseItems: [{ type: 'reasoning', encrypted_content: 'x'.repeat(8 * 1024 * 1024) }] } : {}) }
        }
        expect(chat).toHaveBeenCalledTimes(2)
        expect(input.tools).toBeUndefined()
        expect(input.onDelta).toBeUndefined()
        expect(input.disableProviderTools).toBe(true)
        expect(input.disableAutomaticImageGeneration).toBe(true)
        expect(input.retryCapacity).toBe(false)
        expect(input.sessionUrl).toBeUndefined()
        expect(input.structuredOutput).toBeUndefined()
        expect(input.imageGenerationOptions).toEqual({ enabled: false })
        expect(input.imageRequest).toBeUndefined()
        expect(input.videoGenerationOptions).toBeUndefined()
        expect(JSON.parse(input.toolTurns!.at(-1)!.results[0].output)).toMatchObject({ error: { code: 'MAGIC_AGENT_FILES_EDIT_FAILED' }, report: { writeStatus: 'not-written', fileChanged: false } })
        if (kind === 'stop-in-model') await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
        if (kind === 'navigate-in-model') sender.emit('did-start-navigation')
        if (kind === 'document-url-changed') Object.assign(sender, { getURL: () => 'file:///D:/owned/app/index.html#/canvas?id=different-feedback-project' })
        if (kind === 'provider-error') throw Error('injected final explanation provider rejection')
        if (kind === 'native-unsupported') throw Error('Native tools are not supported by this endpoint')
        if (kind === 'native-same' || kind === 'native-new') return { content: '', toolCalls: [{ id: kind === 'native-same' ? originalCallId : 'new-retry-id', name: 'files.edit', wireName: failedWire, arguments: JSON.stringify(args) }] }
        if (kind === 'legacy') return { content: JSON.stringify({ toolName: 'files.edit', args }) }
        if (kind === 'explicit') return { content: `/tool files.edit ${JSON.stringify(args)}` }
        if (kind === 'image') return { content: 'Do not publish this as a safe explanation.', imageUrl: 'https://never.invalid/image.png' }
        if (kind === 'attachment') return { content: 'Do not publish this as a safe explanation.', attachments: [{ type: 'video', url: 'https://never.invalid/video.mp4' }] }
        if (kind === 'hosted') return { content: 'Do not publish this as a safe explanation.', toolResponseItems: [{ type: 'web_search_call' }] }
        if (kind === 'empty') return { content: '' }
        if (kind === 'too-large') return { content: '你'.repeat(5462) }
        if (kind === 'length') return { content: 'Do not publish this incomplete explanation.', finishReason: 'length' }
        return { content: 'Late explanation must not be published after request ownership ends.' }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: kind !== 'non-native', supportsIsolatedReadOnlyTurns: kind !== 'no-isolation' } as never)
      const onData = vi.fn<(event: LLMChatStreamResp) => void>(event => {
        if (event.type === 'tool-status' && event.toolStatus?.status === 'failed') {
          if (kind === 'stop-after-status') void service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
          if (kind === 'navigate-after-status') sender.emit('did-start-navigation')
        }
      })
      const req: LLMChatReq = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'Apply only the reviewed operation once.' }] }
      const call = method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method))
      const pending = call.then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toEqual(args)
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
      const outcome = await pending
      const noNextModel = ['stop-after-status', 'navigate-after-status', 'persist-failed', 'persist-after-write', 'audit-failed', 'multibatch', 'non-native', 'no-isolation', 'transcript-limit'].includes(kind)
      expect(chat).toHaveBeenCalledTimes(noNextModel ? 1 : 2)
      expect(runtimeCalls).toHaveBeenCalledOnce()
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.fetch).not.toHaveBeenCalled()
      const cancelled = kind.startsWith('stop-') || kind.startsWith('navigate-')
      const session = await store.getSession(route)
      const actions = (session?.eventLog ?? []).map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(actions).toHaveLength(kind === 'persist-failed' ? 0 : 1)
      if (actions[0]) {
        if (kind === 'audit-failed') {
          expect(actions[0].payload).toMatchObject({ ok: false, error: { message: 'injected host failure audit rejection' } })
          expect(actions[0].payload).not.toHaveProperty('content')
          expect(actions[0].payload).not.toHaveProperty('metadata')
        } else {
          expect(actions[0].payload).toMatchObject({ ok: false, error: { code: 'MAGIC_AGENT_FILES_EDIT_FAILED' }, metadata: { report: { failed: 1, writeStatus: 'not-written' } } })
          expect(actions[0].payload.metadata).not.toHaveProperty('mutation')
        }
      }
      if (method === 'chat') {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected' && !cancelled && kind !== 'document-url-changed') {
          if (kind === 'audit-failed') expect(outcome.reason).toMatchObject({ message: 'injected host failure audit rejection' })
          else expect(outcome.reason).toMatchObject({ code: 'MAGIC_AGENT_FILES_EDIT_FAILED', payload: { kind: 'agent-tool-failure/v1', toolHistory: [expect.objectContaining({ status: 'failed' })] } })
        }
      } else {
        expect(outcome.status).toBe('fulfilled')
        const events = onData.mock.calls.map(([event]) => event)
        expect(events.filter(event => event.type === 'text-delta' || event.type === 'attachment')).toEqual([])
        const terminals = events.filter(event => event.type === 'error' || event.type === 'done')
        if (kind.startsWith('navigate-') || kind === 'document-url-changed') expect(terminals).toEqual([])
        else if (kind.startsWith('stop-')) expect(terminals).toEqual([expect.objectContaining({ type: 'done', finishReason: 'cancelled' })])
        else {
          expect(terminals.map(event => event.type)).toEqual(['error', 'done'])
          for (const event of terminals) {
            expect(event.finishReason).toBe('error')
            if (kind === 'audit-failed') { expect(event.error).toBe('injected host failure audit rejection'); expect(event).not.toHaveProperty('metadata') }
            else expect(event).toMatchObject({ metadata: { toolHistory: [expect.objectContaining({ status: 'failed' })] } })
          }
          expect(JSON.stringify(terminals)).not.toContain('Untrusted model explanation')
        }
      }
      expect(append).toHaveBeenCalled()
      expect(sender.listenerCount('did-start-navigation')).toBe(0)
    }
  )

  it('rechecks the current document between explanation error and done frames', async () => {
    const before = 'original\n', file = path.join(root, 'feedback-terminal.txt')
    await fs.writeFile(file, before)
    const args = { path: 'feedback-terminal.txt', expectedSha256: hash(before), replacements: [{ old: 'absent', new: 'never', expectedOccurrences: 1 }] }
    const chat = vi.fn(async (input: LLMChatParams): Promise<LLMChatResult> => {
      if (chat.mock.calls.length === 1) return { content: '', toolCalls: [{ id: 'failed-terminal', name: 'files.edit', wireName: `mp_tool_${input.tools!.findIndex(tool => tool.name === 'files.edit')}`, arguments: JSON.stringify(args) }] }
      return { content: 'The approved edit failed and was not retried.', finishReason: 'stop' }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true, supportsIsolatedReadOnlyTurns: true } as never)
    const events: LLMChatStreamResp[] = [], policy = getAssistantTerminalPolicyRuntime()
    const call = service.chatStream({ ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'Apply this reviewed edit once.' }] }, { onData: event => {
      events.push(event)
      if (event.type === 'error') Object.assign(sender, { getURL: () => 'file:///D:/owned/app/index.html#/canvas?id=other-project' })
    } }, invoke('chatStream'))
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    const approval = policy.listPendingTerminalApprovals()[0]
    policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
    await call
    expect(chat).toHaveBeenCalledTimes(2)
    expect(events.filter(event => event.type === 'error' || event.type === 'done').map(event => event.type)).toEqual(['error'])
    expect(events.find(event => event.type === 'error')).toMatchObject({ finishReason: 'error', error: expect.stringContaining('The approved edit failed and was not retried.') })
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })

  it.each(([['chat', false], ['chat', true], ['chatStream', false], ['chatStream', true]] as const)
    .flatMap(([method, native]) => [false, true].flatMap(rollbackFails => (method === 'chat' ? ['main', 'ipc'] as const : ['main'] as const).map(transport => [method, native, rollbackFails, transport] as const))))(
    'retains actual batch rollback failure via %s native=%s rollbackFails=%s transport=%s', async (method, native, rollbackFails, transport) => {
      await fs.writeFile(path.join(root, 'a.txt'), 'a')
      await fs.writeFile(path.join(root, 'b.txt'), 'b')
      const args = { edits: [
        { path: 'a.txt', expectedSha256: hash('a'), replacements: [{ old: 'a', new: 'A', expectedOccurrences: 1 }] },
        { path: 'b.txt', expectedSha256: hash('b'), replacements: [{ old: 'b', new: 'B', expectedOccurrences: 1 }] }
      ] }
      const chat = vi.fn(async (input: { tools: Array<{ name: string }> }) => {
        const name = 'files.multi-edit', index = input.tools?.findIndex(tool => tool.name === name)
        if (!native) return JSON.stringify({ toolName: name, args })
        expect(index).toBeGreaterThanOrEqual(0)
        return { content: '', toolCalls: [
          { id: 'failed-batch', name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) },
          { id: 'unstarted-batch', name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }
        ] }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const originalRename = fs.rename.bind(fs)
      let targetRenames = 0
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        // Journal/session persistence also renames; inject only actual file commits.
        if ([path.join(root, 'a.txt'), path.join(root, 'b.txt')].includes(String(to))) {
          targetRenames++
          if (targetRenames === 2) throw new Error('injected second commit failure')
          if (targetRenames === 3 && rollbackFails) throw new Error('injected rollback failure')
        }
        return originalRename(from, to)
      })
      const appendEvents = vi.spyOn(store, 'appendEvents')
      const runtimeCalls = vi.spyOn(h.runtime!, 'callTool')
      const onData = vi.fn<(event: LLMChatStreamResp) => void>(), policy = getAssistantTerminalPolicyRuntime()
      const req = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Apply the reviewed batch once.' }] }
      let call: Promise<unknown>
      if (transport === 'ipc') {
        type Api = { svcLLMProxy: { chat(req: LLMChatReq): Promise<LLMChatResp> } }
        const definition = { svcLLMProxy: { chat: llmProxySvcDef.chat } }
        registerIpcServer<Api>(definition, { svcLLMProxy: service })
        const handler = h.handle.mock.calls.find(([name]) => name === 'svcLLMProxy.chat')![1]
        h.invoke.mockImplementation(async (name, request) => {
          expect(name).toBe('svcLLMProxy.chat')
          try { return structuredClone(await handler({ sender, senderFrame: { url, parent: null } }, structuredClone(request))) }
          catch (error) { throw new Error(error instanceof Error ? error.message : 'IPC handler failed') }
        })
        call = createIpcClient<Api>(definition).svcLLMProxy.chat(req)
      } else call = method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method))
      const pending = call.then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('a')
      expect(targetRenames).toBe(0)
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toEqual({ ...args, path: '.' })
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
      const outcome = await pending
      rename.mockRestore()
      expect(targetRenames).toBe(3)
      const rollback = { attempted: true, succeeded: !rollbackFails, restoredPaths: rollbackFails ? [] : ['a.txt'], failedPaths: rollbackFails ? ['a.txt'] : [] }
      const receipt = { error: { message: 'Multi-file commit failed: injected second commit failure', code: 'MAGIC_AGENT_FILES_MUTATION' }, rollback }
      const expectedHistory = [expect.objectContaining({ toolName: 'files.multi-edit', status: 'failed', content: JSON.stringify(receipt, null, 2), metadata: expect.objectContaining(receipt), error: receipt.error.message })]
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      if (method === 'chat') {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') {
          if (transport === 'main') expect(outcome.reason).toBeInstanceOf(IpcServiceError)
          else {
            expect(outcome.reason).not.toBeInstanceOf(Error)
            expect(h.invoke).toHaveBeenCalledOnce()
          }
          expect(outcome.reason).toMatchObject({ code: receipt.error.code, message: receipt.error.message, payload: { kind: 'agent-tool-failure/v1', toolResult: { content: JSON.stringify(receipt, null, 2), metadata: receipt }, toolHistory: expectedHistory } })
        }
      } else {
        expect(outcome.status).toBe('fulfilled')
        const events = onData.mock.calls.map(([event]) => event)
        expect(events.filter(event => event.type === 'tool-status').map(event => event.toolStatus?.status)).toEqual(['running', 'failed'])
        expect(events.filter(event => event.type === 'done' || event.type === 'error')).toEqual([
          expect.objectContaining({ type: 'error', finishReason: 'error', metadata: expect.objectContaining({ toolHistory: expectedHistory }) }),
          expect.objectContaining({ type: 'done', finishReason: 'error', metadata: expect.objectContaining({ toolHistory: expectedHistory }) })
        ])
      }
      expect(chat).toHaveBeenCalledOnce()
      expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(rollbackFails ? 'A' : 'a')
      expect(await fs.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b')
      const snapshots = path.join(root, '.magicpot', 'tool-host', 'snapshots')
      const snapshotIds = await fs.readdir(snapshots)
      expect(snapshotIds).toHaveLength(2)
      const oldContents = await Promise.all(snapshotIds.map(id => fs.readFile(path.join(snapshots, id, 'content'), 'utf8')))
      expect(oldContents.sort()).toEqual(['a', 'b'])
      const session = await store.getSession(route)
      const actions = (session?.eventLog ?? []).map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(runtimeCalls).toHaveBeenCalledOnce()
      expect(appendEvents).toHaveBeenCalledTimes(2)
      expect(actions).toHaveLength(1)
      expect(actions[0]?.payload).toMatchObject({ ok: false, content: JSON.stringify(receipt, null, 2), metadata: receipt, error: receipt.error })
      // Reload actual persisted events using a new store/adapter, not an in-memory
      // receipt substitute. A failed call is replayed as failure, never dispatched.
      await store.flush()
      const reopenedStore = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
      const reopenedRuntime = new AssistantRuntime({ sessionStore: reopenedStore, configProvider: getConfig, chatService: { chat: vi.fn() } })
      const resultAction = actions[0]!
      await expect(reopenedRuntime.callTool(route, 'files.multi-edit', args, {
        runId: resultAction.correlationId, toolCallId: resultAction.payload.toolCallId, allowedToolNames: ['files.multi-edit']
      })).rejects.toMatchObject({ code: 'TOOL_EXECUTION_ALREADY_SETTLED', toolResult: { content: JSON.stringify(receipt, null, 2), metadata: receipt } })
      expect((await reopenedStore.getSession(route))?.eventLog).toEqual(session!.eventLog)
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(rollbackFails ? 'A' : 'a')
      await reopenedRuntime.flush()
      expect(() => policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })).toThrow('not found')
      expect(h.fetch).not.toHaveBeenCalled()
      expect(sender.listenerCount('did-start-navigation')).toBe(0)
    }
  )

  it.each((['chat', 'chatStream'] as const).flatMap(method => [false, true].flatMap(native => (['marker', 'content', 'cas'] as const).map(failure => [method, native, failure] as const))))(
    'EOF patch via %s native=%s rejects %s without mutation or same-identity redispatch', async (method, native, failure) => {
      const before = 'old', file = path.join(root, 'failed-patch.txt')
      await fs.writeFile(file, before)
      const args = { path: 'failed-patch.txt', expectedSha256: hash(failure === 'cas' ? 'stale' : before), patch: ['--- a/failed-patch.txt', '+++ b/failed-patch.txt', '@@ -1,1 +1,1 @@', ...(failure === 'marker' ? ['\\ No newline at end of file'] : []), failure === 'content' ? '-wrong' : '-old', '\\ No newline at end of file', '+new', ''].join('\n') }
      const expectedError = failure === 'marker' ? 'Patch newline marker is orphaned, duplicated, or describes an empty line.' : failure === 'cas' ? 'expectedSha256 is stale.' : 'Patch hunk does not match the complete current file.'
      const chat = vi.fn().mockImplementation(async input => {
        expect(chat).toHaveBeenCalledOnce()
        if (!native) return JSON.stringify({ toolName: 'files.patch', args })
        const index = input.tools.findIndex((tool: { name: string }) => tool.name === 'files.patch')
        expect(index).toBeGreaterThanOrEqual(0)
        return { content: '', toolCalls: [
          { id: 'failed-eof-patch', name: 'files.patch', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) },
          { id: 'unstarted-eof-patch', name: 'files.patch', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }
        ] }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const req = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Apply only the approved patch once.' }] }
      const onData = vi.fn<(event: LLMChatStreamResp) => void>(), policy = getAssistantTerminalPolicyRuntime()
      const pending = (method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method)))
        .then(value => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.target.id).toBe('files.patch')
      expect(approval.request.request.input).toEqual(args)
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
      const outcome = await pending
      if (method === 'chat') {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toMatchObject({ code: 'MAGIC_AGENT_FILES_VALIDATION', message: expectedError })
          expect(outcome.reason).not.toHaveProperty('toolResult')
          expect(outcome.reason).not.toHaveProperty('mutation')
        }
      } else {
        expect(outcome).toEqual({ status: 'fulfilled', value: undefined })
        const terminals = onData.mock.calls.map(([event]) => event).filter(event => event.type === 'done' || event.type === 'error')
        expect(terminals.map(event => event.type)).toEqual(['error', 'done'])
        for (const event of terminals) {
          expect(event).toMatchObject({ finishReason: 'error', error: expectedError, content: '' })
          expect(event).not.toHaveProperty('metadata')
        }
        expect(onData.mock.calls.map(([event]) => event).filter(event => event.type === 'tool-status').map(event => event.toolStatus?.status)).toEqual(['running', 'failed'])
      }
      expect(chat).toHaveBeenCalledOnce()
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
      const session = await store.getSession(route)
      const actions = (session?.eventLog ?? []).map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
      expect(actions).toHaveLength(1)
      const resultAction = actions[0]!
      expect(resultAction.payload).toMatchObject({ ok: false, toolName: 'files.patch', error: { code: 'MAGIC_AGENT_FILES_VALIDATION', message: expectedError } })
      expect(resultAction.payload).not.toHaveProperty('content')
      expect(resultAction.payload).not.toHaveProperty('metadata')
      await store.flush()
      const reopenedStore = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
      const reopenedRuntime = new AssistantRuntime({ sessionStore: reopenedStore, configProvider: getConfig, chatService: { chat: vi.fn() } })
      await expect(reopenedRuntime.callTool(route, 'files.patch', args, { runId: resultAction.correlationId, toolCallId: resultAction.payload.toolCallId, allowedToolNames: ['files.patch'] })).rejects.toMatchObject({ code: 'TOOL_EXECUTION_ALREADY_SETTLED', message: expectedError })
      expect((await reopenedStore.getSession(route))?.eventLog).toEqual(session!.eventLog)
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(() => policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })).toThrow('not found')
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      expect(h.fetch).not.toHaveBeenCalled()
      expect(sender.listenerCount('did-start-navigation')).toBe(0)
      await reopenedRuntime.flush()
    }
  )

  it.each(([['chat', false], ['chat', true], ['chatStream', false], ['chatStream', true]] as const)
    .flatMap(([method, native]) => (['default', 'partial', 'best_effort', 'patch'] as const).flatMap(mode => (['approve', 'deny', 'navigation', 'stop'] as const).map(ending => [method, native, ending, mode] as const))))(
    'captures an exact edit or EOF patch via %s native=%s ending=%s mode=%s', async (method, native, ending, mode) => {
      const name = mode === 'patch' ? 'files.patch' : 'files.edit'
      const before = mode === 'patch' ? 'old' : 'old old\n', after = mode === 'patch' ? 'approved\n' : 'approved approved\n', file = path.join(root, 'edit.txt')
      await fs.writeFile(file, before)
      const args = mode === 'patch' ? { path: 'edit.txt', expectedSha256: hash(before), patch: '--- a/edit.txt\n+++ b/edit.txt\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+approved\n' } : { path: 'edit.txt', expectedSha256: hash(before), ...(mode === 'default' ? {} : { mode }), replacements: [
        { old: 'old', new: 'middle', expectedOccurrences: 2 },
        { old: 'middle', new: 'approved', expectedOccurrences: 2 }
      ] }
      const expectedDiff = mode === 'patch' ? '--- a/edit.txt\n+++ b/edit.txt\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+approved\n' : '--- a/edit.txt\n+++ b/edit.txt\n@@ -1,1 +1,1 @@\n-old old\n+approved approved\n'
      const expectedReceipt = { beforeSha256: hash(before), afterSha256: hash(after), diff: expectedDiff, diffBytes: Buffer.byteLength(expectedDiff), additions: 1, deletions: 1 }
      const chat = vi.fn().mockImplementation(async input => {
        if (chat.mock.calls.length > 1) {
          expect(JSON.stringify(native ? input.toolTurns : input.messages)).toContain(hash(after))
          const outputs: string[] = native
            ? input.toolTurns.flatMap((turn: { results: Array<{ output: string }> }) => turn.results.map(result => result.output))
            : input.messages.map((message: { content: string }) => message.content)
          // These raw result strings already contain JSON-escaped diff fields;
          // stringifying the whole transcript again would double-escape them.
          expect(outputs.some(output => output.includes(JSON.stringify(expectedDiff)))).toBe(true)
          return 'The approved edit returned its actual SHA and snapshot.'
        }
        if (!native) return JSON.stringify({ toolName: name, args })
        const index = input.tools.findIndex((tool: { name: string }) => tool.name === name)
        expect(index).toBeGreaterThanOrEqual(0)
        return { content: '', toolCalls: [{ id: 'approved-file-edit', name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const req = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Apply only the reviewed edit.' }] }
      const onData = vi.fn<(event: LLMChatStreamResp) => void>(), policy = getAssistantTerminalPolicyRuntime()
      let settled = false
      const pending = (method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method)))
        .then(value => { settled = true; return { status: 'fulfilled' as const, value } }, (reason: unknown) => { settled = true; return { status: 'rejected' as const, reason } })
      await vi.waitFor(() => {
        expect(settled, 'The call must wait for the actual approval coordinator.').toBe(false)
        expect(policy.listPendingTerminalApprovals()).toHaveLength(1)
      })
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      expect(chat).toHaveBeenCalledOnce()
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.target.id).toBe(name)
      expect(approval.request.request.input).toEqual(args)
      expect(approval.request.request.route).toMatchObject(route)
      sender.emit('did-start-navigation', { isMainFrame: false })
      expect(policy.listPendingTerminalApprovals()).toHaveLength(1)
      expect(settled).toBe(false)
      if (ending === 'navigation') sender.emit('did-start-navigation')
      else if (ending === 'stop') await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
      else policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: ending === 'approve' })
      const outcome = await pending
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(() => policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })).toThrow('not found')
      if (ending === 'approve') {
        expect(outcome.status).toBe('fulfilled')
        if (outcome.status !== 'fulfilled') throw outcome.reason
        const result = outcome.value
        if (method === 'chat') expect(result).toMatchObject({ content: 'The approved edit returned its actual SHA and snapshot.', metadata: { toolHistory: [expect.objectContaining({ toolName: name, status: 'completed' })] } })
        else expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'The approved edit returned its actual SHA and snapshot.' }))
        expect(chat).toHaveBeenCalledTimes(2)
        const session = await store.getSession(route)
        const results = (session?.eventLog ?? []).map(event => event.metadata?.agentAction as import('@shared/agent').ToolResultAction | undefined).filter(action => action?.type === 'tool.result')
        expect(results).toHaveLength(1)
        expect(results[0]!.payload).toMatchObject({ ok: true, toolName: name, metadata: expectedReceipt })
        expect(JSON.parse(results[0]!.payload.content!)).toMatchObject(expectedReceipt)
        const history = method === 'chat' ? (result as LLMChatResp).metadata?.toolHistory : onData.mock.calls.find(([event]) => event.type === 'done')?.[0].metadata?.toolHistory
        expect(history).toEqual([expect.objectContaining({ toolName: name, status: 'completed', metadata: expect.objectContaining(expectedReceipt) })])
        await store.flush()
        const reopened = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
        expect((await reopened.getSession(route))?.eventLog).toEqual(session!.eventLog)
        expect(await fs.readFile(file, 'utf8')).toBe(after)
        const snapshots = await fs.readdir(path.join(root, '.magicpot', 'tool-host', 'snapshots'))
        expect(snapshots).toHaveLength(1)
        expect(await fs.readFile(path.join(root, '.magicpot', 'tool-host', 'snapshots', snapshots[0], 'content'), 'utf8')).toBe(before)
      } else {
        expect(chat).toHaveBeenCalledOnce()
        expect(await fs.readFile(file, 'utf8')).toBe(before)
        await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
        const expectedError = ending === 'deny' ? 'Terminal execution was denied by the user.'
          : ending === 'stop' ? 'Conversation cancelled by the user.' : 'Agent thread document or request ended.'
        if (method === 'chat') {
          expect(outcome.status).toBe('rejected')
          if (outcome.status === 'rejected') {
            expect(outcome.reason).toBeInstanceOf(Error)
            expect(outcome.reason).toMatchObject({ message: expectedError })
          }
          expect(onData).not.toHaveBeenCalled()
        } else {
          expect(outcome.status).toBe('fulfilled') // Streaming reports errors via frames, not a thrown promise.
          if (outcome.status === 'fulfilled') expect(outcome.value).toBeUndefined()
          const terminal = onData.mock.calls.map(([event]) => event).filter(event => event.type === 'done' || event.type === 'error')
          expect(terminal.filter(event => event.type === 'done' && !['error', 'cancelled'].includes(event.finishReason ?? ''))).toEqual([])
          if (ending === 'deny') expect(terminal).toEqual([
            expect.objectContaining({ type: 'error', done: false, finishReason: 'error', error: expectedError, content: '' }),
            expect.objectContaining({ type: 'done', done: true, finishReason: 'error', error: expectedError, content: '' })
          ])
          else if (ending === 'stop') expect(terminal).toEqual([
            expect.objectContaining({ type: 'done', done: true, finishReason: 'cancelled', content: '' })
          ])
          else expect(terminal).toEqual([]) // No terminal frame may target the replaced document.
        }
      }
      expect(h.fetch).not.toHaveBeenCalled()
      expect(sender.listenerCount('did-start-navigation')).toBe(0)
    }
  )
})
