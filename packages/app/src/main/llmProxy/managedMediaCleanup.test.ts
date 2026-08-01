import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { planManagedMediaCleanup } from './managedMediaCleanup'

const referenced = '1'.repeat(64)
const orphan = '2'.repeat(64)
const identity = '3'.repeat(64)
const created: string[] = []
async function add(root: string, id: string) {
  const original = `originals/${id.slice(0, 2)}/${id}.png`
  const dir = path.join(root, 'derivatives', id.slice(0, 2), id, identity, 'committed')
  const image = `derivatives/${id.slice(0, 2)}/${id}/${identity}/committed/image.webp`
  await fs.mkdir(path.dirname(path.join(root, original)), { recursive: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.dirname(path.join(root, image)), { recursive: true })
  await fs.mkdir(path.join(root, 'metadata'), { recursive: true })
  await fs.writeFile(path.join(root, original), 'image')
  await fs.writeFile(path.join(root, image), 'small')
  await fs.writeFile(
    path.join(root, 'metadata', `${id}.json`),
    JSON.stringify({ schema: 'magicpot.managed-media/v1', sha256: id, relativePath: original })
  )
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 'magicpot.managed-media-derivative/v3',
      purpose: 'managed-media-derivative',
      identity,
      originalSha256: id,
      format: 'webp',
      relativePath: image
    })
  )
}
async function fixture() {
  const root = await createNodeTestArtifactDir('managed-media-cleanup')
  created.push(root)
  await add(root, referenced)
  await add(root, orphan)
  return root
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })))
})

describe('managedMediaCleanup safe planner', () => {
  it('plans a real orphan v3 derivative', async () => {
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
      }
    ])
  })
  it('omits referenced media from actions and skipped', async () => {
    const root = await fixture()
    const plan = await planManagedMediaCleanup({
      chatMediaRoot: root,
      referencedMediaIds: [referenced]
    })
    expect(plan.actions.some((x) => x.mediaId === referenced)).toBe(false)
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
})
