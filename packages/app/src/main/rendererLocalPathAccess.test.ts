import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImportSourceGate } from './llmProxy/managedMediaStore'
import { clearScopedLocalMediaPathsForTest } from './localMediaAccess'
import { authorizeRendererLocalPath } from './rendererLocalPathAccess'

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
