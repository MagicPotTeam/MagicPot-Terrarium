import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const appMock = {
  getPath: vi.fn(),
  isPackaged: false
}

const originalResourcesPath = process.resourcesPath

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value
  })
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
  let copyFileSyncSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('user-data-directory')
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempRoot)
    appMock.isPackaged = false
    setResourcesPath(path.join(tempRoot, 'resources'))
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
    delete process.env['MAGICPOT_STORAGE_ROOT']
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
    delete process.env['MAGICPOT_TEST_RUN_ID']
  })

  afterEach(async () => {
    delete process.env['MAGICPOT_USER_DATA_DIR']
    delete process.env['MAGICPOT_STORAGE_ROOT']
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
    delete process.env['MAGICPOT_TEST_RUN_ID']
    appMock.getPath.mockReset()
    setResourcesPath(originalResourcesPath)
    cwdSpy?.mockRestore()
    cwdSpy = null
    copyFileSyncSpy?.mockRestore()
    copyFileSyncSpy = null
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

    const targetLayoutData = path.join(targetDataDir, 'Data')
    expect(resolved).toMatchObject({
      path: path.resolve(targetLayoutData),
      source: 'persisted',
      storageRoot: path.resolve(targetDataDir),
      projectRoot: path.join(targetDataDir, 'Projects'),
      autoSaveRoot: path.join(targetDataDir, 'AutoSave')
    })
    expect(await fs.readFile(path.join(targetLayoutData, 'config.json'), 'utf8')).toBe(
      '{"ok":true}'
    )
    expect(
      await fs.readFile(path.join(targetLayoutData, 'customSkills', 'skill.json'), 'utf8')
    ).toBe('{"name":"skill"}')
    expect(
      await fs.readFile(path.join(targetLayoutData, 'chat-workspaces', 'workspace.json'), 'utf8')
    ).toBe('{"workspace":true}')
    const bootstrap = JSON.parse(
      await fs.readFile(
        path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json'),
        'utf8'
      )
    ) as { customStorageRoot: string }
    expect(bootstrap.customStorageRoot).toBe(path.resolve(targetDataDir))
  })

  it('copies legacy project and automatic-export directories into the unified root', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const oldProjectsDir = path.join(tempRoot, 'old-projects')
    const oldAutoSaveDir = path.join(oldProjectsDir, '.AutoSave')
    const targetRoot = path.join(tempRoot, 'unified-root')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(oldProjectsDir, '.demo__project-1'), { recursive: true })
    await fs.mkdir(path.join(oldAutoSaveDir, 'Agent'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')
    await fs.writeFile(
      path.join(oldProjectsDir, '.demo__project-1', 'project.mpcanvas'),
      '{}',
      'utf8'
    )
    await fs.writeFile(path.join(oldAutoSaveDir, 'Agent', 'image.png'), 'image', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: oldProjectsDir,
      autoSaveFrom: oldAutoSaveDir
    })

    const reloadedModule = await loadModule()
    reloadedModule.resolveStartupUserDataDirectory()
    expect(
      await fs.readFile(
        path.join(targetRoot, 'Projects', '.demo__project-1', 'project.mpcanvas'),
        'utf8'
      )
    ).toBe('{}')
    expect(await fs.readFile(path.join(targetRoot, 'AutoSave', 'Agent', 'image.png'), 'utf8')).toBe(
      'image'
    )
    await expect(fs.access(path.join(targetRoot, 'Projects', '.AutoSave'))).rejects.toThrow()
  })

  it('switches to an existing valid root without migrating conflicting data', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const targetRoot = path.join(tempRoot, 'target-root')
    const bootstrapPath = path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(targetRoot, 'Data'), { recursive: true })
    await fs.mkdir(path.join(targetRoot, 'Projects'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), 'source', 'utf8')
    await fs.writeFile(path.join(targetRoot, 'Data', 'config.json'), 'target', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir)
    const reloadedModule = await loadModule()
    const resolved = reloadedModule.resolveStartupUserDataDirectory()

    expect(resolved.path).toBe(path.resolve(path.join(targetRoot, 'Data')))
    expect(await fs.readFile(path.join(targetRoot, 'Data', 'config.json'), 'utf8')).toBe('target')
    const bootstrap = JSON.parse(await fs.readFile(bootstrapPath, 'utf8')) as {
      pendingMigrationFrom?: string
    }
    expect(bootstrap.pendingMigrationFrom).toBeUndefined()
  })

  it('does not publish a prepared root change until commit and can roll it back', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const originalRoot = path.join(tempRoot, 'original-root')
    const nextRoot = path.join(tempRoot, 'next-root')
    const bootstrapPath = path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true })
    await fs.writeFile(bootstrapPath, JSON.stringify({ customStorageRoot: originalRoot }), 'utf8')

    const module = await loadModule()
    const prepared = await module.beginUserDataDirectoryChange(nextRoot, currentDataDir)
    expect(JSON.parse(await fs.readFile(bootstrapPath, 'utf8')).customStorageRoot).toBe(
      originalRoot
    )

    await prepared.commit()
    expect(JSON.parse(await fs.readFile(bootstrapPath, 'utf8')).customStorageRoot).toBe(
      path.resolve(nextRoot)
    )
    await prepared.rollback()
    expect(JSON.parse(await fs.readFile(bootstrapPath, 'utf8')).customStorageRoot).toBe(
      originalRoot
    )
  })

  it('keeps using the recoverable legacy root while a pending source needs retry', async () => {
    const currentDataDir = path.join(tempRoot, 'legacy-data')
    const missingProjectsDir = path.join(tempRoot, 'offline-projects')
    const targetRoot = path.join(tempRoot, 'target-root')
    const bootstrapPath = path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{"legacy":true}', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: missingProjectsDir
    })

    const reloadedModule = await loadModule()
    const resolved = reloadedModule.resolveStartupUserDataDirectory()

    expect(resolved).toMatchObject({
      path: path.resolve(currentDataDir),
      storageRoot: path.resolve(currentDataDir),
      source: 'persisted',
      legacyLayout: true
    })
    expect(await fs.readFile(path.join(currentDataDir, 'config.json'), 'utf8')).toBe(
      '{"legacy":true}'
    )
    const pendingBootstrap = JSON.parse(await fs.readFile(bootstrapPath, 'utf8')) as {
      customStorageRoot: string
      pendingMigrationFrom: string
      pendingProjectsFrom: string
    }
    expect(pendingBootstrap).toMatchObject({
      customStorageRoot: path.resolve(targetRoot),
      pendingMigrationFrom: path.resolve(currentDataDir),
      pendingProjectsFrom: path.resolve(missingProjectsDir)
    })
    expect(await fs.readFile(path.join(targetRoot, 'Data', 'config.json'), 'utf8')).toBe(
      '{"legacy":true}'
    )
  })

  it('keeps pending Data and the legacy root active after a retryable child copy failure', async () => {
    const currentDataDir = path.join(tempRoot, 'retryable-data')
    const targetRoot = path.join(tempRoot, 'target-root')
    const bootstrapPath = path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json')
    const sourceConfigPath = path.join(currentDataDir, 'config.json')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.writeFile(sourceConfigPath, '{"retry":true}', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir)
    await fs.rm(path.join(targetRoot, 'Data'), { recursive: true, force: true })

    const originalCopyFileSync = fsSync.copyFileSync.bind(fsSync)
    copyFileSyncSpy = vi.spyOn(fsSync, 'copyFileSync').mockImplementation((source, target) => {
      if (path.resolve(String(source)) === path.resolve(sourceConfigPath)) {
        const error = new Error('busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'
        throw error
      }
      return originalCopyFileSync(source, target)
    })

    const reloadedModule = await loadModule()
    const resolved = reloadedModule.resolveStartupUserDataDirectory()

    expect(resolved.path).toBe(path.resolve(currentDataDir))
    expect(JSON.parse(await fs.readFile(bootstrapPath, 'utf8'))).toMatchObject({
      customStorageRoot: path.resolve(targetRoot),
      pendingMigrationFrom: path.resolve(currentDataDir)
    })
  })

  it('fails early without creating paths when pending Data is unavailable, then recovers', async () => {
    const currentDataDir = path.join(tempRoot, 'offline-data')
    const targetRoot = path.join(tempRoot, 'target-root')
    const bootstrapPath = path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json')
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true })
    await fs.writeFile(
      bootstrapPath,
      JSON.stringify({
        customStorageRoot: targetRoot,
        pendingMigrationFrom: currentDataDir,
        legacyBootstrapsRetired: true
      }),
      'utf8'
    )

    const earlyModule = await import('./portablePaths')
    expect(() => earlyModule.resolveEarlyPortableUserDataDirectory()).toThrow(
      'legacy Data source is unavailable'
    )
    await expect(fs.access(currentDataDir)).rejects.toThrow()
    await expect(fs.access(targetRoot)).rejects.toThrow()

    const startupModule = await loadModule()
    expect(() => startupModule.resolveStartupUserDataDirectory()).toThrow(
      'legacy Data source is unavailable'
    )
    await expect(fs.access(currentDataDir)).rejects.toThrow()
    await expect(fs.access(targetRoot)).rejects.toThrow()

    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{"restored":true}', 'utf8')
    expect((await import('./portablePaths')).resolveEarlyPortableUserDataDirectory()).toBe(
      path.resolve(currentDataDir)
    )
    const resolved = (await loadModule()).resolveStartupUserDataDirectory()
    expect(resolved.path).toBe(path.join(targetRoot, 'Data'))
    expect(await fs.readFile(path.join(targetRoot, 'Data', 'config.json'), 'utf8')).toBe(
      '{"restored":true}'
    )
  })

  it('switches to the unified root after a retrying source is restored', async () => {
    const currentDataDir = path.join(tempRoot, 'legacy-data')
    const projectsDir = path.join(tempRoot, 'offline-projects')
    const targetRoot = path.join(tempRoot, 'target-root')
    const bootstrapPath = path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: projectsDir
    })
    const earlyModule = await import('./portablePaths')
    expect(earlyModule.resolveEarlyPortableUserDataDirectory()).toBe(path.resolve(currentDataDir))
    expect((await loadModule()).resolveStartupUserDataDirectory().path).toBe(
      path.resolve(currentDataDir)
    )
    expect((await import('./portablePaths')).resolveEarlyPortableUserDataDirectory()).toBe(
      path.resolve(currentDataDir)
    )

    await fs.mkdir(path.join(projectsDir, '.restored-project'), { recursive: true })
    await fs.writeFile(
      path.join(projectsDir, '.restored-project', 'project.mpcanvas'),
      'restored',
      'utf8'
    )
    const recoveredModule = await loadModule()
    const resolved = recoveredModule.resolveStartupUserDataDirectory()

    expect(resolved).toMatchObject({
      path: path.join(targetRoot, 'Data'),
      storageRoot: path.resolve(targetRoot),
      source: 'persisted',
      legacyLayout: false
    })
    expect(
      await fs.readFile(
        path.join(targetRoot, 'Projects', '.restored-project', 'project.mpcanvas'),
        'utf8'
      )
    ).toBe('restored')
    const completedBootstrap = JSON.parse(await fs.readFile(bootstrapPath, 'utf8')) as {
      pendingMigrationFrom?: string
      pendingProjectsFrom?: string
    }
    expect(completedBootstrap.pendingMigrationFrom).toBeUndefined()
    expect(completedBootstrap.pendingProjectsFrom).toBeUndefined()
    expect((await import('./portablePaths')).resolveEarlyPortableUserDataDirectory()).toBe(
      path.join(targetRoot, 'Data')
    )
  })

  it('retries pending migrations and merges primary and secondary AutoSave sources', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const projectsDir = path.join(tempRoot, 'projects')
    const primaryAutoSave = path.join(tempRoot, 'primary-autosave')
    const secondaryAutoSave = path.join(projectsDir, '.AutoSave')
    const targetRoot = path.join(tempRoot, 'target-root')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(projectsDir, '.project'), { recursive: true })
    await fs.mkdir(path.join(primaryAutoSave, 'primary'), { recursive: true })
    await fs.mkdir(path.join(secondaryAutoSave, 'secondary'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')
    await fs.writeFile(path.join(projectsDir, '.project', 'project.mpcanvas'), '{}', 'utf8')
    await fs.writeFile(path.join(primaryAutoSave, 'primary', 'image.png'), 'one', 'utf8')
    await fs.writeFile(path.join(secondaryAutoSave, 'secondary', 'image.png'), 'two', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: projectsDir,
      autoSaveFrom: primaryAutoSave,
      autoSaveFromSecondary: secondaryAutoSave
    })
    const reloadedModule = await loadModule()
    reloadedModule.resolveStartupUserDataDirectory()
    reloadedModule.resolveStartupUserDataDirectory()

    expect(
      await fs.readFile(path.join(targetRoot, 'AutoSave', 'primary', 'image.png'), 'utf8')
    ).toBe('one')
    expect(
      await fs.readFile(path.join(targetRoot, 'AutoSave', 'secondary', 'image.png'), 'utf8')
    ).toBe('two')
    await expect(fs.access(path.join(targetRoot, 'Projects', '.AutoSave'))).rejects.toThrow()
  })

  it('retains project cleanup metadata when an AutoSave source was already collected', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const projectsDir = path.join(tempRoot, 'projects')
    const nestedAutoSave = path.join(projectsDir, '.AutoSave')
    const targetRoot = path.join(tempRoot, 'target-root')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(nestedAutoSave, 'Agent'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')
    await fs.writeFile(path.join(nestedAutoSave, 'Agent', 'image.png'), 'image', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: projectsDir,
      autoSaveFromCandidates: [nestedAutoSave]
    })
    const bootstrap = JSON.parse(
      await fs.readFile(
        path.join(tempRoot, '.aiengineelectron-dev', 'user-data-bootstrap.json'),
        'utf8'
      )
    ) as {
      pendingAutoSaveMigrations: Array<{
        source: string
        copiedProjectsRelativePath?: string
      }>
    }
    expect(bootstrap.pendingAutoSaveMigrations).toEqual([
      expect.objectContaining({
        source: path.resolve(nestedAutoSave),
        copiedProjectsRelativePath: '.AutoSave'
      })
    ])

    const reloadedModule = await loadModule()
    reloadedModule.resolveStartupUserDataDirectory()

    expect(await fs.readFile(path.join(targetRoot, 'AutoSave', 'Agent', 'image.png'), 'utf8')).toBe(
      'image'
    )
    await expect(fs.access(path.join(targetRoot, 'Projects', '.AutoSave'))).rejects.toThrow()
  })

  it('merges root, project-root, and per-project AutoSave directories', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const projectsDir = path.join(tempRoot, 'projects')
    const rootAutoSave = path.join(tempRoot, '.AutoSave')
    const targetRoot = path.join(tempRoot, 'target-root')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(projectsDir, 'AutoSave', 'plain'), { recursive: true })
    await fs.mkdir(path.join(projectsDir, '.AutoSave', 'hidden'), { recursive: true })
    await fs.mkdir(path.join(projectsDir, 'project-a', '.AutoSave'), { recursive: true })
    await fs.mkdir(path.join(projectsDir, 'project-b', '.AutoSave'), { recursive: true })
    await fs.mkdir(path.join(rootAutoSave, 'root'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')
    await fs.writeFile(path.join(projectsDir, 'AutoSave', 'plain', 'a.png'), 'plain', 'utf8')
    await fs.writeFile(path.join(projectsDir, '.AutoSave', 'hidden', 'a.png'), 'hidden', 'utf8')
    await fs.writeFile(path.join(projectsDir, 'project-a', '.AutoSave', 'same.png'), 'a', 'utf8')
    await fs.writeFile(path.join(projectsDir, 'project-b', '.AutoSave', 'same.png'), 'b', 'utf8')
    await fs.writeFile(path.join(rootAutoSave, 'root', 'a.png'), 'root', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: projectsDir,
      autoSaveFromCandidates: [rootAutoSave]
    })
    const reloadedModule = await loadModule()
    reloadedModule.resolveStartupUserDataDirectory()

    expect(await fs.readFile(path.join(targetRoot, 'AutoSave', 'plain', 'a.png'), 'utf8')).toBe(
      'plain'
    )
    expect(await fs.readFile(path.join(targetRoot, 'AutoSave', 'hidden', 'a.png'), 'utf8')).toBe(
      'hidden'
    )
    expect(await fs.readFile(path.join(targetRoot, 'AutoSave', 'root', 'a.png'), 'utf8')).toBe(
      'root'
    )
    expect(
      await fs.readFile(
        path.join(targetRoot, 'AutoSave', 'Projects', 'project-a', 'same.png'),
        'utf8'
      )
    ).toBe('a')
    expect(
      await fs.readFile(
        path.join(targetRoot, 'AutoSave', 'Projects', 'project-b', 'same.png'),
        'utf8'
      )
    ).toBe('b')
    await expect(fs.access(path.join(targetRoot, 'Projects', 'AutoSave'))).rejects.toThrow()
    await expect(fs.access(path.join(targetRoot, 'Projects', '.AutoSave'))).rejects.toThrow()
    await expect(
      fs.access(path.join(targetRoot, 'Projects', 'project-a', '.AutoSave'))
    ).rejects.toThrow()
  })

  it('migrates the legacy Data renderer-state project fallback', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const fallbackProjectsDir = path.join(currentDataDir, 'renderer-state', 'project-canvas')
    const targetRoot = path.join(tempRoot, 'target-root')
    await fs.mkdir(path.join(fallbackProjectsDir, '.fallback-project'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')
    await fs.writeFile(
      path.join(fallbackProjectsDir, '.fallback-project', 'project.mpcanvas'),
      'fallback',
      'utf8'
    )

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(targetRoot, currentDataDir, {
      projectsFrom: path.join(tempRoot, 'missing-projects')
    })
    const reloadedModule = await loadModule()
    reloadedModule.resolveStartupUserDataDirectory()

    expect(
      await fs.readFile(
        path.join(targetRoot, 'Projects', '.fallback-project', 'project.mpcanvas'),
        'utf8'
      )
    ).toBe('fallback')
  })

  it('retries Projects and AutoSave migration when returning to the default root', async () => {
    const currentDataDir = path.join(tempRoot, 'legacy-data')
    const projectsDir = path.join(tempRoot, 'legacy-projects')
    const autoSaveDir = path.join(tempRoot, 'legacy-autosave')
    const defaultRoot = path.join(tempRoot, '.aiengineelectron-dev')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(projectsDir, '.default-project'), { recursive: true })
    await fs.mkdir(path.join(autoSaveDir, 'Agent'), { recursive: true })
    await fs.writeFile(path.join(currentDataDir, 'config.json'), '{}', 'utf8')
    await fs.writeFile(
      path.join(projectsDir, '.default-project', 'project.mpcanvas'),
      'default-project',
      'utf8'
    )
    await fs.writeFile(path.join(autoSaveDir, 'Agent', 'image.png'), 'default-autosave', 'utf8')

    const module = await loadModule()
    await module.prepareUserDataDirectoryChange(null, currentDataDir, {
      projectsFrom: projectsDir,
      autoSaveFrom: autoSaveDir
    })
    const reloadedModule = await loadModule()
    reloadedModule.resolveStartupUserDataDirectory()

    expect(
      await fs.readFile(
        path.join(defaultRoot, 'Projects', '.default-project', 'project.mpcanvas'),
        'utf8'
      )
    ).toBe('default-project')
    expect(
      await fs.readFile(path.join(defaultRoot, 'AutoSave', 'Agent', 'image.png'), 'utf8')
    ).toBe('default-autosave')
  })

  it('rejects storage marker files and symlinked marker directories', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const markerFileRoot = path.join(tempRoot, 'marker-file-root')
    const symlinkRoot = path.join(tempRoot, 'symlink-root')
    const actualDataDir = path.join(tempRoot, 'actual-data')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(markerFileRoot, { recursive: true })
    await fs.writeFile(path.join(markerFileRoot, 'Data'), 'not-a-directory', 'utf8')
    await fs.mkdir(symlinkRoot, { recursive: true })
    await fs.mkdir(actualDataDir, { recursive: true })
    await fs.symlink(actualDataDir, path.join(symlinkRoot, 'Data'), 'junction')

    const module = await loadModule()
    await expect(
      module.prepareUserDataDirectoryChange(markerFileRoot, currentDataDir)
    ).rejects.toThrow('does not look like a Magic Pot storage root')
    await expect(
      module.prepareUserDataDirectoryChange(symlinkRoot, currentDataDir)
    ).rejects.toThrow('does not look like a Magic Pot storage root')
  })

  it('rejects non-empty directories that do not look like Magic Pot data', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const foreignDir = path.join(tempRoot, 'foreign-dir')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(foreignDir, { recursive: true })
    await fs.writeFile(path.join(foreignDir, 'notes.txt'), 'hello', 'utf8')

    const module = await loadModule()

    await expect(module.prepareUserDataDirectoryChange(foreignDir, currentDataDir)).rejects.toThrow(
      'The selected directory is not empty and does not look like a Magic Pot storage root.'
    )
  })

  it('accepts directories that already use neutral chat storage markers', async () => {
    const currentDataDir = path.join(tempRoot, 'current-data')
    const targetDataDir = path.join(tempRoot, 'selected-data')
    await fs.mkdir(currentDataDir, { recursive: true })
    await fs.mkdir(path.join(targetDataDir, 'Data', 'chat-workspaces'), { recursive: true })
    await fs.writeFile(
      path.join(targetDataDir, 'Data', 'chat-sessions.json'),
      '{"ok":true}',
      'utf8'
    )

    const module = await loadModule()
    await expect(
      module.prepareUserDataDirectoryChange(targetDataDir, currentDataDir)
    ).resolves.toBe(true)

    const reloadedModule = await loadModule()
    expect(reloadedModule.resolveStartupUserDataDirectory()).toMatchObject({
      path: path.resolve(path.join(targetDataDir, 'Data')),
      source: 'persisted',
      storageRoot: path.resolve(targetDataDir)
    })
  })

  it('routes automated runs through the unified storage layout when no override is set', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-456'

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()
    const root = path.join(tempRoot, 'Desktop', '.magicpot-trash', 'MagicPot', 'run-456')

    expect(resolved).toMatchObject({
      path: path.join(root, 'Data'),
      storageRoot: root,
      projectRoot: path.join(root, 'Projects'),
      autoSaveRoot: path.join(root, 'AutoSave'),
      source: 'default',
      legacyLayout: false
    })
  })

  it('ignores automated user-data overrides that point outside the repo trash root', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-789'
    process.env['MAGICPOT_USER_DATA_DIR'] = path.join(tempRoot, 'outside-user-data')

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toMatchObject({
      path: path.join(tempRoot, 'Desktop', '.magicpot-trash', 'MagicPot', 'run-789', 'Data'),
      source: 'default'
    })
  })

  it('keeps an automated MAGICPOT_USER_DATA_DIR override as the exact legacy leaf', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-987'
    process.env['MAGICPOT_USER_DATA_DIR'] = 'debug-session/userData'

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()
    const legacyLeaf = path.join(
      tempRoot,
      'Desktop',
      '.magicpot-trash',
      'MagicPot',
      'run-987',
      'debug-session',
      'userData'
    )

    expect(resolved).toMatchObject({
      path: legacyLeaf,
      storageRoot: legacyLeaf,
      projectRoot: path.join(legacyLeaf, 'renderer-state', 'project-canvas'),
      autoSaveRoot: path.join(legacyLeaf, 'AutoSave'),
      source: 'env',
      legacyLayout: true
    })
  })

  it('derives automated Data, Projects, and AutoSave from MAGICPOT_STORAGE_ROOT', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-321'
    process.env['MAGICPOT_STORAGE_ROOT'] = 'debug-session/storage'

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()
    const storageRoot = path.join(
      tempRoot,
      'Desktop',
      '.magicpot-trash',
      'MagicPot',
      'run-321',
      'debug-session',
      'storage'
    )

    expect(resolved).toMatchObject({
      path: path.join(storageRoot, 'Data'),
      storageRoot,
      projectRoot: path.join(storageRoot, 'Projects'),
      autoSaveRoot: path.join(storageRoot, 'AutoSave'),
      source: 'env',
      legacyLayout: false
    })
  })

  it('keeps the legacy user-data override as a legacy layout', async () => {
    const legacyData = path.join(tempRoot, 'LegacyData')
    process.env['MAGICPOT_USER_DATA_DIR'] = legacyData

    const module = await loadModule()
    expect(module.resolveStartupUserDataDirectory()).toMatchObject({
      path: legacyData,
      storageRoot: legacyData,
      projectRoot: path.join(legacyData, 'renderer-state', 'project-canvas'),
      source: 'env',
      legacyLayout: true
    })
  })

  it('keeps a legacy user-data override named Data as an exact legacy path', async () => {
    const legacyData = path.join(tempRoot, 'Legacy', 'Data')
    process.env['MAGICPOT_USER_DATA_DIR'] = legacyData

    const module = await loadModule()
    expect(module.getCurrentUserDataDirectoryState(legacyData)).toMatchObject({
      currentPath: legacyData,
      storageRoot: legacyData,
      projectRoot: path.join(legacyData, 'renderer-state', 'project-canvas'),
      autoSaveRoot: path.join(legacyData, 'AutoSave'),
      source: 'env',
      legacyLayout: true
    })
  })

  it('derives Data, Projects, and AutoSave from an explicit storage-root override', async () => {
    const storageRoot = path.join(tempRoot, 'UnifiedMagicPot')
    process.env['MAGICPOT_STORAGE_ROOT'] = storageRoot

    const module = await loadModule()
    expect(module.resolveStartupUserDataDirectory()).toMatchObject({
      path: path.join(storageRoot, 'Data'),
      storageRoot,
      projectRoot: path.join(storageRoot, 'Projects'),
      autoSaveRoot: path.join(storageRoot, 'AutoSave'),
      source: 'env',
      legacyLayout: false
    })
  })

  it('honors the standardized desktop override for automated artifact routing', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-654'
    process.env['MAGICPOT_TEST_DESKTOP_PATH'] = path.join(tempRoot, 'RedirectedDesktop')

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toMatchObject({
      path: path.join(
        tempRoot,
        'RedirectedDesktop',
        '.magicpot-trash',
        'MagicPot',
        'run-654',
        'Data'
      ),
      source: 'default'
    })
  })

  it('keeps packaged default user data outside the installation directory', async () => {
    appMock.isPackaged = true
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') {
        return path.join(tempRoot, 'AppData', 'Roaming')
      }
      if (name === 'desktop') {
        return path.join(tempRoot, 'Desktop')
      }
      if (name === 'temp') {
        return path.join(tempRoot, 'Temp')
      }
      throw new Error(`Unexpected app.getPath(${name})`)
    })

    const module = await loadModule()

    expect(module.getDefaultStorageRoot()).toBe(
      path.join(tempRoot, 'AppData', 'Roaming', 'MagicPot', 'aiengineelectron')
    )
    expect(module.getDefaultUserDataDirectory()).toBe(
      path.join(tempRoot, 'AppData', 'Roaming', 'MagicPot', 'aiengineelectron', 'Data')
    )
  })

  it('migrates an existing packaged default root without recursing into Data', async () => {
    appMock.isPackaged = true
    const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming')
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') return appDataRoot
      if (name === 'desktop') return path.join(tempRoot, 'Desktop')
      if (name === 'temp') return path.join(tempRoot, 'Temp')
      throw new Error(`Unexpected app.getPath(${name})`)
    })
    const defaultRoot = path.join(appDataRoot, 'MagicPot', 'aiengineelectron')
    await fs.mkdir(path.join(defaultRoot, 'customSkills'), { recursive: true })
    await fs.writeFile(path.join(defaultRoot, 'config.json'), '{}', 'utf8')
    await fs.writeFile(path.join(defaultRoot, 'customSkills', 'skill.json'), '{}', 'utf8')

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()

    expect(resolved.path).toBe(path.join(defaultRoot, 'Data'))
    expect(await fs.readFile(path.join(defaultRoot, 'Data', 'config.json'), 'utf8')).toBe('{}')
    expect(
      await fs.readFile(path.join(defaultRoot, 'Data', 'customSkills', 'skill.json'), 'utf8')
    ).toBe('{}')
    await expect(fs.access(path.join(defaultRoot, 'Data', 'Data'))).rejects.toThrow()
  })

  it('migrates legacy app-root data into the packaged default user data directory', async () => {
    appMock.isPackaged = true
    const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming')
    const installRoot = path.join(tempRoot, 'Programs', 'magicpot')
    setResourcesPath(path.join(installRoot, 'resources'))
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') {
        return appDataRoot
      }
      if (name === 'desktop') {
        return path.join(tempRoot, 'Desktop')
      }
      if (name === 'temp') {
        return path.join(tempRoot, 'Temp')
      }
      throw new Error(`Unexpected app.getPath(${name})`)
    })

    const legacyDataDir = path.join(installRoot, 'aiengineelectron')
    const defaultDataDir = path.join(appDataRoot, 'MagicPot', 'aiengineelectron', 'Data')
    await fs.mkdir(path.join(legacyDataDir, 'customSkills'), { recursive: true })
    await fs.writeFile(path.join(legacyDataDir, 'config.json'), '{"api":true}', 'utf8')
    await fs.writeFile(
      path.join(legacyDataDir, 'customSkills', 'agent.skill.json'),
      '{"skill":true}',
      'utf8'
    )

    const module = await loadModule()
    const resolved = module.resolveStartupUserDataDirectory()
    const secondResolved = module.resolveStartupUserDataDirectory()

    expect(resolved).toMatchObject({ path: defaultDataDir, source: 'default' })
    expect(secondResolved).toMatchObject({ path: defaultDataDir, source: 'default' })
    expect(await fs.readFile(path.join(defaultDataDir, 'config.json'), 'utf8')).toBe('{"api":true}')
    expect(
      await fs.readFile(path.join(defaultDataDir, 'customSkills', 'agent.skill.json'), 'utf8')
    ).toBe('{"skill":true}')
  })

  it('retires a migrated legacy bootstrap so it cannot revive later', async () => {
    appMock.isPackaged = true
    const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming')
    const installRoot = path.join(tempRoot, 'Programs', 'magicpot')
    const legacyBootstrapPath = path.join(
      installRoot,
      'aiengineelectron',
      'user-data-bootstrap.json'
    )
    const customDataDir = path.join(tempRoot, 'LegacyCustomData')
    setResourcesPath(path.join(installRoot, 'resources'))
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') return appDataRoot
      if (name === 'desktop') return path.join(tempRoot, 'Desktop')
      if (name === 'temp') return path.join(tempRoot, 'Temp')
      throw new Error(`Unexpected app.getPath(${name})`)
    })
    await fs.mkdir(path.dirname(legacyBootstrapPath), { recursive: true })
    await fs.writeFile(
      legacyBootstrapPath,
      JSON.stringify({ customUserDataDir: customDataDir }),
      'utf8'
    )

    const module = await loadModule()
    expect(module.resolveStartupUserDataDirectory().path).toBe(path.resolve(customDataDir))
    await expect(fs.access(legacyBootstrapPath)).rejects.toThrow()

    const primaryBootstrapPath = path.join(
      appDataRoot,
      'MagicPot',
      'aiengineelectron',
      'user-data-bootstrap.json'
    )
    await fs.writeFile(
      primaryBootstrapPath,
      JSON.stringify({ legacyBootstrapsRetired: true }),
      'utf8'
    )
    await fs.writeFile(
      legacyBootstrapPath,
      JSON.stringify({ customUserDataDir: path.join(tempRoot, 'RevivedData') }),
      'utf8'
    )
    const reloadedModule = await loadModule()
    expect(reloadedModule.resolveStartupUserDataDirectory().source).toBe('default')
  })

  it('honors a legacy app-root bootstrap custom userData override', async () => {
    appMock.isPackaged = true
    const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming')
    const installRoot = path.join(tempRoot, 'Programs', 'magicpot')
    const customDataDir = path.join(tempRoot, 'StableUserData')
    setResourcesPath(path.join(installRoot, 'resources'))
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') {
        return appDataRoot
      }
      if (name === 'desktop') {
        return path.join(tempRoot, 'Desktop')
      }
      if (name === 'temp') {
        return path.join(tempRoot, 'Temp')
      }
      throw new Error(`Unexpected app.getPath(${name})`)
    })
    await fs.mkdir(path.join(installRoot, 'aiengineelectron'), { recursive: true })
    await fs.writeFile(
      path.join(installRoot, 'aiengineelectron', 'user-data-bootstrap.json'),
      JSON.stringify({ customUserDataDir: customDataDir }),
      'utf8'
    )

    const module = await loadModule()

    expect(module.resolveStartupUserDataDirectory()).toMatchObject({
      path: path.resolve(customDataDir),
      source: 'persisted',
      legacyLayout: true
    })
  })
})
