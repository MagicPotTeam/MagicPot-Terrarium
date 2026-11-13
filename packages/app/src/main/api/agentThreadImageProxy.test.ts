import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({
  gifEnabled: false,
  data: '',
  fromId: vi.fn(),
  parent: vi.fn(),
  fetch: vi.fn(),
  generate: vi.fn(),
  edit: vi.fn(),
  decode: vi.fn(),
  current: vi.fn(),
  runtime: undefined as import('../assistantRuntime/runtime').AssistantRuntime | undefined
}))
vi.mock('electron', () => ({
  MessagePortMain: class {},
  net: {},
  app: { getPath: () => h.data, getAppPath: () => process.cwd(), isReady: () => true },
  webContents: { fromId: h.fromId },
  BrowserWindow: { fromWebContents: h.parent },
  nativeImage: { createFromBuffer: h.decode }
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({
    ...DEFAULT_BUILD_ENV,
    pathMap: { data: h.data, file: h.data, resources: '' }
  })
}))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  onConfigCommitted: vi.fn()
}))
vi.mock(import('@shared/llm'), async (original) => ({
  ...(await original()),
  cliFromProfile: vi.fn()
}))
vi.mock('../extensions/generatedRegistry', () => ({
  mainHostExtensionApiV1: {
    llmProxy: [
      {
        id: 'local-image-fixture',
        createThreadImageGenerator: () => ({
          gifEnabled: h.gifEnabled,
          approval: {
            backend: 'codex-json-api-key',
            endpoint: 'https://image.fixture/codex',
            profileId: 'agent-profile'
          },
          assertCurrent: h.current,
          generate: h.generate,
          edit: h.edit
        })
      }
    ]
  }
}))

import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { LLMChatReq, LLMChatResp, LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import type { LLMChatResult } from '@shared/llm'
import { getAgentSessionKey } from '@shared/agent'
import type { ToolResultAction } from '@shared/agent'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import * as runtimeModule from '../assistantRuntime/runtime'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { resetChatMediaDirCacheForTests } from '../llmProxy/chatMediaDir'
import {
  getAssistantTerminalPolicyRuntime,
  closeAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import { stopMcpClientManager } from '../mcp/runtime'
import { stopMagicPotMcpPlatformRuntime } from '../mcp/platform/runtime'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { createBinaryChunkTransport } from '@shared/binaryChunkProtocol'

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'image-project',
  threadId: 'pane'
} as const
const scope = { route, conversationId: 'image-chat' }
const url = 'file:///D:/owned/app/index.html#/canvas?id=image-project'
const invocation = (method: string) => ({
  methodName: `svcLLMProxy.${method}`,
  senderId: 97,
  frameUrl: url,
  senderUrl: url,
  isMainFrame: true
})
// Actual one-pixel RGBA PNG with CRC-checked chunks and zlib-compressed scanline.
// Byte persistence is verified here; this is not an installed UI decode test.
const png = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg2JLyHwAD6AIYhAHF9gAAAABJRU5ErkJggg==',
    'base64'
  )
const gifOutputBytes = (count = 2) =>
  Buffer.concat([
    Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
    Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex'),
    ...Array.from({ length: count }, () =>
      Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex')
    ),
    Buffer.from([0x3b])
  ])
const highBitGif = () => {
  const bytes = gifOutputBytes()
  for (let index = 0; index < 6; index++) bytes[index] |= 0x80
  return bytes
}
const gifResult = (bytes = gifOutputBytes()): LLMChatResult => ({
  content: '',
  finishReason: 'stop',
  attachments: [
    {
      type: 'image',
      mimeType: 'image/gif',
      url: `data:image/gif;base64,${bytes.toString('base64')}`
    }
  ]
})
const imageResult = (): LLMChatResult => ({
  content: '',
  finishReason: 'stop',
  attachments: [
    {
      type: 'image',
      mimeType: 'image/png',
      url: `data:image/png;base64,${png().toString('base64')}`
    }
  ]
})
let sender: EventEmitter
let store: AssistantSessionStore
let service: LLMProxySvcImpl
const modes = [
  ['chat', false],
  ['chat', true],
  ['chatStream', false],
  ['chatStream', true]
] as const
const args = { prompt: 'A fixture frog cutout', transparent_background: true }
const results = async () => {
  const session = await store.getSession(route)
  return (session?.eventLog ?? [])
    .map((event) => event.metadata?.agentAction as ToolResultAction | undefined)
    .filter((action) => action?.type === 'tool.result')
}

beforeEach(async () => {
  h.gifEnabled = false
  h.data = await fs.realpath(await createNodeTestArtifactDir('proxy-image-tool'))
  resetChatMediaDirCacheForTests()
  const config = structuredClone(DEFAULT_CONFIG)
  config.mcp_config.client.servers = []
  config.llm_config.api_profiles = [
    {
      id: 'agent-profile',
      model_name: 'Agent Model',
      base_url: 'https://text.fixture/v1',
      api_key: 'never-used',
      attachment_transports: ['request-data-url'],
      max_input_images: 5
    }
  ]
  vi.mocked(getConfig).mockReturnValue(config)
  vi.stubEnv('MAGICPOT_MCP_STDIO_SERVER', '')
  h.fetch.mockReset().mockRejectedValue(Error('No fixture may use a live network.'))
  vi.stubGlobal('fetch', h.fetch)
  h.current.mockReset()
  h.generate.mockReset().mockImplementation(async () => imageResult())
  h.edit.mockReset().mockImplementation(async () => imageResult())
  h.decode.mockReset().mockImplementation(() => ({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 }),
    resize: () => {
      throw Error('One-pixel input must not be resized.')
    }
  }))
  sender = Object.assign(new EventEmitter(), {
    id: 97,
    isDestroyed: () => false,
    getURL: () => url
  })
  registerMagicAgentTrustedRouteBinding(97, route, {
    trustedUrl: url,
    trustedWebContents: sender as never
  })
  h.fromId.mockReturnValue(sender)
  h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  store = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
  h.runtime = new AssistantRuntime({
    sessionStore: store,
    configProvider: getConfig,
    chatService: { chat: vi.fn() }
  })
  vi.spyOn(runtimeModule, 'getAssistantRuntime').mockReturnValue(h.runtime)
  getAssistantTerminalPolicyRuntime()
  vi.stubEnv('NODE_ENV', 'production')
  service = new LLMProxySvcImpl()
})
afterEach(async () => {
  sender?.emit('did-start-navigation')
  closeAssistantTerminalPolicyRuntime()
  await service?.cancelConversation(
    { conversationId: scope.conversationId },
    invocation('cancelConversation')
  )
  await h.runtime?.flush()
  await stopMcpClientManager()
  await stopMagicPotMcpPlatformRuntime()
  clearMagicAgentTrustedRouteBindingsForTest()
  resetChatMediaDirCacheForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  h.runtime = undefined
  await fs.rm(h.data, { recursive: true, force: true })
  vi.clearAllMocks()
})

