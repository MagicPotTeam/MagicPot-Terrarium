import fs from 'fs/promises'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV, type BuildEnv } from '@shared/config/buildEnv'
import {
  AUTOMATION_SCHEME_DEFINITION_DIR_NAME,
  AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX,
  type AutomationScheme
} from '@shared/automationScheme'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { AutomationSchemeFSCli } from './fs'

vi.mock(import('../config/buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn()
}))

const pathExists = async (targetPath: string): Promise<boolean> =>
  fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false)

const createBuildEnv = (tempRoot: string, dataDir: string): BuildEnv => ({
  ...DEFAULT_BUILD_ENV,
  pathMap: {
    resources: '',
    file: path.join(tempRoot, 'workspace'),
    data: dataDir
  }
})

const createScheme = (id: string, updatedAt = '2026-04-12T00:00:00.000Z'): AutomationScheme => ({
  id,
  name: id,
  description: 'desc',
  enabled: true,
  files: [],
  createdAt: updatedAt,
  updatedAt
})

describe('AutomationSchemeFSCli', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
    tempRoots.length = 0
  })

  it('writes schemes into the independent definition directory and suffix', async () => {
    const tempRoot = await createNodeTestArtifactDir('automation-scheme-save')
    tempRoots.push(tempRoot)

    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(dataDir, { recursive: true })

    const scheme = createScheme('automation-1')
    const cli = new AutomationSchemeFSCli(
      DEFAULT_CONFIG as Config,
      createBuildEnv(tempRoot, dataDir)
    )
    await cli.saveScheme(scheme)

    expect(
      await pathExists(
        path.join(
          dataDir,
          AUTOMATION_SCHEME_DEFINITION_DIR_NAME,
          `automation-1${AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX}`
        )
      )
    ).toBe(true)
    expect(
      await pathExists(path.join(dataDir, 'automationSchemes', 'automation-1.automation.json'))
    ).toBe(false)
  })

  it('does not import legacy .check.json files from customChecks', async () => {
    const tempRoot = await createNodeTestArtifactDir('automation-scheme-check-legacy')
    tempRoots.push(tempRoot)

    const legacyDir = path.join(tempRoot, 'workspace', 'customChecks')
    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })

    const scheme = createScheme('automation-check-legacy')
    const legacyFilePath = path.join(legacyDir, 'automation-check-legacy.check.json')
    await fs.writeFile(legacyFilePath, JSON.stringify(scheme), 'utf8')

    const cli = new AutomationSchemeFSCli(
      DEFAULT_CONFIG as Config,
      createBuildEnv(tempRoot, dataDir)
    )
    const result = await cli.listSchemes()

    expect(result).toEqual([])
    expect(
      await pathExists(
        path.join(
          dataDir,
          AUTOMATION_SCHEME_DEFINITION_DIR_NAME,
          `automation-check-legacy${AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX}`
        )
      )
    ).toBe(false)
    expect(await pathExists(legacyFilePath)).toBe(true)
  })

  it('does not import legacy .automation.json files from the old automationSchemes directory', async () => {
    const tempRoot = await createNodeTestArtifactDir('automation-scheme-automation-legacy')
    tempRoots.push(tempRoot)

    const legacyDir = path.join(tempRoot, 'userData', 'automationSchemes')
    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })

    const scheme = createScheme('automation-json-legacy')
    const legacyFilePath = path.join(legacyDir, 'automation-json-legacy.automation.json')
    await fs.writeFile(legacyFilePath, JSON.stringify(scheme), 'utf8')

    const cli = new AutomationSchemeFSCli(
      DEFAULT_CONFIG as Config,
      createBuildEnv(tempRoot, dataDir)
    )
    const result = await cli.listSchemes()

    expect(result).toEqual([])
    expect(
      await pathExists(
        path.join(
          dataDir,
          AUTOMATION_SCHEME_DEFINITION_DIR_NAME,
          `automation-json-legacy${AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX}`
        )
      )
    ).toBe(false)
    expect(await pathExists(legacyFilePath)).toBe(true)
  })

  it('lists only the independent definition directory when legacy files also exist', async () => {
    const tempRoot = await createNodeTestArtifactDir('automation-scheme-mixed-state')
    tempRoots.push(tempRoot)

    const legacyDir = path.join(tempRoot, 'workspace', 'customChecks')
    const dataDir = path.join(tempRoot, 'userData')
    const definitionDir = path.join(dataDir, AUTOMATION_SCHEME_DEFINITION_DIR_NAME)
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })
    await fs.mkdir(definitionDir, { recursive: true })

    const existingScheme = createScheme('automation-existing', '2026-04-13T00:00:00.000Z')
    const legacyScheme = createScheme('automation-legacy', '2026-04-12T00:00:00.000Z')

    await fs.writeFile(
      path.join(definitionDir, `automation-existing${AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX}`),
      JSON.stringify(existingScheme),
      'utf8'
    )
    await fs.writeFile(
      path.join(legacyDir, 'automation-legacy.check.json'),
      JSON.stringify(legacyScheme),
      'utf8'
    )

    const cli = new AutomationSchemeFSCli(
      DEFAULT_CONFIG as Config,
      createBuildEnv(tempRoot, dataDir)
    )
    const result = await cli.listSchemes()

    expect(result).toEqual([existingScheme])
    expect(
      await pathExists(
        path.join(definitionDir, `automation-legacy${AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX}`)
      )
    ).toBe(false)
  })
})
