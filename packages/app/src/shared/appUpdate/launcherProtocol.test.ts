import { describe, expect, it } from 'vitest'
import {
  MAX_LAUNCH_ATTEMPT,
  MAX_RETAIN_APP_VERSIONS,
  MAX_UNPACKED_SIZE,
  isActivePointerV1,
  isInstalledAppManifestV1,
  isInstalledRuntimeManifestV1,
  isLauncherSettingsV1,
  isLaunchStateV1,
  isSafeRelativePath,
  isValidBuildId,
  parseActivePointer,
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  parseLauncherSettings,
  parseLaunchState,
  serializeActivePointer,
  serializeInstalledAppManifest,
  serializeInstalledRuntimeManifest,
  serializeLauncherSettings,
  serializeLaunchState
} from './launcherProtocol'

const settings = {
  schema: 1 as const,
  updateMode: 'notify-on-launch' as const,
  channel: 'stable' as const,
  retainAppVersions: 3,
  allowPrerelease: false
}
const activePointer = {
  schema: 1 as const,
  activeBuildId: '20260717-053138-c9a892c',
  activeRuntimeId: 'python-3.12.4',
  activatedAt: '2026-07-17T05:31:38Z'
}
const appManifest = {
  schema: 1 as const,
  kind: 'magicpot-app' as const,
  version: '1.2.3',
  buildId: '20260717-053138-c9a892c',
  commitSha: 'c9a892cc9a892cc9a892cc9a892cc9a892cc9a89',
  platform: 'win32' as const,
  arch: 'x64' as const,
  runtimeId: 'python-3.12.4',
  entrypoint: 'MagicPot.exe',
  createdAt: '2026-07-17T05:31:38.123Z',
  unpackedSize: 1024
}
const runtimeManifest = {
  schema: 1 as const,
  kind: 'magicpot-runtime' as const,
  runtimeId: 'python-3.12.4',
  platform: 'win32' as const,
  arch: 'x64' as const,
  createdAt: '2026-07-17T05:31:38Z',
  entrypoints: { python: 'python\\python.exe', comfyui: 'ComfyUI/main.py' },
  unpackedSize: 2048
}
const launchState = {
  schema: 1 as const,
  buildId: '20260717-053138-c9a892c',
  state: 'pending' as const,
  attempt: 1,
  startedAt: '2026-07-17T05:31:38Z'
}

describe('launcher protocol', () => {
  it.each([
    [settings, isLauncherSettingsV1, serializeLauncherSettings, parseLauncherSettings],
    [activePointer, isActivePointerV1, serializeActivePointer, parseActivePointer],
    [
      appManifest,
      isInstalledAppManifestV1,
      serializeInstalledAppManifest,
      parseInstalledAppManifest
    ],
    [
      runtimeManifest,
      isInstalledRuntimeManifestV1,
      serializeInstalledRuntimeManifest,
      parseInstalledRuntimeManifest
    ],
    [launchState, isLaunchStateV1, serializeLaunchState, parseLaunchState]
  ] as const)('round trips valid protocol data', (value, validate, serialize, parse) => {
    expect(validate(value)).toBe(true)
    const serializeValue = serialize as (input: never) => string
    const parseValue = parse as (text: string) => unknown
    expect(parseValue(serializeValue(value as never))).toEqual(value)
  })

  it.each([
    '../MagicPot.exe',
    'bin/../MagicPot.exe',
    '/MagicPot.exe',
    '\\server\\share\\MagicPot.exe',
    'C:\\MagicPot.exe',
    'bin//MagicPot.exe',
    'bin\\\\MagicPot.exe',
    'bin/MagicPot.exe:payload',
    'bin/CON.exe',
    'bin/aux.txt',
    'bin/COM1',
    'bin/CONIN$',
    'bin/CONOUT$.exe',
    'bin/COM¹.exe',
    'bin/COM².payload',
    'bin/COM³',
    'bin/LPT¹.exe',
    'bin/LPT².payload',
    'bin/LPT³',
    'bin/MagicPot.exe.',
    'bin/MagicPot.exe ',
    'bin/evil\u0001.exe'
  ])('rejects unsafe Windows relative path %s', (entrypoint) => {
    expect(isSafeRelativePath(entrypoint)).toBe(false)
    expect(isInstalledAppManifestV1({ ...appManifest, entrypoint })).toBe(false)
  })

  it('accepts either Windows separator and requires app entrypoints to end in .exe', () => {
    expect(isSafeRelativePath('bin/MagicPot.exe')).toBe(true)
    expect(isSafeRelativePath('bin\\MagicPot.exe')).toBe(true)
    expect(isInstalledAppManifestV1({ ...appManifest, entrypoint: 'bin/MagicPot.cmd' })).toBe(false)
  })

  it('requires an exact seven-character build ID SHA suffix matching the commit prefix', () => {
    expect(isInstalledAppManifestV1(appManifest)).toBe(true)
    expect(isInstalledAppManifestV1({ ...appManifest, buildId: '20260717-053138-c9a892cc' })).toBe(
      false
    )
    expect(
      isInstalledAppManifestV1({
        ...appManifest,
        commitSha: 'deadbeec9a892cc9a892cc9a892cc9a892cc9a89'
      })
    ).toBe(false)
  })

  it.each([
    '20260229-053138-c9a892c',
    '20261301-053138-c9a892c',
    '20261201-243138-c9a892c',
    '20261201-056038-c9a892c'
  ])('rejects build IDs with invalid calendar values: %s', (buildId) => {
    expect(isValidBuildId(buildId)).toBe(false)
  })

  it.each([
    '2026-02-29T05:31:38Z',
    '2026-13-01T05:31:38Z',
    '2026-12-01T24:31:38Z',
    '2026-12-01T05:60:38Z',
    '2026-12-01T05:31:60Z',
    '2026-12-01T05:31:38+00:00'
  ])('rejects non-strict UTC timestamps: %s', (startedAt) => {
    expect(isLaunchStateV1({ ...launchState, startedAt })).toBe(false)
  })

  it('validates exported numeric upper bounds inclusively', () => {
    expect(isLauncherSettingsV1({ ...settings, retainAppVersions: MAX_RETAIN_APP_VERSIONS })).toBe(
      true
    )
    expect(
      isLauncherSettingsV1({ ...settings, retainAppVersions: MAX_RETAIN_APP_VERSIONS + 1 })
    ).toBe(false)
    expect(isLaunchStateV1({ ...launchState, attempt: MAX_LAUNCH_ATTEMPT })).toBe(true)
    expect(isLaunchStateV1({ ...launchState, attempt: MAX_LAUNCH_ATTEMPT + 1 })).toBe(false)
    expect(isInstalledAppManifestV1({ ...appManifest, unpackedSize: MAX_UNPACKED_SIZE })).toBe(true)
    expect(isInstalledAppManifestV1({ ...appManifest, unpackedSize: MAX_UNPACKED_SIZE + 1 })).toBe(
      false
    )
    expect(
      isInstalledRuntimeManifestV1({ ...runtimeManifest, unpackedSize: MAX_UNPACKED_SIZE })
    ).toBe(true)
  })

  it('rejects malformed JSON and unknown fields', () => {
    expect(() => parseLaunchState('{bad')).toThrow(/valid JSON/)
    expect(isLaunchStateV1({ ...launchState, extra: true })).toBe(false)
  })
})
