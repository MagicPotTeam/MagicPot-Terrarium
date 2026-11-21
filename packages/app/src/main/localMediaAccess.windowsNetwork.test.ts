import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The Windows network checks with Windows path rules: node:path is path.win32 here, and node:fs
// is an in-memory stand-in that records every call. On Linux CI the shared test file runs them
// with POSIX path rules, where a backslash spelling is not even absolute.
const disk = vi.hoisted(() => ({
  /** Canonical-form rewrites (a DFS namespace folder -> its target), case-insensitive prefix. */
  links: new Map<string, string>(),
  files: new Set<string>(),
  directories: new Set<string>(),
  contents: new Map<string, string>(),
  calls: [] as string[]
}))

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual.win32, default: actual.win32, win32: actual.win32, posix: actual.posix }
})

vi.mock('node:fs', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path')
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const realpath = (value: string): string => {
    disk.calls.push(`realpath ${value}`)
    let resolved = win32.resolve(value)
    for (const [from, to] of disk.links) {
      if (resolved.toLowerCase().startsWith(from.toLowerCase())) {
        resolved = to + resolved.slice(from.length)
      }
    }
    const key = resolved.toLowerCase()
    if (!disk.files.has(key) && !disk.directories.has(key)) throw missing()
    return resolved
  }
  const fake = {
    realpathSync: Object.assign(realpath, { native: realpath }),
    statSync: (value: string) => {
      disk.calls.push(`stat ${value}`)
      const key = win32.resolve(value).toLowerCase()
      if (disk.directories.has(key)) return { isDirectory: () => true, isFile: () => false }
      if (disk.files.has(key)) return { isDirectory: () => false, isFile: () => true }
      throw missing()
    },
    readFileSync: (value: string) => {
      const content = disk.contents.get(value)
      if (content === undefined) throw missing()
      return content
    },
    writeFileSync: (value: string, content: string) => void disk.contents.set(value, content),
    renameSync: (from: string, to: string) => {
      disk.contents.set(to, disk.contents.get(from) ?? '')
      disk.contents.delete(from)
    },
    mkdirSync: () => undefined,
    rmSync: (value: string) => void disk.contents.delete(value),
    promises: {
      realpath: async (value: string) => realpath(value)
    }
  }
  return { ...fake, default: fake }
})

import {
  authorizeLocalMediaImportSourcePathAsync,
  authorizeScopedLocalMediaDirectory,
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  flushLocalMediaAccessGrants,
  initializeLocalMediaAccess,
  isLexicallyCoveredLocalMediaPath,
  resolveAuthorizedLocalMediaPath,
  resolveAuthorizedLocalMediaPathAsync
} from './localMediaAccess'

const GRANTS_PATH = 'C:\\Users\\u\\AppData\\Roaming\\MagicPot\\local-media-grants.json'
const ROOT = 'C:\\Users\\u\\AppData\\Roaming\\MagicPot'
// A DFS namespace folder and the server it resolves to.
const DROPPED_DIR = '\\\\corp\\dfs\\photos'
const CANONICAL_DIR = '\\\\server1\\share$\\photos'

let platform: PropertyDescriptor
beforeAll(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
})

function resetDisk(): void {
  clearScopedLocalMediaPathsForTest()
  disk.links.clear()
  disk.files.clear()
  disk.directories.clear()
  disk.contents.clear()
  disk.links.set(DROPPED_DIR, CANONICAL_DIR)
  disk.directories.add(CANONICAL_DIR.toLowerCase())
  disk.files.add(`${CANONICAL_DIR}\\x.png`.toLowerCase())
  disk.files.add(`${CANONICAL_DIR}\\sub\\y.png`.toLowerCase())
  disk.directories.add(ROOT.toLowerCase())
  disk.calls.length = 0
}

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
})

