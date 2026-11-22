import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type CustomSkill } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { CustomSkillFSCli } from './fs'
vi.mock(import('../config/buildEnv'), () => ({ getBuildEnv: vi.fn() }))
vi.mock(import('../config/config'), () => ({ getConfig: vi.fn() }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
const setup = async () => {
  const root = await createNodeTestArtifactDir('procedural-skill'); roots.push(root)
  const dir = path.join(root, 'data', 'customSkills')
  const cli = new CustomSkillFSCli(DEFAULT_CONFIG, { ...DEFAULT_BUILD_ENV, pathMap: { resources: '', file: path.join(root, 'legacy'), data: path.join(root, 'data') } })
  const save = async (name: string, patch: Partial<CustomSkill> = {}) => {
    const file = path.join(dir, name + '.skill.json'); await fs.mkdir(path.dirname(file), { recursive: true })
    const skill: CustomSkill = { id: path.basename(name), skillName: path.basename(name), category: '', type: 'normal', prompt: 'Read first. Test before editing.', procedural: { enabled: true, paths: ['*.ts'] }, ...patch }
    await fs.writeFile(file, JSON.stringify(skill), 'utf8'); return file
  }
  return { root, dir, cli, save }
}
describe('passive procedural skill filesystem discovery', () => {
  it('does not create or migrate a missing user directory, even with legacy files', async () => {
    const t = await setup(); const legacy = path.join(t.root, 'legacy', 'customSkills'); await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'legacy.skill.json'), JSON.stringify({ id: 'legacy', type: 'normal', prompt: 'do not copy', procedural: { enabled: true } }))
    expect(await t.cli.listProceduralSkills()).toEqual({ skills: [], truncated: false })
    await expect(fs.stat(t.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('loads opted-in normal instructions, preserves files and strips credentials/authority/attachments', async () => {
    const t = await setup()
    const file = await t.save('category/good', { instructions: { systemPrompt: 'Step one', userPrompt: 'Step two' }, apiKey: 'secret', apiAddress: 'https://do-not-fetch.invalid', scripts: ['run.py'], resources: ['secret.txt'], bindings: [{ appId: 'evil', toolNames: ['terminal.run'] }], referenceAttachments: [{ type: 'file', url: 'https://do-not-fetch.invalid/file' }] })
    const before = await fs.readFile(file, 'utf8')
    await t.save('disabled', { procedural: { enabled: false } }); await t.save('legacy', { procedural: undefined }); await t.save('agent', { type: 'agent' })
    const result = await t.cli.listProceduralSkills()
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({ id: 'good', instructions: 'Step one\n\nStep two', paths: ['*.ts'], baseDirectory: path.normalize(await fs.realpath(path.dirname(file))), digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(JSON.stringify(result)).not.toMatch(/secret|terminal.run|do-not-fetch|run.py/)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    await expect(fs.stat(path.join(t.dir, '_categories.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('fails closed for invalid, oversized and ambiguous definitions while keeping supported entries', async () => {
    const t = await setup(); await t.save('good'); await t.save('duplicate1', { id: 'dup' }); await t.save('duplicate2', { id: 'dup' })
    await t.save('bad-pattern', { procedural: { enabled: true, paths: ['../secret'] } }); await t.save('big', { prompt: 'a'.repeat(70000) })
    await fs.writeFile(path.join(t.dir, 'broken.skill.json'), '{bad', 'utf8')
    const result = await t.cli.listProceduralSkills(); expect(result.truncated).toBe(true); expect(result.skills.map((s) => s.id)).toEqual(['good'])
  })
  it('rejects hardlinked files and does not traverse a linked category', async () => {
    const t = await setup(), outside = path.join(t.root, 'outside'); await fs.mkdir(outside)
    await t.save('good'); const source = path.join(outside, 'external.skill.json')
    await fs.writeFile(source, JSON.stringify({ id: 'external', skillName: 'external', type: 'normal', prompt: 'external', procedural: { enabled: true } }))
    await fs.link(source, path.join(t.dir, 'hardlink.skill.json'))
    await fs.symlink(outside, path.join(t.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await t.cli.listProceduralSkills()).skills.map((s) => s.id)).toEqual(['good'])
  })
  it('caps candidate count and aggregate bytes and checks cancellation', async () => {
    const t = await setup()
    for (let i = 0; i < 101; i++) await t.save(`s${i}`)
    const result = await t.cli.listProceduralSkills(); expect(result.truncated).toBe(true); expect(result.skills.length).toBeLessThanOrEqual(100)
    const controller = new AbortController(); controller.abort(); await expect(t.cli.listProceduralSkills(controller.signal)).rejects.toThrow()
  })
  it('preserves procedural opt-in across the existing normalize/save/reload path', async () => {
    const t = await setup(); await t.save('saved'); const [skill] = (await t.cli.listSkills()).skills
    await t.cli.saveSkill(skill); expect((await t.cli.listProceduralSkills()).skills).toHaveLength(1)
  })
})
