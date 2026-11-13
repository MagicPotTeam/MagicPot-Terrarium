import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { verifyHtmlBootstrap } from './agentThreadHtmlAssets'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'html-build-assets-')); roots.push(root)
  const dir = path.join(root, 'out/main'); mkdirSync(dir, { recursive: true })
  const files = ['index.js', 'normal-abcd.js'].map(name => { const code = `// fixture ${name}`; writeFileSync(path.join(dir, name), code); return { path: name, bytes: Buffer.byteLength(code), sha256: createHash('sha256').update(code).digest('hex') } })
  const manifest = { protocol: 'magicpot-isolated-html-bootstrap/v1', entry: 'index.js', files }
  const save = () => writeFileSync(path.join(dir, 'html-bootstrap-manifest.json'), JSON.stringify(manifest))
  save(); return { root, dir, manifest, save }
}
describe('isolated bootstrap build closure', () => {
  it('accepts a complete matched app-owned build and rejects missing/corrupted chunks', () => {
    const t = fixture(); expect(verifyHtmlBootstrap(t.root)).toBe(path.join(t.dir, 'index.js'))
    writeFileSync(path.join(t.dir, 'normal-abcd.js'), '// changed')
    expect(() => verifyHtmlBootstrap(t.root)).toThrow('identity changed')
  })
  it.each(['../escape.js', 'nested/index.js', 'C:/foreign.js'])('rejects manifest path authority %s', name => {
    const t = fixture(); t.manifest.files[1].path = name; t.save()
    expect(() => verifyHtmlBootstrap(t.root)).toThrow('manifest entry')
  })
  it('refuses old bundles without a bootstrap manifest and excessive declared bytes', () => {
    const t = fixture(); rmSync(path.join(t.dir, 'html-bootstrap-manifest.json'))
    expect(() => verifyHtmlBootstrap(t.root)).toThrow()
    t.manifest.files[0].bytes = 17 * 1024 * 1024; t.save()
    expect(() => verifyHtmlBootstrap(t.root)).toThrow('manifest entry')
  })
})
