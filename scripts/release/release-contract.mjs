import fs from 'node:fs'

const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
const TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const MARKER_PATTERN = /<!-- magicpot-release: (\{[^\r\n]*\}) -->/g

function isStableSemver(value) {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

function isValidUtcTimestamp(value) {
  if (typeof value !== 'string') return false
  const match = TIMESTAMP_PATTERN.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  )
}

function expectedAssetNames(version, timestamp) {
  if (!isStableSemver(version)) throw new Error(`Invalid release version: ${version}`)
  if (!isValidUtcTimestamp(timestamp)) throw new Error(`Invalid release timestamp: ${timestamp}`)
  return [`magicpot-${version}-${timestamp}-setup.exe`, `magicpot-${version}-${timestamp}-win.7z`]
}

function markerFor(value) {
  return `<!-- magicpot-release: ${JSON.stringify(value)} -->`
}

function parseReleaseMarker(body) {
  if (typeof body !== 'string') return null
  const matches = [...body.matchAll(MARKER_PATTERN)]
  if (matches.length !== 1) return null

  let value
  try {
    value = JSON.parse(matches[0][1])
  } catch {
    return null
  }

  if (markerFor(value) !== matches[0][0]) return null
  if (
    value?.schema !== 1 ||
    !Number.isSafeInteger(value.runId) ||
    !Number.isSafeInteger(value.runAttempt) ||
    !isStableSemver(value.version) ||
    !isValidUtcTimestamp(value.timestamp) ||
    typeof value.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(value.sourceCommit) ||
    typeof value.sourceTree !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(value.sourceTree)
  ) {
    return null
  }
  return value
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value.trim())
  return match ? match[1].toLowerCase() : null
}

function hasDownloadUrl(asset, tagName) {
  if (typeof asset?.browser_download_url !== 'string') return false
  try {
    const path = decodeURIComponent(new URL(asset.browser_download_url).pathname)
    return path.endsWith(`/releases/download/${tagName}/${asset.name}`)
  } catch {
    return false
  }
}

function inspectAssetContract(assets, version, tagName = '') {
  if (!Array.isArray(assets) || assets.length !== 2 || !isStableSemver(version)) {
    return { ok: false, reason: 'expected exactly two assets' }
  }

  const expectedPattern = new RegExp(
    `^magicpot-${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{8}T\\d{6}Z)-(setup\\.exe|win\\.7z)$`
  )
  const matches = assets.map((asset) => expectedPattern.exec(asset?.name || ''))
  if (matches.some((match) => !match)) {
    return { ok: false, reason: 'asset names are not timestamped Windows assets' }
  }
  const timestamps = new Set(matches.map((match) => match[1]))
  if (timestamps.size !== 1 || new Set(matches.map((match) => match[2])).size !== 2) {
    return { ok: false, reason: 'asset names do not share one setup/archive timestamp' }
  }
  if (
    !matches.some((match) => match[2] === 'setup.exe') ||
    !matches.some((match) => match[2] === 'win.7z')
  ) {
    return { ok: false, reason: 'setup.exe and win.7z are both required' }
  }

  for (const asset of assets) {
    const size = Number(asset?.size)
    if (!Number.isSafeInteger(size) || size <= 0 || size >= MAX_ASSET_BYTES) {
      return { ok: false, reason: `invalid size for ${asset?.name || 'asset'}` }
    }
    if (
      asset.state !== 'uploaded' ||
      !normalizeDigest(asset.digest) ||
      !hasDownloadUrl(asset, tagName)
    ) {
      return { ok: false, reason: `invalid uploaded state, digest, or URL for ${asset.name}` }
    }
  }

  return {
    ok: true,
    timestamp: timestamps.values().next().value,
    names: assets.map((asset) => asset.name)
  }
}

function classifyRelease(release, { version, tagName = '' } = {}) {
  if (!release || typeof release !== 'object') return { kind: 'missing' }
  const published = release.draft === false && typeof release.published_at === 'string'
  const contract = inspectAssetContract(release.assets, version, tagName)

  if (published) {
    return contract.ok
      ? { kind: 'published-two-asset-contract', contract }
      : { kind: 'published-legacy', reason: contract.reason }
  }
  if (release.draft === true) {
    const marker = parseReleaseMarker(release.body)
    return marker ? { kind: 'draft-managed', marker, contract } : { kind: 'draft-unmanaged' }
  }
  return { kind: 'unpublished-invalid' }
}

if (
  process.argv[1] &&
  new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href === import.meta.url
) {
  if (process.argv[2] === 'classify') {
    const versionIndex = process.argv.indexOf('--version')
    const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined
    const input = fs.readFileSync(0, 'utf8')
    const result = classifyRelease(JSON.parse(input), { version })
    process.stdout.write(`${result.kind}\n`)
  }
}

export {
  MAX_ASSET_BYTES,
  classifyRelease,
  expectedAssetNames,
  hasDownloadUrl,
  inspectAssetContract,
  isStableSemver,
  isValidUtcTimestamp,
  markerFor,
  normalizeDigest,
  parseReleaseMarker
}
