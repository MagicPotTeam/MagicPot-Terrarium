import { afterEach, describe, expect, it } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'
import {
  CANVAS_READ_TOOL_NAMES,
  CANVAS_WEB_TOOL_NAMES,
  withCanvasFileTools
} from './canvasFileTools'
const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=project-a'
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project-a',
  threadId: 'pane-a'
} as const
const req = (): LLMChatReq => ({
  profileId: 'owned-profile',
  conversationId: 'conversation-a',
  route,
  messages: [{ role: 'user', content: String.raw`Read "D:\Project Notes\report.txt"` }]
})
const invoke = (): ServiceInvocationContext => ({
  methodName: 'svcLLMProxy.chatStream',
  senderId: 11,
  frameUrl: url,
  senderUrl: url,
  isMainFrame: true
})
function trust() {
  registerMagicAgentTrustedRouteBinding(11, route, {
    trustedUrl: url,
    trustedWebContents: { id: 11, isDestroyed: () => false }
  })
}
afterEach(clearMagicAgentTrustedRouteBindingsForTest)
describe('canvas file tools without a persistent file form', () => {
  it.each(['svcLLMProxy.chat', 'svcLLMProxy.chatStream'])(
    'exposes existing readonly tools for trusted %s without changing user paths',
    (methodName) => {
      trust()
      const input = req()
      const before = JSON.stringify(input)
      const output = withCanvasFileTools(input, { ...invoke(), methodName })
      expect(output.skillRuntime?.bindings?.[0]?.toolNames).toEqual([
        ...CANVAS_READ_TOOL_NAMES,
        ...CANVAS_WEB_TOOL_NAMES
      ])
      expect(output.messages).toBe(input.messages)
      expect(JSON.stringify(input)).toBe(before)
      expect(output.systemPrompt).toContain('not file contents')
      expect(output.skillRuntime?.bindings?.[0]?.toolNames).not.toContain('files.write')
    }
  )
  it.each(['svcLLMProxy.chat', 'svcLLMProxy.chatStream'])(
    'keeps read tools when %s carries the disabled image settings emitted by ChatPage',
    (methodName) => {
      trust()
      const input: LLMChatReq = {
        ...req(),
        imageGenerationOptions: {
          enabled: false,
          outputFormat: 'png',
          size: 'auto',
          quality: 'high',
          background: 'auto'
        }
      }
      const before = JSON.stringify(input)
      const output = withCanvasFileTools(input, { ...invoke(), methodName })
      expect(output.skillRuntime?.bindings?.[0]?.toolNames).toEqual([
        ...CANVAS_READ_TOOL_NAMES,
        ...CANVAS_WEB_TOOL_NAMES
      ])
      expect(output.imageGenerationOptions).toBe(input.imageGenerationOptions)
      expect(output.messages).toBe(input.messages)
      expect(JSON.stringify(input)).toBe(before)
      expect(withCanvasFileTools(input)).toBe(input)
      expect(withCanvasFileTools(input, { ...invoke(), senderId: 999 })).toBe(input)
    }
  )
  it.each([{ enabled: true }, { action: 'edit' }, {}] as LLMChatReq['imageGenerationOptions'][])(
    'does not add file tools to an enabled or unspecified image request %j',
    (imageGenerationOptions) => {
      trust()
      const input = { ...req(), imageGenerationOptions }
      expect(withCanvasFileTools(input, invoke())).toBe(input)
    }
  )
  it('does not add file tools to an explicit image request contract', () => {
    trust()
    const input = {
      ...req(),
      imageGenerationOptions: { enabled: false },
      imageRequest: {
        version: 1,
        schema: 'magicpot.image-request.v1',
        requestId: 'request-1',
        taskId: 'task-1',
        action: 'edit',
        history: {},
        limits: {
          maxImages: 1,
          maxBytesPerImage: 1,
          maxTotalBytes: 1,
          maxRequestBodyBytes: 1
        },
        permission: { images: true, externalFetch: false }
      }
    } satisfies LLMChatReq
    expect(withCanvasFileTools(input, invoke())).toBe(input)
  })
  it('does not grant defaults to a direct or remote main-process caller without IPC identity', () => {
    const r = req()
    expect(withCanvasFileTools(r)).toBe(r)
  })
  it('does not grant defaults to an unregistered sender', () => {
    const r = req()
    expect(withCanvasFileTools(r, invoke())).toBe(r)
  })
  it.each([
    { isMainFrame: false },
    { senderId: 12 },
    { frameUrl: 'https://untrusted.test/#/canvas?id=project-a' },
    { senderUrl: 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=other-project' },
    { frameUrl: 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=project-a&id=project-a' },
    { methodName: 'svcOther.chat' }
  ])('rejects untrusted or mismatched IPC context %j', (patch) => {
    trust()
    const r = req()
    expect(withCanvasFileTools(r, { ...invoke(), ...patch })).toBe(r)
  })
  it.each([
    { skillRuntime: { skillId: 'restricted', bindings: [{ appId: 'explicit', toolNames: [] }] } },
    { skillRuntime: { skillId: 'external-agent' } },
    { route: { ...route, channel: 'generic' } },
    { route: { ...route, threadId: '' } },
    { conversationId: '' },
    { imageGenerationOptions: { action: 'generate' } },
    { videoGenerationOptions: {} }
  ] as Partial<LLMChatReq>[])('preserves explicit skill/media/route boundaries %j', (patch) => {
    trust()
    const r = { ...req(), ...patch }
    expect(withCanvasFileTools(r, invoke())).toBe(r)
  })
})
