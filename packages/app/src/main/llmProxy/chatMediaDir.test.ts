import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const appMock = {
  getPath: vi.fn(),
  getAppPath: vi.fn(),
  isPackaged: false
}

let currentConfig: { download_dir?: string } = {}

vi.mock('electron', () => ({
  app: appMock
}))

vi.mock('../config/config', () => ({
  getConfig: () => currentConfig
}))

async function loadModule() {
  vi.resetModules()
  return import('./chatMediaDir')
}

describe('chatMediaDir', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('chat-media-dir')
    const downloadDir = path.join(tempRoot, 'downloads')
    currentConfig = {
      download_dir: downloadDir
    }
    await fs.mkdir(downloadDir, { recursive: true })
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

  it('prefers the configured download directory outside automated runs', async () => {
    const module = await loadModule()
    const mediaDir = module.getChatMediaDir('Alice Team')

    expect(mediaDir).toBe(path.join(tempRoot, 'downloads', '.chat_media', 'alice-team'))
    await expect(fs.access(mediaDir)).resolves.toBeUndefined()
  })

  it('routes automated runs into desktop .Codex-Junk/MagicPot/<run-id>/llm-proxy/chat-media', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-789'

    const module = await loadModule()
    const mediaDir = module.getChatMediaDir('Alice Team')

    expect(mediaDir).toBe(
      path.join(
        tempRoot,
        'Desktop',
        '.Codex-Junk',
        'MagicPot',
        'run-789',
        'llm-proxy',
        'chat-media',
        'alice-team'
      )
    )
    await expect(fs.access(mediaDir)).resolves.toBeUndefined()
  })
})
