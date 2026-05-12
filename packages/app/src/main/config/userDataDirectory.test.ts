import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const appMock = {
  getPath: vi.fn(),
  isPackaged: false
}

vi.mock('electron', () => ({
  app: appMock
}))

async function loadModule() {
  vi.resetModules()
  return import('./userDataDirectory')
}

describe('userDataDirectory', () => {
  let tempRoot = ''
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('user-data-directory')
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempRoot)
    appMock.isPackaged = false
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'desktop') {
        return path.join(tempRoot, 'Desktop')
      }
      if (name === 'temp') {
        return path.join(tempRoot, 'Temp')
      }
      throw new Error(`Unexpected app.getPath(${name})`)
    })
    delete process.env['MAGICPOT_USER_DATA_DIR']
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
    delete process.env['MAGICPOT_TEST_RUN_ID']
  })

  afterEach(async () => {
    delete process.env['MAGICPOT_USER_DATA_DIR']
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
    delete process.env['MAGICPOT_TEST_RUN_ID']
    appMock.getPath.mockReset()
    cwdSpy?.mockRestore()
    cwdSpy = null
    await fs.rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
    vi.clearAllMocks()
  })

  it('migrates current data into an empty selected directory on next launch', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const targetDataDir = path.join(tempRoot, 'selected-data')
    await fs.mkdir(path.join(currentDataDir, 'customSkills'), { recursive: true })
    await fs.mkdir(path.join(currentDataDir, 'chat-workspaces'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{"ok":true}', 'utf8')
    await fs.writeFile(
      path.join(currentDataDir, 'customSkills', 'skill.json'),
      '{"name":"skill"}',
      'utf8'
    )
    await fs.writeFile(
      path.join(currentDataDir, 'chat-workspaces', 'workspace.json'),
      '{"workspace":true}',
      'utf8'
    )

    const module = await loadModule()
    await expect(
      module.prepareUserDataDirectoryChange(targetDataDir, currentDataDir)
    ).resolves.toBe(true)

    const reloadedModule = await loadModule()
    const resolved = reloadedModule.resolveStartupUserDataDirectory()

    expect(resolved).toEqual({
      path: path.resolve(targetDataDir),
      source: 'persisted'
    })
    expect(await fs.readFile(path.join(targetDataDir, 'config.json'), 'utf8')).toBe('{"ok":true}')
    expect(await fs.readFile(path.join(targetDataDir, 'customSkills', 'skill.json'), 'utf8')).toBe(
      '{"name":"skill"}'
    )
    expect(
      await fs.readFile(path.join(targetDataDir, 'chat-workspaces', 'workspace.json'), 'utf8')
    ).toBe('{"workspace":true}')
    const bootstrap = JSON.parse(
      await fs.readFile(
        path.join(tempRoot, 'aiengineelectron-dev', 'user-data-bootstrap.json'),
        'utf8'
      )
    ) as { customUserDataDir: string }
    expect(bootstrap.customUserDataDir).toBe(path.resolve(targetDataDir))
  })

  it('rejects non-empty directories that do not look like Magic Pot data', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const foreignDir = path.join(tempRoot, 'foreign-dir')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(foreignDir, { recursive: true })
    await fs.writeFile(path.join(foreignDir, 'notes.txt'), 'hello', 'utf8')

    const module = await loadModule()

    await expect(module.prepareUserDataDirectoryChange(foreignDir, currentDataDir)).rejects.toThrow(
      'The selected directory is not empty and does not look like a Magic Pot data directory.'
    )
  })

  it('accepts directories that already use neutral chat storage markers', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const targetDataDir = path.join(tempRoot, 'selected-data')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(targetDataDir, 'chat-workspaces'), { recursive: true })
    await fs.writeFile(path.join(targetDataDir, 'chat-sessions.json'), '{"ok":true}', 'utf8')

    const module = await loadModule()
    await expect(
      module.prepareUserDataDirectoryChange(targetDataDir, currentDataDir)
    ).resolves.toBe(true)

    const reloadedModule = await loadModule()
    expect(reloadedModule.resolveStartupUserDataDirectory()).toEqual({
      path: path.resolve(targetDataDir),
      source: 'persisted'
    })
  })

  it('routes automated runs into the repo trash userData directory when no explicit override is set', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-456'

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toEqual({
      path: path.join(tempRoot, 'Desktop', 'Codex-Junk', 'MagicPot', 'run-456', 'userData'),
      source: 'default'
    })
  })

  it('ignores automated user-data overrides that point outside the repo trash root', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-789'
    process.env['MAGICPOT_USER_DATA_DIR'] = path.join(tempRoot, 'outside-user-data')

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toEqual({
      path: path.join(tempRoot, 'Desktop', 'Codex-Junk', 'MagicPot', 'run-789', 'userData'),
      source: 'default'
    })
  })

  it('accepts automated user-data overrides that stay inside the repo trash root', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-987'
    process.env['MAGICPOT_USER_DATA_DIR'] = 'debug-session/userData'

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toEqual({
      path: path.join(
        tempRoot,
        'Desktop',
        'Codex-Junk',
        'MagicPot',
        'run-987',
        'debug-session',
        'userData'
      ),
      source: 'env'
    })
  })

  it('honors the standardized desktop override for automated artifact routing', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-654'
    process.env['MAGICPOT_TEST_DESKTOP_PATH'] = path.join(tempRoot, 'RedirectedDesktop')

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toEqual({
      path: path.join(
        tempRoot,
        'RedirectedDesktop',
        'Codex-Junk',
        'MagicPot',
        'run-654',
        'userData'
      ),
      source: 'default'
    })
  })
})
