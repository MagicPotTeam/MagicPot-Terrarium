import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MAX_ASSET_BYTES,
  classifyRelease,
  expectedAssetNames,
  inspectAssetContract,
  markerFor,
  normalizeDigest,
  parseReleaseMarker,
  isValidUtcTimestamp
} from './release-contract.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')
const RETRY_ATTEMPTS = 8
const RETRY_DELAY_MS = 1500

class GhError extends Error {
  constructor(message, { status, stdout, stderr } = {}) {
    super(message)
    this.name = 'GhError'
    this.status = status
    this.stdout = stdout
    this.stderr = stderr
  }

  get isNotFound() {
    return this.status === 404 || /\b404\b|not found/i.test(`${this.message}\n${this.stderr || ''}`)
  }
}

function run(command, args, { input } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}: ${(result.stderr || result.stdout || '').trim()}`
    )
  }
  return (result.stdout || '').trim()
}

function gh(args, { input, allowNotFound = false } = {}) {
  const result = spawnSync('gh', args, {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: process.env
  })
  if (result.error) throw result.error
  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  if (result.status !== 0) {
    const error = new GhError(
      `gh ${args.join(' ')} failed with exit code ${result.status}: ${(stderr || stdout).trim()}`,
      { status: result.status, stdout, stderr }
    )
    if (allowNotFound && error.isNotFound) return null
    throw error
  }
  return stdout.trim()
}

function ghApiJson(endpoint, options = {}) {
  const args = ['api', endpoint, '--header', 'Accept: application/vnd.github+json']
  if (options.method) args.push('--method', options.method)
  if (options.input !== undefined) args.push('--input', '-')
  const output = gh(args, { input: options.input, allowNotFound: options.allowNotFound })
  if (output === null) return null
  if (!output) return {}
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`GitHub API returned invalid JSON for ${endpoint}: ${error.message}`)
  }
}

function repository() {
  const value = process.env.GITHUB_REPOSITORY
  if (!value || !/^[^/]+\/[^/]+$/.test(value)) throw new Error('GITHUB_REPOSITORY is required')
  return value
}

function releaseTag() {
  const value = process.env.RELEASE_TAG
  if (!value || !/^[A-Za-z0-9._/-]+$/.test(value))
    throw new Error(`Invalid RELEASE_TAG: ${value || '(empty)'}`)
  return value
}

function releaseEndpoint(tag) {
  return `repos/${repository()}/releases/tags/${tag}`
}

function releaseIdEndpoint(id) {
  if (!Number.isSafeInteger(Number(id))) throw new Error(`Invalid release id: ${id}`)
  return `repos/${repository()}/releases/${id}`
}

function tagRefEndpoint(tag) {
  return `repos/${repository()}/git/ref/tags/${tag}`
}

function assetEndpoint(id) {
  if (!Number.isSafeInteger(Number(id))) throw new Error(`Invalid release asset id: ${id}`)
  return `repos/${repository()}/releases/assets/${id}`
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    throw new Error(`package.json version must be stable SemVer, received ${packageJson.version}`)
  }
  return packageJson.version
}

function timestamp() {
  const value = process.env.RELEASE_TIMESTAMP || process.env.MAGICPOT_RELEASE_TIMESTAMP
  if (!isValidUtcTimestamp(value))
    throw new Error(`Invalid RELEASE_TIMESTAMP: ${value || '(empty)'}`)
  return value
}

function currentSource() {
  const sourceCommit = run('git', ['rev-parse', 'HEAD']).toLowerCase()
  const sourceTree = run('git', ['rev-parse', 'HEAD^{tree}']).toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[0-9a-f]{40}$/.test(sourceTree)) {
    throw new Error('Unable to resolve the checked out source commit/tree')
  }
  return { sourceCommit, sourceTree }
}

function markerValues(version, source, releaseTimestamp) {
  const runId = Number(process.env.GITHUB_RUN_ID)
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT || 1)
  if (!Number.isSafeInteger(runId) || runId < 0)
    throw new Error('GITHUB_RUN_ID must be a safe integer')
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1)
    throw new Error('GITHUB_RUN_ATTEMPT must be a positive safe integer')
  return {
    schema: 1,
    runId,
    runAttempt,
    sourceCommit: source.sourceCommit,
    sourceTree: source.sourceTree,
    version,
    timestamp: releaseTimestamp
  }
}

function bodyFor(marker) {
  return [
    'Windows releases include:',
    '- embedded `.7z` for first-time full runtime delivery',
    '- timestamped `setup.exe` for app-body updates',
    '',
    markerFor(marker)
  ].join('\n')
}

function localAssets(version, releaseTimestamp) {
  const directory = process.env.RELEASE_ASSET_DIR
  if (!directory) throw new Error('RELEASE_ASSET_DIR is required')
  const assetDirectory = path.resolve(repoRoot, directory)
  const names = expectedAssetNames(version, releaseTimestamp)
  if (!fs.existsSync(assetDirectory) || !fs.statSync(assetDirectory).isDirectory()) {
    throw new Error(`Release asset directory does not exist: ${assetDirectory}`)
  }
  const entries = fs.readdirSync(assetDirectory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const expected = [...names].sort()
  if (files.length !== expected.length || files.some((name, index) => name !== expected[index])) {
    throw new Error(`Release assets must be exactly: ${names.join(', ')}`)
  }

  return names.map((name) => {
    const filePath = path.join(assetDirectory, name)
    const stat = fs.statSync(filePath)
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size >= MAX_ASSET_BYTES) {
      throw new Error(`Invalid release asset size: ${name} (${stat.size})`)
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    return { name, path: filePath, size: stat.size, hash }
  })
}

function releaseAssetsByName(release) {
  return new Map(
    (Array.isArray(release?.assets) ? release.assets : []).map((asset) => [asset.name, asset])
  )
}

function verifyAssets(release, local, version, tag) {
  const contract = inspectAssetContract(release.assets, version, tag)
  if (!contract.ok) throw new Error(`GitHub release asset contract failed: ${contract.reason}`)
  const apiAssets = releaseAssetsByName(release)
  for (const localAsset of local) {
    const apiAsset = apiAssets.get(localAsset.name)
    const digest = normalizeDigest(apiAsset?.digest)
    if (!apiAsset || Number(apiAsset.size) !== localAsset.size || digest !== localAsset.hash) {
      throw new Error(`GitHub digest/size does not match local ${localAsset.name}`)
    }
  }
  return contract
}

function parseTime(value, label) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp: ${value}`)
  return parsed
}

