import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { AGENT_LOCAL_FILE_LIMITS } from '@shared/api/svcAgentLocalFiles'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

type SenderMock = {
  id: number
  destroyed: boolean
  url: string
  isDestroyed(): boolean
  getURL(): string
  on(event: string, cb: () => void): void
  removeListener(event: string, cb: () => void): void
  emit(event: string): void
}
const h = vi.hoisted(() => ({
  sender: null as SenderMock | null,
  parent: null as { webContents: SenderMock | null; isDestroyed(): boolean } | null,
  dataRoot: '',
  prompt: vi.fn(() => {
    throw new Error('Local Agent reads must not prompt')
  })
}))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.dataRoot } }) }))
vi.mock('electron', () => ({
  app: {
    getLocale: () => 'zh-CN',
    getPath: () => h.dataRoot,
    getAppPath: () => process.cwd(),
    isReady: () => true
  },
  utilityProcess: {
    fork: () => {
      throw new Error('No real document process in these fixtures')
    }
  },
  BrowserWindow: { fromWebContents: () => h.parent },
  webContents: { fromId: () => h.sender },
  dialog: { showMessageBox: h.prompt, showOpenDialog: h.prompt }
}))

import { createCanvasPathReadHandler } from './canvasPathReadApproval'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'
const TRUSTED_URL = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=project-a'
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project-a',
  threadId: 'pane-a'
} as const
const request = (patch: Partial<LLMChatReq> = {}): LLMChatReq => ({
  profileId: 'owned-profile',
  conversationId: 'conversation-a',
  route,
  // No actual file path is present: access is the desktop default, not inferred from a path mention.
  messages: [{ role: 'user', content: 'inspect the local project as needed' }],
  ...patch
})
const invocation = (patch: Partial<ServiceInvocationContext> = {}): ServiceInvocationContext => ({
  methodName: 'svcLLMProxy.chatStream',
  senderId: 11,
  frameUrl: TRUSTED_URL,
  senderUrl: TRUSTED_URL,
  isMainFrame: true,
  ...patch
})
function makeSender(): SenderMock {
  const listeners = new Map<string, Set<() => void>>()
  const sender: SenderMock = {
    id: 11,
    destroyed: false,
    url: TRUSTED_URL,
    isDestroyed: () => sender.destroyed,
    getURL: () => sender.url,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
    },
    removeListener(event, cb) {
      listeners.get(event)?.delete(cb)
    },
    emit(event) {
      for (const cb of [...(listeners.get(event) ?? [])]) cb()
    }
  }
  return sender
}
let root = ''
async function fixture(name: string, content: string | Uint8Array = 'hello'): Promise<string> {
  const file = path.join(root, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}
function handler() {
  const created = createCanvasPathReadHandler(request(), invocation())
  expect(created).toBeDefined()
  return created!
}
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}
beforeEach(async () => {
  h.sender = makeSender()
  h.parent = { webContents: h.sender, isDestroyed: () => false }
  h.prompt.mockClear()
  clearMagicAgentTrustedRouteBindingsForTest()
  registerMagicAgentTrustedRouteBinding(11, route, {
    trustedUrl: TRUSTED_URL,
    trustedWebContents: { id: 11, isDestroyed: () => false }
  })
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'canvas-default-local-read-')))
  h.dataRoot = root
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  clearMagicAgentTrustedRouteBindingsForTest()
  await fs.rm(root, { recursive: true, force: true })
  expect(h.prompt).not.toHaveBeenCalled()
})

describe('default reads remain local desktop capabilities', () => {
  it.each([
    'no-identity',
    'untrusted',
    'iframe',
    'remote-route',
    'explicit-skill',
    'media',
    'comparison',
    'wrong-project'
  ])('does not expose a local callback for %s', (kind) => {
    const req = request()
    const inv = invocation()
    if (kind === 'untrusted') inv.senderId = 999
    if (kind === 'iframe') inv.isMainFrame = false
    if (kind === 'remote-route')
      req.route = { channel: 'generic', scopeType: 'dm', scopeId: 'external' }
    if (kind === 'explicit-skill') req.skillRuntime = { skillId: 'external-agent' }
    if (kind === 'media') req.imageGenerationOptions = { enabled: true }
    if (kind === 'comparison') req.comparisonRouting = 'configured'
    if (kind === 'wrong-project') {
      inv.frameUrl = TRUSTED_URL.replace('project-a', 'project-b')
      inv.senderUrl = inv.frameUrl
    }
    expect(
      createCanvasPathReadHandler(req, kind === 'no-identity' ? undefined : inv)
    ).toBeUndefined()
  })
  it('requires the live parent and sender URL to match', () => {
    h.parent!.webContents = { ...h.sender!, id: 99 }
    expect(createCanvasPathReadHandler(request(), invocation())).toBeUndefined()
    h.parent!.webContents = h.sender
    h.sender!.url = TRUSTED_URL + '&different=1'
    expect(createCanvasPathReadHandler(request(), invocation())).toBeUndefined()
  })
})