describe('Windows network paths with Windows path rules', () => {
  it('refuses every unscoped network spelling before any filesystem call', async () => {
    resetDisk()
    const spellings = [
      '\\\\server\\share\\image.png',
      '//server/share/image.png',
      '/\\server\\share\\image.png',
      '\\/server/share/image.png',
      '\\\\?\\UNC\\server\\share\\image.png',
      '\\\\.\\UNC\\server\\share\\image.png',
      '  \\\\server\\share\\image.png  ',
      // The spelling of a granted folder, but not inside it.
      '\\\\corp\\dfs\\other\\image.png'
    ]
    authorizeScopedLocalMediaDirectory(DROPPED_DIR)
    disk.calls.length = 0
    for (const spelling of spellings) {
      expect(resolveAuthorizedLocalMediaPath(spelling, [ROOT])).toBeNull()
      await expect(authorizeLocalMediaImportSourcePathAsync(spelling, [ROOT])).resolves.toBeNull()
    }
    expect(disk.calls).toEqual([])
  })

  it('serves a picked network file in the spelling it was dropped with', () => {
    resetDisk()
    const canonical = `${CANONICAL_DIR}\\x.png`
    expect(authorizeScopedLocalMediaPath(`${DROPPED_DIR}\\x.png`)).toBe(true)

    // The canvas keeps the dropped path, and the protocol hands it over as //host/...
    expect(resolveAuthorizedLocalMediaPath('//corp/dfs/photos/x.png', [])).toBe(canonical)
    expect(resolveAuthorizedLocalMediaPath(`${DROPPED_DIR}\\x.png`, [])).toBe(canonical)
    expect(resolveAuthorizedLocalMediaPath(canonical, [])).toBe(canonical)
    // Only that file: a sibling in the same spelling is still refused before any call.
    disk.calls.length = 0
    expect(resolveAuthorizedLocalMediaPath(`${DROPPED_DIR}\\sub\\y.png`, [])).toBeNull()
    expect(disk.calls).toEqual([])
  })

  it('serves the files of a picked network folder in the spelling it was picked with', () => {
    resetDisk()
    expect(authorizeScopedLocalMediaDirectory(DROPPED_DIR)).toBe(true)

    expect(resolveAuthorizedLocalMediaPath('//corp/dfs/photos/sub/y.png', [])).toBe(
      `${CANONICAL_DIR}\\sub\\y.png`
    )
    expect(resolveAuthorizedLocalMediaPath(`${CANONICAL_DIR}\\x.png`, [])).toBe(
      `${CANONICAL_DIR}\\x.png`
    )
  })

  it('forgets a spelling with its grant when newer grants push the grant out', () => {
    resetDisk()
    expect(authorizeScopedLocalMediaPath(`${DROPPED_DIR}\\x.png`)).toBe(true)
    for (let index = 0; index < 1_000; index += 1) {
      const file = `C:\\Pictures\\${index}.png`
      disk.files.add(file.toLowerCase())
      authorizeScopedLocalMediaPath(file)
    }
    disk.calls.length = 0
    expect(resolveAuthorizedLocalMediaPath('//corp/dfs/photos/x.png', [])).toBeNull()
    expect(disk.calls).toEqual([])
  })

  it('keeps the spellings across a restart, only for grants that are still there', () => {
    resetDisk()
    initializeLocalMediaAccess(GRANTS_PATH)
    authorizeScopedLocalMediaPath(`${DROPPED_DIR}\\x.png`)
    authorizeScopedLocalMediaDirectory(DROPPED_DIR)
    flushLocalMediaAccessGrants()
    const persisted = JSON.parse(disk.contents.get(GRANTS_PATH) ?? '{}')
    expect(persisted.networkFileSpellings).toEqual([
      [`${DROPPED_DIR}\\x.png`, `${CANONICAL_DIR}\\x.png`]
    ])
    expect(persisted.networkDirectorySpellings).toEqual([[DROPPED_DIR, CANONICAL_DIR]])

    initializeLocalMediaAccess(GRANTS_PATH)
    expect(resolveAuthorizedLocalMediaPath('//corp/dfs/photos/x.png', [])).toBe(
      `${CANONICAL_DIR}\\x.png`
    )

    // The folder is gone on the next start: its grant is not loaded, and its spelling no
    // longer lets a request reach the host.
    disk.directories.delete(CANONICAL_DIR.toLowerCase())
    disk.files.delete(`${CANONICAL_DIR}\\x.png`.toLowerCase())
    initializeLocalMediaAccess(GRANTS_PATH)
    disk.calls.length = 0
    expect(resolveAuthorizedLocalMediaPath('//corp/dfs/photos/sub/y.png', [])).toBeNull()
    expect(resolveAuthorizedLocalMediaPath('//corp/dfs/photos/x.png', [])).toBeNull()
    expect(disk.calls).toEqual([])
  })
})