function jobStartedAt() {
  const value = process.env.MAGICPOT_RELEASE_JOB_STARTED_AT
  if (!value) throw new Error('MAGICPOT_RELEASE_JOB_STARTED_AT is required')
  return parseTime(value, 'MAGICPOT_RELEASE_JOB_STARTED_AT')
}

function verifyAssetWindow(release, startedAt, endedAt) {
  for (const asset of release.assets || []) {
    for (const field of ['created_at', 'updated_at']) {
      if (!asset[field]) throw new Error(`Release asset ${asset.name} is missing ${field}`)
      const value = parseTime(asset[field], `asset ${asset.name} ${field}`)
      if (value < startedAt || value > endedAt) {
        throw new Error(`Release asset ${asset.name} ${field} is outside the release job window`)
      }
    }
  }
}

function sleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function getRelease(tag) {
  return ghApiJson(releaseEndpoint(tag), { allowNotFound: true })
}

function resolvePeeledTagCommit(tag, depth = 0) {
  if (depth > 3) throw new Error(`Tag ${tag} is nested too deeply to verify`)
  const ref = ghApiJson(tagRefEndpoint(tag), { allowNotFound: true })
  if (!ref) return null
  const object = ref.object
  if (!object || !/^[0-9a-f]{40}$/i.test(object.sha))
    throw new Error(`Tag ${tag} has an invalid target`)
  if (object.type === 'commit') return object.sha.toLowerCase()
  if (object.type !== 'tag')
    throw new Error(`Tag ${tag} does not point to a commit or annotated tag`)
  const annotated = ghApiJson(`repos/${repository()}/git/tags/${object.sha}`)
  if (annotated.object?.type === 'commit') return annotated.object.sha.toLowerCase()
  if (annotated.object?.type === 'tag') {
    const nestedTag = `${tag}#${annotated.object.sha}`
    return resolvePeeledTagCommit(nestedTag, depth + 1)
  }
  throw new Error(`Annotated tag ${tag} does not point to a commit`)
}

