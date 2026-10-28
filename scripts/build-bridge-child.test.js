import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { vol } from 'memfs'
import { build } from 'vite'
import { bridgeChildSourceManifest, buildBridgeChild } from './build-bridge-child.mjs'

vi.mock('vite', () => ({ build: vi.fn() }))
afterEach(() => {
  vol.reset()
  vi.resetAllMocks()
})
const root = path.resolve('D:/synthetic bridge child/repo')
const entry = path.join(root, 'packages/app/src/main/figplugin/bridgeChildEntry.ts')
const imageContract = path.join(root, 'packages/app/src/shared/figplugin/hostExecutionAssets.ts')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seed = (name, data) => {
  fs.mkdirSync(path.dirname(name), { recursive: true })
  fs.writeFileSync(name, data)
}
const output = (...ids) => ({
  output: [{ type: 'chunk', modules: Object.fromEntries(ids.map((id) => [id, {}])) }]
})

describe('Bridge child build source closure', () => {
  it('records actual emitted module dependencies, including new shared image contracts, rather than a static six-file list', async () => {
    seed(entry, 'owned entry')
    seed(imageContract, 'owned execution image contract')
    seed(path.join(root, 'out/bridge-child/index.cjs'), 'owned compiled fixture')
    vi.mocked(build).mockResolvedValue(output(entry, imageContract, '\0virtual-helper'))
    const manifest = await buildBridgeChild({ root })
    expect(manifest.sourceFiles).toEqual([
      {
        path: 'packages/app/src/main/figplugin/bridgeChildEntry.ts',
        sha256: digest('owned entry')
      },
      {
        path: 'packages/app/src/shared/figplugin/hostExecutionAssets.ts',
        sha256: digest('owned execution image contract')
      }
    ])
    expect(manifest.files).toEqual([
      { path: 'out/bridge-child/index.cjs', sha256: digest('owned compiled fixture') }
    ])
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'out/bridge-child/manifest.json'), 'utf8'))
    ).toEqual(manifest)
  })

  it('updates a dependency digest without needing an entry-point edit and deduplicates transformed module IDs', () => {
    seed(entry, 'same entry')
    seed(imageContract, 'old image contract')
    const before = bridgeChildSourceManifest(root, output(entry, imageContract))
    seed(imageContract, 'new image contract')
    const after = bridgeChildSourceManifest(root, [
      output(entry, imageContract + '?commonjs-proxy'),
      output(imageContract)
    ])
    expect(after).toHaveLength(2)
    expect(after[0]).toEqual(before[0])
    expect(after[1].sha256).not.toBe(before[1].sha256)
  })

  it('normalizes linked package sources without exposing an absolute machine path', () => {
    seed(entry, 'entry')
    const linked = path.resolve('D:/owned package cache/node_modules/zod/index.js')
    seed(linked, 'owned linked package')
    expect(bridgeChildSourceManifest(root, output(entry, linked))).toContainEqual({
      path: 'node_modules/zod/index.js',
      sha256: digest('owned linked package')
    })
  })

  it('rejects ambiguous linked package identities instead of silently dropping a version', () => {
    seed(entry, 'entry')
    const first = path.resolve('D:/package cache/a/node_modules/zod/index.js')
    const second = path.resolve('D:/package cache/b/node_modules/zod/index.js')
    seed(first, 'first version')
    seed(second, 'second version')
    expect(() => bridgeChildSourceManifest(root, output(entry, first, second))).toThrow('Ambiguous')
  })

  it.each([undefined, {}, { output: [] }])(
    'rejects a build without an observable entry module %#',
    (result) => {
      expect(() => bridgeChildSourceManifest(root, result)).toThrow()
    }
  )

  it('refuses missing, relative and outside non-package source identities', () => {
    seed(entry, 'entry')
    const outside = path.resolve('D:/unrelated-user-files/image.png')
    seed(outside, 'not a build dependency')
    for (const id of [imageContract, 'relative.ts', outside])
      expect(() => bridgeChildSourceManifest(root, output(entry, id))).toThrow()
  })
})