describe('any ordinary local path is read without a per-path prompt', () => {
  it('reads exact UTF-8 bytes without a path mention and revokes the internal handle afterwards', async () => {
    const content = '你好 café 🌱\r\nsecond line\r\n'
    const file = await fixture('unmentioned 空 格 🌱.txt', content)
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    const revoke = vi.spyOn(LocalFileReadGrants.prototype, 'revokeSender')
    const result = await handler()(file)
    expect(JSON.parse(result.content)).toMatchObject({
      content,
      encoding: 'utf-8',
      returnedBytes: Buffer.byteLength(content)
    })
    expect(result.metadata).toEqual({ source: 'local-file', readOnly: true })
    const grant = await authorize.mock.results[0].value
    expect(result.content).not.toContain(grant.id)
    expect(revoke).toHaveBeenCalled()
  })
  it('reads different paths and repeats reads without any additional confirmation', async () => {
    const a = await fixture('a.txt', 'A')
    const b = await fixture('b.txt', 'B')
    const read = handler()
    for (const [file, value] of [
      [a, 'A'],
      [b, 'B'],
      [a, 'A']
    ]) {
      expect(JSON.parse((await read(file)).content).content).toBe(value)
    }
  })
  it.each(['.git/config', '.env', '.ssh/notes.txt', 'credentials.txt', 'session.kt/notes.txt'])(
    'does not apply a hidden-name or credential-name path blacklist to %s',
    async (name) => {
      const file = await fixture(name, 'SYNTHETIC_TEST_ONLY')
      expect(JSON.parse((await handler()(file)).content).content).toBe('SYNTHETIC_TEST_ONLY')
    }
  )
  it('still rejects non-local device syntax and traversal', async () => {
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    for (const bad of [
      '\\\\.\\PhysicalDrive0',
      '\\\\?\\C:\\item',
      'C:\\root\\..\\item',
      'relative/file'
    ]) {
      await expectCode(handler()(bad), 'PATH_DENIED')
    }
    expect(authorize).not.toHaveBeenCalled()
  })
  it('keeps OS, regular-file, encoding and format errors instead of granting write/execute access', async () => {
    await expectCode(handler()(path.join(root, 'missing.txt')), 'NOT_FOUND')
    await expectCode(handler()(root), 'PATH_DENIED')
    await expectCode(
      handler()(await fixture('binary.png', new Uint8Array([0, 1, 2]))),
      'BINARY_FILE'
    )
  })
  it('enforces smaller caller byte and character bounds', async () => {
    const file = await fixture('bounded.txt', '1234567890')
    const open = vi.spyOn(fs, 'open')
    await expectCode(handler()(file, undefined, { maxBytes: 3 }), 'FILE_TOO_LARGE')
    expect(open).not.toHaveBeenCalled()
    await expectCode(handler()(file, undefined, { maxStringLength: 3 }), 'TEXT_TOO_LARGE')
  })
  it('retains plain text and document size ceilings', async () => {
    await expectCode(
      handler()(
        await fixture('large.txt', Buffer.alloc(AGENT_LOCAL_FILE_LIMITS.fileBytes + 1, 32))
      ),
      'FILE_TOO_LARGE'
    )
    await expectCode(
      handler()(
        await fixture('large.pdf', Buffer.alloc(AGENT_LOCAL_FILE_LIMITS.documentBytes + 1, 32))
      ),
      'FILE_TOO_LARGE'
    )
  })
  it('uses the existing document extractor limit for a supported PDF path', async () => {
    const file = await fixture('document.pdf')
    const read = vi.spyOn(LocalFileReadGrants.prototype, 'read').mockResolvedValue({
      name: 'document.pdf',
      relativePath: '',
      content: 'extracted',
      encoding: 'utf-8',
      sizeBytes: 1,
      returnedBytes: 9,
      truncated: false
    })
    await handler()(file)
    expect(read.mock.calls[0][3]).toEqual({ maxBytes: AGENT_LOCAL_FILE_LIMITS.documentBytes })
  })
})

