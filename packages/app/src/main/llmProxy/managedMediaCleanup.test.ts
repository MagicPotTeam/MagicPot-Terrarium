import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import {
  cleanupManagedMediaStagingOnShutdown,
  executeManagedMediaCleanup,
  planManagedMediaCleanup,
  type ManagedMediaCleanupAudit
} from './managedMediaCleanup'
import { managedMediaDerivativeIdentityFor } from './managedMediaDerivativeManifest'

const referenced = '1'.repeat(64)
const orphan = '2'.repeat(64)
const identityFor = (id: string) => managedMediaDerivativeIdentityFor(id, 256, 'webp')
const identity = identityFor(orphan)
const taskOrphan = '4'.repeat(64)
const FRESH_ORPHAN = '5'.repeat(64)
const FIXTURE_AGE_MS = 2 * 24 * 60 * 60 * 1_000
const created: string[] = []
async function add(root: string, id: string, options: { fresh?: boolean } = {}) {
  const identity = identityFor(id)
  const original = `originals/${id.slice(0, 2)}/${id}.png`
  const dir = path.join(root, 'derivatives', id.slice(0, 2), id, identity, 'committed')
  const image = `derivatives/${id.slice(0, 2)}/${id}/${identity}/committed/image.webp`
  const imagePath = path.join(root, ...image.split('/'))
  const imageBytes = Buffer.from('small')
  await fs.mkdir(path.dirname(path.join(root, original)), { recursive: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.dirname(path.join(root, image)), { recursive: true })
  await fs.mkdir(path.join(root, 'metadata'), { recursive: true })
  await fs.writeFile(path.join(root, original), 'image')
  await fs.writeFile(imagePath, imageBytes)
  await fs.writeFile(
    path.join(root, 'metadata', `${id}.json`),
    JSON.stringify({ schema: 'magicpot.managed-media/v1', sha256: id, relativePath: original })
  )
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 'magicpot.managed-media-derivative/v4',
      purpose: 'managed-media-derivative',
      identity,
      originalSha256: id,
      format: 'webp',
      maxEdge: 256,
      relativePath: image,
      mimeType: 'image/webp',
      sizeBytes: imageBytes.length,
      width: 8,
      height: 4,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
      localMediaUrl: `local-media://${pathToFileURL(imagePath).toString().slice('file://'.length)}`,
      encoderVersion: 'canvas-thumbnail-sidecar/v2',
      orientationPolicy: 'apply-exif-before-resize/v1',
      cropPolicy: 'crop-meaningful-transparent-border/v1'
    })
  )
  if (!options.fresh) {
    const old = new Date(Date.now() - FIXTURE_AGE_MS)
    await Promise.all([
      fs.utimes(path.join(root, original), old, old),
      fs.utimes(imagePath, old, old),
      fs.utimes(path.join(root, 'metadata', `${id}.json`), old, old),
      fs.utimes(path.join(dir, 'manifest.json'), old, old)
    ])
  }
}
async function fixture() {
  const root = await createNodeTestArtifactDir('managed-media-cleanup')
  await fs.mkdir(root, { recursive: true })
  const canonicalRoot = await fs.realpath(root)
  created.push(root)
  await add(canonicalRoot, referenced)
  await add(canonicalRoot, orphan)
  return canonicalRoot
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })))
})

