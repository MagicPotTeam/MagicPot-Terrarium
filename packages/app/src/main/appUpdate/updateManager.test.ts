import path from 'path'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '@shared/api/svcAppUpdate'

const fsState = vi.hoisted(() => {
  const files = new Map<string, Buffer>()
  let tempDirectoryCounter = 0

  const fsMock = {
    promises: {
      mkdir: vi.fn(async () => undefined),
      mkdtemp: vi.fn(async (prefix: string) => {
        tempDirectoryCounter += 1
        return `${prefix}${tempDirectoryCounter}`
      }),
      chmod: vi.fn(async () => undefined),
      open: vi.fn(async (filePath: string) => {
        files.set(filePath, Buffer.alloc(0))
        return {
          write: vi.fn(async (buffer: Buffer, offset = 0, length = buffer.length - offset) => {
            const part = buffer.subarray(offset, offset + Math.min(length, 1))
            files.set(filePath, Buffer.concat([files.get(filePath) ?? Buffer.alloc(0), part]))
            return { bytesWritten: part.length, buffer }
          }),
          sync: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined)
        }
      }),
      stat: vi.fn(async (filePath: string) => {
        const content = files.get(filePath)
        if (!content) throw new Error(`ENOENT: ${filePath}`)
        return { isFile: () => true, size: content.length }
      }),
      rm: vi.fn(async (targetPath: string) => {
        for (const filePath of files.keys()) {
          if (filePath === targetPath || filePath.startsWith(`${targetPath}${path.sep}`))
            files.delete(filePath)
        }
      })
    },
    createReadStream: vi.fn((filePath: string) => {
      const stream = {
        async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
          const content = files.get(filePath)
          if (!content) throw new Error(`ENOENT: ${filePath}`)
          yield content
        },
        destroy: vi.fn()
      }
      return stream
    })
  }

  return {
    files,
    fsMock,
    reset: () => {
      files.clear()
      tempDirectoryCounter = 0
      for (const mock of [
        fsMock.promises.mkdir,
        fsMock.promises.mkdtemp,
        fsMock.promises.chmod,
        fsMock.promises.open,
        fsMock.promises.stat,
        fsMock.promises.rm,
        fsMock.createReadStream
      ])
        mock.mockClear()
    }
  }
})

vi.mock('fs', () => ({ default: fsState.fsMock }))

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

type SetupOptions = {
  platform: NodeJS.Platform
  isPackaged?: boolean
  packageMode?: 'pure' | 'embedded'
  exePath?: string
  launcherEnv?: Partial<
    Record<
      | 'MAGICPOT_LAUNCHER_ROOT'
      | 'MAGICPOT_LAUNCH_BUILD_ID'
      | 'MAGICPOT_LAUNCH_RUNTIME_ID'
      | 'MAGICPOT_LAUNCH_TOKEN',
      string
    >
  >
}

type ReleaseAsset = {
  name: string
  browser_download_url: string
  size: number
  digest: string
}

type Release = {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}

const appQuitMock = vi.hoisted(() => vi.fn())

async function loadUpdateManager({
  platform,
  isPackaged = true,
  packageMode = 'pure',
  exePath = path.join('D:', 'Magic Pot', 'magicpot.exe'),
  launcherEnv = {}
}: SetupOptions) {
  vi.resetModules()
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.stubEnv('MAGICPOT_LAUNCHER_ROOT', launcherEnv.MAGICPOT_LAUNCHER_ROOT ?? '')
  vi.stubEnv('MAGICPOT_LAUNCH_BUILD_ID', launcherEnv.MAGICPOT_LAUNCH_BUILD_ID ?? '')
  vi.stubEnv('MAGICPOT_LAUNCH_RUNTIME_ID', launcherEnv.MAGICPOT_LAUNCH_RUNTIME_ID ?? '')
  vi.stubEnv('MAGICPOT_LAUNCH_TOKEN', launcherEnv.MAGICPOT_LAUNCH_TOKEN ?? '')

  const appTempPath = path.join('D:', 'Temp')
  const appMock = {
    isPackaged,
    getPath: vi.fn((name: string) => {
      if (name === 'exe') return exePath
      if (name === 'temp') return appTempPath
      throw new Error(`Unexpected app.getPath(${name})`)
    }),
    getVersion: vi.fn(() => '9.9.9'),
    quit: appQuitMock
  }

  vi.doMock('electron', () => ({ app: appMock }))
  vi.doMock('@shared/config/viteEnv', () => ({
    PACKAGE_MODE: packageMode,
    PACKAGE_VERSION: '1.2.3',
    UPDATE_PROVIDER_CHANNEL: 'latest',
    UPDATE_PROVIDER_OWNER: 'MagicPotTeam',
    UPDATE_PROVIDER_REPO: 'MagicPot-Terrarium'
  }))
  const module = await import('./updateManager')
  return { module, appMock }
}

