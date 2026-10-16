import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_WORKER_ASSETS, verifyDocumentWorkerAssets } from './documentWorkerAssets'

// The real CJS builder transformer uses native fs/promises; fixture writes and
// the main asset verifier must use the same owned real filesystem, not memfs.
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

const roots: string[] = []
const require = createRequire(import.meta.url)
const { createTransformer } = require('app-builder-lib/out/fileTransformer.js')
function fixture() {
  const trash = path.join(process.cwd(), '.magicpot-trash')
  fs.mkdirSync(trash, { recursive: true })
  const root = fs.mkdtempSync(path.join(trash, 'document-assets-test-'))
  roots.push(root)
  const write = (relative: string, bytes: string) => {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
    return full
  }
  const files: Array<{ path: string; sha256: string }> = DOCUMENT_WORKER_ASSETS.map((relative) => {
    const full = write(relative, 'owned inert fixture ' + relative)
    return {
      path: relative,
      sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  })
  const manifest = {
    protocol: 'magicpot-document-worker-assets/v2',
    pdfjsVersion: '6.3.289',
    saxesVersion: '6.0.0',
    files
  }
  const packageJson = {
    name: 'pdfjs-dist',
    version: '6.3.289',
    main: 'build/pdf.mjs',
    scripts: {},
    keywords: ['fixture'],
    bugs: 'https://fixture.invalid/'
  }
  write('out/document-worker/manifest.json', JSON.stringify(manifest))
  write('node_modules/pdfjs-dist/package.json', JSON.stringify(packageJson))
  return { root, write, manifest, packageJson }
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('main-owned fixed document asset closure', () => {
  it('verifies executable bytes before choosing the fixed entry, ignoring transformed non-runtime metadata', async () => {
    const f = fixture()
    expect(verifyDocumentWorkerAssets(f.root)).toBe(path.join(f.root, DOCUMENT_WORKER_ASSETS[0]))
    const metadata = path.join(f.root, 'node_modules/pdfjs-dist/package.json')
    const changed = await createTransformer(f.root, {}, {})(metadata)
    expect(changed).not.toBeNull()
    expect(JSON.parse(changed)).not.toHaveProperty('scripts')
    fs.writeFileSync(metadata, changed)
    expect(verifyDocumentWorkerAssets(f.root)).toBe(path.join(f.root, DOCUMENT_WORKER_ASSETS[0]))
  })
  it.each(DOCUMENT_WORKER_ASSETS)('rejects altered executable/license asset %s', (relative) => {
    const f = fixture()
    f.write(relative, 'different owned bytes')
    expect(() => verifyDocumentWorkerAssets(f.root)).toThrow('Document worker assets unavailable')
  })
  it.each([
    { name: 'wrong-owned-name' },
    { version: '0.0.0' },
    { main: '../../wrong-owned-module.mjs' },
    { exports: null }
  ])('rejects module resolution contract mismatch %j', (metadata) => {
    const f = fixture()
    f.write(
      'node_modules/pdfjs-dist/package.json',
      JSON.stringify({ ...f.packageJson, ...metadata })
    )
    expect(() => verifyDocumentWorkerAssets(f.root)).toThrow('Document worker assets unavailable')
  })
  it('rejects a manifest-selected replacement entry rather than following it', () => {
    const f = fixture()
    f.manifest.files[0].path = 'out/document-worker/owned-alternative.cjs'
    f.write('out/document-worker/owned-alternative.cjs', 'not an executable')
    f.write('out/document-worker/manifest.json', JSON.stringify(f.manifest))
    expect(() => verifyDocumentWorkerAssets(f.root)).toThrow('Document worker assets unavailable')
  })
})
