import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { buildSkillContext, scanSkillWorkspace } from './context'
import type { ThreadProceduralSkill } from '@shared/api/agentThreadSkill'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const skill = (id: string, patch: Partial<ThreadProceduralSkill> = {}): ThreadProceduralSkill => ({ id, name: id, description: 'Only metadata', paths: ['*.ts'], instructions: 'PRIVATE_BODY', baseDirectory: 'D:/PRIVATE_ROOT', digest: 'PRIVATE_DIGEST', ...patch })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-context-'))); roots.push(root)
  const put = async (name: string) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'PRIVATE_FILE_BODY') }
  return { root, put }
}
describe('opt-in bounded metadata skill context', () => {
  it('lists metadata only, hides suppressed skills and marks matches without disclosing filenames/roots/body/digest', () => {
    const result = buildSkillContext([skill('visible'), skill('hidden', { disableModelInvocation: true })], { index: true, paths: true, catalogTruncated: false, scan: { paths: ['PRIVATE_NAME.ts'], truncated: false } })
    expect(JSON.parse(result)).toMatchObject({ grantsPermission: false, instructionsLoaded: false, scan: 'bounded-scan', skills: [{ id: 'visible', pathMatched: true }] })
    expect(result).not.toMatch(/PRIVATE_|hidden/)
  })
  it('independently handles index-only/path-only/unavailable and strict multibyte byte budget with omission counts', () => {
    const list = [skill('match'), skill('not-match', { paths: ['*.pdf'] })]
    expect(JSON.parse(buildSkillContext(list, { index: true, paths: false, catalogTruncated: false })).skills).toHaveLength(2)
    expect(JSON.parse(buildSkillContext(list, { index: false, paths: true, catalogTruncated: false, scan: { paths: ['a.ts'], truncated: true } }))).toMatchObject({ scan: 'partial', skills: [{ id: 'match' }] })
    expect(JSON.parse(buildSkillContext(list, { index: false, paths: true, catalogTruncated: false, scan: { paths: [], truncated: false, unavailable: true } }))).toMatchObject({ scan: 'unavailable', skills: [] })
    const text = buildSkillContext(Array.from({ length: 100 }, (_, i) => skill('界'.repeat(120) + i, { description: '界'.repeat(1000) })), { index: true, paths: false, catalogTruncated: true })
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096); expect(JSON.parse(text).omitted).toBeGreaterThan(0)
  })
  it('scans only names in the supplied main workspace, skips hidden/cache/link/hardlink content and bounds depth', async () => {
    const t = await fixture(), outside = await fixture()
    await t.put('src/main.ts'); await t.put('.hidden.ts'); await t.put('node_modules/dependency.ts'); await t.put('a/b/c/at-depth3.py'); await t.put('a/b/c/d/too-deep.ts'); await outside.put('EXTERNAL_SECRET.ts')
    await fs.symlink(outside.root, path.join(t.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.link(path.join(outside.root, 'EXTERNAL_SECRET.ts'), path.join(t.root, 'hard.ts'))
    const read = vi.spyOn(fs, 'readFile'), open = vi.spyOn(fs, 'open')
    const result = await scanSkillWorkspace(t.root, new AbortController().signal, () => undefined)
    expect(result).toEqual({ paths: ['a/b/c/at-depth3.py', 'src/main.ts'], truncated: true }); expect(read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    await expect(scanSkillWorkspace(path.join(t.root, 'linked'), new AbortController().signal, () => undefined)).rejects.toThrow('linked')
  })
  it('reports cap exhaustion and refuses relative/network roots, cancellation and document revocation', async () => {
    const t = await fixture(); for (let i = 0; i < 501; i++) await t.put(`f${i}.ts`)
    expect(await scanSkillWorkspace(t.root, new AbortController().signal, () => undefined)).toMatchObject({ truncated: true, paths: expect.any(Array) })
    expect((await scanSkillWorkspace(t.root, new AbortController().signal, () => undefined)).paths).toHaveLength(500)
    await expect(scanSkillWorkspace('../outside', new AbortController().signal, () => undefined)).rejects.toThrow('absolute')
    await expect(scanSkillWorkspace('\\\\server\\share', new AbortController().signal, () => undefined)).rejects.toThrow('local')
    const c = new AbortController(); c.abort(); await expect(scanSkillWorkspace(t.root, c.signal, () => undefined)).rejects.toThrow()
    await expect(scanSkillWorkspace(t.root, new AbortController().signal, () => { throw new Error('revoked') })).rejects.toThrow('revoked')
  })
})