describe('managedMediaCleanup safe planner', () => {
  it('plans a real orphan v4 derivative from the current producer contract', async () => {
    const root = await fixture()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(plan.actions).toEqual([
      {
        kind: 'derivative-file',
        mediaId: orphan,
        relativePath: `derivatives/22/${orphan}/${identity}/committed/image.webp`
      },
      { kind: 'metadata-file', mediaId: orphan, relativePath: `metadata/${orphan}.json` },
      {
        kind: 'original-file',
        mediaId: orphan,
        relativePath: `originals/22/${orphan}.png`
      }
    ])
  })
  it('keeps durable reference counts aligned with the protected ID set', async () => {
    const root = await fixture()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced],
      referenceCounts: { [referenced]: 3 }
    })
    expect(plan.referenceCounts).toEqual({ [referenced]: 3 })
    await expect(
      planManagedMediaCleanup({
        chatMediaRoot: root,
        referencedMediaIds: [referenced],
        referenceCounts: { [referenced]: 0 }
      })
    ).rejects.toThrow('referenceCounts')
    await expect(
      planManagedMediaCleanup({
        chatMediaRoot: root,
        referencedMediaIds: [referenced],
        referenceCounts: { [orphan]: 2 }
      })
    ).rejects.toThrow('unknown media ID')
  })
  it('omits referenced media from actions and skipped', async () => {
    const root = await fixture()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(plan.actions.some((x) => x.kind === 'derivative-file' && x.mediaId === referenced)).toBe(
      false
    )
    expect(plan.skipped.some((x) => x.relativePath.includes(referenced))).toBe(false)
  })
  it('skips malformed metadata, derivative, and nonregular image entries', async () => {
    const root = await fixture()
    await fs.writeFile(path.join(root, 'metadata', 'bad.json'), '{}')
    await fs.writeFile(
      path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'manifest.json'),
      '{}'
    )
    await fs.rm(path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'image.webp'))
    await fs.mkdir(
      path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'image.webp')
    )
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(plan.skipped.some((x) => x.relativePath === 'metadata/bad.json')).toBe(true)
    expect(plan.skipped.some((x) => x.relativePath.includes(orphan))).toBe(true)
  })

  it('fails closed for legacy and corrupt derivative manifests', async () => {
    const root = await fixture()
    const manifestPath = path.join(
      root,
      'derivatives',
      '22',
      orphan,
      identity,
      'committed',
      'manifest.json'
    )
    const current = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>

    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...current, schema: 'magicpot.managed-media-derivative/v3' })
    )
    const legacyPlan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(
      legacyPlan.actions.some((action) => 'mediaId' in action && action.mediaId === orphan)
    ).toBe(false)
    expect(legacyPlan.skipped).toContainEqual(
      expect.objectContaining({
        relativePath: expect.stringContaining(orphan),
        reason: expect.stringContaining('schema')
      })
    )

    await fs.writeFile(manifestPath, JSON.stringify({ ...current, width: 0 }))
    const corruptPlan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(
      corruptPlan.actions.some((action) => 'mediaId' in action && action.mediaId === orphan)
    ).toBe(false)
    expect(corruptPlan.skipped).toContainEqual(
      expect.objectContaining({
        relativePath: expect.stringContaining(orphan),
        reason: expect.stringContaining('width')
      })
    )
    await executeManagedMediaCleanup(corruptPlan, { dryRun: false })
    await expect(fs.stat(path.join(root, 'originals', '22', `${orphan}.png`))).resolves.toBeTruthy()
  })

  it('does not partially delete a record when one derivative identity is unknown', async () => {
    const root = await fixture()
    // Keep the valid derivative from the fixture, but add an unrecognized
    // sibling identity. The whole orphan record must remain recoverable.
    await fs.mkdir(path.join(root, 'derivatives', '22', orphan, 'not-a-media-id'), {
      recursive: true
    })

    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })

    expect(plan.actions.some((action) => 'mediaId' in action && action.mediaId === orphan)).toBe(
      false
    )
    expect(plan.skipped).toContainEqual({
      relativePath: `derivatives/22/${orphan}/not-a-media-id`,
      reason: 'unrecognized derivative identity'
    })
    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(fs.stat(path.join(root, 'originals', '22', `${orphan}.png`))).resolves.toBeTruthy()
    await expect(
      fs.stat(path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'image.webp'))
    ).resolves.toBeTruthy()
  })

  it('bounds cleanup metadata reads and leaves oversized records untouched', async () => {
    const root = await fixture()
    await fs.writeFile(
      path.join(root, 'metadata', `${orphan}.json`),
      JSON.stringify({
        schema: 'magicpot.managed-media/v1',
        sha256: orphan,
        relativePath: `originals/22/${orphan}.png`,
        padding: 'x'.repeat(70 * 1024)
      })
    )

    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })

    expect(plan.actions.some((action) => 'mediaId' in action && action.mediaId === orphan)).toBe(
      false
    )
    expect(plan.skipped).toContainEqual({
      relativePath: `metadata/${orphan}.json`,
      reason: 'metadata file is unsafe or too large'
    })
    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(fs.stat(path.join(root, 'originals', '22', `${orphan}.png`))).resolves.toBeTruthy()
  })
  it('skips traversal and symlink safely', async () => {
    const root = await fixture()
    await fs.writeFile(
      path.join(root, 'metadata', `${orphan}.json`),
      JSON.stringify({
        schema: 'magicpot.managed-media/v1',
        sha256: orphan,
        relativePath: '../../outside.png'
      })
    )
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(plan.actions).toEqual([])
    expect(plan.skipped.some((x) => /original path|traversal/i.test(x.reason))).toBe(true)
  })

  it('dry-runs and executes only planned orphan derivatives and temp files', async () => {
    const root = await fixture()
    const temporary = path.join(root, '.staging', 'orphan.tmp')
    await fs.mkdir(path.dirname(temporary), { recursive: true })
    await fs.writeFile(temporary, 'temporary')
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced],
      retention: { stagingTtlMs: 0 }
    })
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        { kind: 'derivative-file', mediaId: orphan, relativePath: expect.stringContaining(orphan) },
        { kind: 'temp-file', relativePath: '.staging/orphan.tmp' }
      ])
    )
    const dryRun = await executeManagedMediaCleanup(plan)
    expect(dryRun.dryRun).toBe(true)
    expect(await fs.stat(temporary)).toBeTruthy()
    expect(await fs.stat(path.join(root, 'originals', '11', `${referenced}.png`))).toBeTruthy()
    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'image.webp'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(root, 'metadata', `${orphan}.json`))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      fs.stat(path.join(root, 'originals', '22', `${orphan}.png`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.stat(path.join(root, 'originals', '11', `${referenced}.png`))).toBeTruthy()
  })

  it('stops before deleting later actions when a newer snapshot invalidates execution', async () => {
    const root = await fixture()
    const temporary = path.join(root, '.staging', 'orphan.tmp')
    await fs.mkdir(path.dirname(temporary), { recursive: true })
    await fs.writeFile(temporary, 'temporary')
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced],
      now: Date.now() + 1_000,
      retention: { stagingTtlMs: 0 }
    })
    let checks = 0
    const result = await executeManagedMediaCleanup(plan, {
      dryRun: false,
      shouldContinue: () => checks++ < 3
    })

    expect(result.deleted).toEqual(['.staging/orphan.tmp'])
    expect(result.skipped).toContainEqual({
      relativePath: `derivatives/22/${orphan}/${identity}/committed/image.webp`,
      reason: 'reference snapshot changed'
    })
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'image.webp'))
    ).resolves.toBeTruthy()
  })

  it('retains fresh staging files and reports a non-sensitive audit', async () => {
    const root = await fixture()
    const temporary = path.join(root, '.staging', 'current.tmp')
    await fs.mkdir(path.dirname(temporary), { recursive: true })
    await fs.writeFile(temporary, 'task material')
    const now = Date.now()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced],
      now,
      retention: { stagingTtlMs: 60 * 60 * 1_000 }
    })
    expect(plan.actions.some((action) => action.relativePath === '.staging/current.tmp')).toBe(
      false
    )
    expect(plan.audit).toMatchObject({
      stagingFileCount: 1,
      staleStagingFileCount: 0,
      quotaExceeded: false
    })
    expect(JSON.stringify(plan.audit)).not.toContain('task material')
  })

  it('retains a fresh complete orphan record until its durable TTL expires', async () => {
    const root = await fixture()
    await add(root, FRESH_ORPHAN, { fresh: true })
    const now = Date.now()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced],
      now,
      retention: { orphanTtlMs: 60 * 60 * 1_000 }
    })
    expect(
      plan.actions.some((action) => 'mediaId' in action && action.mediaId === FRESH_ORPHAN)
    ).toBe(false)
    expect(plan.skipped).toContainEqual({
      relativePath: `metadata/${FRESH_ORPHAN}.json`,
      reason: 'orphan media record is within retention TTL'
    })
    expect(plan.audit).toMatchObject({
      durableOrphanRecordCount: 2,
      retainedDurableOrphanRecordCount: 1,
      orphanTtlMs: 60 * 60 * 1_000
    })
    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(
      fs.stat(path.join(root, 'originals', '55', `${FRESH_ORPHAN}.png`))
    ).resolves.toBeTruthy()
  })

  it('retains a durable record when any required timestamp is unavailable', async () => {
    const root = await fixture()
    const originalPath = path.join(root, 'originals', '22', `${orphan}.png`)
    const realLstat = fs.lstat.bind(fs)
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args: any[]) => {
      const stat = await (realLstat as (...inner: any[]) => Promise<any>)(...args)
      if (path.resolve(String(args[0])) === path.resolve(originalPath))
        Object.defineProperty(stat, 'mtimeMs', { configurable: true, value: Number.NaN })
      return stat
    })
    try {
      const plan = await planManagedMediaCleanup({
        chatMediaRoot: root,
        referencedMediaIds: [referenced],
        retention: { orphanTtlMs: 0 }
      })
      expect(plan.actions.some((action) => 'mediaId' in action && action.mediaId === orphan)).toBe(
        false
      )
      expect(plan.skipped).toContainEqual({
        relativePath: `metadata/${orphan}.json`,
        reason: 'orphan media timestamp is unavailable'
      })
      expect(plan.audit).toMatchObject({
        durableOrphanRecordCount: 1,
        retainedDurableOrphanRecordCount: 1
      })
    } finally {
      lstatSpy.mockRestore()
    }
  })

  it('reclaims the oldest expired files first when staging exceeds quota', async () => {
    const root = await fixture()
    const first = path.join(root, '.staging', 'first.tmp')
    const second = path.join(root, '.staging', 'second.tmp')
    await fs.mkdir(path.dirname(first), { recursive: true })
    await fs.writeFile(first, '12345')
    await fs.writeFile(second, '67890')
    const now = Date.now()
    await fs.utimes(first, new Date(now - 10_000), new Date(now - 10_000))
    await fs.utimes(second, new Date(now - 5_000), new Date(now - 5_000))
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced],
      now,
      retention: { stagingTtlMs: 1_000, maxStagingBytes: 5 }
    })
    expect(plan.audit).toMatchObject({
      stagingFileCount: 2,
      stagingBytes: 10,
      staleStagingFileCount: 2,
      staleStagingBytes: 10,
      quotaBytes: 5,
      quotaExceeded: true
    })
    expect(plan.actions).toEqual(
      expect.arrayContaining([{ kind: 'temp-file', relativePath: '.staging/first.tmp' }])
    )
    expect(
      plan.actions.some(
        (action) => action.kind === 'temp-file' && action.relativePath === '.staging/second.tmp'
      )
    ).toBe(false)
  })

  it('rejects invalid retention policies', async () => {
    const root = await fixture()
    await expect(
      planManagedMediaCleanup({
        chatMediaRoot: root,
        referencedMediaIds: [],
        retention: { stagingTtlMs: -1 }
      })
    ).rejects.toThrow(RangeError)
    await expect(
      planManagedMediaCleanup({
        chatMediaRoot: root,
        referencedMediaIds: [],
        retention: { orphanTtlMs: -1 }
      })
    ).rejects.toThrow(RangeError)
    await expect(
      planManagedMediaCleanup({
        chatMediaRoot: root,
        referencedMediaIds: [],
        retention: { maxStagingBytes: 0 }
      })
    ).rejects.toThrow(RangeError)
  })

  it('includes cleanup counts in the execution audit without file content', async () => {
    const root = await fixture()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    const result = await executeManagedMediaCleanup(plan)
    const audit: ManagedMediaCleanupAudit & { deletedCount: number; skippedCount: number } =
      result.audit
    expect(audit.deletedCount).toBe(result.deleted.length)
    expect(audit.skippedCount).toBe(result.skipped.length)
    expect(JSON.stringify(audit)).not.toContain(root)
  })

  it('sweeps expired staging in the base and task roots during shutdown only', async () => {
    const root = await fixture()
    const now = Date.now()
    const baseStaging = path.join(root, '.staging')
    const taskStaging = path.join(root, 'comfy-outputs', 'tasks', 'task-1', '.staging')
    await fs.mkdir(path.join(root, 'comfy-outputs', 'tasks', 'bad scope'), { recursive: true })
    await fs.mkdir(baseStaging, { recursive: true })
    await fs.mkdir(taskStaging, { recursive: true })
    const baseExpired = path.join(baseStaging, 'base-expired.tmp')
    const baseFresh = path.join(baseStaging, 'base-fresh.tmp')
    const taskExpired = path.join(taskStaging, 'task-expired.tmp')
    await fs.writeFile(baseExpired, 'expired')
    await fs.writeFile(baseFresh, 'fresh')
    await fs.writeFile(taskExpired, 'task expired')
    await fs.utimes(baseExpired, new Date(now - 10_000), new Date(now - 10_000))
    await fs.utimes(taskExpired, new Date(now - 10_000), new Date(now - 10_000))

    const audit = await cleanupManagedMediaStagingOnShutdown({
      chatMediaRoot: root,
      now,
      retention: { stagingTtlMs: 1_000 }
    })

    expect(audit).toMatchObject({
      rootsScanned: 2,
      stagingFileCount: 3,
      staleStagingFileCount: 2,
      deletedCount: 2,
      skippedCount: 2
    })
    await expect(fs.stat(baseExpired)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(taskExpired)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(baseFresh)).resolves.toBeTruthy()
    // Shutdown cleanup never touches durable originals or derivatives.
    await expect(
      fs.stat(path.join(root, 'originals', '11', `${referenced}.png`))
    ).resolves.toBeTruthy()
    await expect(
      fs.stat(path.join(root, 'derivatives', '22', orphan, identity, 'committed', 'image.webp'))
    ).resolves.toBeTruthy()
    expect(Object.keys(audit)).not.toContain('deleted')
    expect(JSON.stringify(audit)).not.toContain('expired')
  })

  it('enumerates global and normalized Comfy task roots for normal GC', async () => {
    const root = await fixture()
    const globalRoot = path.join(root, 'comfy-outputs', 'global')
    const taskRoot = path.join(root, 'comfy-outputs', 'tasks', 'prompt-123')
    await fs.mkdir(globalRoot, { recursive: true })
    await fs.mkdir(taskRoot, { recursive: true })
    await add(globalRoot, taskOrphan)
    await add(taskRoot, taskOrphan)
    const taskTemp = path.join(taskRoot, '.staging', 'old.tmp')
    const now = Date.now()
    await fs.mkdir(path.dirname(taskTemp), { recursive: true })
    await fs.writeFile(taskTemp, 'old')
    await fs.utimes(taskTemp, new Date(now - 10_000), new Date(now - 10_000))

    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      // A single global ID set protects an ID no matter which physical task
      // store contains it.
      referencedMediaIds: [referenced],
      now,
      retention: { stagingTtlMs: 1_000 }
    })

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        {
          kind: 'derivative-file',
          mediaId: taskOrphan,
          relativePath: `comfy-outputs/global/derivatives/44/${taskOrphan}/${identityFor(taskOrphan)}/committed/image.webp`
        },
        {
          kind: 'metadata-file',
          mediaId: taskOrphan,
          relativePath: `comfy-outputs/global/metadata/${taskOrphan}.json`
        },
        {
          kind: 'original-file',
          mediaId: taskOrphan,
          relativePath: `comfy-outputs/global/originals/44/${taskOrphan}.png`
        },
        {
          kind: 'derivative-file',
          mediaId: taskOrphan,
          relativePath: `comfy-outputs/tasks/prompt-123/derivatives/44/${taskOrphan}/${identityFor(taskOrphan)}/committed/image.webp`
        },
        {
          kind: 'metadata-file',
          mediaId: taskOrphan,
          relativePath: `comfy-outputs/tasks/prompt-123/metadata/${taskOrphan}.json`
        },
        {
          kind: 'original-file',
          mediaId: taskOrphan,
          relativePath: `comfy-outputs/tasks/prompt-123/originals/44/${taskOrphan}.png`
        },
        {
          kind: 'temp-file',
          relativePath: 'comfy-outputs/tasks/prompt-123/.staging/old.tmp'
        }
      ])
    )

    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(
      fs.stat(path.join(globalRoot, 'originals', '44', `${taskOrphan}.png`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(path.join(taskRoot, 'originals', '44', `${taskOrphan}.png`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(taskTemp)).rejects.toMatchObject({ code: 'ENOENT' })
    // The base reference remains protected even when the task roots are scanned.
    await expect(
      fs.stat(path.join(root, 'originals', '11', `${referenced}.png`))
    ).resolves.toBeTruthy()
  })

  it('enumerates task/model namespace scopes while protecting user output', async () => {
    const root = await fixture()
    const taskRoot = path.join(root, 'task', 'task-123')
    const modelRoot = path.join(root, 'model', 'model-123')
    const userOutputRoot = path.join(root, 'user-output', 'export-123')
    await add(taskRoot, taskOrphan)
    await add(modelRoot, taskOrphan)
    await add(userOutputRoot, taskOrphan)

    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        {
          kind: 'derivative-file',
          mediaId: taskOrphan,
          relativePath: `task/task-123/derivatives/44/${taskOrphan}/${identityFor(taskOrphan)}/committed/image.webp`
        },
        {
          kind: 'metadata-file',
          mediaId: taskOrphan,
          relativePath: `task/task-123/metadata/${taskOrphan}.json`
        },
        {
          kind: 'original-file',
          mediaId: taskOrphan,
          relativePath: `task/task-123/originals/44/${taskOrphan}.png`
        },
        {
          kind: 'derivative-file',
          mediaId: taskOrphan,
          relativePath: `model/model-123/derivatives/44/${taskOrphan}/${identityFor(taskOrphan)}/committed/image.webp`
        },
        {
          kind: 'metadata-file',
          mediaId: taskOrphan,
          relativePath: `model/model-123/metadata/${taskOrphan}.json`
        },
        {
          kind: 'original-file',
          mediaId: taskOrphan,
          relativePath: `model/model-123/originals/44/${taskOrphan}.png`
        }
      ])
    )
    expect(plan.actions.some((action) => action.relativePath.startsWith('user-output/'))).toBe(
      false
    )
    expect(plan.skipped).toContainEqual({
      relativePath: 'user-output',
      reason: 'user-output namespace is user-managed and excluded from cleanup'
    })

    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(
      fs.stat(path.join(taskRoot, 'originals', '44', `${taskOrphan}.png`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(path.join(modelRoot, 'originals', '44', `${taskOrphan}.png`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(path.join(userOutputRoot, 'originals', '44', `${taskOrphan}.png`))
    ).resolves.toBeTruthy()
  })

  it('fails closed for malformed lifecycle namespace scopes', async () => {
    const root = await fixture()
    const malformedRoot = path.join(root, 'task', 'bad scope')
    await add(malformedRoot, taskOrphan)
    const regularFile = path.join(root, 'model', 'not-a-directory')
    await fs.mkdir(path.dirname(regularFile), { recursive: true })
    await fs.writeFile(regularFile, 'not a model scope')

    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })

    expect(plan.actions.some((action) => action.relativePath.includes('bad scope'))).toBe(false)
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'task/bad scope',
          reason: 'unknown namespace scope'
        }),
        expect.objectContaining({
          relativePath: 'model/not-a-directory',
          reason: 'unsafe or non-directory namespace scope'
        })
      ])
    )
    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(
      fs.stat(path.join(malformedRoot, 'originals', '44', `${taskOrphan}.png`))
    ).resolves.toBeTruthy()
  })

  it('fails closed for malformed task scopes and does not delete their contents', async () => {
    const root = await fixture()
    const malformedRoot = path.join(root, 'comfy-outputs', 'tasks', 'bad scope')
    await add(malformedRoot, taskOrphan)
    const regularFile = path.join(root, 'comfy-outputs', 'tasks', 'not-a-directory')
    await fs.mkdir(path.dirname(regularFile), { recursive: true })
    await fs.writeFile(regularFile, 'not a task root')

    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })

    expect(plan.actions.some((action) => action.relativePath.includes('bad scope'))).toBe(false)
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'comfy-outputs/tasks/bad scope',
          reason: 'unknown task scope'
        }),
        expect.objectContaining({
          relativePath: 'comfy-outputs/tasks/not-a-directory',
          reason: 'unsafe or non-directory task root'
        })
      ])
    )
    await executeManagedMediaCleanup(plan, { dryRun: false })
    await expect(
      fs.stat(path.join(malformedRoot, 'originals', '44', `${taskOrphan}.png`))
    ).resolves.toBeTruthy()
  })

  it('rejects forged scoped cleanup actions outside normalized roots', async () => {
    const root = await fixture()
    const temporary = path.join(root, '.staging', 'forged.tmp')
    await fs.mkdir(path.dirname(temporary), { recursive: true })
    await fs.writeFile(temporary, 'keep')
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: []
    })
    const result = await executeManagedMediaCleanup(
      {
        ...plan,
        actions: [
          {
            kind: 'temp-file',
            relativePath: 'comfy-outputs/tasks/bad scope/.staging/forged.tmp'
          }
        ]
      },
      { dryRun: false }
    )
    expect(result.deleted).toEqual([])
    expect(result.skipped).toEqual([
      {
        relativePath: 'comfy-outputs/tasks/bad scope/.staging/forged.tmp',
        reason: 'cleanup path has an invalid task scope'
      }
    ])
    await expect(fs.stat(temporary)).resolves.toBeTruthy()
  })
})