describe('default bounded directory browsing', () => {
  it('lists names including hidden local paths without reading bodies', async () => {
    await fixture('folder/note.txt', 'BODY_NOT_READ')
    await fixture('.env', 'BODY_NOT_READ')
    const read = vi.spyOn(LocalFileReadGrants.prototype, 'read')
    const result = await handler()(root, undefined, { operation: 'tree', maxDepth: 1 })
    expect(JSON.parse(result.content).entries).toEqual([
      { path: '.env', type: 'file' },
      { path: 'folder', type: 'directory' },
      { path: 'folder/note.txt', type: 'file' }
    ])
    expect(result.content).not.toContain('BODY_NOT_READ')
    expect(result.metadata).toEqual({ source: 'local-directory', readOnly: true })
    expect(read).not.toHaveBeenCalled()
  })
  it('limits depth and the total returned entry count', async () => {
    await fixture('a/child/grandchild.txt')
    await fixture('b.txt')
    await fixture('c.txt')
    const value = JSON.parse(
      (await handler()(root, undefined, { operation: 'tree', maxDepth: 0, maxEntries: 2 })).content
    )
    expect(value.entries.length).toBeLessThanOrEqual(2)
    expect(value.entries.every((entry: { path: string }) => !entry.path.includes('/'))).toBe(true)
    expect(value.truncated).toBe(true)
  })
  it('matches absolute-directory globs without a confirmation or file-content read', async () => {
    await fixture('src/a.ts', 'NOT_READ')
    await fixture('src/b.txt', 'NOT_READ')
    await fixture('top.ts', 'NOT_READ')
    const result = await handler()(root, undefined, {
      operation: 'glob',
      pattern: '**/*.ts',
      maxFiles: 1
    })
    const value = JSON.parse(result.content)
    expect(value.pattern).toBe('**/*.ts')
    expect(value.entries).toHaveLength(1)
    expect(value.entries[0].path.endsWith('.ts')).toBe(true)
    expect(value.truncated).toBe(true)
    expect(result.content).not.toContain('NOT_READ')
  })
  it('rejects traversal patterns before opening the directory', async () => {
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    await expect(
      handler()(root, undefined, { operation: 'glob', pattern: '../*' })
    ).rejects.toThrow()
    expect(authorize).not.toHaveBeenCalled()
  })
  it('reads and selects an absolute JSON file while retaining redaction and prototype guards', async () => {
    const file = await fixture(
      'data.json',
      JSON.stringify({ list: [{ name: 'example', token: 'SYNTHETIC_TOKEN' }] })
    )
    const result = await handler()(file, undefined, { operation: 'json', pointer: '/list/0' })
    expect(JSON.parse(result.content).value).toEqual({ name: 'example', token: '[REDACTED]' })
    await expect(
      handler()(file, undefined, { operation: 'json', pointer: '/__proto__' })
    ).rejects.toThrow()
    const bad = await fixture('bad.json', '{"__proto__":{"polluted":true}}')
    await expect(handler()(bad, undefined, { operation: 'json' })).rejects.toThrow(
      'valid safe JSON'
    )
    expect({}).not.toHaveProperty('polluted')
  })

  it('honors an explicit JSON string limit larger than the default', async () => {
    const text = 'x'.repeat(20_000)
    const file = await fixture('large-json-string.json', JSON.stringify({ text }))
    const read = handler()
    const explicit = JSON.parse(
      (
        await read(file, undefined, {
          operation: 'json',
          maxStringLength: 32_768
        })
      ).content
    )
    expect(explicit.value.text).toBe(text)
    expect(explicit.truncated).toBe(false)
    const defaults = JSON.parse((await read(file, undefined, { operation: 'json' })).content)
    expect(defaults.value.text).toHaveLength(16_384)
    expect(defaults.truncated).toBe(true)
  })

  it('supports drive roots without enumerating the real root in this synthetic test', async () => {
    const drive = path.parse(root).root
    const list = vi.spyOn(LocalFileReadGrants.prototype, 'list').mockResolvedValue({
      entries: [{ name: 'owned-fixture', kind: 'directory' }],
      truncated: false
    })
    const opendir = vi.spyOn(fs, 'opendir')
    const value = JSON.parse(
      (await handler()(drive, undefined, { operation: 'tree', maxDepth: 0 })).content
    )
    expect(value.root).toBe(drive)
    expect(list).toHaveBeenCalledOnce()
    expect(opendir).not.toHaveBeenCalled()
  })
})

