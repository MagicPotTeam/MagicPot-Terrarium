import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { loadRegisteredSkillPackages, validateSkillPackages } from './packages'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-package-'))); roots.push(root)
  const put = async (relative: string, body: string) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body, 'utf8'); return file }
  const registry = [{ id: 'user', directory: root, enabled: true }]
  return { root, put, registry }
}
describe('read-only explicitly registered Markdown skill directories', () => {
  it('does not read disabled/other-project roots or create missing directories', async () => {
    const t = await setup(), spy = vi.spyOn(fs, 'opendir')
    expect(await loadRegisteredSkillPackages([{ ...t.registry[0], enabled: false }], 'project')).toEqual({ skills: [], truncated: false })
    expect(await loadRegisteredSkillPackages([{ ...t.registry[0], projectId: 'other' }], 'project')).toEqual({ skills: [], truncated: false }); expect(spy).not.toHaveBeenCalled()
    expect(await loadRegisteredSkillPackages([{ ...t.registry[0], directory: path.join(t.root, 'absent') }], 'project')).toEqual({ skills: [], truncated: true })
    await expect(fs.stat(path.join(t.root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('loads folder/flat instructions with reference base roots and no script/resource/authority execution', async () => {
    const t = await setup()
    await t.put('build/SKILL.md', '---\nname: tests-first\ndescription: Read before editing\npaths: ["*.ts"]\nallowed-tools: [bash]\nhooks: {before: run.py}\n---\nRun tests with separate approval.')
    await t.put('build/run.py', 'raise Exception("MUST_NOT_EXECUTE")')
    await t.put('flat.md', '---\ndisable-model-invocation: true\n---\nExplicit only.')
    const result = await loadRegisteredSkillPackages(t.registry, 'project')
    expect(result.truncated).toBe(false); expect(result.skills).toHaveLength(2)
    expect(result.skills[0]).toMatchObject({ name: 'tests-first', source: 'markdown', baseDirectory: path.join(t.root, 'build'), metadataFields: ['allowed-tools', 'hooks'] })
    expect(result.skills[1]).toMatchObject({ name: 'flat', disableModelInvocation: true })
    expect(JSON.stringify(result)).not.toContain('MUST_NOT_EXECUTE'); expect(result.skills[0]).not.toHaveProperty('bindings')
    const previous = result.skills[0].digest; await t.put('build/SKILL.md', '# Changed instructions')
    expect((await loadRegisteredSkillPackages(t.registry, 'project')).skills[0].digest).not.toBe(previous)
  })
  it('preserves the pre-manifest directory pathname ID and two-element registration/content digest shape', async () => {
    const t = await setup(); await t.put('Review/SKILL.md', '---\nname: stable-legacy\n---\n# Legacy body')
    const { digest, ...content } = (await loadRegisteredSkillPackages(t.registry, 'project')).skills[0]
    expect(content.id).toBe(`pkg-user-${createHash('sha256').update(path.join('Review', 'SKILL.md')).digest('hex').slice(0, 16)}`)
    expect(digest).toBe(createHash('sha256').update(JSON.stringify([t.registry[0], content])).digest('hex'))
  })
  it('prefers folder form over flat of the same declared name and supports a directly registered skill folder', async () => {
    const t = await setup(); await t.put('one/SKILL.md', '---\nname: shared\n---\nFolder instructions'); await t.put('flat.md', '---\nname: shared\n---\nFlat instructions')
    expect((await loadRegisteredSkillPackages(t.registry, 'project')).skills.map(item => item.instructions)).toEqual(['Folder instructions'])
    const result = await loadRegisteredSkillPackages([{ ...t.registry[0], directory: path.join(t.root, 'one') }], 'project')
    expect(result.skills).toHaveLength(1); expect(result.skills[0].baseDirectory).toBe(path.join(t.root, 'one'))
  })
  it('rejects linked roots, linked ancestors/categories and hardlinked Markdown', async () => {
    const t = await setup(), outside = await setup(); await outside.put('foreign/SKILL.md', '# Outside')
    await t.put('good.md', '# Good')
    await fs.link(path.join(outside.root, 'foreign/SKILL.md'), path.join(t.root, 'hard.md'))
    await fs.symlink(outside.root, path.join(t.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const local = await loadRegisteredSkillPackages(t.registry, 'project')
    expect(local.skills.map(item => item.name)).toEqual(['good']); expect(local.truncated).toBe(true)
    expect((await loadRegisteredSkillPackages([{ ...t.registry[0], directory: path.join(t.root, 'linked') }], 'project')).skills).toEqual([])
    expect((await loadRegisteredSkillPackages([{ ...t.registry[0], directory: path.join(t.root, 'linked/foreign') }], 'project')).skills).toEqual([])
  })
  it('refuses malformed registry and bounded metadata/body, observes cancellation and caps files', async () => {
    const t = await setup()
    expect(() => validateSkillPackages([{ ...t.registry[0], directory: '../outside' }])).toThrow('absolute')
    expect(() => validateSkillPackages([t.registry[0], t.registry[0]])).toThrow('invalid')
    expect(() => validateSkillPackages([{ ...t.registry[0], grants: true }])).toThrow('invalid')
    const controller = new AbortController(); controller.abort(); await expect(loadRegisteredSkillPackages(t.registry, 'project', controller.signal)).rejects.toThrow()
    await t.put('broken.md', '---\na: &a [1]\nb: *a\n---\nNever expanded')
    await t.put('large.md', 'a'.repeat(65537)); await t.put('good.md', '# Good')
    const first = await loadRegisteredSkillPackages(t.registry, 'project'); expect(first.skills.map(item => item.name)).toEqual(['good']); expect(first.truncated).toBe(true)
    for (let i = 0; i < 102; i++) await t.put(`skill${i}.md`, '# Bounded')
    const capped = await loadRegisteredSkillPackages(t.registry, 'project'); expect(capped.truncated).toBe(true); expect(capped.skills.length).toBeLessThanOrEqual(100)
  })
  it('rejects a transient ordinary-directory substitution restored before the final directory fence', async () => {
    const t = await setup(); await t.put('good/SKILL.md', '# Original')
    await t.put('.replacement/SKILL.md', '# Substituted')
    const original = fs.lstat.bind(fs); let phase = 0
    const file = path.join(t.root, 'good/SKILL.md')
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === file && phase === 0) { phase = 1; await fs.rename(path.join(t.root, 'good'), path.join(t.root, '.saved')); await fs.rename(path.join(t.root, '.replacement'), path.join(t.root, 'good')) }
      const result = await original(...args)
      if (String(args[0]) === file && phase === 1) { phase = 2; return result }
      if (String(args[0]) === file && phase === 2) { phase = 3; await fs.rename(path.join(t.root, 'good'), path.join(t.root, '.replacement')); await fs.rename(path.join(t.root, '.saved'), path.join(t.root, 'good')) }
      return result
    })
    const result = await loadRegisteredSkillPackages(t.registry, 'project')
    expect(phase).toBe(3); expect(result.skills).toEqual([]); expect(result.truncated).toBe(true)
  })
  it('fences directory replacement while a definition read is pending instead of returning stale package contents', async () => {
    const t = await setup(); await t.put('good/SKILL.md', '# Original')
    const original = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => { const handle = await original(...args); await fs.rename(path.join(t.root, 'good'), path.join(t.root, 'moved')); await t.put('good/SKILL.md', '# Replacement'); return handle })
    const result = await loadRegisteredSkillPackages(t.registry, 'project'); expect(spy).toHaveBeenCalled(); expect(result.skills).toEqual([]); expect(result.truncated).toBe(true)
  })
})
