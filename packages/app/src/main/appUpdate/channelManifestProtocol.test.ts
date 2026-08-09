import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  channelManifestSigningPayload,
  compareSemanticVersionsV1,
  parseChannelManifestV1,
  selectLatestArtifactsV1,
  verifyChannelManifestSignature
} from './channelManifestProtocol'

const SHA = 'c9a892c000000000000000000000000000000000'
const HASH = 'a'.repeat(64)
const EMPTY_SIGNATURE = Buffer.alloc(64).toString('base64')
const ROOT = 'https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases'

function artifact(runtimeId = 'comfy-win-x64-20260701-a1b2c3d') {
  return {
    kind: 'app',
    version: '1.0.113-nightly.20260717.053138',
    buildId: '20260717-053138-c9a892c',
    commitSha: SHA,
    runtimeId,
    platform: 'win32',
    arch: 'x64',
    url: `${ROOT}/download/nightly-20260717/magicpot-app.zip`,
    sha256: HASH,
    size: 123,
    unpackedSize: 456,
    entrypoint: 'app/MagicPot.exe',
    createdAt: '2026-07-17T05:40:00Z'
  }
}

function runtime(runtimeId = 'comfy-win-x64-20260701-a1b2c3d') {
  return {
    kind: 'runtime',
    runtimeId,
    platform: 'win32',
    arch: 'x64',
    url: `${ROOT}/download/runtime-20260701/magicpot-runtime.7z`,
    sha256: 'b'.repeat(64),
    size: 789,
    unpackedSize: 999,
    entrypoint: 'python_embeded/python.exe',
    createdAt: '2026-07-01T03:00:00Z'
  }
}

function release() {
  return {
    version: '1.0.113-nightly.20260717.053138',
    buildId: '20260717-053138-c9a892c',
    commitSha: SHA,
    publishedAt: '2026-07-17T05:40:00Z',
    releaseNotesUrl: `${ROOT}/tag/nightly-20260717`,
    minimumLauncherVersion: '1.0.0',
    artifacts: { app: artifact(), runtime: runtime() }
  }
}

function manifest() {
  return {
    schema: 1,
    channel: 'nightly',
    generatedAt: '2026-07-17T05:40:00Z',
    releases: [release()],
    signature: { algorithm: 'ed25519', keyId: 'release-key-1', value: EMPTY_SIGNATURE }
  }
}

function parse(value: unknown = manifest()) {
  return parseChannelManifestV1(value, { expectedChannel: 'nightly' })
}

