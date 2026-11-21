import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImportSourceGate, type ImportSourceGate } from './llmProxy/managedMediaStore'
import { clearScopedLocalMediaPathsForTest } from './localMediaAccess'
import { authorizeRendererLocalPath, checkRendererLocalPath } from './rendererLocalPathAccess'

// node:fs is the in-memory filesystem of the node test setup.
const root = path.join(process.cwd(), '.magicpot-trash', 'renderer-local-path-access')

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
  fs.rmSync(root, { recursive: true, force: true })
})

/** A realpath on a share that stopped answering. */
const neverAnswers = () => new Promise<string>(() => undefined)

describe('authorizeRendererLocalPath', () => {
  it('answers null at its deadline when the path never answers, with or without the gate', async () => {
    const file = path.join(root, 'a.png')
    for (const gate of [null, createImportSourceGate({ onSaturated: () => undefined })]) {
      const started = performance.now()
      await expect(
        authorizeRendererLocalPath(file, [root], { gate, timeoutMs: 30, realpath: neverAnswers })
      ).resolves.toBeNull()
      expect(performance.now() - started).toBeLessThan(5_000)
    }
  })

  it('authorizes a file under a root and refuses one outside it', async () => {
    const inside = path.join(root, 'media', 'a.png')
    const outside = path.join(process.cwd(), '.magicpot-trash', 'elsewhere-secret.txt')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, 'a')
    fs.writeFileSync(outside, 'secret')
    try {
      for (const gate of [null, undefined]) {
        await expect(authorizeRendererLocalPath(inside, [root], { gate })).resolves.toBe(
          fs.realpathSync.native(inside)
        )
        await expect(authorizeRendererLocalPath(outside, [root], { gate })).resolves.toBeNull()
      }
      // Never a synchronous realpath of the named path.
      const sync = vi.spyOn(fs.realpathSync, 'native')
      await authorizeRendererLocalPath(inside, [root], { gate: null })
      expect(sync.mock.calls.filter(([target]) => String(target) === inside)).toEqual([])
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})

/** A gate that refuses every call at once, as one whose slots are all held by stalled calls. */
const saturatedGate: ImportSourceGate = {
  acquire: (_key, _start, refuse) => {
    refuse()
    return () => false
  },
  active: 3,
  overdue: 3
}

describe('checkRendererLocalPath: why a path was refused', () => {
  it('tells a missing file from one that is outside and from one that did not answer', async () => {
    const inside = path.join(root, 'media', 'a.png')
    const outside = path.join(process.cwd(), '.magicpot-trash', 'elsewhere-secret.txt')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, 'a')
    fs.writeFileSync(outside, 'secret')
    const eio = async () => {
      throw Object.assign(new Error('i/o error'), { code: 'EIO' })
    }
    try {
      for (const gate of [null, undefined]) {
        const check = (filePath: string, options = {}) =>
          checkRendererLocalPath(filePath, [root], { gate, ...options })
        await expect(check(inside)).resolves.toEqual({ canonicalPath: fs.realpathSync(inside) })
        await expect(check(path.join(root, 'media', 'gone.png'))).resolves.toEqual({
          canonicalPath: null,
          reason: 'missing'
        })
        await expect(check(path.join(inside, 'not-a-folder.png'))).resolves.toMatchObject({
          reason: 'missing'
        })
        await expect(check(outside)).resolves.toMatchObject({ reason: 'refused' })
        await expect(check('relative/a.png')).resolves.toMatchObject({ reason: 'refused' })
        // The filesystem failed or gave no answer in time: the file may well be there.
        await expect(check(inside, { realpath: eio })).resolves.toMatchObject({
          reason: 'unavailable'
        })
        await expect(
          check(path.join(root, 'stalls', 'b.png'), { realpath: neverAnswers, timeoutMs: 20 })
        ).resolves.toMatchObject({ reason: 'unavailable' })
      }
      // Every slot of the gate is held by calls past their deadline: an existing file is
      // unavailable, never missing.
      await expect(
        checkRendererLocalPath(inside, [root], { gate: saturatedGate })
      ).resolves.toEqual({ canonicalPath: null, reason: 'unavailable' })
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})
