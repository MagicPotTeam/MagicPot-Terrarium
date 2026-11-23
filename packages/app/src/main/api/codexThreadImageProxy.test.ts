import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { LLMChatResp, LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import type { ToolResultAction } from '@shared/agent'

// The durable approval and managed-image fixture requires real paths and SQLite.
vi.unmock('node:fs')
vi.unmock('node:fs/promises')

// Local ordinary-chain fixture: real composed registry, CLIProxy native text client,
// Codex JSON image client, durable adapter, formal approval and managed-media store.
// Only Electron/document, config, authentication and HTTP/provider are substitutes.
// No real credentials or live requests.
const h = vi.hoisted(() => ({
  data: '',
  fetch: vi.fn(),
  fromId: vi.fn(),
  parent: vi.fn(),
  configChanged: undefined as (() => void) | undefined,
  decode: vi.fn()
}))
vi.mock('electron', () => ({
  MessagePortMain: class {},
  net: {},
  app: {
    getVersion: () => 'fixture',
    getPath: () => h.data,
    getAppPath: () => process.cwd(),
    isReady: () => true
  },
  webContents: { fromId: h.fromId },
  BrowserWindow: { fromWebContents: h.parent },
  nativeImage: { createFromBuffer: h.decode }
}))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  onConfigCommitted: vi.fn((callback: () => void) => {
    h.configChanged = callback
    return () => {
      if (h.configChanged === callback) h.configChanged = undefined
    }
  })
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({
    ...DEFAULT_BUILD_ENV,
    pathMap: { data: h.data, file: h.data, resources: '' }
  })
}))
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import * as runtimeModule from '../assistantRuntime/runtime'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'
import {
  getAssistantTerminalPolicyRuntime,
  closeAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import { resetChatMediaDirCacheForTests } from '../llmProxy/chatMediaDir'
import { stopMcpClientManager } from '../mcp/runtime'
import { stopMagicPotMcpPlatformRuntime } from '../mcp/platform/runtime'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { __resetCodexRequestGovernorForTests } from './codexRequestGovernor'

const auth = vi.hoisted(() => ({ ensure: vi.fn(), refresh: vi.fn() }))
vi.mock('./codexOAuth', () => ({
  ensureCodexCliAuthTokens: auth.ensure,
  forceRefreshCodexCliAuthTokens: auth.refresh
}))

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'private-wire',
  threadId: 'pane'
} as const
const scope = { route, conversationId: 'private-wire-chat' }
const url = 'file:///D:/owned/app/index.html#/canvas?id=private-wire'
const invocation = (method: string) => ({
  methodName: `svcLLMProxy.${method}`,
  senderId: 103,
  frameUrl: url,
  senderUrl: url,
  isMainFrame: true
})
const prompt = 'A real one-pixel fixture, no live provider'
const encoded =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg2JLyHwAD6AIYhAHF9gAAAABJRU5ErkJggg=='
// A valid two-frame GIF: the late-response test must reject the changed backend, not malformed bytes.
const animatedBytes = Buffer.concat([
  Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
  ...Array.from({ length: 2 }, () =>
    Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex')
  ),
  Buffer.from([0x3b])
])
const sse = (output: unknown[]) =>
  new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }
  )