function assertTagPointsToSource(tag, sourceCommit) {
  const peeledCommit = resolvePeeledTagCommit(tag)
  if (!peeledCommit)
    throw new Error(`Tag ${tag} does not exist; refusing to publish without tag verification`)
  if (peeledCommit !== sourceCommit) {
    throw new Error(
      `Tag ${tag} peels to ${peeledCommit}, expected checked out HEAD ${sourceCommit}`
    )
  }
}

function uploadAssets(tag, local) {
  for (const asset of local) {
    gh(['release', 'upload', tag, asset.path, '--repo', repository(), '--clobber'])
  }
}

function deleteAssets(release) {
  for (const asset of release.assets || []) {
    ghApiJson(assetEndpoint(asset.id), { method: 'DELETE' })
  }
}

function releaseName() {
  return process.env.RELEASE_NAME || `MagicPot ${readPackageVersion()}`
}

function waitForAssets(tag, version, local) {
  let lastError
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const release = getRelease(tag)
    if (!release) throw new Error(`Release ${tag} disappeared while verifying uploaded assets`)
    try {
      verifyAssets(release, local, version, tag)
      return release
    } catch (error) {
      lastError = error
      if (attempt < RETRY_ATTEMPTS) sleep(RETRY_DELAY_MS)
    }
  }
  throw new Error(`Release asset digest verification did not converge: ${lastError.message}`)
}

function writeOutput(url) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  fs.appendFileSync(outputPath, `url=${url}\n`, 'utf8')
}

function ensureReleaseMarker(release, expectedMarker) {
  const marker = parseReleaseMarker(release.body)
  if (!marker) throw new Error('Release body does not contain exactly one valid MagicPot marker')
  if (marker.version !== expectedMarker.version)
    throw new Error('Release marker version does not match package.json')
  if (
    marker.sourceCommit !== expectedMarker.sourceCommit ||
    marker.sourceTree !== expectedMarker.sourceTree
  ) {
    throw new Error('Managed draft source does not match the checked out source commit/tree')
  }
  return marker
}

function createDraft(tag, source, version, releaseTimestamp, marker) {
  const payload = {
    tag_name: tag,
    target_commitish: source.sourceCommit,
    name: releaseName(),
    body: bodyFor(marker),
    draft: true,
    prerelease: false
  }
  return ghApiJson(`repos/${repository()}/releases`, {
    method: 'POST',
    input: JSON.stringify(payload)
  })
}

function stage() {
  const tag = releaseTag()
  const version = readPackageVersion()
  const releaseTimestamp = timestamp()
  const source = currentSource()
  const marker = markerValues(version, source, releaseTimestamp)
  const local = localAssets(version, releaseTimestamp)
  let release = getRelease(tag)

  if (release && release.draft === false) {
    const classification = classifyRelease(release, { version, tagName: tag })
    if (
      classification.kind === 'published-two-asset-contract' &&
      parseReleaseMarker(release.body)?.version === version
    ) {
      writeOutput(release.html_url)
      console.log(
        `Release ${tag} is already published and verified; leaving its provenance unchanged.`
      )
      return
    }
    throw new Error(`Refusing to modify published release ${tag}: ${classification.kind}`)
  }

  const existingTag = resolvePeeledTagCommit(tag)
  if (existingTag && existingTag !== source.sourceCommit) {
    throw new Error(`Existing tag ${tag} does not point to checked out HEAD`)
  }

  if (!release) {
    release = createDraft(tag, source, version, releaseTimestamp, marker)
    if (!release?.id) throw new Error(`GitHub did not return the created draft release for ${tag}`)
    assertTagPointsToSource(tag, source.sourceCommit)
  } else {
    if (release.prerelease) throw new Error(`Managed release ${tag} cannot be a prerelease`)
    ensureReleaseMarker(release, marker)
    assertTagPointsToSource(tag, source.sourceCommit)
    if (release.body !== bodyFor(marker)) {
      release = ghApiJson(releaseIdEndpoint(release.id), {
        method: 'PATCH',
        input: JSON.stringify({ body: bodyFor(marker), name: releaseName() })
      })
    }
  }

  const existingAssets = releaseAssetsByName(release)
  let assetsMatch = false
  try {
    verifyAssets(release, local, version, tag)
    assetsMatch = true
    const started = jobStartedAt()
    const now = Date.now()
    verifyAssetWindow(release, started, now)
  } catch {
    assetsMatch = false
  }
  if (!assetsMatch) {
    deleteAssets(release)
    uploadAssets(tag, local)
    release = waitForAssets(tag, version, local)
  } else if (existingAssets.size !== 2) {
    throw new Error('Managed draft contains an unexpected asset state')
  }

  verifyAssets(release, local, version, tag)
  writeOutput(release.html_url)
  console.log(
    `Staged and verified draft release ${tag}: ${local.map((asset) => asset.name).join(', ')}`
  )
}

