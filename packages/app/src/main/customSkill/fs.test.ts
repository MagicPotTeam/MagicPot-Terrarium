import fs from 'fs/promises'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import { DEFAULT_BUILD_ENV, type BuildEnv } from '@shared/config/buildEnv'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { CustomSkillFSCli } from './fs'

vi.mock(import('../config/buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn()
}))

describe('CustomSkillFSCli', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
    tempRoots.length = 0
  })

  it('migrates legacy skill files from file root into userData and normalizes skill prompts', async () => {
    const tempRoot = await createNodeTestArtifactDir('custom-skill')
    tempRoots.push(tempRoot)

    const legacyDir = path.join(tempRoot, 'workspace', 'customSkills')
    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })

    const skill: CustomSkill = {
      id: 'skill-1',
      category: 'tagging',
      skillName: 'Tagging Assistant',
      prompt: 'prompt',
      type: 'normal',
      apiKey: 'secret'
    }

    await fs.writeFile(
      path.join(legacyDir, 'tagging-assistant.skill.json'),
      JSON.stringify(skill),
      'utf8'
    )

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const cli = new CustomSkillFSCli(DEFAULT_CONFIG as Config, buildEnv)
    const result = await cli.listSkills()

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      ...skill,
      instructions: {
        systemPrompt: skill.prompt,
        userPrompt: undefined
      }
    })
    expect(
      await fs
        .access(path.join(dataDir, 'customSkills', 'tagging-assistant.skill.json'))
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('preserves structured runtime skill fields on save and reload', async () => {
    const tempRoot = await createNodeTestArtifactDir('custom-skill-structured')
    tempRoots.push(tempRoot)

    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const cli = new CustomSkillFSCli(DEFAULT_CONFIG as Config, buildEnv)
    const skill: CustomSkill = {
      id: 'skill-2',
      category: 'platform',
      skillName: 'Structured Runner',
      prompt: 'legacy prompt',
      type: 'agent',
      description: 'structured skill definition',
      instructions: {
        systemPrompt: 'structured system prompt',
        userPrompt: 'structured user prompt'
      },
      execution: {
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'sidecar'
      },
      fallback: {
        strategy: 'single-file',
        message: 'fallback to single file'
      },
      resources: ['resource://skill/docs'],
      scripts: ['pre-run.ts', 'post-run.ts'],
      bindings: [
        {
          appId: 'app-1',
          toolNames: ['tool-a'],
          resourceUris: ['resource://skill/docs']
        }
      ],
      outputSchema: {
        type: 'object',
        properties: {
          result: { type: 'string' }
        }
      }
    }

    await cli.saveSkill(skill)
    const result = await cli.listSkills()

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      ...skill,
      execution: {
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'sidecar',
        fallbackStrategy: 'single-file'
      },
      fallback: {
        strategy: 'single-file',
        message: 'fallback to single file'
      }
    })
    expect(result.skills[0].instructions).toEqual(skill.instructions)
    expect(result.skills[0].outputSchema).toEqual(skill.outputSchema)
  })
})
