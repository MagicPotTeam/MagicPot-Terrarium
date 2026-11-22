import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_STORAGE_MARKER, CATALOG_STORAGE_PREFIX, CATALOG_STORAGE_ROOT_ENV, provideConfinedCatalogStorage } from './installedCatalogStorage'

vi.unmock('node:fs'); vi.unmock('node:fs/promises')

const readerTest = path.resolve('packages/app/src/main/magicAgentRuntime/installedCatalogReader.test.ts')
const cleanup: (() => void)[] = []
afterEach(() => { for (const run of cleanup.splice(0)) run() })

describe('confined storage root for the installed-catalog reader fixtures', () => {
  it('is not provided to this or any other unlisted test file', async () => {
    expect(process.env[CATALOG_STORAGE_ROOT_ENV] ?? '').not.toContain(CATALOG_STORAGE_PREFIX)
    for (const other of [__filename, path.resolve('packages/app/src/main/config/config.test.ts'), path.resolve('packages/app/src/main/api/installedCatalogReader.test.ts'), readerTest + '.bak', '']) {
      const env: Record<string, string | undefined> = {}
      const release = await provideConfinedCatalogStorage(other, env); cleanup.push(release)
      expect(env).toEqual({})
      release(); expect(env).toEqual({})
    }
  })
  it('gives the reader test a fresh temporary root and removes it, with the variable, on release', async () => {
    const env: Record<string, string | undefined> = { UNRELATED: 'kept' }
    const release = await provideConfinedCatalogStorage(readerTest, env); cleanup.push(release)
    const root = env[CATALOG_STORAGE_ROOT_ENV]!
    expect(path.isAbsolute(root)).toBe(true); expect(root).toContain(CATALOG_STORAGE_MARKER)
    expect(path.dirname(root)).toBe(fs.realpathSync.native(os.tmpdir())); expect(path.basename(root).startsWith(CATALOG_STORAGE_PREFIX)).toBe(true)
    expect(fs.statSync(root).isDirectory()).toBe(true); expect(fs.readdirSync(root)).toEqual([])
    fs.mkdirSync(path.join(root, 'reader-fixture-x', 'nested'), { recursive: true }); fs.writeFileSync(path.join(root, 'reader-fixture-x', 'nested', 'file'), 'x')
    release()
    expect(env).toEqual({ UNRELATED: 'kept' }); expect(fs.existsSync(root)).toBe(false)
    expect(() => release()).not.toThrow(); expect(env).toEqual({ UNRELATED: 'kept' })
  })
  it('creates a different root for every file run', async () => {
    const first: Record<string, string | undefined> = {}, second: Record<string, string | undefined> = {}
    cleanup.push(await provideConfinedCatalogStorage(readerTest, first), await provideConfinedCatalogStorage(readerTest, second))
    expect(first[CATALOG_STORAGE_ROOT_ENV]).not.toBe(second[CATALOG_STORAGE_ROOT_ENV])
  })
  it.each(['relative/studio-catalog-storage', path.resolve(os.tmpdir(), 'some-real-profile'), ''])('replaces the unconfined value %j only for the file and restores it exactly', async (previous) => {
    const env: Record<string, string | undefined> = { [CATALOG_STORAGE_ROOT_ENV]: previous }
    const release = await provideConfinedCatalogStorage(readerTest, env); cleanup.push(release)
    const root = env[CATALOG_STORAGE_ROOT_ENV]!
    expect(root).not.toBe(previous); expect(path.basename(root).startsWith(CATALOG_STORAGE_PREFIX)).toBe(true)
    release()
    expect(env).toEqual({ [CATALOG_STORAGE_ROOT_ENV]: previous }); expect(fs.existsSync(root)).toBe(false)
    expect(fs.existsSync(path.resolve(os.tmpdir(), 'some-real-profile'))).toBe(false)
  })
  it('leaves an explicitly supplied confined root alone and never deletes it', async () => {
    const explicit = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `explicit-${CATALOG_STORAGE_MARKER}-`))
    cleanup.push(() => fs.rmSync(explicit, { recursive: true, force: true }))
    fs.writeFileSync(path.join(explicit, 'owner-file'), 'kept')
    const env: Record<string, string | undefined> = { [CATALOG_STORAGE_ROOT_ENV]: explicit }
    const release = await provideConfinedCatalogStorage(readerTest, env)
    expect(env).toEqual({ [CATALOG_STORAGE_ROOT_ENV]: explicit })
    release()
    expect(env).toEqual({ [CATALOG_STORAGE_ROOT_ENV]: explicit }); expect(fs.readFileSync(path.join(explicit, 'owner-file'), 'utf8')).toBe('kept')
  })
  it('does not undo a value that the test file itself put in place afterwards', async () => {
    const env: Record<string, string | undefined> = {}
    const release = await provideConfinedCatalogStorage(readerTest, env); cleanup.push(release)
    const root = env[CATALOG_STORAGE_ROOT_ENV]!
    env[CATALOG_STORAGE_ROOT_ENV] = 'set-by-the-test'
    release()
    expect(env).toEqual({ [CATALOG_STORAGE_ROOT_ENV]: 'set-by-the-test' }); expect(fs.existsSync(root)).toBe(false)
  })
})