let sender: EventEmitter
let service: LLMProxySvcImpl
let runtime: AssistantRuntime
let store: AssistantSessionStore
beforeEach(async () => {
  h.data = await fs.realpath(await createNodeTestArtifactDir('codex-image-composed-wire'))
  resetChatMediaDirCacheForTests()
  __resetCodexRequestGovernorForTests()
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.mcp_config.client.servers = []
  config.llm_config.api_profiles = [
    {
      id: 'selected',
      call_type: 'cliproxyapi',
      model_use: 'agent',
      model_name: 'fixture-text',
      base_url: 'https://provider.fixture/codex',
      api_key: 'fixture-key',
      attachment_transports: ['request-data-url'],
      max_input_images: 5
    },
    {
      id: 'selected-oauth',
      auth_mode: 'codex_oauth',
      model_use: 'agent',
      model_name: 'fixture-text',
      base_url: '',
      api_key: '',
      attachment_transports: ['request-data-url'],
      max_input_images: 5
    }
  ]
  auth.ensure
    .mockReset()
    .mockResolvedValue({ accessToken: 'fixture-oauth', accountId: 'fixture-account' })
  auth.refresh.mockReset().mockRejectedValue(Error('Unexpected OAuth refresh.'))
  vi.mocked(getConfig).mockReturnValue(config)
  sender = Object.assign(new EventEmitter(), {
    id: 103,
    isDestroyed: () => false,
    getURL: () => url
  })
  registerMagicAgentTrustedRouteBinding(103, route, {
    trustedUrl: url,
    trustedWebContents: sender as never
  })
  h.fromId.mockReturnValue(sender)
  h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  store = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
  runtime = new AssistantRuntime({
    sessionStore: store,
    configProvider: getConfig,
    chatService: { chat: vi.fn() }
  })
  vi.spyOn(runtimeModule, 'getAssistantRuntime').mockReturnValue(runtime)
  h.configChanged = undefined
  h.fetch.mockReset()
  h.decode
    .mockReset()
    .mockImplementation(() => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }))
  vi.stubGlobal('fetch', h.fetch)
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MAGICPOT_MCP_STDIO_SERVER', '')
  service = new LLMProxySvcImpl()
  getAssistantTerminalPolicyRuntime()
})
afterEach(async () => {
  sender.emit('did-start-navigation')
  await service.cancelConversation(
    { conversationId: scope.conversationId },
    invocation('cancelConversation')
  )
  closeAssistantTerminalPolicyRuntime()
  await runtime.flush()
  await stopMcpClientManager()
  await stopMagicPotMcpPlatformRuntime()
  clearMagicAgentTrustedRouteBindingsForTest()
  resetChatMediaDirCacheForTests()
  __resetCodexRequestGovernorForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await fs.rm(h.data, { recursive: true, force: true })
})