function digest(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function asset(
  version: string,
  timestamp: string,
  kind: 'setup.exe' | 'win.7z',
  content = Buffer.from('installer payload'),
  repo = 'MagicPot-Terrarium',
  owner = 'MagicPotTeam',
  tag = `release/${version}`
): ReleaseAsset {
  const name = `magicpot-${version}-${timestamp}-${kind}`
  return {
    name,
    browser_download_url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`,
    size: content.length,
    digest: digest(content)
  }
}

function release(version: string, timestamp: string, options: Partial<Release> = {}): Release {
  return {
    tag_name: `release/${version}`,
    name: `MagicPot ${version}`,
    body: `Notes for ${version}`,
    published_at: '2026-01-01T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [asset(version, timestamp, 'setup.exe'), asset(version, timestamp, 'win.7z')],
    ...options
  }
}

function responseJson(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => value)
  } as unknown as Response
}

function responseBody(chunks: Buffer[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        for (const chunk of chunks) yield chunk
      }
    }
  } as unknown as Response
}

function mockSpawn(mode: 'spawn' | 'error' | 'silent' = 'spawn'): void {
  spawnMock.mockImplementation(() => ({
    unref: vi.fn(),
    once: (event: string, callback: (error?: Error) => void): unknown => {
      if (mode === 'spawn' && event === 'spawn') callback()
      if (mode === 'error' && event === 'error') callback(new Error('installer could not start'))
      return undefined
    }
  }))
}

function expectWindowsSupported(status: AppUpdateStatus): void {
  expect(status).toMatchObject({ supported: true, canCheck: true })
}

describe('custom GitHub release asset updater', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fsState.reset()
    spawnMock.mockReset()
    appQuitMock.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  it.each([
    ['linux', 'linux'],
    ['macOS', 'darwin']
  ] as const)('remains unsupported on %s', async (_name, platform) => {
    const { module } = await loadUpdateManager({ platform })
    await expect(module.initializeAppUpdateManager()).resolves.toMatchObject({
      state: 'unsupported',
      supported: false,
      canCheck: false,
      canDownload: false,
      canInstall: false
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('remains unsupported in development', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32', isPackaged: false })
    await expect(module.initializeAppUpdateManager()).resolves.toMatchObject({
      state: 'unsupported',
      supported: false
    })
  })

  it('preserves launcher-managed behavior only for a complete validated marker', async () => {
    const { module } = await loadUpdateManager({
      platform: 'win32',
      launcherEnv: {
        MAGICPOT_LAUNCHER_ROOT: path.resolve('D:', 'MagicPotLauncher'),
        MAGICPOT_LAUNCH_BUILD_ID: '20250102-030405-abcdef0',
        MAGICPOT_LAUNCH_RUNTIME_ID: 'python-3.12.1',
        MAGICPOT_LAUNCH_TOKEN: '0123456789abcdef0123456789abcdef'
      }
    })

    for (const action of [
      module.initializeAppUpdateManager,
      module.checkForAppUpdates,
      module.downloadAppUpdate,
      module.installAppUpdate
    ]) {
      await expect(action()).resolves.toMatchObject({
        state: 'managed-by-launcher',
        supported: false,
        canCheck: false,
        canDownload: false,
        canInstall: false
      })
    }
    expect(fetch).not.toHaveBeenCalled()

    const incomplete = await loadUpdateManager({
      platform: 'win32',
      launcherEnv: { MAGICPOT_LAUNCHER_ROOT: path.resolve('D:', 'forged') }
    })
    await expect(incomplete.module.initializeAppUpdateManager()).resolves.toMatchObject({
      state: 'idle',
      supported: true
    })
  })

  it('queries the configured private repository directly and selects semver/timestamp deterministically', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(
      responseJson([
        release('1.10.0', '20260101T010101Z'),
        release('1.9.99', '20990101T010101Z'),
        release('1.10.0', '20260102T010101Z'),
        release('1.11.0', '20260103T010101Z', {
          assets: [asset('1.11.0', '20260103T010101Z', 'setup.exe')]
        })
      ])
    )

    const status = await module.checkForAppUpdates()
    expectWindowsSupported(status)
    expect(status).toMatchObject({
      state: 'available',
      latestVersion: '1.10.0',
      releaseName: 'MagicPot 1.10.0'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/MagicPotTeam/MagicPot-Terrarium/releases?per_page=100',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        })
      })
    )
  })

  it('ignores drafts, prereleases, non-release tags, malformed assets, blockmaps, and latest.yml', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    vi.mocked(fetch).mockResolvedValueOnce(
      responseJson([
        release('1.9.0', '20260101T000000Z', { draft: true }),
        release('1.9.1', '20260101T000001Z', { prerelease: true }),
        release('1.9.2', '20260101T000002Z', { tag_name: 'v1.9.2' }),
        release('1.9.3', '20260101T000003Z', {
          assets: [
            asset('1.9.3', '20260101T000003Z', 'setup.exe'),
            { ...asset('1.9.3', '20260101T000003Z', 'win.7z'), digest: 'sha256:not-a-digest' },
            {
              ...asset('1.9.3', '20260101T000003Z', 'setup.exe'),
              name: 'magicpot-1.9.3-20260101T000003Z-setup.exe.blockmap'
            },
            {
              ...asset('1.9.3', '20260101T000003Z', 'setup.exe'),
              name: 'latest.yml'
            }
          ]
        })
      ])
    )

    await expect(module.checkForAppUpdates()).resolves.toMatchObject({
      state: 'not-available',
      latestVersion: '1.2.3'
    })
  })

  it('never downgrades and does not claim up-to-date when GitHub access fails', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    vi.mocked(fetch).mockResolvedValueOnce(
      responseJson([release('1.2.3', '20260101T000000Z'), release('1.2.2', '20260102T000000Z')])
    )
    await expect(module.checkForAppUpdates()).resolves.toMatchObject({
      state: 'not-available',
      latestVersion: '1.2.3'
    })

    const inaccessible = await loadUpdateManager({ platform: 'win32' })
    vi.mocked(fetch).mockResolvedValueOnce(responseJson({ message: 'Not Found' }, 404))
    const error = await inaccessible.module.checkForAppUpdates()
    expect(error.state).toBe('error')
    expect(error.errorMessage).toMatch(/private|inaccessible|manually/i)
    expect(error.errorMessage).not.toMatch(/not-available|up.to.date/i)
  })

  it('rejects invalid expected asset URLs and invalid positive metadata', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const validSetup = asset('1.3.0', '20260101T000000Z', 'setup.exe')
    const validWin = asset('1.3.0', '20260101T000000Z', 'win.7z')
    vi.mocked(fetch).mockResolvedValueOnce(
      responseJson([
        release('1.3.0', '20260101T000000Z', {
          assets: [{ ...validSetup, browser_download_url: 'http://github.com/wrong' }, validWin]
        }),
        release('1.3.1', '20260101T000001Z', {
          assets: [
            { ...validSetup, name: 'magicpot-1.3.1-20260101T000001Z-setup.exe', size: 0 },
            validWin
          ]
        }),
        release('1.3.2', '20260101T000002Z', {
          assets: [
            {
              ...validSetup,
              name: 'magicpot-1.3.2-20260101T000002Z-setup.exe',
              digest: 'sha256:abc'
            },
            validWin
          ]
        })
      ])
    )
    await expect(module.checkForAppUpdates()).resolves.toMatchObject({ state: 'not-available' })
  })

  it('streams to a unique private .part directory, handles partial writes, and verifies size/hash', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const update = release('1.3.0', '20260101T000000Z')
    vi.mocked(fetch)
      .mockResolvedValueOnce(responseJson([update]))
      .mockResolvedValueOnce(responseBody([Buffer.from('installer '), Buffer.from('payload')]))

    await expect(module.checkForAppUpdates()).resolves.toMatchObject({ state: 'available' })
    const status = await module.downloadAppUpdate()
    expect(status).toMatchObject({ state: 'downloaded', downloadedAt: expect.any(Number) })
    expect(fsState.fsMock.promises.mkdtemp).toHaveBeenCalledWith(
      expect.stringContaining(path.join('D:', 'Temp', 'magicpot-updates', 'magicpot-update-.part-'))
    )
    expect(fsState.fsMock.promises.open).toHaveBeenCalledWith(
      expect.stringMatching(/magicpot-1\.3\.0-20260101T000000Z-setup\.exe$/),
      'wx',
      0o600
    )
    const [filePath] = [...fsState.files.keys()]
    expect(filePath).toMatch(/\.part-[^/\\]+[/\\]magicpot-1\.3\.0-20260101T000000Z-setup\.exe$/)
    expect(fsState.files.get(filePath)).toEqual(Buffer.from('installer payload'))
    expect(fsState.fsMock.promises.chmod).toHaveBeenCalledWith(
      expect.stringContaining('.part-'),
      0o700
    )
  })

  it('cleans the private temporary directory after size or digest verification failure', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const update = release('1.3.0', '20260101T000000Z')
    vi.mocked(fetch)
      .mockResolvedValueOnce(responseJson([update]))
      .mockResolvedValueOnce(responseBody([Buffer.from('wrong payload')]))

    await module.checkForAppUpdates()
    const status = await module.downloadAppUpdate()
    expect(status.state).toBe('error')
    expect(status.errorMessage).toMatch(/size|SHA256/i)
    expect(fsState.files).toHaveLength(0)
    expect(fsState.fsMock.promises.rm).toHaveBeenCalledWith(expect.stringContaining('.part-'), {
      recursive: true,
      force: true
    })
  })

  it('serializes check/download commands and clears stale downloaded metadata before a new check', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const update = release('1.3.0', '20260101T000000Z')
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(responseJson([update]))
      .mockResolvedValueOnce(responseBody([Buffer.from('installer payload')]))
      .mockResolvedValueOnce(responseJson([]))

    const check = module.checkForAppUpdates()
    const download = module.downloadAppUpdate()
    await expect(check).resolves.toMatchObject({ state: 'available' })
    await expect(download).resolves.toMatchObject({ state: 'downloaded' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await expect(module.checkForAppUpdates()).resolves.toMatchObject({ state: 'not-available' })
    expect(module.getAppUpdateStatus()).toMatchObject({
      state: 'not-available',
      canDownload: false,
      canInstall: false
    })
    expect(fsState.files).toHaveLength(0)
  })

  it('protects status listeners from exceptions and supports unsubscribe', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const badListener = vi.fn(() => {
      throw new Error('renderer listener failed')
    })
    const goodListener = vi.fn()
    const unsubscribe = module.addAppUpdateStatusListener(badListener)
    module.addAppUpdateStatusListener(goodListener)
    expect(badListener).toHaveBeenCalled()
    expect(goodListener).toHaveBeenCalled()

    vi.mocked(fetch).mockResolvedValueOnce(responseJson([]))
    await module.checkForAppUpdates()
    expect(goodListener).toHaveBeenCalledWith(expect.objectContaining({ state: 'not-available' }))
    const badCallsBefore = badListener.mock.calls.length
    unsubscribe()
    vi.mocked(fetch).mockResolvedValueOnce(responseJson([]))
    await module.checkForAppUpdates()
    expect(badListener.mock.calls.length).toBe(badCallsBefore)
  })

  it('rechecks integrity immediately before installing and never installs a modified file', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const update = release('1.3.0', '20260101T000000Z')
    vi.mocked(fetch)
      .mockResolvedValueOnce(responseJson([update]))
      .mockResolvedValueOnce(responseBody([Buffer.from('installer payload')]))
    await module.checkForAppUpdates()
    await module.downloadAppUpdate()
    const [filePath] = [...fsState.files.keys()]
    fsState.files.set(filePath, Buffer.from('changed payload'))

    const status = await module.installAppUpdate()
    expect(status.state).toBe('error')
    expect(status.errorMessage).toMatch(/size|SHA256/i)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()
    expect(module.isAppUpdateInstallInProgress()).toBe(false)
    expect(fsState.files).toHaveLength(0)
  })

  it('launches NSIS with an unquoted raw /D= directory argument and quits only after spawn', async () => {
    const { module } = await loadUpdateManager({
      platform: 'win32',
      exePath: path.join('D:', 'Magic Pot', 'magicpot', 'magicpot.exe')
    })
    const update = release('1.3.0', '20260101T000000Z')
    vi.mocked(fetch)
      .mockResolvedValueOnce(responseJson([update]))
      .mockResolvedValueOnce(responseBody([Buffer.from('installer payload')]))
    mockSpawn('spawn')

    await module.checkForAppUpdates()
    await module.downloadAppUpdate()
    const status = await module.installAppUpdate()
    expect(status.state).toBe('installing')
    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(/magicpot-1\.3\.0-20260101T000000Z-setup\.exe$/),
      [`/D=${path.dirname(path.join('D:', 'Magic Pot', 'magicpot', 'magicpot.exe'))}`],
      expect.objectContaining({ detached: true, shell: false, stdio: 'ignore', windowsHide: false })
    )
    expect(spawnMock.mock.calls[0][1][0]).not.toContain('"')
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(module.isAppUpdateInstallInProgress()).toBe(true)
  })

  it('reports asynchronous installer spawn errors before quitting', async () => {
    const { module } = await loadUpdateManager({ platform: 'win32' })
    const update = release('1.3.0', '20260101T000000Z')
    vi.mocked(fetch)
      .mockResolvedValueOnce(responseJson([update]))
      .mockResolvedValueOnce(responseBody([Buffer.from('installer payload')]))
    mockSpawn('error')

    await module.checkForAppUpdates()
    await module.downloadAppUpdate()
    const status = await module.installAppUpdate()
    expect(status).toMatchObject({ state: 'error', errorMessage: 'installer could not start' })
    expect(appQuitMock).not.toHaveBeenCalled()
    expect(module.isAppUpdateInstallInProgress()).toBe(false)
    expect(fsState.files).toHaveLength(0)
  })
})
