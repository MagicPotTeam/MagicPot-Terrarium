import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const appMock = {
  getPath: vi.fn(),
  getAppPath: vi.fn(),
  isPackaged: false
}

vi.mock('electron', () => ({
  app: appMock
}))

async function loadModule() {
  vi.resetModules()
  return import('./chatMediaDir')
}

describe('chatMediaDir', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('chat-media-dir')
    appMock.isPackaged = false
    appMock.getAppPath.mockReturnValue(path.join(tempRoot, 'app'))
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'desktop') {
        return path.join(tempRoot, 'Desktop')
      }
      if (name === 'temp') {
        return path.join(tempRoot, 'Temp')
      }
      if (name === 'exe') {
        return path.join(tempRoot, 'MagicPot.exe')
      }
      if (name === 'userData') {
        return path.join(tempRoot, 'userData')
      }
      throw new Error(`Unexpected app.getPath(${name})`)
    })
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
    delete process.env['MAGICPOT_TEST_RUN_ID']
  })

  afterEach(async () => {
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
    delete process.env['MAGICPOT_TEST_RUN_ID']
    appMock.getPath.mockReset()
    appMock.getAppPath.mockReset()
    await fs.rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
    vi.clearAllMocks()
  })

  it('keeps chat media inside app-owned user data outside automated runs', async () => {
    const module = await loadModule()
    const mediaDir = module.getChatMediaDir('Alice Team')

    expect(mediaDir).toBe(path.join(tempRoot, 'userData', '.chat_media', 'alice-team'))
    await expect(fs.access(mediaDir)).resolves.toBeUndefined()
  })

  it('routes automated runs into desktop .magicpot-trash/MagicPot/<run-id>/llm-proxy/chat-media', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-789'

    const module = await loadModule()
    const mediaDir = module.getChatMediaDir('Alice Team')

    expect(mediaDir).toBe(
      path.join(
        tempRoot,
        'Desktop',
        '.magicpot-trash',
        'MagicPot',
        'run-789',
        'llm-proxy',
        'chat-media',
        'alice-team'
      )
    )
    await expect(fs.access(mediaDir)).resolves.toBeUndefined()
  })

  it('falls back to userData instead of the app directory', async () => {
    const module = await loadModule()
    const mediaDir = module.getChatMediaDir('Alice Team')

    expect(mediaDir).toBe(path.join(tempRoot, 'userData', '.chat_media', 'alice-team'))
    await expect(fs.access(mediaDir)).resolves.toBeUndefined()
  })

  it('resolves lifecycle namespaces below the app-owned media root', async () => {
    const module = await loadModule()

    expect(module.resolveChatMediaNamespaceDir('task', 'task-123')).toBe(
      path.join(tempRoot, 'userData', '.chat_media', 'task', 'task-123')
    )
    expect(module.resolveChatMediaNamespaceDir('model')).toBe(
      path.join(tempRoot, 'userData', '.chat_media', 'model')
    )

    const outputDir = module.getChatMediaNamespaceDir('user-output', 'export-1')
    expect(outputDir).toBe(
      path.join(tempRoot, 'userData', '.chat_media', 'user-output', 'export-1')
    )
    await expect(fs.access(outputDir)).resolves.toBeUndefined()
  })

  it('fails closed for unknown namespaces and non-canonical namespace scopes', async () => {
    const module = await loadModule()

    expect(module.isSafeChatMediaScope('task-123')).toBe(true)
    expect(module.isSafeChatMediaScope('../outside')).toBe(false)
    expect(module.isSafeChatMediaScope('Task-123')).toBe(false)
    expect(module.isSafeChatMediaScope('task/123')).toBe(false)
    expect(module.isSafeChatMediaScope('')).toBe(false)

    expect(() => module.resolveChatMediaNamespaceDir('unknown', 'task-123')).toThrow(
      'Unknown chat media namespace'
    )
    expect(() => module.resolveChatMediaNamespaceDir('task', '../outside')).toThrow(
      'canonical safe identifier'
    )
    expect(() => module.getChatMediaNamespaceDir('model', 'Task 123')).toThrow(
      'canonical safe identifier'
    )
  })

  it('does not create a namespace through a symlinked parent', async () => {
    const module = await loadModule()
    const baseDir = module.resolveBaseChatMediaDir()
    const outside = path.join(tempRoot, 'outside')
    await fs.mkdir(outside, { recursive: true })
    try {
      await fs.symlink(
        outside,
        path.join(baseDir, 'task'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }

    expect(() => module.getChatMediaNamespaceDir('task', 'scope-1')).toThrow('canonical directory')
    await expect(fs.access(path.join(outside, 'scope-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