describe('the async policy (paths the renderer names) with Windows path rules', () => {
  // A LoRA model folder the user configured on a share.
  const NETWORK_ROOT = '\\\\nas\\models\\loras'
  const NETWORK_FILE = `${NETWORK_ROOT}\\style.safetensors`

  const withNetworkRoot = (): void => {
    resetDisk()
    disk.directories.add(NETWORK_ROOT.toLowerCase())
    disk.files.add(NETWORK_FILE.toLowerCase())
    disk.files.add(`${ROOT}\\media\\a.png`.toLowerCase())
    disk.calls.length = 0
  }

  it('refuses every unscoped network spelling before any filesystem call', async () => {
    withNetworkRoot()
    for (const spelling of [
      '\\\\attacker\\share\\x.png',
      '//attacker/share/x.png',
      '/\\attacker\\share\\x.png',
      '\\/attacker/share/x.png',
      '\\\\?\\UNC\\attacker\\share\\x.png',
      '\\??\\UNC\\attacker\\share\\x.png',
      '/??/UNC/nas/models/loras/style.safetensors',
      // Inside the configured share, but network roots are off by default (the protocol).
      NETWORK_FILE,
      '//nas/models/loras/style.safetensors'
    ]) {
      await expect(
        resolveAuthorizedLocalMediaPathAsync(spelling, [ROOT, NETWORK_ROOT])
      ).resolves.toBeNull()
      // With network roots: only a request inside one gets through, never another host.
      if (!/nas/.test(spelling) || spelling.startsWith('/??')) {
        await expect(
          resolveAuthorizedLocalMediaPathAsync(spelling, [ROOT, NETWORK_ROOT], {
            allowNetworkRoots: true
          })
        ).resolves.toBeNull()
      }
    }
    expect(disk.calls).toEqual([])
  })

  it('reads a configured network folder only with network roots, contacting only that host', async () => {
    withNetworkRoot()
    await expect(
      resolveAuthorizedLocalMediaPathAsync(
        '//nas/models/loras/style.safetensors',
        [ROOT, NETWORK_ROOT],
        {
          allowNetworkRoots: true
        }
      )
    ).resolves.toBe(NETWORK_FILE)
    // A sibling share of the same host, by its text: refused before any call.
    disk.calls.length = 0
    await expect(
      resolveAuthorizedLocalMediaPathAsync('\\\\nas\\other\\style.safetensors', [NETWORK_ROOT], {
        allowNetworkRoots: true
      })
    ).resolves.toBeNull()
    // `..` cannot climb out of the share by its text either.
    await expect(
      resolveAuthorizedLocalMediaPathAsync(`${NETWORK_ROOT}\\..\\..\\x`, [NETWORK_ROOT], {
        allowNetworkRoots: true
      })
    ).resolves.toBeNull()
    expect(disk.calls).toEqual([])
  })

  it('never canonicalizes a network root for a local request', async () => {
    withNetworkRoot()
    await expect(
      resolveAuthorizedLocalMediaPathAsync(`${ROOT}\\media\\a.png`, [NETWORK_ROOT, ROOT], {
        allowNetworkRoots: true
      })
    ).resolves.toBe(`${ROOT}\\media\\a.png`)
    await expect(
      resolveAuthorizedLocalMediaPathAsync('C:\\elsewhere\\b.png', [NETWORK_ROOT, ROOT], {
        allowNetworkRoots: true
      })
    ).resolves.toBeNull()
    expect(disk.calls.filter((call) => /nas/i.test(call))).toEqual([])
  })

  it('serves a granted network file in its dropped spelling, as the sync policy does', async () => {
    resetDisk()
    expect(authorizeScopedLocalMediaPath(`${DROPPED_DIR}\\x.png`)).toBe(true)
    await expect(resolveAuthorizedLocalMediaPathAsync('//corp/dfs/photos/x.png', [])).resolves.toBe(
      `${CANONICAL_DIR}\\x.png`
    )
    disk.calls.length = 0
    await expect(
      resolveAuthorizedLocalMediaPathAsync(`${DROPPED_DIR}\\sub\\y.png`, [])
    ).resolves.toBeNull()
    expect(disk.calls).toEqual([])
  })

  it('tells a lexically covered path from one outside without any filesystem call', () => {
    withNetworkRoot()
    expect(isLexicallyCoveredLocalMediaPath(`${ROOT}\\missing.png`, [ROOT])).toBe(true)
    expect(isLexicallyCoveredLocalMediaPath('C:\\Users\\u\\.ssh\\id_rsa', [ROOT])).toBe(false)
    expect(isLexicallyCoveredLocalMediaPath('\\\\attacker\\share\\x', [ROOT])).toBe(false)
    expect(disk.calls).toEqual([])
  })
})