it.each(
  (['chat', 'chatStream'] as const).flatMap((method) =>
    (
      [
        'deny',
        'stop',
        'navigation',
        'config-link',
        'config-target',
        'late-link',
        'gif-backend-switch',
        'late-gif-backend-switch'
      ] as const
    ).map((boundary) => [method, boundary] as const)
  )
)(
  'linked native %s %s cannot upload/publish late or switch to another backend',
  async (method, boundary) => {
    const text = {
      id: 'ordinary-linked',
      model_name: 'fixture-text',
      provider: 'openai' as const,
      call_type: 'api',
      api_mode: 'responses' as const,
      model_use: 'agent' as const,
      base_url: 'https://independent-text.fixture/v1',
      api_key: 'never-image-key',
      attachment_transports: ['request-data-url'],
      codex_image_profile_id: 'selected-oauth'
    }
    const gifRequest = boundary === 'gif-backend-switch' || boundary === 'late-gif-backend-switch'
    if (gifRequest) getConfig().llm_config.api_profiles[0].base_url = 'https://provider.fixture/v1'
    getConfig().llm_config.api_profiles.push(text)
    let imageCalls = 0,
      textCalls = 0
    let release: (() => void) | undefined
    const imageReply = new Promise<void>((resolve) => {
      release = resolve
    })
    h.fetch.mockImplementation(async (input, init) => {
      const endpoint = String(input),
        body = JSON.parse(String(init.body))
      if (endpoint.endsWith('/images/edits')) {
        imageCalls++
        expect(endpoint).toBe('https://chatgpt.com/backend-api/codex/images/edits')
        expect(init.headers.Authorization).toBe('Bearer fixture-oauth')
        expect(JSON.stringify(init)).not.toContain('never-image-key')
        await imageReply
        return Response.json({
          data: [{ b64_json: gifRequest ? animatedBytes.toString('base64') : encoded }],
          output_format: gifRequest ? 'gif' : 'png'
        })
      }
      expect(endpoint).toBe('https://independent-text.fixture/v1/responses')
      expect(init.headers.Authorization).toBe('Bearer never-image-key')
      textCalls++
      const tool = body.tools.find((tool: { description?: string }) =>
        tool.description?.startsWith('image_gen:')
      )
      expect(tool).toBeDefined()
      return sse([
        {
          type: 'function_call',
          call_id: 'linked-boundary',
          id: 'linked-boundary',
          name: tool.name,
          arguments: JSON.stringify({
            prompt,
            num_last_images_to_include: 1,
            ...(gifRequest ? { gif: {} } : {})
          })
        }
      ])
    })
    const events = vi.fn<(event: LLMChatStreamResp) => void>()
    const req = {
      ...scope,
      profileId: text.id,
      messages: [
        {
          role: 'user' as const,
          content: 'Reference for a later edit.',
          attachments: [
            {
              type: 'image' as const,
              url: `data:image/png;base64,${encoded}`,
              mimeType: 'image/png'
            }
          ]
        }
      ]
    }
    req.messages.push({
      role: 'user',
      content: 'Edit the earlier reference.'
    } as (typeof req.messages)[number])
    let settled = false,
      failure: unknown
    const pending = (
      method === 'chat'
        ? service.chat(req, invocation(method))
        : service.chatStream(req, { onData: events }, invocation(method))
    ).then(
      (value) => {
        settled = true
        return { ok: true as const, value }
      },
      (error) => {
        settled = true
        failure = error
        return { ok: false as const, error }
      }
    )
    const policy = getAssistantTerminalPolicyRuntime()
    await vi.waitFor(() => {
      if (failure) throw failure
      const error = events.mock.calls.find(([event]) => event.type === 'error')
      if (error) throw Error(JSON.stringify(error))
      expect(policy.listPendingTerminalApprovals()).toHaveLength(1)
    })
    expect(imageCalls).toBe(0)
    expect(auth.ensure).not.toHaveBeenCalled()
    const approval = policy.listPendingTerminalApprovals()[0]
    expect(approval.request.request.input).toMatchObject({
      profileId: 'selected-oauth',
      uploadsInputImages: true,
      ...(gifRequest ? { gif: {}, output_format: 'gif', backend: 'codex-json-oauth' } : {})
    })
    expect(JSON.stringify(approval)).not.toContain('base64,')
    expect(JSON.stringify(approval)).not.toContain('never-image-key')
    const resolve = (approved: boolean) =>
      policy.resolvePendingTerminalApproval({
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        approved
      })
    if (boundary === 'deny') resolve(false)
    if (boundary === 'stop')
      await service.cancelConversation(
        { conversationId: scope.conversationId },
        invocation('cancelConversation')
      )
    if (boundary === 'navigation') sender.emit('did-start-navigation')
    if (boundary === 'config-link' || boundary === 'gif-backend-switch') {
      text.codex_image_profile_id = 'selected'
      resolve(true)
    }
    if (boundary === 'config-target') {
      getConfig().llm_config.api_profiles[1].auth_mode = undefined
      h.configChanged?.()
      if (policy.listPendingTerminalApprovals().length) resolve(true)
    }
    if (boundary === 'late-link' || boundary === 'late-gif-backend-switch') {
      resolve(true)
      await vi.waitFor(() => {
        if (failure) throw failure
        expect(imageCalls).toBe(1)
      })
      text.codex_image_profile_id = 'selected'
      release!()
    }
    release!()
    await vi.waitFor(() => expect(settled).toBe(true))
    const outcome = await pending
    if (method === 'chat') expect(outcome.ok).toBe(false)
    expect(
      events.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'done')
        .flatMap((event) => event.attachments ?? [])
    ).toEqual([])
    const outputEvents = events.mock.calls.map(([event]) => event)
    expect(outputEvents.filter((event) => event.type === 'attachment')).toEqual([])
    expect(
      outputEvents.filter((event) => event.type === 'done' && event.finishReason === 'stop')
    ).toEqual([])
    if (method === 'chatStream' && boundary === 'navigation')
      expect(
        outputEvents.filter((event) => event.type === 'done' || event.type === 'error')
      ).toEqual([])
    const afterDispatch = boundary === 'late-link' || boundary === 'late-gif-backend-switch'
    // Inspect the raw attempts as well as the decoded JSON counter: an incorrect /v1 multipart
    // upload or fallback to another endpoint must not be hidden by a failing body parser.
    expect(h.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://independent-text.fixture/v1/responses',
      ...(afterDispatch ? ['https://chatgpt.com/backend-api/codex/images/edits'] : [])
    ])
    expect(imageCalls).toBe(afterDispatch ? 1 : 0)
    expect(textCalls).toBe(1)
    expect(auth.refresh).not.toHaveBeenCalled()
    if (!afterDispatch) expect(auth.ensure).not.toHaveBeenCalled()
    expect(policy.listPendingTerminalApprovals()).toEqual([])
    const failedActions = async () => {
      const session = await store.getSession(route)
      return session!.eventLog
        .map((event) => event.metadata?.agentAction as ToolResultAction | undefined)
        .filter((action) => action?.type === 'tool.result')
    }
    await vi.waitFor(async () => expect(await failedActions()).toHaveLength(1))
    const actions = await failedActions()
    expect(actions[0]?.payload.ok).toBe(false)
    if (afterDispatch)
      expect(actions[0]?.payload.error?.code).toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
    expect(JSON.stringify(actions)).not.toContain('"completed":true')
  }
)