function publish() {
  const finalStepStartedAt = Date.now()
  const tag = releaseTag()
  const version = readPackageVersion()
  const release = getRelease(tag)
  if (!release) throw new Error(`Draft release ${tag} does not exist`)

  if (release.draft === false) {
    const classification = classifyRelease(release, { version, tagName: tag })
    if (
      classification.kind === 'published-two-asset-contract' &&
      parseReleaseMarker(release.body)?.version === version
    ) {
      writeOutput(release.html_url)
      console.log(`Release ${tag} is already published and verified; no-op.`)
      return
    }
    throw new Error(`Refusing to modify published release ${tag}: ${classification.kind}`)
  }
  if (release.prerelease) throw new Error('Release must not be a prerelease')

  const source = currentSource()
  const releaseTimestamp = timestamp()
  const expectedMarker = markerValues(version, source, releaseTimestamp)
  ensureReleaseMarker(release, expectedMarker)
  assertTagPointsToSource(tag, source.sourceCommit)
  const local = localAssets(version, releaseTimestamp)
  const verified = waitForAssets(tag, version, local)
  const jobStart = jobStartedAt()
  const nowBeforePublish = Date.now()
  verifyAssetWindow(verified, jobStart, nowBeforePublish)

  const published = ghApiJson(releaseIdEndpoint(verified.id), {
    method: 'PATCH',
    input: JSON.stringify({ draft: false })
  })
  if (!published || published.draft !== false)
    throw new Error(`GitHub did not publish draft release ${tag}`)

  let finalRelease = published
  let publishedAt
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    finalRelease = getRelease(tag)
    publishedAt = finalRelease?.published_at
    if (publishedAt) break
    if (attempt < RETRY_ATTEMPTS) sleep(RETRY_DELAY_MS)
  }
  if (!finalRelease || finalRelease.draft || finalRelease.prerelease || !publishedAt) {
    throw new Error(`Published release ${tag} failed final state verification`)
  }
  const publishedAtMs = parseTime(publishedAt, 'release published_at')
  const finalNow = Date.now()
  if (publishedAtMs < finalStepStartedAt || publishedAtMs > finalNow) {
    throw new Error('Release published_at is outside the final publish step window')
  }
  verifyAssets(finalRelease, local, version, tag)
  verifyAssetWindow(finalRelease, jobStart, finalNow)
  writeOutput(finalRelease.html_url)
  console.log(`Published verified Windows release ${tag}`)
}

function main(argv = process.argv.slice(2)) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)
    throw new Error('GH_TOKEN or GITHUB_TOKEN is required')
  const command = argv[0]
  if (command === 'stage') return stage()
  if (command === 'publish') return publish()
  throw new Error('Usage: node scripts/release/publish-release.mjs <stage|publish>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export {
  GhError,
  bodyFor,
  classifyRelease,
  inspectAssetContract,
  localAssets,
  main,
  markerValues,
  parseTime,
  verifyAssets
}
