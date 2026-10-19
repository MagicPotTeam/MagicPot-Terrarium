import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'

// Use the real filesystem for genuine temporary UTF-8 fixtures (setup otherwise maps fs to memfs).
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

const h = vi.hoisted(() => {
  const state: {
    sender: SenderMock | null
    parent: { destroyed: boolean; webContents: SenderMock | null; isDestroyed(): boolean } | null
    dialogCalls: Record<string, unknown>[]
    mode: 'auto' | 'manual'
    response: number
    pending: null | ((value: { response: number }) => void)
    locale: string
    dataRoot: string
  } = {
    sender: null,
    parent: null,
    dialogCalls: [],
    mode: 'auto',
    response: 1,
    pending: null,
    locale: 'en-US',
    dataRoot: ''
  }
  return state
})

vi.mock('electron', () => ({
  app: {
    getLocale: () => h.locale,
    getPath: () => h.dataRoot,
    getAppPath: () => process.cwd(),
    isReady: () => true
  },
  utilityProcess: {
    fork: () => {
      throw new Error('utilityProcess.fork must not run for plain text reads')
    }
  },
  BrowserWindow: { fromWebContents: () => h.parent },
  webContents: { fromId: () => h.sender },
  dialog: {
    showMessageBox: (_parent: unknown, options: Record<string, unknown>) => {
      h.dialogCalls.push(options)
      if (h.mode === 'manual') {
        return new Promise((resolve) => {
          h.pending = resolve as (value: { response: number }) => void
        })
      }
      return Promise.resolve({ response: h.response, checkboxChecked: false })
    }
  }
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
  messages: [{ role: 'user', content: 'read the path I mentioned' }],
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

function trust(): void {
  registerMagicAgentTrustedRouteBinding(11, route, {
    trustedUrl: TRUSTED_URL,
    trustedWebContents: { id: 11, isDestroyed: () => false }
  })
}

function makeSender(): SenderMock {
  const listeners = new Map<string, Set<() => void>>()
  const sender: SenderMock = {
    id: 11,
    destroyed: false,
    url: TRUSTED_URL,
    isDestroyed() {
      return sender.destroyed
    },
    getURL() {
      return sender.url
    },
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

function makeParent() {
  const parent = {
    destroyed: false,
    webContents: h.sender,
    isDestroyed() {
      return parent.destroyed
    }
  }
  return parent
}

let root = ''
async function fixture(name: string, content = 'hello'): Promise<string> {
  const selected = path.join(root, name)
  await fs.mkdir(path.dirname(selected), { recursive: true })
  await fs.writeFile(selected, content)
  return selected
}

function handler(): (
  filePath: string,
  signal?: AbortSignal
) => Promise<{ content: string; metadata?: Record<string, unknown> }> {
  const created = createCanvasPathReadHandler(request(), invocation())
  expect(created).toBeDefined()
  return created!
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

beforeEach(async () => {
  h.sender = makeSender()
  h.parent = makeParent()
  h.dialogCalls = []
  h.mode = 'auto'
  h.response = 1
  h.pending = null
  h.locale = 'en-US'
  clearMagicAgentTrustedRouteBindingsForTest()
  trust()
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'canvas-path-approval-')))
  h.dataRoot = root
})

afterEach(async () => {
  vi.restoreAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  await fs.rm(root, { recursive: true, force: true })
})

describe('no handler without an eligible trusted local canvas chat', () => {
  it.each([
    ['no IPC identity', () => [request(), undefined] as const],
    [
      'custom skill runtime',
      () => [request({ skillRuntime: { skillId: 'external-agent' } }), invocation()] as const
    ],
    [
      'remote/generic route',
      () =>
        [
          request({ route: { ...route, channel: 'generic' } as unknown as LLMChatReq['route'] }),
          invocation()
        ] as const
    ],
    [
      'cross-project hash id',
      () =>
        [
          request(),
          invocation({
            frameUrl: 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=project-b',
            senderUrl: 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=project-b'
          })
        ] as const
    ]
  ])('returns undefined for %s', (_label, build) => {
    const [req, inv] = build()
    expect(createCanvasPathReadHandler(req, inv)).toBeUndefined()
  })
})

describe('default deny never authorizes or reads', () => {
  it('denies when the user chooses Deny', async () => {
    const file = await fixture('note.txt')
    h.response = 0
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    const read = vi.spyOn(LocalFileReadGrants.prototype, 'read')

    await expectCode(handler()(file), 'GRANT_DENIED')

    expect(h.dialogCalls).toHaveLength(1)
    expect(authorize).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('one approved exact read', () => {
  it('returns the exact UTF-8 bytes with no grant token and revokes in finally', async () => {
    const content = '你好 café 🌱\r\nsecond line\r\n'
    const file = await fixture('unicode 空 格 🌱.txt', content)
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
    const read = vi.spyOn(LocalFileReadGrants.prototype, 'read')
    const revoke = vi.spyOn(LocalFileReadGrants.prototype, 'revokeSender')
    const deliver = vi.spyOn(LocalFileReadGrants.prototype, 'assertDeliveryAuthorized')

    const result = await handler()(file)
    const parsed = JSON.parse(result.content) as Record<string, unknown>

    expect(parsed).toEqual({
      name: 'unicode 空 格 🌱.txt',
      relativePath: '',
      content,
      encoding: 'utf-8',
      sizeBytes: Buffer.byteLength(content),
      returnedBytes: Buffer.byteLength(content),
      truncated: false
    })
    expect(result.metadata).toEqual({ source: 'approved-local-file', readOnly: true })

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize.mock.calls[0].slice(0, 4)).toEqual([
      11,
      { projectId: 'project-a', paneId: 'pane-a', sessionId: 'conversation-a' },
      file,
      'file'
    ])
    const grant = (await authorize.mock.results[0].value) as { id: string }
    expect(result.content).not.toContain(grant.id)

    expect(read).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalled()
    expect(h.dialogCalls).toHaveLength(1)
  })
})

describe('aborts never read even on a late approval', () => {
  it('rejects a pre-aborted request without prompting', async () => {
    const file = await fixture('note.txt')
    const controller = new AbortController()
    controller.abort()
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')

    await expectCode(handler()(file, controller.signal), 'CANCELLED')

    expect(h.dialogCalls).toHaveLength(0)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('does not read when the caller aborts while the prompt is open', async () => {
    const file = await fixture('note.txt')
    h.mode = 'manual'
    const controller = new AbortController()
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')

    const pending = handler()(file, controller.signal)
    expect(h.pending).toBeTypeOf('function')
    controller.abort()
    h.pending!({ response: 1 })

    await expectCode(pending, 'CANCELLED')
    expect(authorize).not.toHaveBeenCalled()
  })

  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'] as const)(
    'does not read when the renderer emits %s while the prompt is open',
    async (event) => {
      const file = await fixture('note.txt')
      h.mode = 'manual'
      const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')

      const pending = handler()(file)
      expect(h.pending).toBeTypeOf('function')
      h.sender!.emit(event)
      h.pending!({ response: 1 })

      await expectCode(pending, 'SCOPE_CHANGED')
      expect(authorize).not.toHaveBeenCalled()
    }
  )
})

describe('consent is per read, never for a directory', () => {
  it('prompts again for each file and only ever authorizes a single file', async () => {
    const a = await fixture('a.txt', 'A')
    const b = await fixture('b.txt', 'B')
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')

    const first = await handler()(a)
    const second = await handler()(b)

    expect((JSON.parse(first.content) as { content: string }).content).toBe('A')
    expect((JSON.parse(second.content) as { content: string }).content).toBe('B')
    expect(h.dialogCalls).toHaveLength(2)
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls.map((call) => call[3])).toEqual(['file', 'file'])
    expect(authorize.mock.calls.some((call) => call[3] === 'directory')).toBe(false)
  })
})

describe('device and traversal path boundaries are rejected before prompting', () => {
  it.each([
    '\\\\.\\PhysicalDrive0',
    '\\\\?\\C:\\secret',
    'C:\\root\\..\\secret',
    'C:\\root\\sub\\..',
    'relative\\x'
  ])('rejects %s without prompting or authorizing', async (bad) => {
    const authorize = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')

    await expectCode(handler()(bad), 'PATH_DENIED')

    expect(h.dialogCalls).toHaveLength(0)
    expect(authorize).not.toHaveBeenCalled()
  })
})

describe('post-read delivery boundaries and fixed permission limits', () => {
  it('never offers an authority for a mismatched live parent', () => {
    h.parent!.webContents = { ...h.sender!, id: 99 }
    expect(createCanvasPathReadHandler(request(), invocation())).toBeUndefined()
  })

  it('uses default-deny buttons and shows the exact path, project, thread and transmission notice', async () => {
    const file = await fixture('approval-note.txt')
    h.locale = 'zh-CN'
    await handler()(file)
    expect(h.dialogCalls[0]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: file,
      buttons: ['拒绝', '仅本次读取']
    })
    expect(h.dialogCalls[0].detail).toContain('project-a')
    expect(h.dialogCalls[0].detail).toContain('conversation-a')
    expect(h.dialogCalls[0].detail).toContain('文件内容会发送给当前模型并存入本对话')
  })

  it('requires fresh consent when the same file is read twice', async () => {
    const file = await fixture('same.txt', 'same owned bytes')
    const read = handler()
    await read(file)
    h.response = 0
    await expectCode(read(file), 'GRANT_DENIED')
    expect(h.dialogCalls).toHaveLength(2)
  })

  it('does not return bytes after navigation occurs during the real read delivery', async () => {
    const file = await fixture('late.txt', 'OWNED_DO_NOT_DELIVER')
    const realRead = LocalFileReadGrants.prototype.read
    const revoke = vi.spyOn(LocalFileReadGrants.prototype, 'revokeSender')
    vi.spyOn(LocalFileReadGrants.prototype, 'read').mockImplementation(async function (
      this: LocalFileReadGrants,
      ...args
    ) {
      const result = await realRead.apply(this, args)
      h.sender!.emit('did-start-navigation')
      return result
    })
    await expectCode(handler()(file), 'SCOPE_CHANGED')
    expect(revoke).toHaveBeenCalled()
  })

  it('does not return bytes after cancellation occurs at the real read delivery boundary', async () => {
    const file = await fixture('cancel-late.txt', 'OWNED_DO_NOT_DELIVER')
    const controller = new AbortController()
    const realRead = LocalFileReadGrants.prototype.read
    vi.spyOn(LocalFileReadGrants.prototype, 'read').mockImplementation(async function (
      this: LocalFileReadGrants,
      ...args
    ) {
      const result = await realRead.apply(this, args)
      controller.abort()
      return result
    })
    await expectCode(handler()(file, controller.signal), 'CANCELLED')
  })

  it('enforces a caller byte ceiling before opening the approved file', async () => {
    const file = await fixture('bounded.txt', '1234567890')
    const open = vi.spyOn(fs, 'open')
    const read = createCanvasPathReadHandler(request(), invocation())!
    await expectCode(read(file, undefined, { maxBytes: 3 }), 'FILE_TOO_LARGE')
    expect(open).not.toHaveBeenCalled()
  })

  it('enforces a smaller caller character bound without returning oversized content', async () => {
    const file = await fixture('chars.txt', '1234567890')
    const read = createCanvasPathReadHandler(request(), invocation())!
    await expectCode(read(file, undefined, { maxStringLength: 3 }), 'TEXT_TOO_LARGE')
  })

  it('denies a directory and protected file even when the native response approves', async () => {
    const file = await fixture('.env', 'OWNED_FAKE_NOT_A_CREDENTIAL')
    const read = vi.spyOn(LocalFileReadGrants.prototype, 'read')
    await expectCode(handler()(file), 'PATH_DENIED')
    await expectCode(handler()(root), 'PATH_DENIED')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a concurrent prompt then releases the renderer slot after denial', async () => {
    const file = await fixture('concurrent.txt')
    h.mode = 'manual'
    const first = handler()(file)
    await expectCode(handler()(file), 'BUSY')
    h.pending!({ response: 0 })
    await expectCode(first, 'GRANT_DENIED')
    h.mode = 'auto'
    await expect(handler()(file)).resolves.toHaveProperty('content')
  })
})

describe('real adapter and kernel pipeline', () => {
  it('retains native consent through adapter, kernel, real registry and real file reader', async () => {
    const { AssistantExecutionAdapter } = await import('../assistantRuntime/executionAdapter')
    const { AssistantSessionStore } = await import('../assistantRuntime/sessionStore')
    const { DEFAULT_CONFIG } = await import('@shared/config/config')
    const file = await fixture('outside-workspace.txt', 'OWNED_INTEGRATION_CONTENT')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace)
    const store = new AssistantSessionStore(path.join(root, 'owned-session.json'))
    const model = vi.fn()
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: model } })
    try {
      const result = await adapter.callTool(
        'files.read',
        { path: file },
        {
          config: DEFAULT_CONFIG,
          route,
          sessionStore: store,
          workspaceRootDir: workspace,
          taskState: { sessionKey: 'owned', running: false, queuedCount: 0, updatedAt: 1 },
          readExternalFile: createCanvasPathReadHandler(request(), invocation())
        },
        { allowedToolNames: ['files.read'], runId: 'owned-integration-run' }
      )
      expect(JSON.parse(result.content).content).toBe('OWNED_INTEGRATION_CONTENT')
      expect(h.dialogCalls).toHaveLength(1)
      expect(model).not.toHaveBeenCalled()
      const stored = await store.getSession(route)
      const actions = stored?.eventLog?.map((event) => event.metadata?.agentAction) ?? []
      expect(JSON.stringify(actions)).toContain('OWNED_INTEGRATION_CONTENT')
      expect(JSON.stringify(actions)).toContain('tool.result')
      expect(JSON.stringify(actions)).not.toContain('readExternalFile')
    } finally {
      await store.flush()
    }
  })

  it('does not replace the existing allowed-tool boundary with native confirmation', async () => {
    const { AssistantExecutionAdapter } = await import('../assistantRuntime/executionAdapter')
    const { AssistantSessionStore } = await import('../assistantRuntime/sessionStore')
    const { DEFAULT_CONFIG } = await import('@shared/config/config')
    const file = await fixture('denied-tool.txt', 'OWNED_NOT_READ')
    const store = new AssistantSessionStore(path.join(root, 'deny-session.json'))
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
    try {
      await expect(
        adapter.callTool(
          'files.read',
          { path: file },
          {
            config: DEFAULT_CONFIG,
            route,
            sessionStore: store,
            workspaceRootDir: root,
            taskState: { sessionKey: 'owned', running: false, queuedCount: 0, updatedAt: 1 },
            readExternalFile: createCanvasPathReadHandler(request(), invocation())
          },
          { allowedToolNames: [], runId: 'owned-denied-run' }
        )
      ).rejects.toThrow()
      expect(h.dialogCalls).toHaveLength(0)
    } finally {
      await store.flush()
    }
  })
})