it.each(['chat', 'chatStream'] as const)(
  'continues editing the previous result on a fresh %s turn after approving each upload',
  async (method) => {
    const base = 'https://provider.fixture/v1'
    getConfig().llm_config.api_profiles[0].base_url = base
    const webp = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v02aAA='
    let edits = 0,
      calls = 0
    h.fetch.mockImplementation(async (input, init) => {
      if (String(input) === `${base}/images/edits`) {
        const file = (init.body as FormData).get('image') as File
        expect(Buffer.from(await file.arrayBuffer()).toString('base64')).toBe(
          edits++ === 0 ? webp : encoded
        )
        return edits === 1
          ? Response.json({ data: [{ b64_json: encoded }], output_format: 'png' })
          : Response.json({ data: [{ b64_json: webp }] }) // compatible gateway omits the output-format hint
      }
      expect(String(input)).toBe(`${base}/responses`)
      const body = JSON.parse(String(init.body))
      const step = ++calls
      if (step % 2 === 0)
        return sse([
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }
        ])
      const tool = body.tools.find((entry: { description?: string }) =>
        entry.description?.startsWith('image_gen:')
      )
      return sse([
        {
          type: 'function_call',
          call_id: `edit-${step}`,
          id: `fn-${step}`,
          name: tool.name,
          arguments: JSON.stringify({
            prompt: step === 1 ? 'Preserve the style.' : 'Simplify the previous picture.',
            num_last_images_to_include: 1
          })
        }
      ])
    })
    const policy = getAssistantTerminalPolicyRuntime()
    const turn = async (messages: import('@shared/llm').ChatMessage[]) => {
      const req = { ...scope, profileId: 'selected', messages }
      if (method === 'chat') return service.chat(req, invocation(method))
      const onData = vi.fn<(event: LLMChatStreamResp) => void>()
      await service.chatStream(req, { onData }, invocation(method))
      const done = onData.mock.calls.map(([e]) => e).findLast((e) => e.type === 'done')
      if (!done) throw Error('Missing completed image turn')
      return done
    }
    // Every edit uploads an image, so each turn waits for exactly one formal approval.
    const approveEdit = async () => {
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1), {
        timeout: 10_000
      })
      const [approval] = policy.listPendingTerminalApprovals()
      expect(approval.request.request.input).toMatchObject({
        uploadsInputImages: true,
        inputImages: [expect.any(Object)]
      })
      expect(JSON.stringify(approval)).not.toContain('base64,')
      expect(edits).toBe(approved)
      policy.resolvePendingTerminalApproval({
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        approved: true
      })
      approved++
    }
    let approved = 0
    const first = {
      role: 'user' as const,
      content: '风格不变，设计优化下画面',
      attachments: [
        { type: 'image' as const, mimeType: 'image/webp', url: `data:image/webp;base64,${webp}` }
      ]
    }
    const firstTurn = turn([first])
    await approveEdit()
    const original = await firstTurn
    const media = original.attachments?.[0].media
    expect(media?.kind).toBe('managed')
    const returned = await fs.readFile(path.join(h.data, '.chat_media', media!.relativePath))
    const history = [
      first,
      {
        role: 'assistant' as const,
        content: 'Done.',
        attachments: [
          {
            type: 'image' as const,
            mimeType: 'image/png',
            url: `data:image/png;base64,${returned.toString('base64')}`
          }
        ]
      },
      { role: 'user' as const, content: '目前画面太斑驳、太碎，简化一些。' }
    ]
    const second = turn(history)
    await approveEdit()
    await vi.waitFor(() => {
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      expect(edits).toBe(2)
    })
    const saved = (await second).attachments?.[0].media
    expect(saved).toMatchObject({ kind: 'managed', mimeType: 'image/webp' })
    expect(
      (await fs.readFile(path.join(h.data, '.chat_media', saved!.relativePath))).toString('base64')
    ).toBe(webp)
    expect(calls).toBe(4)
    expect(edits).toBe(2)
    expect(policy.listPendingTerminalApprovals()).toEqual([])
  }
)