describe('channel manifest protocol', () => {
  it('strictly parses the complete schema from JSON', () => {
    const result = parseChannelManifestV1(JSON.stringify(manifest()), {
      expectedChannel: 'nightly'
    })
    expect(result.releases[0].artifacts.app.entrypoint).toBe('app/MagicPot.exe')
    expect(result.releases[0].artifacts.runtime?.unpackedSize).toBe(999)
  })

  it.each([
    ['top-level', (value: any) => (value.extra = true)],
    ['release', (value: any) => (value.releases[0].extra = true)],
    ['artifacts container', (value: any) => (value.releases[0].artifacts.extra = true)],
    ['app artifact', (value: any) => (value.releases[0].artifacts.app.extra = true)],
    ['runtime artifact', (value: any) => (value.releases[0].artifacts.runtime.extra = true)],
    ['signature', (value: any) => (value.signature.extra = true)]
  ])('rejects unknown fields in %s', (_name, mutate) => {
    const value = manifest()
    mutate(value)
    expect(() => parse(value)).toThrow(/unknown field/)
  })

  it.each([
    [
      'HTTP artifact',
      (value: any) =>
        (value.releases[0].artifacts.app.url = value.releases[0].artifacts.app.url.replace(
          'https:',
          'http:'
        ))
    ],
    [
      'other repository',
      (value: any) =>
        (value.releases[0].artifacts.app.url =
          'https://github.com/attacker/repo/releases/download/x/a.zip')
    ],
    [
      'lookalike path',
      (value: any) =>
        (value.releases[0].artifacts.app.url =
          'https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases-evil/releases/download/x/a.zip')
    ],
    [
      'credentials',
      (value: any) =>
        (value.releases[0].artifacts.app.url =
          'https://user@github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/x/a.zip')
    ]
  ])('rejects untrusted URL: %s', (_name, mutate) => {
    const value = manifest()
    mutate(value)
    expect(() => parse(value)).toThrow(/HTTPS|trusted GitHub/)
  })

  it('allows an explicitly trusted HTTPS origin and repository prefix', () => {
    const value = manifest()
    value.releases[0].releaseNotesUrl = 'https://releases.example.test/team/repo/releases/tag/n'
    value.releases[0].artifacts.app.url =
      'https://releases.example.test/team/repo/releases/download/n/app.zip'
    value.releases[0].artifacts.runtime.url =
      'https://releases.example.test/team/repo/releases/download/r/runtime.7z'
    expect(
      parseChannelManifestV1(value, {
        expectedChannel: 'nightly',
        trustedSources: [{ origin: 'https://releases.example.test', repoPathPrefix: '/team/repo' }]
      })
    ).toBeTruthy()
  })

  it('rejects channel mismatch and malformed identity links', () => {
    expect(() => parseChannelManifestV1(manifest(), { expectedChannel: 'stable' })).toThrow(
      /requested channel/
    )
    const badCommit = manifest()
    badCommit.releases[0].artifacts.app.commitSha = `fffffff${SHA.slice(7)}`
    expect(() => parse(badCommit)).toThrow(/buildId and commitSha|identities/)
    const badRuntime = manifest()
    badRuntime.releases[0].artifacts.runtime.runtimeId = 'different-runtime'
    expect(() => parse(badRuntime)).toThrow(/runtimeId/)
  })

  it('rejects duplicate IDs and one version pointing to different builds', () => {
    const duplicate = manifest()
    duplicate.releases.push(structuredClone(duplicate.releases[0]))
    expect(() => parse(duplicate)).toThrow(/duplicate buildId/)
    const conflict = manifest()
    const second = structuredClone(conflict.releases[0])
    second.buildId = '20260718-053138-deadbee'
    second.commitSha = `deadbee${'0'.repeat(33)}`
    second.artifacts.app.buildId = second.buildId
    second.artifacts.app.commitSha = second.commitSha
    second.artifacts.runtime.runtimeId = 'other-runtime'
    second.artifacts.app.runtimeId = 'other-runtime'
    conflict.releases.push(second)
    expect(() => parse(conflict)).toThrow(/conflicting build IDs/)
  })

  it('canonicalizes JSON deterministically and excludes signature from payload', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 'é' }, list: [true, null] })).toBe(
      '{"a":{"x":"é","y":2},"list":[true,null],"z":1}'
    )
    const parsed = parse()
    const payload = channelManifestSigningPayload(parsed).toString('utf8')
    expect(payload).not.toContain('signature')
    expect(payload).toBe(
      canonicalJson({
        schema: parsed.schema,
        channel: parsed.channel,
        generatedAt: parsed.generatedAt,
        releases: parsed.releases
      })
    )
  })

  it('verifies Ed25519 with Node crypto and rejects tampering or unknown keys', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const value = manifest()
    const unsigned = parse(value)
    value.signature.value = sign(
      null,
      channelManifestSigningPayload(unsigned),
      privateKey
    ).toString('base64')
    const signed = parse(value)
    expect(verifyChannelManifestSignature(signed, { 'release-key-1': publicKey })).toBe(true)
    expect(verifyChannelManifestSignature(signed, {})).toBe(false)
    signed.releases[0].artifacts.app.size += 1
    expect(verifyChannelManifestSignature(signed, { 'release-key-1': publicKey })).toBe(false)
  })

  it('selects the newest compatible app and resolves a runtime published by another release', () => {
    const value = manifest()
    const older = value.releases[0]
    older.version = '1.0.112-nightly.20260716.053138'
    older.buildId = '20260716-053138-bbbbbbb'
    older.commitSha = `bbbbbbb${'0'.repeat(33)}`
    older.publishedAt = '2026-07-16T05:40:00Z'
    older.artifacts.app.version = older.version
    older.artifacts.app.buildId = older.buildId
    older.artifacts.app.commitSha = older.commitSha
    const newest = structuredClone(older)
    newest.version = '1.0.113-nightly.20260717.053138'
    newest.buildId = '20260717-053138-c9a892c'
    newest.commitSha = SHA
    newest.publishedAt = '2026-07-17T05:40:00Z'
    newest.artifacts.app.version = newest.version
    newest.artifacts.app.buildId = newest.buildId
    newest.artifacts.app.commitSha = newest.commitSha
    const newestWithoutRuntime = { ...newest, artifacts: { app: newest.artifacts.app } }
    const mixedManifest = { ...value, releases: [older, newestWithoutRuntime] }
    const selected = selectLatestArtifactsV1(parse(mixedManifest))
    expect(selected?.release.buildId).toBe(newestWithoutRuntime.buildId)
    expect(selected?.runtime.runtimeId).toBe(newestWithoutRuntime.artifacts.app.runtimeId)
  })

  it('orders candidates by SemVer before publication time and keeps filtered runtimes', () => {
    const value = manifest()
    const runtimeProvider = value.releases[0]
    runtimeProvider.version = '1.0.0-beta.2'
    runtimeProvider.artifacts.app.version = runtimeProvider.version
    const candidate = structuredClone(runtimeProvider)
    candidate.version = '2.0.0'
    candidate.artifacts.app.version = candidate.version
    candidate.buildId = '20260716-053138-bbbbbbb'
    candidate.artifacts.app.buildId = candidate.buildId
    candidate.commitSha = `bbbbbbb${'0'.repeat(33)}`
    candidate.artifacts.app.commitSha = candidate.commitSha
    candidate.publishedAt = '2026-07-16T05:40:00Z'
    const candidateWithoutRuntime = { ...candidate, artifacts: { app: candidate.artifacts.app } }
    const selected = selectLatestArtifactsV1(
      {
        ...parse({ ...value, releases: [runtimeProvider] }),
        releases: [runtimeProvider, candidateWithoutRuntime]
      } as any,
      'win32',
      'x64',
      (release) => release.version === '2.0.0'
    )
    expect(selected?.release.version).toBe('2.0.0')
    expect(selected?.runtime.runtimeId).toBe(candidate.artifacts.app.runtimeId)
  })

  it('compares long numeric prerelease identifiers exactly and accepts leading zeroes', () => {
    expect(
      compareSemanticVersionsV1('1.0.0-alpha.9007199254740993', '1.0.0-alpha.9007199254740992')
    ).toBe(1)
    expect(compareSemanticVersionsV1('1.0.0-alpha.0002', '1.0.0-alpha.2')).toBe(0)
    expect(compareSemanticVersionsV1('9007199254740992.0.0', '1.0.0')).toBeUndefined()
  })

  it('returns no selection when the required runtime is absent', () => {
    const value = manifest()
    const withoutRuntime = {
      ...value,
      releases: [{ ...value.releases[0], artifacts: { app: value.releases[0].artifacts.app } }]
    }
    expect(selectLatestArtifactsV1(parse(withoutRuntime))).toBeUndefined()
  })
})
