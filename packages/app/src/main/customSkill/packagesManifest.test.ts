import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { THREAD_SKILL_LIMITS as LIMITS, type ProceduralSkillPackage } from '@shared/api/agentThreadSkill'
import { loadRegisteredSkillPackages, validateSkillPackages } from './packages'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-manifest-'))); roots.push(root)
  const put = async (relative: string, body: string) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body, 'utf8'); return file }
  const registry: ProceduralSkillPackage[] = [{ id: 'user', directory: root, enabled: true, source: 'manifest' }]
  return { root, put, registry }
}
describe('explicit local kohaku.yaml procedural skill registration', () => {
  it('loads only declared nested folder/flat/suffix skills with frontmatter priority and no package slot execution', async () => {
    const t = await setup()
    await t.put('SKILL.md', '# ROOT_UNDECLARED_MUST_NOT_LOAD'); await t.put('unlisted.md', '# UNDECLARED_MUST_NOT_LOAD')
    await t.put('skills/review/SKILL.md', '---\nname: effective-review\ndescription: Frontmatter wins\npaths: ["*.ts"]\nallowed-tools: [shell.execute]\nhooks: {before: hidden.py}\n---\nDECLARED_REVIEW_ONLY')
    await t.put('skills/flat.md', '# DECLARED_FLAT_ONLY'); await t.put('nested/deep.md', '# DECLARED_SUFFIX_ONLY')
    await t.put('skills/review/hidden.py', 'raise Exception("PACKAGE_SCRIPT_MUST_NOT_READ_EXECUTE")')
    const manifest = 'name: selected\npython_dependencies: [never-install]\ntools: [{name: never-register, module: hidden}]\nplugins: [{name: never-load, module: hidden}]\nskills:\n - {name: fallback-review, path: skills/review, description: Manifest loses}\n - {name: flat-fallback, path: skills/flat.md, description: Manifest fallback}\n - {name: deep-fallback, path: nested/deep.old}\n'
    await t.put('kohaku.yaml', manifest)
    const opens = vi.spyOn(fs, 'open'), directories = vi.spyOn(fs, 'opendir'), result = await loadRegisteredSkillPackages(t.registry, 'project')
    expect(directories).not.toHaveBeenCalled(); expect(result.truncated).toBe(false)
    expect(result.skills.map(({ name, description, instructions }) => ({ name, description, instructions }))).toEqual([
      { name: 'effective-review', description: 'Frontmatter wins', instructions: 'DECLARED_REVIEW_ONLY' },
      { name: 'flat-fallback', description: 'Manifest fallback', instructions: '# DECLARED_FLAT_ONLY' },
      { name: 'deep-fallback', description: '', instructions: '# DECLARED_SUFFIX_ONLY' }
    ])
    expect(result.skills[0]).toMatchObject({ baseDirectory: path.join(t.root, 'skills/review'), metadataFields: ['allowed-tools', 'hooks'], source: 'markdown' })
    expect(opens.mock.calls.map(call => path.relative(t.root, String(call[0])).replace(/\\/g, '/'))).toEqual(['kohaku.yaml', 'skills/review/SKILL.md', 'skills/flat.md', 'nested/deep.md'])
    expect(JSON.stringify(result)).not.toMatch(/UNDECLARED|PACKAGE_SCRIPT|never-install|never-register|never-load/)
    const initial = result.skills.map(item => ({ id: item.id, digest: item.digest }))
    opens.mockRestore(); await t.put('kohaku.yaml', manifest + '# changed manifest snapshot\n')
    const next = (await loadRegisteredSkillPackages(t.registry, 'project')).skills
    expect(next.map(item => item.id)).toEqual(initial.map(item => item.id)); expect(next.every((item, i) => item.digest !== initial[i].digest)).toBe(true)
  })
  it('does not scan disabled or other-project manifests and never falls back to yml after invalid yaml', async () => {
    const t = await setup(); await t.put('kohaku.yml', 'skills: [{name: one, path: one}]'); await t.put('one.md', '# One')
    const opens = vi.spyOn(fs, 'open'), stats = vi.spyOn(fs, 'lstat')
    expect(await loadRegisteredSkillPackages([{ ...t.registry[0], enabled: false }], 'project')).toEqual({ skills: [], truncated: false })
    expect(await loadRegisteredSkillPackages([{ ...t.registry[0], projectId: 'other' }], 'project')).toEqual({ skills: [], truncated: false })
    expect(opens).not.toHaveBeenCalled(); expect(stats).not.toHaveBeenCalled()
    const yml = await loadRegisteredSkillPackages(t.registry, 'project'); expect(yml.skills[0].name).toBe('one'); expect(yml.truncated).toBe(false)
    opens.mockClear(); await t.put('kohaku.yaml', 'skills: malformed')
    expect(await loadRegisteredSkillPackages(t.registry, 'project')).toEqual({ skills: [], truncated: true })
    expect(opens.mock.calls.map(call => path.basename(String(call[0])))).toEqual(['kohaku.yaml'])
    expect(() => validateSkillPackages([{ ...t.registry[0], source: 'url' }])).toThrow('invalid')
  })
  it.each(['missing-manifest', 'malformed', 'missing-skill', 'non-markdown', 'duplicate-file', 'duplicate-name', 'bad-frontmatter', 'path-traversal', 'oversized', 'bad-utf8'] as const)('fails the whole registration without scan fallback for %s', async mode => {
    const t = await setup(); await t.put('unlisted.md', '# MUST_NOT_LOAD_FALLBACK'); await t.put('good.md', '# Good')
    let skills = [{ name: 'good', path: 'good.md' }]
    if (mode === 'missing-skill') skills.push({ name: 'missing', path: 'missing' })
    if (mode === 'non-markdown') { await t.put('bad.py', 'MUST_NOT_EXECUTE'); skills.push({ name: 'bad', path: 'bad.py' }) }
    if (mode === 'duplicate-file') skills.push({ name: 'alias', path: 'good' })
    if (mode === 'duplicate-name') { await t.put('first.md', '---\nname: shared\n---\nFirst'); await t.put('second.md', '---\nname: shared\n---\nSecond'); skills = [{ name: 'first', path: 'first.md' }, { name: 'second', path: 'second.md' }] }
    if (mode === 'bad-frontmatter') await t.put('good.md', '---\nallowed-tools: &evil [shell]\nhooks: *evil\n---\nNo')
    if (mode === 'path-traversal') skills.push({ name: 'escape', path: '../outside.md' })
    if (mode === 'oversized') await t.put('good.md', 'a'.repeat(LIMITS.fileBytes + 1))
    if (mode === 'bad-utf8') await fs.writeFile(path.join(t.root, 'good.md'), Buffer.from([0xff, 0xfe]))
    if (mode !== 'missing-manifest') await t.put('kohaku.yaml', mode === 'malformed' ? 'skills: *bad' : JSON.stringify({ skills }))
    const directories = vi.spyOn(fs, 'opendir')
    expect(await loadRegisteredSkillPackages(t.registry, 'project')).toEqual({ skills: [], truncated: true }); expect(directories).not.toHaveBeenCalled()
  })
  it.each(['manifest-hardlink', 'skill-hardlink', 'skill-parent-junction', 'root-junction'] as const)('rejects %s without opening outside bodies', async mode => {
    const t = await setup(), foreign = await setup()
    await t.put('kohaku.yaml', 'skills: [{name: one, path: inner}]'); await t.put('inner/SKILL.md', '# Local')
    await foreign.put('kohaku.yaml', 'skills: [{name: foreign, path: foreign}]'); await foreign.put('foreign/SKILL.md', '# OUTSIDE_SECRET')
    if (mode === 'manifest-hardlink') { await fs.rm(path.join(t.root, 'kohaku.yaml')); await fs.link(path.join(foreign.root, 'kohaku.yaml'), path.join(t.root, 'kohaku.yaml')) }
    if (mode === 'skill-hardlink') { await fs.rm(path.join(t.root, 'inner/SKILL.md')); await fs.link(path.join(foreign.root, 'foreign/SKILL.md'), path.join(t.root, 'inner/SKILL.md')) }
    if (mode === 'skill-parent-junction') { await fs.rm(path.join(t.root, 'inner'), { recursive: true }); await fs.symlink(path.join(foreign.root, 'foreign'), path.join(t.root, 'inner'), process.platform === 'win32' ? 'junction' : 'dir') }
    if (mode === 'root-junction') { await fs.symlink(foreign.root, path.join(t.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); t.registry[0].directory = path.join(t.root, 'linked') }
    const opens = vi.spyOn(fs, 'open'), result = await loadRegisteredSkillPackages(t.registry, 'project')
    expect(result).toEqual({ skills: [], truncated: true }); expect(opens.mock.calls.every(call => String(call[0]) === path.join(t.root, 'kohaku.yaml'))).toBe(true)
  })
  it.each(['manifest-replaced', 'manifest-edited', 'higher-precedence-appeared', 'cancel-after-manifest'] as const)('rejects %s before publishing any partial declarations', async mode => {
    const t = await setup(), selected = mode === 'higher-precedence-appeared' ? 'kohaku.yml' : 'kohaku.yaml'
    await t.put(selected, 'skills: [{name: first, path: first.md}, {name: second, path: second.md}]'); await t.put('first.md', '# First'); await t.put('second.md', '# Second')
    const original = fs.open.bind(fs), controller = new AbortController()
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]) === path.join(t.root, 'second.md')) {
        if (mode === 'manifest-replaced') { await fs.rename(path.join(t.root, selected), path.join(t.root, 'old.yaml')); await t.put(selected, 'skills: []') }
        if (mode === 'manifest-edited') await fs.appendFile(path.join(t.root, selected), '\n# changed')
        if (mode === 'higher-precedence-appeared') await t.put('kohaku.yaml', 'skills: []')
        if (mode === 'cancel-after-manifest') controller.abort(new Error('Explicit cancellation'))
      }
      return handle
    })
    if (mode === 'cancel-after-manifest') await expect(loadRegisteredSkillPackages(t.registry, 'project', controller.signal)).rejects.toThrow('cancellation')
    else expect(await loadRegisteredSkillPackages(t.registry, 'project')).toEqual({ skills: [], truncated: true })
  })
  it('keeps explicitly empty frontmatter descriptions rather than replacing them with manifest descriptions', async () => {
    const t = await setup(); await t.put('kohaku.yaml', 'skills: [{name: one, path: one.md, description: Manifest fallback}]')
    await t.put('one.md', '---\ndescription: ""\n---\nBody')
    const result = await loadRegisteredSkillPackages(t.registry, 'project')
    expect(result.truncated).toBe(false); expect(result.skills[0].description).toBe('')
  })
  it.each(['earlier-file-edit', 'earlier-file-unlink', 'earlier-file-replace'] as const)('rejects %s while a later declared file is being read', async mode => {
    const t = await setup(); await t.put('kohaku.yaml', 'skills: [{name: first, path: first.md}, {name: second, path: second.md}]')
    const first = await t.put('first.md', '# First'); await t.put('second.md', '# Second')
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]) === path.join(t.root, 'second.md')) {
        if (mode === 'earlier-file-edit') await fs.appendFile(first, '\n# edited before publication')
        if (mode === 'earlier-file-unlink') await fs.rm(first)
        if (mode === 'earlier-file-replace') { await fs.rename(first, path.join(t.root, 'retired.md')); await t.put('first.md', '# New') }
      }
      return handle
    })
    expect(await loadRegisteredSkillPackages(t.registry, 'project')).toEqual({ skills: [], truncated: true })
  })
  it.skipIf(process.platform !== 'win32')('keeps legacy folder IDs for manifest path spelling aliases on a case-insensitive filesystem', async () => {
    const t = await setup(); await t.put('Review/skill.md', '---\nname: one\n---\n# One')
    const legacy = (await loadRegisteredSkillPackages([{ ...t.registry[0], source: undefined }], 'project')).skills[0]
    for (const declared of ['Review', 'REVIEW', 'Review/skill.md', 'REVIEW/SKILL.md']) {
      await t.put('kohaku.yaml', JSON.stringify({ skills: [{ name: 'one', path: declared }] }))
      const result = await loadRegisteredSkillPackages(t.registry, 'project')
      expect(result.truncated).toBe(false); expect(result.skills[0].id).toBe(legacy.id)
    }
  })
  it.skipIf(process.platform !== 'win32')('keeps legacy root-own and flat IDs for canonical manifest aliases', async () => {
    for (const own of [true, false]) {
      const t = await setup(), file = own ? 'skill.md' : 'MixedCase.md'
      await t.put(file, '---\nname: one\n---\n# One')
      const legacy = (await loadRegisteredSkillPackages([{ ...t.registry[0], source: undefined }], 'project')).skills[0]
      for (const declared of [file, file.toLowerCase(), file.toUpperCase().replace(/\.MD$/, '.md')]) {
        await t.put('kohaku.yaml', JSON.stringify({ skills: [{ name: 'one', path: declared }] }))
        const result = await loadRegisteredSkillPackages(t.registry, 'project')
        expect(result.truncated).toBe(false); expect(result.skills[0].id).toBe(legacy.id)
      }
    }
  })
  it('bounds total bytes across all declarations and never publishes an over-budget partial manifest', async () => {
    const t = await setup(), skills = Array.from({ length: 40 }, (_, i) => ({ name: `item${i}`, path: `items/${i}.md` }))
    for (const item of skills) await t.put(item.path, '界'.repeat(16000))
    await t.put('kohaku.yaml', JSON.stringify({ skills }))
    expect(await loadRegisteredSkillPackages(t.registry, 'project')).toEqual({ skills: [], truncated: true })
  })
})