it.each(
  (['chat', 'chatStream'] as const).flatMap((method) =>
    (['key', 'oauth'] as const).flatMap((mode) =>
      [false, true].flatMap((edits) =>
        [false, true].flatMap((linked) =>
          [false, true].map((gifOutput) => [method, mode, edits, linked, gifOutput] as const)
        )
      )
    )
  )
)(
  'composed native %s auth=%s edits=%s linked=%s gif=%s → scoped Images wire → managed final image, no fallback',
  async (method, mode, edits, linked, gifOutput) => {
    // Exercise the installed CLIProxy /v1 configuration on both chat entry points.
    const gateway = mode === 'key' && !linked && !gifOutput
    if (gateway) getConfig().llm_config.api_profiles[0].base_url = 'https://provider.fixture/v1'
    const webpEdit = gateway && edits
    const base = gateway
      ? 'https://provider.fixture/v1'
      : mode === 'key'
        ? 'https://provider.fixture/codex'
        : 'https://chatgpt.com/backend-api/codex'
    const imageProfileId = mode === 'key' ? 'selected' : 'selected-oauth'
    const profileId = linked ? 'ordinary-text' : imageProfileId
    const textBase = linked ? 'https://text.fixture/v1' : base
    const textAuthorization = linked
      ? 'Bearer independent-text-key'
      : mode === 'key'
        ? 'Bearer fixture-key'
        : 'Bearer fixture-oauth'
    if (linked)
      getConfig().llm_config.api_profiles.push({
        id: profileId,
        model_use: 'agent',
        provider: 'openai',
        call_type: 'api',
        api_mode: 'responses',
        model_name: 'fixture-text',
        base_url: textBase,
        api_key: 'independent-text-key',
        attachment_transports: ['request-data-url'],
        max_input_images: 5,
        codex_image_profile_id: imageProfileId
      })
    const gifControls = { frame_count: 2, frame_duration_ms: 100 }
    const outputBytes = gifOutput ? animatedBytes : Buffer.from(encoded, 'base64')
    const outputEncoded = outputBytes.toString('base64')
    const authorization = mode === 'key' ? 'Bearer fixture-key' : 'Bearer fixture-oauth'
    let textCalls = 0,
      imageCalls = 0
    h.fetch.mockImplementation(async (input, init) => {
      const endpoint = String(input)
      const multipart = init.body instanceof FormData ? init.body : undefined
      const body = multipart
        ? Object.fromEntries(multipart.entries())
        : JSON.parse(String(init.body))
      if (endpoint === `${base}/images/${edits ? 'edits' : 'generations'}`) {
        expect(init.headers.Authorization).toBe(authorization)
        expect(JSON.stringify(init)).not.toContain('independent-text-key')
        imageCalls++
        expect(init.redirect).toBe('error')
        if (webpEdit) {
          const file = multipart?.get('image') as File
          expect(file?.type).toBe('image/webp')
          expect(file.name).toMatch(/\.webp$/)
          expect(Buffer.from(await file.arrayBuffer()).toString('base64')).toBe(
            'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v02aAA='
          )
          expect(body.prompt).toBe(prompt)
          expect(body.model).toBe('gpt-image-2')
        } else
          expect(body).toEqual({
            prompt,
            background: 'transparent',
            model: 'gpt-image-2',
            size: 'auto',
            quality: 'auto',
            ...(gifOutput ? { output_format: 'gif', ...gifControls } : {}),
            ...(edits ? { images: [{ image_url: `data:image/png;base64,${encoded}` }] } : {})
          })
        return Response.json({
          data: [{ b64_json: outputEncoded }],
          output_format: gifOutput ? 'gif' : 'png'
        })
      }
      expect(endpoint).toBe(`${textBase}/responses`)
      expect(init.headers.Authorization).toBe(textAuthorization)
      textCalls++
      expect(body.model).toBe('fixture-text')
      expect(body.tools).not.toContainEqual(expect.objectContaining({ type: 'image_generation' }))
      if (textCalls % 2 === 1) {
        const tool = body.tools.find((tool: { description?: string }) =>
          tool.description?.startsWith('image_gen:')
        )
        expect(tool).toBeDefined()
        // Schema follows the backend, even when this particular call asks for a still.
        if (gateway) expect(tool.parameters).not.toHaveProperty('properties.gif')
        else expect(tool.parameters).toHaveProperty('properties.gif')
        expect(imageCalls).toBe(textCalls === 1 ? 0 : 1)
        return sse([
          {
            type: 'function_call',
            call_id: 'fixture-image-once',
            id: 'fixture-function',
            name: tool.name,
            arguments: JSON.stringify({
              prompt,
              transparent_background: true,
              ...(gifOutput ? { gif: gifControls } : {}),
              ...(edits ? { num_last_images_to_include: 1 } : {})
            })
          }
        ])
      }
      const output = body.input.findLast(
        (item: { type: string }) => item.type === 'function_call_output'
      )
      expect(output).toMatchObject({ call_id: 'fixture-image-once' })
      // The provider sees only a summary of the receipt, never managed media references.
      expect(output.output).toMatch(
        /^Image generation completed\.( image_count=\d+; edited_images=\d+(; output_format=\w+)?\.)?$/
      )
      expect(output.output).not.toMatch(/managed|local-media:|base64/)
      return sse([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Image generated and persisted.' }]
        }
      ])
    })
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const request = {
      ...scope,
      profileId,
      messages: [
        {
          role: 'user' as const,
          content: webpEdit
            ? '风格不变，优化下画面'
            : gateway
              ? '随便出一张图'
              : 'Please generate this fixture image.',
          ...(edits
            ? {
                attachments: [
                  {
                    type: 'image' as const,
                    url: webpEdit
                      ? 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v02aAA='
                      : `data:image/png;base64,${encoded}`,
                    mimeType: webpEdit ? 'image/webp' : 'image/png'
                  }
                ]
              }
            : {})
        }
      ]
    }
    const call =
      method === 'chat'
        ? service.chat(request, invocation(method))
        : service.chatStream(request, { onData }, invocation(method))
    // Preserve the real early error if framing fails before reaching approval.
    let earlyError: unknown
    const pending = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => {
        earlyError = error
        return { ok: false as const, error }
      }
    )
    const policy = getAssistantTerminalPolicyRuntime()
    if (!gifOutput && !edits) {
      // A plain text-to-image request: no approval is resolved by this fixture, so reaching
      // the wire proves generation didn't wait for a card or a modal. Edits upload images
      // and always wait for the approval below.
      await vi.waitFor(() => {
        if (earlyError) throw earlyError
        expect(imageCalls).toBe(1)
      })
      expect(policy.listPendingTerminalApprovals()).toEqual([])
    } else {
      await vi.waitFor(() => {
        if (earlyError) throw earlyError
        const errorEvent = onData.mock.calls
          .map(([event]) => event)
          .find((event) => event.type === 'error')
        if (errorEvent) throw new Error(JSON.stringify(errorEvent))
        expect(policy.listPendingTerminalApprovals()).toHaveLength(1)
      })
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toMatchObject({
        prompt,
        profileId: imageProfileId,
        backend: gateway
          ? 'openai-images-api-key'
          : mode === 'key'
            ? 'codex-json-api-key'
            : 'codex-json-oauth',
        endpoint: base,
        ...(gifOutput ? { gif: gifControls, output_format: 'gif' } : {})
      })
      expect(imageCalls).toBe(0)
      if (edits) {
        const finalTextRequest = h.fetch.mock.calls.find(
          ([input]) => String(input) === `${textBase}/responses`
        )
        expect(JSON.stringify(JSON.parse(String(finalTextRequest![1]!.body)))).toContain(
          'num_last_images_to_include'
        )
        expect(JSON.stringify(JSON.parse(String(finalTextRequest![1]!.body)))).not.toContain(
          'Local/recent reference edits and GIF are not admitted'
        )
        // The approval names the exact reference image: the WebP attachment on the gateway
        // edit, the PNG one elsewhere.
        const webpFixture = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v02aAA='
        expect(approval.request.request.input).toMatchObject({
          uploadsInputImages: true,
          inputImages: [
            expect.objectContaining(
              webpEdit
                ? {
                    sourceSha256: createHash('sha256')
                      .update(Buffer.from(webpFixture, 'base64'))
                      .digest('hex'),
                    sourceMimeType: 'image/webp',
                    sourceWidth: 2,
                    sourceHeight: 1,
                    sizeBytes: 44,
                    mimeType: 'image/webp'
                  }
                : {
                    sourceSha256: createHash('sha256')
                      .update(Buffer.from(encoded, 'base64'))
                      .digest('hex'),
                    sourceMimeType: 'image/png',
                    sourceWidth: 1,
                    sourceHeight: 1,
                    sizeBytes: 70,
                    mimeType: 'image/png'
                  }
            )
          ]
        })
        expect(JSON.stringify(approval)).not.toContain('base64,')
      }
      policy.resolvePendingTerminalApproval({
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        approved: true
      })
    }
    const outcome = await pending
    if (!outcome.ok) throw outcome.error
    const result =
      method === 'chat'
        ? (outcome.value as LLMChatResp)
        : onData.mock.calls.map(([event]) => event).findLast((event) => event.type === 'done')!
    expect(result).toMatchObject({
      content: 'Image generated and persisted.',
      attachments: [
        expect.objectContaining({
          type: 'image',
          url: expect.stringMatching(/^local-media:/),
          media: expect.objectContaining({
            sha256: createHash('sha256').update(outputBytes).digest('hex'),
            sizeBytes: outputBytes.length
          })
        })
      ],
      metadata: {
        toolHistory: [expect.objectContaining({ toolName: 'image_gen', status: 'completed' })]
      }
    })
    expect(imageCalls).toBe(1)
    expect(textCalls).toBe(2)
    expect(h.fetch).toHaveBeenCalledTimes(3)
    const record = await store.getSession(route)
    const actions = record!.eventLog
      .map((event) => event.metadata?.agentAction as ToolResultAction | undefined)
      .filter((action) => action?.type === 'tool.result')
    expect(actions).toHaveLength(1)
    const receipt = JSON.parse(actions[0]!.payload.content!)
    await expect(
      fs.readFile(path.join(h.data, '.chat_media', receipt.images[0].media.relativePath))
    ).resolves.toEqual(outputBytes)
    if (gifOutput)
      expect(receipt).toMatchObject({
        output_format: 'gif',
        gif: gifControls,
        gif_outputs: [{ width: 1, height: 1, frameCount: 2, totalFramePixels: 2 }]
      })
    const replay = await runtime.callTool(
      route,
      'image_gen',
      {
        prompt,
        transparent_background: true,
        ...(gifOutput ? { gif: gifControls } : {}),
        ...(edits ? { num_last_images_to_include: 1 } : {})
      },
      {
        runId: actions[0]!.correlationId,
        toolCallId: actions[0]!.payload.toolCallId,
        allowedToolNames: ['image_gen']
      }
    )
    expect(replay.content).toBe(actions[0]!.payload.content)
    expect(h.fetch).toHaveBeenCalledTimes(3)
    await store.flush()
    const reopened = new AssistantRuntime({
      sessionStore: new AssistantSessionStore(path.join(h.data, 'sessions.json')),
      configProvider: getConfig,
      chatService: { chat: vi.fn() }
    })
    // Only the existing MAIN runtime receives the original durable identity;
    // nothing supplied by the renderer/model grants replay or filesystem access.
    vi.spyOn(runtime, 'callTool').mockImplementation((requestedRoute, name, input, options) =>
      reopened.callTool(requestedRoute, name, input, {
        ...options,
        runId: actions[0]!.correlationId,
        toolCallId: actions[0]!.payload.toolCallId
      })
    )
    const resumedData = vi.fn<(event: LLMChatStreamResp) => void>()
    const resumed =
      method === 'chat'
        ? await service.chat(request, invocation(method))
        : (await service.chatStream(request, { onData: resumedData }, invocation(method)),
          resumedData.mock.calls.map(([event]) => event).findLast((event) => event.type === 'done'))
    expect(resumed?.attachments).toEqual(result.attachments)
    expect(imageCalls).toBe(1)
    expect(textCalls).toBe(4)
    expect(h.fetch).toHaveBeenCalledTimes(5)
    expect(policy.listPendingTerminalApprovals()).toEqual([])
    await reopened.flush()
    expect(auth.refresh).not.toHaveBeenCalled()
    if (mode === 'key') expect(auth.ensure).not.toHaveBeenCalled()
    else expect(auth.ensure).toHaveBeenCalled()
  }
)