function model(native: boolean, toolArgs: Record<string, unknown> = args) {
  const chat = vi.fn().mockImplementation(async (input) => {
    expect(input.disableAutomaticImageGeneration).toBe(true)
    if (chat.mock.calls.length > 1) {
      const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
      expect(transcript).toContain('local-media:')
      expect(
        transcript.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/gu, '[input]')
      ).not.toContain('base64,')
      return { content: 'Generated image receipt received.', finishReason: 'stop' }
    }
    const name = 'image_gen'
    const index = input.tools?.findIndex((tool: { name: string }) => tool.name === name)
    if (native) {
      expect(index, 'Ordinary native thread must discover image_gen.').toBeGreaterThanOrEqual(0)
      return {
        content: '',
        toolCalls: [
          {
            id: 'generate-once',
            name,
            wireName: `mp_tool_${index}`,
            arguments: JSON.stringify(toolArgs)
          }
        ]
      }
    }
    expect(input.systemPrompt).toContain('image_gen')
    return JSON.stringify({ toolName: name, args: toolArgs })
  })
  vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
  return chat
}
function start(
  method: 'chat' | 'chatStream',
  onData: (event: LLMChatStreamResp) => void,
  overrides: Partial<LLMChatReq> = {}
) {
  const req: LLMChatReq = {
    ...scope,
    profileId: 'agent-profile',
    messages: [{ role: 'user', content: 'Generate the reviewed picture once.' }],
    ...overrides
  }
  const call =
    method === 'chat'
      ? service.chat(req, invocation(method))
      : service.chatStream(req, { onData }, invocation(method))
  return call.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
}
async function approval() {
  const policy = getAssistantTerminalPolicyRuntime()
  await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
  const entry = policy.listPendingTerminalApprovals()[0]
  return {
    entry,
    resolve: (approved = true) =>
      policy.resolvePendingTerminalApproval({
        approvalId: entry.approvalId,
        expectedRevision: entry.revision,
        approved
      })
  }
}

it.each([false, true])('GIF schema is exposed only with MAIN capability=%s', async (enabled) => {
  const { createAgentThreadImageTools } = await import('./agentThreadImageTools')
  const provider = createAgentThreadImageTools({
    ...scope,
    signal: new AbortController().signal,
    generator: {
      gifEnabled: enabled,
      approval: {
        backend: 'codex-json-api-key',
        endpoint: 'https://image.fixture/codex',
        profileId: 'agent-profile'
      },
      assertCurrent: h.current,
      generate: h.generate
    },
    assertLive: () => {},
    assertInvocation: () => {}
  })
  const schema = provider.listTools()[0].inputSchema
  if (enabled)
    expect(schema).toHaveProperty('properties.gif', {
      type: 'object',
      additionalProperties: false,
      properties: {
        frame_count: { type: 'integer', minimum: 2, maximum: 16 },
        frame_duration_ms: { type: 'integer', minimum: 20, maximum: 2000 }
      }
    })
  else expect(schema).not.toHaveProperty('properties.gif')
})

