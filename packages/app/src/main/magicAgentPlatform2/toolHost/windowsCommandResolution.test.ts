import { describe, expect, it } from 'vitest'
import {
  isJobHelperLaunchable,
  isWindowsBatchFileName,
  resolveWindowsSpawnCommand,
  windowsSpawnSearchPath,
  type WindowsCommandLookup
} from './windowsCommandResolution'

/** A fake Windows file system: GetFileAttributesW is case-insensitive and ignores slash direction. */
const lookup = (
  files: readonly string[],
  parentEnv: Record<string, string | undefined> = { Path: 'C:\\parent-bin' },
  directories: readonly string[] = []
): WindowsCommandLookup & { probes: string[] } => {
  const key = (value: string) => value.replace(/\//g, '\\').toLowerCase()
  const fileSet = new Set(files.map(key))
  const directorySet = new Set(directories.map(key))
  const probes: string[] = []
  return {
    parentEnv,
    probes,
    isFile: (candidate) => {
      probes.push(candidate)
      return fileSet.has(key(candidate)) && !directorySet.has(key(candidate))
    }
  }
}

const cwd = 'C:\\work'

describe('resolveWindowsSpawnCommand (libuv search_path on win32)', () => {
  it('looks in cwd before PATH for a bare name', () => {
    const fs = lookup(['C:\\work\\tool.exe', 'C:\\bin\\tool.exe'])
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: 'C:\\bin' }, fs)).toBe(
      'C:\\work\\tool.exe'
    )
  })

  it('tries .com before .exe and the name as given only when it has an extension', () => {
    expect(
      resolveWindowsSpawnCommand(
        'tool',
        cwd,
        { PATH: 'C:\\bin' },
        lookup(['C:\\bin\\tool.com', 'C:\\bin\\tool.exe'])
      )
    ).toBe('C:\\bin\\tool.com')
    // No extension: the bare file is never a candidate.
    const bare = lookup(['C:\\bin\\tool'])
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: 'C:\\bin' }, bare)).toBeUndefined()
    expect(bare.probes).toEqual([
      'C:\\work\\tool.com',
      'C:\\work\\tool.exe',
      'C:\\bin\\tool.com',
      'C:\\bin\\tool.exe'
    ])
    // With an extension the name as given comes first, then name + .com / .exe are appended.
    expect(
      resolveWindowsSpawnCommand(
        'tool.exe',
        cwd,
        { PATH: 'C:\\bin' },
        lookup(['C:\\bin\\tool.exe.com', 'C:\\bin\\tool.exe'])
      )
    ).toBe('C:\\bin\\tool.exe')
    expect(
      resolveWindowsSpawnCommand(
        'tool.v2',
        cwd,
        { PATH: 'C:\\bin' },
        lookup(['C:\\bin\\tool.v2.exe'])
      )
    ).toBe('C:\\bin\\tool.v2.exe')
    // A trailing dot is no extension and no second dot is added.
    expect(
      resolveWindowsSpawnCommand('tool.', cwd, { PATH: 'C:\\bin' }, lookup(['C:\\bin\\tool.exe']))
    ).toBe('C:\\bin\\tool.exe')
  })

  it('resolves a name with a path component against cwd only, never PATH', () => {
    const fs = lookup(['C:\\work\\sub\\tool.exe', 'C:\\bin\\sub\\tool.exe', 'C:\\bin\\tool.exe'])
    expect(resolveWindowsSpawnCommand('sub\\tool', cwd, { PATH: 'C:\\bin' }, fs)).toBe(
      'C:\\work\\sub\\tool.exe'
    )
    expect(resolveWindowsSpawnCommand('sub/tool', cwd, { PATH: 'C:\\bin' }, fs)).toBe(
      'C:\\work\\sub/tool.exe'
    )
    expect(resolveWindowsSpawnCommand('.\\tool', cwd, { PATH: 'C:\\bin' }, fs)).toBeUndefined()
    expect(
      resolveWindowsSpawnCommand(
        'D:\\x\\tool.exe',
        cwd,
        { PATH: 'C:\\bin' },
        lookup(['D:\\x\\tool.exe'])
      )
    ).toBe('D:\\x\\tool.exe')
    expect(resolveWindowsSpawnCommand('\\x\\tool', cwd, {}, lookup(['C:\\x\\tool.exe']))).toBe(
      'C:\\x\\tool.exe'
    )
    expect(
      resolveWindowsSpawnCommand(
        '\\\\srv\\share\\tool',
        cwd,
        {},
        lookup(['\\\\srv\\share\\tool.exe'])
      )
    ).toBe('\\\\srv\\share\\tool.exe')
    // Drive-relative on the cwd drive is relative to cwd; on another drive it stays drive-relative.
    expect(
      resolveWindowsSpawnCommand('C:sub\\tool', cwd, {}, lookup(['C:\\work\\sub\\tool.exe']))
    ).toBe('C:\\work\\sub\\tool.exe')
    expect(resolveWindowsSpawnCommand('D:tool', cwd, {}, lookup(['D:tool.exe']))).toBe('D:tool.exe')
  })

  it('takes PATH from the env passed to spawn, matching the key case-insensitively like Node and libuv', () => {
    const fs = lookup(['C:\\bin\\tool.exe', 'C:\\parent-bin\\tool.exe', 'C:\\upper\\tool.exe'])
    expect(resolveWindowsSpawnCommand('tool', cwd, { Path: 'C:\\bin' }, fs)).toBe(
      'C:\\bin\\tool.exe'
    )
    expect(resolveWindowsSpawnCommand('tool', cwd, { pAtH: 'C:\\bin' }, fs)).toBe(
      'C:\\bin\\tool.exe'
    )
    // Node keeps the first key in code-unit order of each case-insensitive group: 'PATH' < 'Path'.
    expect(
      resolveWindowsSpawnCommand('tool', cwd, { Path: 'C:\\bin', PATH: 'C:\\upper' }, fs)
    ).toBe('C:\\upper\\tool.exe')
    // An undefined first key hides the group; libuv then copies PATH from the parent.
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: undefined, Path: 'C:\\bin' }, fs)).toBe(
      'C:\\parent-bin\\tool.exe'
    )
    expect(resolveWindowsSpawnCommand('tool', cwd, {}, fs)).toBe('C:\\parent-bin\\tool.exe')
    expect(windowsSpawnSearchPath({ OTHER: 'x' }, {})).toBeUndefined()
    expect(resolveWindowsSpawnCommand('tool', cwd, {}, lookup([], {}))).toBeUndefined()
    // An empty PATH searches cwd only.
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: '' }, fs)).toBeUndefined()
  })

  it('parses PATH entries like libuv: quotes, empty entries, trailing separators, relative entries', () => {
    const fs = lookup([
      'C:\\quoted;dir\\tool.exe',
      'C:\\work\\tools\\tool.exe',
      'C:\\slash\\tool.exe'
    ])
    expect(
      resolveWindowsSpawnCommand('tool', cwd, { PATH: ';;"C:\\quoted;dir";C:\\other\\' }, fs)
    ).toBe('C:\\quoted;dir\\tool.exe')
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: 'C:\\none;tools' }, fs)).toBe(
      'C:\\work\\tools\\tool.exe'
    )
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: "'C:\\slash\\'" }, fs)).toBe(
      'C:\\slash\\tool.exe'
    )
  })

  it('skips cwd when NoDefaultCurrentDirectoryInExePath is set in the parent environment', () => {
    const fs = lookup(['C:\\work\\tool.exe', 'C:\\bin\\tool.exe'], {
      PATH: 'C:\\bin',
      NODEFAULTCURRENTDIRECTORYINEXEPATH: ''
    })
    expect(resolveWindowsSpawnCommand('tool', cwd, undefined, fs)).toBe('C:\\bin\\tool.exe')
  })

  it('skips directories and refuses empty names', () => {
    const fs = lookup(['C:\\work\\tool.exe', 'C:\\bin\\tool.exe'], undefined, [
      'C:\\work\\tool.exe'
    ])
    expect(resolveWindowsSpawnCommand('tool', cwd, { PATH: 'C:\\bin' }, fs)).toBe(
      'C:\\bin\\tool.exe'
    )
    expect(resolveWindowsSpawnCommand('', cwd, { PATH: 'C:\\bin' }, fs)).toBeUndefined()
    expect(resolveWindowsSpawnCommand('.', cwd, { PATH: 'C:\\bin' }, fs)).toBeUndefined()
  })

  it('hands only absolute .exe / .com paths to the Job Object helper', () => {
    expect(isJobHelperLaunchable('C:\\bin\\tool.exe')).toBe(true)
    expect(isJobHelperLaunchable('c:/bin/TOOL.COM')).toBe(true)
    expect(isJobHelperLaunchable('\\\\srv\\share\\tool.exe')).toBe(true)
    expect(isJobHelperLaunchable('C:\\bin\\tool.bat')).toBe(false)
    expect(isJobHelperLaunchable('C:\\bin\\tool.cmd')).toBe(false)
    expect(isJobHelperLaunchable('C:\\bin\\tool.exe.')).toBe(false)
    expect(isJobHelperLaunchable('D:tool.exe')).toBe(false)
    expect(isJobHelperLaunchable('/tmp/tool.exe')).toBe(false)
  })

  it('hands paths with spaces and non-ASCII characters to the helper, but no path beyond the classic limits', () => {
    const fs = lookup(['C:\\Program Files\\工具 集\\outil é.exe'])
    const resolved = resolveWindowsSpawnCommand(
      'outil é',
      'C:\\作業 フォルダ',
      {
        PATH: 'C:\\Program Files\\工具 集'
      },
      fs
    )
    expect(resolved).toBe('C:\\Program Files\\工具 集\\outil é.exe')
    expect(isJobHelperLaunchable(resolved!, 'C:\\作業 フォルダ')).toBe(true)
    // Deliberately stricter than libuv: the helper has no long-path manifest, so a command or a
    // working directory at or beyond the classic limits keeps the direct spawn.
    const dir = (length: number) => `C:\\${'d'.repeat(length - 3)}`
    expect(dir(247)).toHaveLength(247)
    expect(isJobHelperLaunchable('C:\\bin\\tool.exe', dir(247))).toBe(true)
    expect(isJobHelperLaunchable('C:\\bin\\tool.exe', dir(248))).toBe(false)
    expect(isJobHelperLaunchable(`${dir(238)}\\tool.exe`)).toBe(true)
    expect(isJobHelperLaunchable(`${dir(239)}\\tool.exe`)).toBe(false)
  })
})

describe('isWindowsBatchFileName (Node refuses these names without a shell)', () => {
  it('matches .cmd and .bat as given, in any case, with trailing dots and spaces', () => {
    for (const name of ['npm.cmd', 'build.BAT', 'C:\\tools\\x.Cmd', 'npm.cmd.', 'npm.cmd ', 'b.bat. .'])
      expect(isWindowsBatchFileName(name), name).toBe(true)
  })
  it('does not match other names', () => {
    for (const name of ['npm', 'npm.exe', 'npm.cmd.exe', 'cmd', 'x.batch', 'tool.com', 'a.cmdx'])
      expect(isWindowsBatchFileName(name), name).toBe(false)
  })
})