describe('cancellation, lifecycle and bounded concurrent work', () => {
  it('does not start a pre-cancelled read', async () => {
    const controller = new AbortController()
    controller.abort()
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    await expectCode(handler()(path.join(root, 'missing.txt'), controller.signal), 'CANCELLED')
    expect(authorize).not.toHaveBeenCalled()
  })
  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'])(
    'drops a completed read on %s before delivery',
    async (event) => {
      const file = await fixture('read.txt')
      const realRead = LocalFileReadGrants.prototype.read
      vi.spyOn(LocalFileReadGrants.prototype, 'read').mockImplementation(async function (
        this: LocalFileReadGrants,
        ...args
      ) {
        const result = await realRead.apply(this, args)
        h.sender!.emit(event)
        return result
      })
      await expectCode(handler()(file), 'SCOPE_CHANGED')
    }
  )
  it('checks live navigation before starting an operation', async () => {
    const read = handler()
    h.sender!.url = TRUSTED_URL.replace('project-a', 'project-b')
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    await expectCode(read(path.join(root, 'missing.txt')), 'SCOPE_CHANGED')
    expect(authorize).not.toHaveBeenCalled()
  })
  it('drops directory results on cancellation or navigation', async () => {
    await fixture('visible.txt')
    const controller = new AbortController()
    const realList = LocalFileReadGrants.prototype.list
    vi.spyOn(LocalFileReadGrants.prototype, 'list').mockImplementation(async function (
      this: LocalFileReadGrants,
      ...args
    ) {
      const result = await realList.apply(this, args)
      controller.abort()
      return result
    })
    await expectCode(handler()(root, controller.signal, { operation: 'tree' }), 'CANCELLED')
  })
  it('bounds concurrent reads and releases its slot afterwards', async () => {
    const file = await fixture('concurrent.txt')
    const read = handler()
    const pending = read(file)
    await expectCode(read(file), 'BUSY')
    await pending
    await expect(read(file)).resolves.toHaveProperty('content')
  })
})

describe('real adapter and kernel preserve default read access and explicit tool restrictions', () => {
  it.each(['files.read', 'files.tree', 'files.glob', 'files.json.read'] as const)(
    'executes absolute %s through the real registry without prompting',
    async (tool) => {
      const { AssistantExecutionAdapter } = await import('../assistantRuntime/executionAdapter')
      const { AssistantSessionStore } = await import('../assistantRuntime/sessionStore')
      const { DEFAULT_CONFIG } = await import('@shared/config/config')
      const file = await fixture('directory/owned.txt', 'OWNED_CONTENT')
      const workspace = path.join(root, 'workspace')
      await fs.mkdir(workspace)
      const jsonFile = await fixture('directory/data.json', '{"answer":42}')
      const store = new AssistantSessionStore(path.join(root, 'owned-session.json'))
      const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
      try {
        const result = await adapter.callTool(
          tool,
          {
            path:
              tool === 'files.tree' || tool === 'files.glob'
                ? path.dirname(file)
                : tool === 'files.json.read'
                  ? jsonFile
                  : file,
            ...(tool === 'files.glob' ? { pattern: '*.txt' } : {})
          },
          {
            config: DEFAULT_CONFIG,
            route,
            sessionStore: store,
            workspaceRootDir: workspace,
            taskState: { sessionKey: 'owned', running: false, queuedCount: 0, updatedAt: 1 },
            readExternalFile: handler()
          },
          { allowedToolNames: [tool], runId: 'owned-integration-run' }
        )
        const value = JSON.parse(result.content)
        if (tool === 'files.read') expect(value.content).toBe('OWNED_CONTENT')
        else if (tool === 'files.json.read') expect(value.value).toEqual({ answer: 42 })
        else if (tool === 'files.glob')
          expect(value.entries).toEqual([{ path: 'owned.txt', type: 'file' }])
        else
          expect(value.entries).toEqual([
            { path: 'data.json', type: 'file' },
            { path: 'owned.txt', type: 'file' }
          ])
        const actions = (await store.getSession(route))?.eventLog?.map(
          (event) => event.metadata?.agentAction
        )
        expect(JSON.stringify(actions)).toContain('tool.result')
        expect(JSON.stringify(actions)).not.toContain('readExternalFile')
      } finally {
        await store.flush()
      }
    }
  )
  it.each(['files.read', 'files.tree'] as const)(
    'does not override an explicit denial of %s',
    async (tool) => {
      const { AssistantExecutionAdapter } = await import('../assistantRuntime/executionAdapter')
      const { AssistantSessionStore } = await import('../assistantRuntime/sessionStore')
      const { DEFAULT_CONFIG } = await import('@shared/config/config')
      const store = new AssistantSessionStore(path.join(root, 'denied-session.json'))
      const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
      const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
      try {
        await expect(
          adapter.callTool(
            tool,
            { path: root },
            {
              config: DEFAULT_CONFIG,
              route,
              sessionStore: store,
              workspaceRootDir: root,
              taskState: { sessionKey: 'owned', running: false, queuedCount: 0, updatedAt: 1 },
              readExternalFile: handler()
            },
            { allowedToolNames: [], runId: 'denied-run' }
          )
        ).rejects.toThrow()
        expect(authorize).not.toHaveBeenCalled()
      } finally {
        await store.flush()
      }
    }
  )
})