function gifProvider(enabled = true, messages: import('@shared/llm').ChatMessage[] = []) {
  return import('./agentThreadImageTools').then(({ createAgentThreadImageTools }) =>
    createAgentThreadImageTools({
      ...scope,
      signal: new AbortController().signal,
      messages,
      generator: {
        gifEnabled: enabled,
        approval: {
          backend: 'codex-json-api-key',
          endpoint: 'https://image.fixture/codex',
          profileId: 'agent-profile'
        },
        assertCurrent: h.current,
        generate: h.generate,
        edit: h.edit
      },
      assertLive: () => {},
      assertInvocation: () => {}
    })
  )
}
it.each([
  null,
  false,
  [],
  'gif',
  { frame_count: 1 },
  { frame_count: 17 },
  { frame_count: true },
  { frame_count: 2.5 },
  { frame_count: '2' },
  { frame_duration_ms: 19 },
  { frame_duration_ms: 2001 },
  { frame_duration_ms: false },
  { frame_duration_ms: 20.5 },
  { frameCount: 2 },
  { extra: 1 }
])('GIF invalid controls %j fail before approval or generation', async (gif) => {
  const provider = await gifProvider()
  await expect(
    provider.callTool('image_gen', { ...args, gif }, { route, runId: 'invalid-gif' })
  ).rejects.toThrow('Invalid image_gen')
  expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.edit).not.toHaveBeenCalled()
})
it.each([false, true])(
  'GIF cannot be model enabled when trusted capability is %s',
  async (explicit) => {
    const provider = await gifProvider(false)
    await expect(
      provider.callTool(
        'image_gen',
        {
          ...args,
          gif: {},
          ...(explicit ? { gifEnabled: true, codex_image_gif_enabled: true } : {})
        },
        { route, runId: 'off' }
      )
    ).rejects.toThrow('Invalid image_gen')
    expect(h.generate).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    [false, true].map((edits) => [method, native, edits] as const)
  )
)(
  'GIF %s native=%s edits=%s has exact approval, managed replay and no GIF input admission',
  async (method, native, edits) => {
    h.gifEnabled = true
    const gifArgs = {
      ...args,
      gif: edits ? {} : { frame_count: 2, frame_duration_ms: 100 },
      ...(edits ? { num_last_images_to_include: 1 } : {})
    }
    const gifBytes = gifOutputBytes()
    h.generate.mockResolvedValue(gifResult(gifBytes))
    h.edit.mockResolvedValue(gifResult(gifBytes))
    const chat = model(native, gifArgs)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const requestInputs: Partial<LLMChatReq> = edits
      ? {
          messages: [
            {
              role: 'user',
              content: 'Animate attached PNG.',
              attachments: [imageResult().attachments![0]]
            }
          ]
        }
      : {}
    const pending = start(method, onData, requestInputs)
    const permit = await Promise.race([
      approval(),
      pending.then((outcome) => {
        throw outcome.ok ? Error('No GIF approval') : outcome.error
      })
    ])
    expect(permit.entry.request.request.input).toMatchObject({ ...gifArgs, output_format: 'gif' })
    expect(h.generate).not.toHaveBeenCalled()
    permit.resolve()
    const outcome = await pending
    if (!outcome.ok) throw outcome.error
    const response =
      method === 'chat'
        ? (outcome.value as LLMChatResp)
        : onData.mock.calls.map(([e]) => e).findLast((e) => e.type === 'done')
    expect(response?.attachments).toHaveLength(1)
    expect(response?.attachments?.[0]).toMatchObject({
      mimeType: 'image/gif',
      fileName: 'generated-1.gif'
    })
    const generator = edits ? h.edit : h.generate
    if (edits)
      expect(h.edit).toHaveBeenCalledWith(
        args.prompt,
        [imageResult().attachments![0].url],
        expect.objectContaining({ gif: {} })
      )
    else
      expect(h.generate).toHaveBeenCalledWith(
        args.prompt,
        expect.objectContaining({ gif: { frameCount: 2, frameDurationMs: 100 } })
      )
    expect(generator).toHaveBeenCalledOnce()
    expect(chat).toHaveBeenCalledTimes(2)
    expect(h.decode).toHaveBeenCalledTimes(edits ? 1 : 0)
    const actions = await results()
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload.ok).toBe(true)
    const receipt = JSON.parse(actions[0]!.payload.content!)
    expect(receipt).toMatchObject({
      completed: true,
      output_format: 'gif',
      gif: gifArgs.gif,
      gif_outputs: [{ width: 1, height: 1, frameCount: 2, totalFramePixels: 2 }]
    })
    await store.flush()
    const reopened = new AssistantRuntime({
      sessionStore: new AssistantSessionStore(path.join(h.data, 'sessions.json')),
      configProvider: getConfig,
      chatService: { chat: vi.fn() }
    })
    vi.spyOn(h.runtime!, 'callTool').mockImplementation((requestedRoute, name, input, options) =>
      reopened.callTool(requestedRoute, name, input, {
        ...options,
        runId: actions[0]!.correlationId,
        toolCallId: actions[0]!.payload.toolCallId
      })
    )
    model(native, gifArgs)
    const replayEvents = vi.fn<(event: LLMChatStreamResp) => void>()
    const replay = await start(method, replayEvents, requestInputs)
    if (!replay.ok) throw replay.error
    const restored =
      method === 'chat'
        ? (replay.value as LLMChatResp)
        : replayEvents.mock.calls.map(([e]) => e).findLast((e) => e.type === 'done')
    expect(restored?.attachments).toEqual(response?.attachments)
    expect(generator).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    await reopened.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    ['deny', 'stop', 'navigation', 'changed'].map((ending) => [method, native, ending] as const)
  )
)(
  'GIF %s native=%s %s before dispatch never generates or publishes',
  async (method, native, ending) => {
    h.gifEnabled = true
    model(native, { ...args, gif: {} })
    const events = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start(method, events)
    const permit = await approval()
    if (ending === 'stop')
      await service.cancelConversation(
        { conversationId: scope.conversationId },
        invocation('cancelConversation')
      )
    else if (ending === 'navigation') sender.emit('did-start-navigation')
    else {
      if (ending === 'changed')
        h.current.mockImplementation(() => {
          throw Error('GIF opt-in revoked.')
        })
      permit.resolve(ending !== 'deny')
    }
    const outcome = await pending
    if (method === 'chat') expect(outcome.ok).toBe(false)
    expect(
      events.mock.calls
        .map(([e]) => e)
        .filter((e) => e.type === 'attachment' || (e.type === 'done' && e.finishReason === 'stop'))
    ).toEqual([])
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.edit).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    const actions = await results()
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload.ok).toBe(false)
  }
)
it.each(
  modes.flatMap(([method, native]) =>
    ['stop', 'navigation', 'changed'].map((ending) => [method, native, ending] as const)
  )
)(
  'GIF %s native=%s %s after dispatch discards late output with no retry',
  async (method, native, ending) => {
    h.gifEnabled = true
    model(native, { ...args, gif: {} })
    let release!: (r: LLMChatResult) => void
    h.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const events = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start(method, events)
    const permit = await approval()
    permit.resolve()
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalledOnce())
    if (ending === 'stop')
      await service.cancelConversation(
        { conversationId: scope.conversationId },
        invocation('cancelConversation')
      )
    else if (ending === 'navigation') sender.emit('did-start-navigation')
    else
      h.current.mockImplementation(() => {
        throw Error('GIF opt-in revoked.')
      })
    release(gifResult())
    const outcome = await pending
    if (method === 'chat') expect(outcome.ok).toBe(false)
    await vi.waitFor(async () => {
      const actions = await results()
      expect(actions).toHaveLength(1)
      expect(actions[0]?.payload).toMatchObject({
        ok: false,
        error: { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' }
      })
    })
    expect(
      events.mock.calls
        .map(([e]) => e)
        .filter((e) => e.type === 'attachment' || (e.type === 'done' && e.finishReason === 'stop'))
    ).toEqual([])
    if (ending === 'navigation')
      expect(
        events.mock.calls.map(([e]) => e).filter((e) => e.type === 'done' || e.type === 'error')
      ).toEqual([])
    expect(h.generate).toHaveBeenCalledOnce()
    expect(h.edit).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(h.data, '.chat_media'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  }
)

it.each([
  'still',
  'missing-frames',
  'wrong-count',
  'oversized',
  'invalid-second',
  'high-bit-signature',
  'high-bit-second',
  'unrequested'
] as const)(
  'GIF output %s fails after dispatch without managed publication or automatic retry',
  async (kind) => {
    const provider = await gifProvider()
    let output = gifResult()
    const input = { ...args, ...(kind !== 'unrequested' ? { gif: { frame_count: 2 } } : {}) }
    if (kind === 'still') output = imageResult()
    if (kind === 'missing-frames') output = gifResult(gifOutputBytes(1))
    if (kind === 'wrong-count') output = gifResult(gifOutputBytes(3))
    if (kind === 'oversized') {
      const bytes = gifOutputBytes()
      bytes.writeUInt16LE(4097, 6)
      output = gifResult(bytes)
    }
    if (kind === 'invalid-second')
      output.attachments!.push(gifResult(Buffer.from('GIF89a')).attachments![0])
    if (kind === 'high-bit-signature') output = gifResult(highBitGif())
    if (kind === 'high-bit-second')
      output.attachments!.push(gifResult(highBitGif()).attachments![0])
    h.generate.mockResolvedValue(output)
    const pending = provider
      .callTool('image_gen', input, { route, runId: kind, toolCallId: kind })
      .catch((error) => error)
    const permit = await approval()
    permit.resolve()
    expect(await pending).toMatchObject({
      code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN',
      retryBlocked: true
    })
    expect(provider.completedAttachments()).toEqual([])
    expect(h.generate).toHaveBeenCalledOnce()
    await expect(fs.stat(path.join(h.data, '.chat_media'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  }
)

it.each(['fresh', 'replay'] as const)(
  'GIF %s owned output remains a newest input sentinel, never substitutes the older PNG',
  async (kind) => {
    const provider = await gifProvider(true, [
      { role: 'user', content: '', attachments: [imageResult().attachments![0]] }
    ])
    h.generate.mockResolvedValue(gifResult())
    const generated = provider.callTool(
      'image_gen',
      { ...args, gif: {} },
      { route, runId: 'gif', toolCallId: 'gif' }
    )
    const permit = await approval()
    permit.resolve()
    const result = await generated
    const restored =
      kind === 'fresh'
        ? provider
        : await gifProvider(true, [
            { role: 'user', content: '', attachments: [imageResult().attachments![0]] }
          ])
    await restored.acceptCompletedResult(result)
    await restored.acceptCompletedResult(result)
    expect(restored.completedAttachments()).toHaveLength(1)
    await expect(
      restored.callTool(
        'image_gen',
        { ...args, num_last_images_to_include: 1 },
        { route, runId: 'do-not-skip-gif' }
      )
    ).rejects.toThrow()
    expect(h.edit).not.toHaveBeenCalled()
    expect(h.generate).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  }
)

it.each([
  'opt-out',
  'forged-summary',
  'malformed-summary',
  'invalid-controls',
  'missing-output-mode',
  'wrong-scope',
  'missing-file'
] as const)('GIF replay %s never publishes, rereads input or regenerates', async (kind) => {
  const provider = await gifProvider()
  h.generate.mockResolvedValue(gifResult())
  const pending = provider.callTool(
    'image_gen',
    { ...args, gif: {} },
    { route, runId: 'source', toolCallId: 'source' }
  )
  const permit = await approval()
  permit.resolve()
  const result = await pending
  const receipt = JSON.parse(result.content)
  if (kind === 'forged-summary') receipt.gif_outputs[0].frameCount = 16
  if (kind === 'malformed-summary') receipt.gif_outputs[0] = null
  if (kind === 'invalid-controls') receipt.gif = { frame_count: true }
  if (kind === 'missing-output-mode') delete receipt.output_format
  if (kind === 'wrong-scope')
    receipt.images[0].media.relativePath = receipt.images[0].media.relativePath.replace(
      'user-output/',
      'thread-attachments/'
    )
  if (kind === 'missing-file')
    await fs.unlink(path.join(h.data, '.chat_media', receipt.images[0].media.relativePath))
  const restored = await gifProvider(kind !== 'opt-out')
  await expect(
    restored.acceptCompletedResult({ ...result, content: JSON.stringify(receipt) })
  ).rejects.toMatchObject({ code: 'IMAGE_RESULT_RESTORE_FAILED', retryBlocked: true })
  expect(restored.completedAttachments()).toEqual([])
  expect(h.generate).toHaveBeenCalledOnce()
  expect(h.edit).not.toHaveBeenCalled()
  expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
})

it.each([0, 1])(
  'GIF replay rejects integrity-matching high-bit signature at batch index %s without partial publication',
  async (index) => {
    const source = await gifProvider()
    h.generate.mockResolvedValue(gifResult())
    const pending = source.callTool(
      'image_gen',
      { ...args, gif: {} },
      { route, runId: 'legacy-signature', toolCallId: 'legacy-signature' }
    )
    const permit = await approval()
    permit.resolve()
    const result = await pending
    const receipt = JSON.parse(result.content)
    const [{ getChatMediaDir, getChatMediaNamespaceDir }, { importManagedMedia }] =
      await Promise.all([
        import('../llmProxy/chatMediaDir'),
        import('../llmProxy/managedMediaStore')
      ])
    // Model a legacy stored malformed GIF with valid store hash/metadata. The
    // unchanged store's ASCII sniff is not the Agent structural-signature barrier.
    const scopeHash = createHash('sha256')
      .update(JSON.stringify([getAgentSessionKey(route), scope.conversationId]))
      .digest('hex')
    const imported = await importManagedMedia(
      getChatMediaNamespaceDir('user-output', scopeHash),
      {
        bytes: highBitGif(),
        mimeType: 'image/gif',
        originalFileName: `generated-${index + 1}.gif`,
        provenance: { source: 'legacy-signature-fixture' }
      },
      { authorizedRoot: getChatMediaDir() }
    )
    const invalid = {
      type: 'image',
      media: imported.reference,
      mimeType: 'image/gif',
      url: imported.localMediaUrl,
      fileName: `generated-${index + 1}.gif`
    }
    if (index === 0) receipt.images[0] = invalid
    else {
      receipt.images.push(invalid)
      receipt.image_count = 2
      receipt.gif_outputs.push({ ...receipt.gif_outputs[0] })
    }
    const inspect = vi.spyOn(await import('./agentThreadImageGif'), 'inspectThreadImageGif')
    const restored = await gifProvider()
    await expect(
      restored.acceptCompletedResult({ ...result, content: JSON.stringify(receipt) })
    ).rejects.toMatchObject({ code: 'IMAGE_RESULT_RESTORE_FAILED', retryBlocked: true })
    expect(inspect).toHaveBeenLastCalledWith(highBitGif())
    expect(restored.completedAttachments()).toEqual([])
    expect(h.generate).toHaveBeenCalledOnce()
    expect(h.edit).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  }
)

it.each(modes)(
  'provider mutation during %s native=%s cannot replace the captured image_gen input',
  async (method, native) => {
    const image = imageResult().attachments![0]
    const originalUrl = image.url
    const chat = model(native, { ...args, num_last_images_to_include: 1 })
    const respond = chat.getMockImplementation()!
    const replaced = vi.fn()
    chat.mockImplementation(async (input) => {
      // This models a careless provider-side in-place image replacement, not a
      // production transformer. The tool's original request snapshot must survive.
      const attachment = input.messages?.[0]?.attachments?.[0]
      if (attachment) {
        attachment.url = 'data:image/png;base64,AAAA'
        replaced(attachment.url)
      }
      return respond(input)
    })
    const pending = start(method, vi.fn(), {
      messages: [{ role: 'user', content: 'Use the original image.', attachments: [image] }]
    })
    const permit = await Promise.race([
      approval(),
      pending.then((outcome) => {
        throw outcome.ok ? Error('No image approval') : outcome.error
      })
    ])
    expect(replaced).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    expect(permit.entry.request.request.input).toMatchObject({
      inputImages: [
        expect.objectContaining({
          sourceSha256: createHash('sha256').update(png()).digest('hex'),
          sha256: createHash('sha256').update(png()).digest('hex')
        })
      ]
    })
    permit.resolve()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw outcome.error
    expect(h.edit).toHaveBeenCalledWith(
      args.prompt,
      [originalUrl],
      expect.objectContaining({ transparentBackground: true, signal: expect.any(AbortSignal) })
    )
  }
)

it.each(modes)(
  'binary %s native=%s retains captured original bytes across provider mutation and approval',
  async (method, native) => {
    const original = png()
    const binary = await createBinaryChunkTransport(original, {
      mimeType: 'image/png',
      chunkSize: 32
    })
    const image = {
      type: 'image' as const,
      url: 'binary:reference-not-a-path',
      mimeType: 'image/png',
      binary: { transport: 'chunked-binary-v1' as const, ...binary }
    }
    const originalFrames = structuredClone(image.binary)
    const expectedUrl = `data:image/png;base64,${original.toString('base64')}`
    const chat = model(native, { ...args, num_last_images_to_include: 1 })
    const respond = chat.getMockImplementation()!
    const replaced = vi.fn()
    chat.mockImplementation(async (input) => {
      const attachment = input.messages?.[0]?.attachments?.[0]
      if (attachment) {
        attachment.url = 'data:image/png;base64,AAAA'
        replaced(attachment.url)
      }
      return respond(input)
    })
    const pending = start(method, vi.fn(), {
      messages: [{ role: 'user', content: 'Edit exact binary.', attachments: [image] }]
    })
    const permit = await Promise.race([
      approval(),
      pending.then((outcome) => {
        throw outcome.ok ? Error('No image approval') : outcome.error
      })
    ])
    expect(replaced).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    const hash = createHash('sha256').update(original).digest('hex')
    expect(permit.entry.request.request.input).toMatchObject({
      inputImages: [
        expect.objectContaining({ sourceSha256: hash, sha256: hash, sizeBytes: original.length })
      ]
    })
    expect(image.binary).toEqual(originalFrames)
    permit.resolve()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw outcome.error
    expect(h.edit).toHaveBeenCalledWith(
      args.prompt,
      [expectedUrl],
      expect.objectContaining({ transparentBackground: true, signal: expect.any(AbortSignal) })
    )
  }
)

it('invalid newest sentinel in the direct tool-provider snapshot never falls back to an older image', async () => {
  const older = imageResult().attachments![0]
  const newest = {
    type: 'image' as const,
    url: `data:image/png;base64,${'A'.repeat(28_000_100)}`,
    mimeType: 'image/png'
  }
  const provider = await gifProvider(false, [
    { role: 'user', content: 'Use newest only.', attachments: [older, newest] }
  ])
  await expect(
    provider.callTool(
      'image_gen',
      { ...args, num_last_images_to_include: 1 },
      {
        route,
        runId: 'invalid-newest-sentinel'
      }
    )
  ).rejects.toThrow('Recent image')
  expect(h.edit).not.toHaveBeenCalled()
  expect(h.generate).not.toHaveBeenCalled()
  expect(h.decode).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
  expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
})

it.each(modes)(
  'recent %s native=%s edits a supplied image after exact upload approval',
  async (method, native) => {
    const editArgs = { ...args, num_last_images_to_include: 1 }
    const chat = model(native, editArgs)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const image = imageResult().attachments![0]
    const pending = start(method, onData, {
      messages: [{ role: 'user', content: 'Add the reviewed hat.', attachments: [image] }]
    })
    const permit = await Promise.race([
      approval(),
      pending.then((outcome) => {
        throw outcome.ok ? Error('Request ended without image upload approval.') : outcome.error
      })
    ])
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.edit).not.toHaveBeenCalled()
    const hash = createHash('sha256').update(png()).digest('hex')
    expect(permit.entry.request.request.input).toMatchObject({
      ...editArgs,
      endpoint: 'https://image.fixture/codex',
      inputImages: [
        expect.objectContaining({
          sourceSha256: hash,
          sha256: hash,
          sizeBytes: png().length,
          mimeType: 'image/png',
          width: 1,
          height: 1
        })
      ]
    })
    expect(JSON.stringify(permit.entry)).not.toContain('base64,')
    permit.resolve()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw outcome.error
    const response =
      method === 'chat'
        ? (outcome.value as LLMChatResp)
        : onData.mock.calls.map(([event]) => event).findLast((event) => event.type === 'done')
    expect(response?.attachments).toHaveLength(1)
    expect(response?.attachments?.[0].url).toMatch(/^local-media:/)
    expect(h.edit).toHaveBeenCalledOnce()
    expect(h.edit).toHaveBeenCalledWith(
      args.prompt,
      [image.url],
      expect.objectContaining({ transparentBackground: true, signal: expect.any(AbortSignal) })
    )
    expect(h.generate).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledTimes(2)
    const actions = await results()
    expect(actions).toHaveLength(1)
    expect(JSON.parse(actions[0]!.payload.content!)).toMatchObject({
      completed: true,
      edited_images: 1,
      image_count: 1
    })
    await store.flush()
    const reopened = new AssistantRuntime({
      sessionStore: new AssistantSessionStore(path.join(h.data, 'sessions.json')),
      configProvider: getConfig,
      chatService: { chat: vi.fn() }
    })
    await expect(
      reopened.callTool(route, 'image_gen', editArgs, {
        runId: actions[0]!.correlationId,
        toolCallId: actions[0]!.payload.toolCallId,
        allowedToolNames: ['image_gen']
      })
    ).resolves.toMatchObject({ content: actions[0]!.payload.content })
    expect(h.edit).toHaveBeenCalledOnce()
    expect(h.generate).not.toHaveBeenCalled()
    // Conditional replay: MAIN supplies the original identity. Restoring output
    // does not re-read/re-decode/re-upload an input or grant a fresh edit permit.
    vi.spyOn(h.runtime!, 'callTool').mockImplementation((requestedRoute, name, input, options) =>
      reopened.callTool(requestedRoute, name, input, {
        ...options,
        runId: actions[0]!.correlationId,
        toolCallId: actions[0]!.payload.toolCallId
      })
    )
    const decodedBeforeReplay = h.decode.mock.calls.length
    model(native, editArgs)
    const replayData = vi.fn<(event: LLMChatStreamResp) => void>()
    const resumed = await start(method, replayData)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw resumed.error
    const restored =
      method === 'chat'
        ? (resumed.value as LLMChatResp)
        : replayData.mock.calls.map(([event]) => event).findLast((event) => event.type === 'done')
    expect(restored?.attachments).toEqual(response?.attachments)
    expect(h.edit).toHaveBeenCalledOnce()
    expect(h.decode).toHaveBeenCalledTimes(decodedBeforeReplay)
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    await reopened.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

const sourceImage = () => imageResult().attachments![0]
const variant = (value: number) => {
  const data = Buffer.from(`fixture\0${value}`),
    part = Buffer.alloc(data.length + 12)
  part.writeUInt32BE(data.length)
  part.write('tEXt', 4)
  data.copy(part, 8)
  let crc = 0xffffffff
  for (const byte of part.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  part.writeUInt32BE((crc ^ 0xffffffff) >>> 0, part.length - 4)
  const bytes = png()
  return {
    ...sourceImage(),
    url: `data:image/png;base64,${Buffer.concat([bytes.subarray(0, -12), part, bytes.subarray(-12)]).toString('base64')}`
  }
}

it.each(['current', 'legacy'] as const)(
  'repeated acceptance of one %s durable result does not invent another recent image',
  async (format) => {
    const { createAgentThreadImageTools } = await import('./agentThreadImageTools')
    const provider = createAgentThreadImageTools({
      ...scope,
      messages: [{ role: 'user', content: '', attachments: [sourceImage()] }],
      signal: new AbortController().signal,
      generator: {
        approval: {
          backend: 'codex-json-api-key',
          endpoint: 'https://image.fixture/codex',
          profileId: 'agent-profile'
        },
        assertCurrent: h.current,
        generate: h.generate,
        edit: h.edit
      },
      assertLive: () => {},
      assertInvocation: () => {}
    })
    const first = provider.callTool('image_gen', args, {
      route,
      runId: 'first',
      toolCallId: 'generated'
    })
    const permit = await approval()
    permit.resolve()
    const generation = await first
    expect(generation.metadata!.imagePublicationId).toMatch(/^[a-f0-9]{64}$/u)
    const result =
      format === 'legacy' ? { ...generation, metadata: { ...generation.metadata } } : generation
    if (format === 'legacy') delete result.metadata!.imagePublicationId
    await provider.acceptCompletedResult(result)
    await provider.acceptCompletedResult(result)
    expect(provider.completedAttachments()).toHaveLength(1)
    const edit = provider
      .callTool(
        'image_gen',
        { ...args, num_last_images_to_include: 3 },
        { route, runId: 'edit', toolCallId: 'edit' }
      )
      .then(
        () => ({ error: undefined as unknown }),
        (error) => ({ error: error as unknown })
      )
    let settled = false
    void edit.then(() => {
      settled = true
    })
    await vi.waitFor(() =>
      expect(
        settled || getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals().length > 0
      ).toBe(true)
    )
    const unexpected = getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()[0]
    if (unexpected)
      getAssistantTerminalPolicyRuntime().resolvePendingTerminalApproval({
        approvalId: unexpected.approvalId,
        expectedRevision: unexpected.revision,
        approved: false
      })
    const outcome = await edit
    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toContain('Only 2 recent image(s)')
    expect(h.edit).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  }
)

it.each(modes)(
  'recent %s native=%s edits five distinct supplied images newest-first',
  async (method, native) => {
    const supplied = [variant(1), variant(2), variant(3), variant(4), variant(5)]
    const chat = model(native, { ...args, num_last_images_to_include: 5 })
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start(method, onData, {
      messages: [
        {
          role: 'user',
          content: 'Edit all five in newest-first order.',
          attachments: supplied
        }
      ]
    })
    const permit = await approval()
    expect(permit.entry.request.request.input).toMatchObject({
      num_last_images_to_include: 5,
      inputImages: Array.from({ length: 5 }, () =>
        expect.objectContaining({ mimeType: 'image/png', width: 1, height: 1 })
      )
    })
    permit.resolve()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw outcome.error
    expect(h.edit.mock.calls[0][1]).toEqual(supplied.toReversed().map((image) => image.url))
    expect(h.generate).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledTimes(2)
    expect(JSON.parse((await results())[0]!.payload.content!)).toMatchObject({
      completed: true,
      edited_images: 5
    })
  }
)

it.each(['valid', 'missing', 'corrupt'] as const)(
  'generate then edit current-loop owned managed image: %s',
  async (ending) => {
    let step = 0
    const first = model(true),
      original = first.getMockImplementation()!
    // After generation, ask for a new edit in the same live tool loop. Only the
    // provider's owned validated output may enter the read seam, not tool text.
    first.mockImplementation(async (input) => {
      step++
      if (step === 1) return original(input)
      if (step === 2) {
        const action = (await results())[0]!
        const receipt = JSON.parse(action.payload.content!)
        const filename = path.join(h.data, '.chat_media', receipt.images[0].media.relativePath)
        if (ending === 'missing') await fs.unlink(filename)
        if (ending === 'corrupt') {
          const bytes = png()
          bytes[bytes.length - 1] ^= 1
          await fs.writeFile(filename, bytes)
        }
        const tool = input.tools!.findIndex((tool: { name: string }) => tool.name === 'image_gen')
        expect(tool).toBeGreaterThanOrEqual(0)
        return {
          content: '',
          toolCalls: [
            {
              id: 'edit-current-loop',
              name: 'image_gen',
              wireName: `mp_tool_${tool}`,
              arguments: JSON.stringify({ ...args, num_last_images_to_include: 1 })
            }
          ],
          finishReason: 'tool_call'
        }
      }
      return { content: 'Owned edit complete.', finishReason: 'stop' }
    })
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start('chat', onData)
    const generationPermit = await approval()
    generationPermit.resolve()
    if (ending === 'valid') {
      // The first permit has already been consumed. Wait for a DIFFERENT approval,
      // not the just-resolved entry still completing its coordinator microtask.
      await Promise.race([
        pending.then((outcome) => {
          throw outcome.ok ? Error('No second approval.') : outcome.error
        }),
        vi.waitFor(() => {
          const approvals = getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()
          expect(approvals).toHaveLength(1)
          expect(approvals[0].approvalId).not.toBe(generationPermit.entry.approvalId)
        })
      ])
      const editPermit = await approval()
      expect(editPermit.entry.request.request.input).toMatchObject({
        num_last_images_to_include: 1
      })
      editPermit.resolve()
    }
    const outcome = await pending
    expect(outcome.ok).toBe(ending === 'valid')
    expect(h.generate).toHaveBeenCalledOnce()
    expect(h.edit).toHaveBeenCalledTimes(ending === 'valid' ? 1 : 0)
    if (ending === 'valid') expect(h.edit.mock.calls[0][1]).toEqual([sourceImage().url])
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(modes)(
  'ordinary %s native=%s approves, persists image and restores replayed final attachments without dispatch',
  async (method, native) => {
    const chat = model(native)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start(method, onData)
    const permit = await approval()
    expect(h.generate).not.toHaveBeenCalled()
    expect(permit.entry.request.request.target.id).toBe('image_gen')
    expect(permit.entry.request.request.input).toMatchObject({
      ...args,
      conversationId: scope.conversationId,
      backend: 'codex-json-api-key',
      endpoint: 'https://image.fixture/codex',
      profileId: 'agent-profile'
    })
    permit.resolve()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw outcome.error
    const response =
      method === 'chat'
        ? (outcome.value as LLMChatResp)
        : onData.mock.calls.map(([event]) => event).findLast((event) => event.type === 'done')
    expect(response).toMatchObject({
      finishReason: 'stop',
      attachments: [
        expect.objectContaining({
          type: 'image',
          url: expect.stringMatching(/^local-media:/),
          media: expect.objectContaining({
            kind: 'managed',
            sha256: createHash('sha256').update(png()).digest('hex')
          })
        })
      ],
      metadata: {
        toolHistory: [expect.objectContaining({ toolName: 'image_gen', status: 'completed' })]
      }
    })
    expect(h.generate).toHaveBeenCalledOnce()
    expect(h.generate).toHaveBeenCalledWith(
      args.prompt,
      expect.objectContaining({ transparentBackground: true, signal: expect.any(AbortSignal) })
    )
    expect(chat).toHaveBeenCalledTimes(2)
    const actions = await results()
    expect(actions).toHaveLength(1)
    const action = actions[0]!
    expect(action.payload).toMatchObject({ ok: true, toolName: 'image_gen' })
    const receipt = JSON.parse(action.payload.content!)
    expect(receipt).toMatchObject({ image_count: 1, edited_images: 0, completed: true })
    expect(JSON.stringify(receipt)).not.toContain('base64,')
    await expect(
      fs.readFile(path.join(h.data, '.chat_media', receipt.images[0].media.relativePath))
    ).resolves.toEqual(png())
    // A retained display URL is data, not a filesystem permit. Only the validated
    // managed reference may reconstruct the final attachment's canonical URL.
    receipt.images[0].url = 'local-media:///D:/unowned/forged-replay-image.png'
    action.payload.content = JSON.stringify(receipt)
    await store.appendEvents(route, [])
    await store.flush()
    const runtime = new AssistantRuntime({
      sessionStore: new AssistantSessionStore(path.join(h.data, 'sessions.json')),
      configProvider: getConfig,
      chatService: { chat: vi.fn() }
    })
    const replay = await runtime.callTool(route, 'image_gen', args, {
      runId: action.correlationId,
      toolCallId: action.payload.toolCallId,
      allowedToolNames: ['image_gen']
    })
    expect(replay.content).toBe(action.payload.content)
    expect(h.generate).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    // Simulate MAIN's retained durable invocation identity, not a renderer-granted
    // retry flag: the entire second request still uses current thread admission,
    // model planning, real reopened journal/runtime and final result plumbing.
    vi.spyOn(h.runtime!, 'callTool').mockImplementation((requestedRoute, name, input, options) =>
      runtime.callTool(requestedRoute, name, input, {
        ...options,
        runId: action.correlationId,
        toolCallId: action.payload.toolCallId
      })
    )
    model(native)
    const replayData = vi.fn<(event: LLMChatStreamResp) => void>()
    const resumed = await start(method, replayData)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw resumed.error
    const restored =
      method === 'chat'
        ? (resumed.value as LLMChatResp)
        : replayData.mock.calls.map(([event]) => event).findLast((event) => event.type === 'done')
    expect(restored?.attachments).toEqual(response?.attachments)
    expect(h.generate).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    await runtime.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    (['deny', 'stop', 'navigation', 'changed'] as const).flatMap((ending) =>
      [false, true].map((edits) => [method, native, ending, edits] as const)
    )
  )
)(
  '%s native=%s %s edits=%s before dispatch never generates or publishes',
  async (method, native, ending, edits) => {
    const chat = model(native, edits ? { ...args, num_last_images_to_include: 1 } : args)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start(
      method,
      onData,
      edits
        ? {
            messages: [
              { role: 'user', content: 'Edit this.', attachments: [imageResult().attachments![0]] }
            ]
          }
        : {}
    )
    const permit = await approval()
    if (ending === 'stop') {
      await service.cancelConversation(
        { conversationId: scope.conversationId },
        invocation('cancelConversation')
      )
    } else if (ending === 'navigation') sender.emit('did-start-navigation')
    else {
      if (ending === 'changed') {
        h.current.mockImplementation(() => {
          throw Error('Image backend changed.')
        })
      }
      permit.resolve(ending !== 'deny')
    }
    const outcome = await pending
    if (method === 'chat') expect(outcome.ok).toBe(false)
    const events = onData.mock.calls.map(([event]) => event)
    expect(events.filter((event) => event.type === 'attachment')).toEqual([])
    expect(
      events.filter((event) => event.type === 'done' && event.finishReason === 'stop')
    ).toEqual([])
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.edit).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    (['stop', 'navigation'] as const).flatMap((ending) =>
      [false, true].map((edits) => [method, native, ending, edits] as const)
    )
  )
)(
  '%s native=%s %s edits=%s after dispatch drops late images and retains unknown outcome',
  async (method, native, ending, edits) => {
    const chat = model(native, edits ? { ...args, num_last_images_to_include: 1 } : args)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    let started!: () => void
    let release!: (result: LLMChatResult) => void
    const dispatch = new Promise<void>((resolve) => {
      started = resolve
    })
    const generate = edits ? h.edit : h.generate
    generate.mockImplementation(() => {
      started()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const pending = start(
      method,
      onData,
      edits
        ? {
            messages: [
              { role: 'user', content: 'Edit this.', attachments: [imageResult().attachments![0]] }
            ]
          }
        : {}
    )
    const permit = await approval()
    permit.resolve()
    await dispatch
    const signal = generate.mock.calls[0][edits ? 2 : 1].signal as AbortSignal
    if (ending === 'stop') {
      await service.cancelConversation(
        { conversationId: scope.conversationId },
        invocation('cancelConversation')
      )
    } else sender.emit('did-start-navigation')
    await pending
    expect(signal.aborted).toBe(true)
    expect(chat).toHaveBeenCalledOnce()
    release(imageResult())
    await vi.waitFor(async () => {
      const actions = await results()
      expect(actions).toHaveLength(1)
      expect(actions[0]?.payload).toMatchObject({
        ok: false,
        error: { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' }
      })
    })
    expect(generate).toHaveBeenCalledOnce()
    expect(edits ? h.generate : h.edit).not.toHaveBeenCalled()
    expect(
      onData.mock.calls.map(([event]) => event).filter((event) => event.type === 'attachment')
    ).toEqual([])
    await expect(fs.stat(path.join(h.data, '.chat_media'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    [
      { ...args, confirmed: true },
      { ...args, base_url: 'https://model-selected.invalid' },
      { ...args, referenced_image_paths: ['secret.png'] },
      { ...args, num_last_images_to_include: 0 },
      { ...args, num_last_images_to_include: 6 },
      { ...args, num_last_images_to_include: 1.5 },
      { ...args, gif: {} }
    ].map((input) => [method, native, input] as const)
  )
)(
  '%s native=%s rejects unsupported or authority-bearing arguments %j before approval',
  async (method, native, input) => {
    const chat = model(native, input)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const outcome = await start(method, onData)
    if (method === 'chat') expect(outcome.ok).toBe(false)
    expect(chat).toHaveBeenCalledOnce()
    expect(h.generate).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    (['missing', 'corrupt', 'insufficient', 'unsupported', 'decode'] as const).map(
      (kind) => [method, native, kind] as const
    )
  )
)(
  '%s native=%s recent %s never substitutes another image or dispatches',
  async (method, native, kind) => {
    const supplied = imageResult().attachments![0]
    if (kind === 'corrupt') {
      const corrupt = png()
      corrupt[corrupt.length - 1] ^= 1
      supplied.url = `data:image/png;base64,${corrupt.toString('base64')}`
    }
    if (kind === 'unsupported') {
      supplied.url = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs='
      supplied.mimeType = 'image/gif'
    }
    if (kind === 'decode')
      h.decode.mockReturnValue({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) })
    const chat = model(native, {
      ...args,
      num_last_images_to_include: kind === 'insufficient' ? 2 : 1
    })
    const events = vi.fn<(event: LLMChatStreamResp) => void>()
    const outcome = await start(method, events, {
      messages: [
        {
          role: 'user',
          content: 'Edit selected.',
          ...(kind === 'missing' ? {} : { attachments: [supplied] })
        }
      ]
    })
    if (method === 'chat') expect(outcome.ok).toBe(false)
    else expect(events.mock.calls.some(([event]) => event.type === 'error')).toBe(true)
    expect(chat).toHaveBeenCalledOnce()
    expect(h.edit).not.toHaveBeenCalled()
    expect(h.generate).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    const actions = await results()
    expect(actions).toHaveLength(1)
    expect(actions[0]!.payload.ok).toBe(false)
    expect(actions[0]!.payload.error?.code).not.toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(modes)(
  '%s native=%s invalid image fails rather than reporting task or attachment success',
  async (method, native) => {
    h.generate.mockResolvedValue({
      content: 'submitted',
      attachments: [{ type: 'image', mimeType: 'image/png', url: 'data:image/png;base64,QUJD' }]
    })
    const chat = model(native)
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const pending = start(method, onData)
    const permit = await approval()
    permit.resolve()
    const outcome = await pending
    if (method === 'chat') expect(outcome.ok).toBe(false)
    expect(
      onData.mock.calls.map(([event]) => event).filter((event) => event.type === 'attachment')
    ).toEqual([])
    expect(chat).toHaveBeenCalledOnce()
    expect(h.generate).toHaveBeenCalledOnce()
    const actions = await results()
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload).toMatchObject({
      ok: false,
      error: { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' }
    })
    await expect(
      h.runtime!.callTool(route, 'image_gen', args, {
        runId: actions[0]!.correlationId,
        toolCallId: actions[0]!.payload.toolCallId,
        allowedToolNames: ['image_gen']
      })
    ).rejects.toMatchObject({ code: 'TOOL_REPLAY_REQUIRES_REVIEW' })
    expect(h.generate).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  }
)

it.each(
  modes.flatMap(([method, native]) =>
    (
      [
        'missing',
        'corrupt',
        'foreign-conversation',
        'forged-path',
        'second-missing',
        'stop',
        'navigation',
        'config'
      ] as const
    ).map((ending) => [method, native, ending] as const)
  )
)(
  '%s native=%s replay %s fails without regeneration, approval or partial attachments',
  async (method, native, ending) => {
    model(native)
    const firstData = vi.fn<(event: LLMChatStreamResp) => void>()
    const initial = start(method, firstData)
    const permit = await approval()
    permit.resolve()
    const first = await initial
    expect(first.ok).toBe(true)
    const [action] = await results()
    const receipt = JSON.parse(action!.payload.content!)
    const originalPath = path.join(h.data, '.chat_media', receipt.images[0].media.relativePath)
    if (ending === 'missing') await fs.unlink(originalPath)
    if (ending === 'corrupt') {
      const corrupt = Buffer.from(png())
      corrupt[45] ^= 1
      await fs.writeFile(originalPath, corrupt)
    }
    if (ending === 'forged-path') {
      receipt.images[0].media.relativePath = 'user-output/foreign/originals/../secret.png'
      action!.payload.content = JSON.stringify(receipt)
    }
    if (ending === 'second-missing') {
      const hash = 'a'.repeat(64)
      const extra = structuredClone(receipt.images[0])
      extra.media.sha256 = hash
      extra.media.relativePath = extra.media.relativePath.replace(
        /originals\/.+$/,
        `originals/aa/${hash}.png`
      )
      extra.media.originalFileName = 'generated-2.png'
      receipt.images.push(extra)
      receipt.image_count = 2
      action!.payload.content = JSON.stringify(receipt)
    }
    await store.appendEvents(route, [])
    await store.flush()
    const restoredStore = new AssistantSessionStore(path.join(h.data, 'sessions.json'))
    const reopened = new AssistantRuntime({
      sessionStore: restoredStore,
      configProvider: getConfig,
      chatService: { chat: vi.fn() }
    })
    const resolution = await import('../llmProxy/managedMediaStore')
    const actualResolve = resolution.resolveManagedMediaReference
    if (['stop', 'navigation', 'config'].includes(ending)) {
      vi.spyOn(resolution, 'resolveManagedMediaReference').mockImplementation(async (...input) => {
        const result = await actualResolve(...input)
        if (ending === 'stop')
          await service.cancelConversation(
            { conversationId: scope.conversationId },
            invocation('cancelConversation')
          )
        else if (ending === 'navigation') sender.emit('did-start-navigation')
        else
          h.current.mockImplementation(() => {
            throw Error('Image backend changed.')
          })
        return result
      })
    }
    vi.spyOn(h.runtime!, 'callTool').mockImplementation((requestedRoute, name, input, options) =>
      reopened.callTool(requestedRoute, name, input, {
        ...options,
        runId: action!.correlationId,
        toolCallId: action!.payload.toolCallId
      })
    )
    const chat = model(native)
    const replayData = vi.fn<(event: LLMChatStreamResp) => void>()
    const second = await start(
      method,
      replayData,
      ending === 'foreign-conversation' ? { conversationId: 'other-chat' } : {}
    )
    const events = replayData.mock.calls.map(([event]) => event)
    if (method === 'chat') {
      expect(second.ok).toBe(false)
      if (!second.ok && !['stop', 'navigation'].includes(ending))
        expect(second.error).toMatchObject({ code: 'IMAGE_RESULT_RESTORE_FAILED' })
    }
    // Navigation closes this document's channel; no terminal is sent to its new
    // owner. Stop has a cancelled terminal, other live failures have an error.
    else if (ending === 'navigation')
      expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toEqual([])
    else
      expect(
        events.some(
          (event) =>
            event.type === 'error' || (event.type === 'done' && event.finishReason === 'cancelled')
        )
      ).toBe(true)
    if (method === 'chatStream' && !['stop', 'navigation'].includes(ending))
      expect(events.find((event) => event.type === 'error')?.error).toContain(
        'Saved image result is unavailable or invalid'
      )
    expect(events.filter((event) => event.type === 'attachment')).toEqual([])
    expect(
      events.filter((event) => event.type === 'done' && event.finishReason === 'stop')
    ).toEqual([])
    expect(chat).toHaveBeenCalledOnce()
    expect(h.generate).toHaveBeenCalledOnce()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    const saved = await restoredStore.getSession(route)
    const settled = saved!.eventLog.filter(
      (event) =>
        (event.metadata?.agentAction as ToolResultAction | undefined)?.type === 'tool.result'
    )
    expect(settled).toHaveLength(1)
    expect((settled[0].metadata!.agentAction as ToolResultAction).payload.ok).toBe(true)
    await reopened.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  }
)
