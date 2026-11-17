import { join, resolve } from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// The node suite replaces fs with memfs; these checks read the real files.
let readFileSync: typeof import('fs').readFileSync
beforeAll(async () => {
  readFileSync = (await vi.importActual<typeof import('fs')>('fs')).readFileSync
})

// The 4096 px master logo costs a 64 MB decode wherever it is drawn. Runtime
// surfaces (title bar, sidebar, Linux window icon, fallback drag icon) use the
// small copies made by scripts/assets/generate-logo-sizes.py; packaging keeps
// using the master in packages/runtime-assets/build.
const repoRoot = resolve(__dirname, '../../../..')
const read = (relativePath: string) => readFileSync(join(repoRoot, relativePath))

function pngSize(relativePath: string): { width: number; height: number } {
  const bytes = read(relativePath)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('runtime logo assets', () => {
  it.each([
    ['packages/app/src/renderer/src/assets/logo-128.png', 128],
    ['packages/app/src/renderer/src/assets/logo-256.png', 256],
    ['packages/runtime-assets/resources/icon-256.png', 256]
  ])('%s is a %i px square PNG', (relativePath, size) => {
    expect(pngSize(relativePath)).toEqual({ width: size, height: size })
  })

  it('keeps the master logo for packaging', () => {
    expect(pngSize('packages/runtime-assets/build/icon.png')).toEqual({ width: 4096, height: 4096 })
    const builderConfig = read('config/electron/electron-builder.config.js').toString('utf8')
    expect(builderConfig).toContain('${buildResourcesDir}/icon.png')
  })

  it.each([
    ['packages/app/src/renderer/src/components/TitleBar.tsx', ["'../assets/logo-128.png'"]],
    [
      'packages/app/src/renderer/src/components/SidebarHeader.tsx',
      ["'../assets/logo-128.png'", "'../assets/logo-256.png'"]
    ],
    ['packages/app/src/main/mainWindow.ts', ["runtime-assets/resources/icon-256.png?asset'"]]
  ])('%s draws the small logo, never the 4096 px master', (relativePath, expected) => {
    const source = read(relativePath).toString('utf8')
    for (const reference of expected) expect(source).toContain(reference)
    expect(source).not.toMatch(/runtime-assets\/(build|resources)\/icon\.png/)
    expect(source).not.toContain('assets/logo.png')
  })
})
