import { describe, expect, it } from 'vitest'
import {
  isActivePointerV1,
  isInstalledAppManifestV1,
  isInstalledRuntimeManifestV1,
  isLauncherSettingsV1,
  isLaunchStateV1,
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
  activeRuntimeId: 'comfy-win-x64-20260701-a1b2c3d',
  previousBuildId: '20260716-050000-b7c8d9e',
  previousRuntimeId: 'comfy-win-x64-20260620-f6e5d4c',
  activatedAt: '2026-07-17T05:45:00Z'
}
const appManifest = {
  schema: 1 as const,
  kind: 'magicpot-app' as const,
  version: '1.0.113-nightly.20260717.053138',
  buildId: '20260717-053138-c9a892c',
  commitSha: 'c9a892c000000000000000000000000000000000',
  platform: 'win32' as const,
  arch: 'x64' as const,
  runtimeId: 'comfy-win-x64-20260701-a1b2c3d',
  entrypoint: 'app/MagicPot.exe',
  createdAt: '2026-07-17T05:40:00Z',
  unpackedSize: 1234567890
}
const runtimeManifest = {
  schema: 1 as const,
  kind: 'magicpot-runtime' as const,
  runtimeId: 'comfy-win-x64-20260701-a1b2c3d',
  platform: 'win32' as const,
  arch: 'x64' as const,
  createdAt: '2026-07-01T03:00:00Z',
  entrypoints: { python: 'python_embeded/python.exe', comfyui: 'ComfyUI/main.py' },
  unpackedSize: 9876543210
}
const launchState = {
  schema: 1 as const,
  buildId: '20260717-053138-c9a892c',
  state: 'pending' as const,
  attempt: 1,
  startedAt: '2026-07-17T05:45:01Z'
}

describe('launcher protocol schema 1', () => {
  it('round-trips every valid document type', () => {
    expect(parseLauncherSettings(serializeLauncherSettings(settings))).toEqual(settings)
    expect(parseActivePointer(serializeActivePointer(activePointer))).toEqual(activePointer)
    expect(parseInstalledAppManifest(serializeInstalledAppManifest(appManifest))).toEqual(
      appManifest
    )
    expect(
      parseInstalledRuntimeManifest(serializeInstalledRuntimeManifest(runtimeManifest))
    ).toEqual(runtimeManifest)
    expect(parseLaunchState(serializeLaunchState(launchState))).toEqual(launchState)
  })

  it('rejects non-objects, unknown schemas, extra fields and invalid enums', () => {
    expect(isLauncherSettingsV1(null)).toBe(false)
    expect(isLauncherSettingsV1({ ...settings, schema: 2 })).toBe(false)
    expect(isLauncherSettingsV1({ ...settings, channel: 'canary' })).toBe(false)
    expect(isLauncherSettingsV1({ ...settings, updateMode: 'background' })).toBe(false)
    expect(isLauncherSettingsV1({ ...settings, extra: true })).toBe(false)
    expect(isLaunchStateV1({ ...launchState, state: 'unknown' })).toBe(false)
    expect(() => parseLaunchState('[]')).toThrow(/schema 1/)
  })

  it('rejects invalid build and runtime identifiers', () => {
    expect(isActivePointerV1({ ...activePointer, activeBuildId: '../build' })).toBe(false)
    expect(isActivePointerV1({ ...activePointer, activeBuildId: 'latest' })).toBe(false)
    expect(isActivePointerV1({ ...activePointer, activeRuntimeId: 'runtime/../../escape' })).toBe(
      false
    )
    expect(isInstalledAppManifestV1({ ...appManifest, runtimeId: 'C:\\runtime' })).toBe(false)
    expect(isLaunchStateV1({ ...launchState, buildId: '20260717-c9a892c' })).toBe(false)
  })

  it.each([
    '/app/MagicPot.exe',
    '\\server\\share\\MagicPot.exe',
    'C:\\app\\MagicPot.exe',
    '../app/MagicPot.exe',
    'app/../MagicPot.exe',
    'app/MagicPot.dll'
  ])('rejects unsafe app entrypoint %s', (entrypoint) => {
    expect(isInstalledAppManifestV1({ ...appManifest, entrypoint })).toBe(false)
  })

  it('rejects unsafe runtime entrypoints and malformed manifest fields', () => {
    expect(
      isInstalledRuntimeManifestV1({
        ...runtimeManifest,
        entrypoints: { ...runtimeManifest.entrypoints, python: '../python.exe' }
      })
    ).toBe(false)
    expect(
      isInstalledRuntimeManifestV1({
        ...runtimeManifest,
        entrypoints: { ...runtimeManifest.entrypoints, comfyui: 'C:\\ComfyUI\\main.py' }
      })
    ).toBe(false)
    expect(isInstalledAppManifestV1({ ...appManifest, commitSha: 'c9a892c' })).toBe(false)
    expect(isInstalledRuntimeManifestV1({ ...runtimeManifest, unpackedSize: 0 })).toBe(false)
  })

  it('requires previous build and runtime pointers as a pair', () => {
    const { previousRuntimeId: _omitted, ...incomplete } = activePointer
    expect(isActivePointerV1(incomplete)).toBe(false)
  })
})
