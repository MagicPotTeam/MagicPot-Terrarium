import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
vi.mock('../config/config', () => ({ getConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: vi.fn() }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { getBuildEnv } from '../config/buildEnv'
import { loadUserProceduralCatalog } from './catalog'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-catalog-'))); roots.push(root)
  vi.mocked(getBuildEnv).mockReturnValue({ ...DEFAULT_BUILD_ENV, pathMap: { data: root, file: root, resources: '' } })
  const config = structuredClone(DEFAULT_CONFIG), directory = path.join(root, 'registered'); await fs.mkdir(directory)
  config.llm_config.proceduralSkillPackages = [{ id: 'package', directory, enabled: true, projectId: 'project' }]
  const json = async (id: string, name: string) => { await fs.mkdir(path.join(root, 'customSkills'), { recursive: true }); await fs.writeFile(path.join(root, 'customSkills', id + '.skill.json'), JSON.stringify({ id, skillName: name, type: 'normal', prompt: 'Existing JSON', procedural: { enabled: true } })) }
  return { config, root, directory, json }
}
describe('merged passive procedural skill catalog', () => {
  it('preserves opted-in JSON and exposes Markdown only for explicitly registered projects', async () => {
    const t = await setup(); await t.json('json', 'legacy-json'); await fs.writeFile(path.join(t.directory, 'read-first.md'), '# Markdown instructions')
    expect((await loadUserProceduralCatalog(t.config, 'project')).skills.map(item => item.name).sort()).toEqual(['legacy-json', 'read-first'])
    expect((await loadUserProceduralCatalog(t.config, 'foreign')).skills.map(item => item.name)).toEqual(['legacy-json'])
    t.config.llm_config.proceduralSkillPackages![0].enabled = false
    expect((await loadUserProceduralCatalog(t.config, 'project')).skills.map(item => item.name)).toEqual(['legacy-json'])
  })
  it('fails closed on colliding definitions instead of shadowing JSON with package content', async () => {
    const t = await setup(); await t.json('json', 'same-name'); await t.json('good', 'unique')
    await fs.writeFile(path.join(t.directory, 'collision.md'), '---\nname: same-name\n---\nPackage cannot override')
    expect(await loadUserProceduralCatalog(t.config, 'project')).toMatchObject({ truncated: true, skills: [{ name: 'unique' }] })
  })
})
