import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vol } from 'memfs'
import fs from 'node:fs'
import path from 'path'

import * as configMod from '../config/config'
import * as buildEnvMod from '../config/buildEnv'

import type { Config } from '@shared/config/config'
import type { BuildEnv } from '@shared/config/buildEnv'
import type { QAppMenuItem } from '@shared/api/svcQApp'
import type { QAppCfg } from '@shared/qApp/cfgTypes'
import type { Workflow } from '@shared/comfy/types'

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn()
}))

vi.mock(import('../config/buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

import { QAppFSCli } from './fs'

const FILE_DIR = '/file'
const DATA_DIR = '/data'
const BUILTIN_QAPPS_DIR = path.join(FILE_DIR, 'packages', 'qapps')
const USER_QAPPS_DIR = path.join(DATA_DIR, 'qApps')

function minimalWorkflow(): Workflow {
  return {
    node1: { class_type: 'TestNode', inputs: {} }
  }
}

function minimalQAppCfg(): QAppCfg {
  return {
    icon: 'icon.png',
    inputs: []
  }
}

function legacyManifest(source: string = 'local'): string {
  return JSON.stringify(
    {
      name: 'LegacyApp',
      version: '1.0.0',
      source
    },
    null,
    2
  )
}

function mockConfigAndEnv(): void {
  vi.mocked(configMod.getConfig).mockReturnValue({} as unknown as Config)

  vi.mocked(buildEnvMod.getBuildEnv).mockReturnValue({
    env: {
      build: 'development',
      platform: 'unknown',
      buildMode: 'pure',
      packageVersion: 'test'
    },
    pathMap: {
      data: DATA_DIR,
      file: FILE_DIR,
      resources: DATA_DIR
    },
    embeddedDefaults: {
      pythonCmd: '',
      comfyuiDir: '',
      comfyuiArgs: []
    }
  } as unknown as BuildEnv)
}

async function writeBundle(
  baseDir: string,
  key: string,
  cfg: QAppCfg = minimalQAppCfg(),
  workflow: Workflow = minimalWorkflow(),
  manifest?: string
): Promise<void> {
  const fsp = await import('node:fs/promises')
  await fsp.mkdir(path.dirname(path.join(baseDir, `${key}.qacfg.json`)), { recursive: true })
  await fsp.writeFile(path.join(baseDir, `${key}.qacfg.json`), JSON.stringify(cfg, null, 2))
  await fsp.writeFile(path.join(baseDir, `${key}.prompt.json`), JSON.stringify(workflow, null, 2))
  if (manifest) {
    await fsp.writeFile(path.join(baseDir, `${key}.manifest.json`), manifest)
  }
}

function findItemByKey(items: QAppMenuItem[], key: string): QAppMenuItem | undefined {
  for (const item of items) {
    if (item.key === key) {
      return item
    }
    const nested = item.children ? findItemByKey(item.children, key) : undefined
    if (nested) {
      return nested
    }
  }
  return undefined
}

describe('QAppFSCli with memfs', () => {
  beforeEach(() => {
    vol.reset()
    mockConfigAndEnv()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('listQAppKeys', () => {
    it('returns an empty list when both sources are empty', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const cli = new QAppFSCli()
      await expect(cli.listQAppKeys()).resolves.toEqual([])
    })

    it('scans nested user qApps and only includes complete pairs', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(path.join(USER_QAPPS_DIR, 'A/B'), { recursive: true })
      await fsp.writeFile(path.join(USER_QAPPS_DIR, 'A/B', 'X.prompt.json'), JSON.stringify({}))
      await fsp.writeFile(
        path.join(USER_QAPPS_DIR, 'A/B', 'X.qacfg.json'),
        JSON.stringify({ icon: 'i', inputs: [] })
      )
      await fsp.writeFile(path.join(USER_QAPPS_DIR, 'A', 'Y.prompt.json'), JSON.stringify({}))

      const cli = new QAppFSCli()
      const items = await cli.listQAppKeys()

      const aDir = items.find((n) => n.name === 'A' && n.isDirectory)
      expect(aDir).toBeDefined()
      const bDir = aDir!.children!.find((n) => n.name === 'B' && n.isDirectory)
      expect(bDir).toBeDefined()
      const xItem = bDir!.children!.find((n) => n.name === 'X' && !n.isDirectory)
      expect(xItem).toBeDefined()
      expect(aDir!.children!.find((n) => n.name === 'Y')).toBeUndefined()
    })

    it('prefers userData overrides over bundled qApps', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      await writeBundle(
        BUILTIN_QAPPS_DIR,
        'Shared/App',
        { icon: 'builtin.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'SharedApp', version: '1.0.0', source: 'builtin' }, null, 2)
      )
      await writeBundle(
        USER_QAPPS_DIR,
        'Shared/App',
        { icon: 'user.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'SharedApp', version: '1.0.0', source: 'local' }, null, 2)
      )

      const cli = new QAppFSCli()
      const items = await cli.listQAppKeys()
      const shared = findItemByKey(items, 'Shared/App')
      expect(shared?.isBuiltin).toBe(false)
      expect(shared?.icon).toBe('user.png')
    })

    it('merges userData overrides into bundled folders without hiding bundled siblings', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      await writeBundle(
        BUILTIN_QAPPS_DIR,
        'Shared/App',
        { icon: 'builtin-app.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'App', version: '1.0.0', source: 'builtin' }, null, 2)
      )
      await writeBundle(
        BUILTIN_QAPPS_DIR,
        'Shared/Other',
        { icon: 'builtin-other.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'Other', version: '1.0.0', source: 'builtin' }, null, 2)
      )
      await writeBundle(
        USER_QAPPS_DIR,
        'Shared/App',
        { icon: 'user-app.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'App', version: '1.0.0', source: 'local' }, null, 2)
      )

      const cli = new QAppFSCli()
      const items = await cli.listQAppKeys()
      const sharedDir = findItemByKey(items, 'Shared')
      const app = findItemByKey(items, 'Shared/App')
      const other = findItemByKey(items, 'Shared/Other')

      expect(sharedDir?.isDirectory).toBe(true)
      expect(sharedDir?.children).toHaveLength(2)
      expect(app?.isBuiltin).toBe(false)
      expect(app?.icon).toBe('user-app.png')
      expect(other?.isBuiltin).toBe(true)
      expect(other?.icon).toBe('builtin-other.png')
    })

    it('migrates legacy root qApps with non-builtin manifests into userData', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      await writeBundle(
        BUILTIN_QAPPS_DIR,
        'Legacy/MoveMe',
        { icon: 'legacy.png', inputs: [] },
        minimalWorkflow(),
        legacyManifest('local')
      )

      const cli = new QAppFSCli()
      const items = await cli.listQAppKeys()
      const legacy = findItemByKey(items, 'Legacy/MoveMe')

      expect(legacy).toBeDefined()
      expect(legacy?.isBuiltin).toBe(false)
      expect(fs.existsSync(path.join(USER_QAPPS_DIR, 'Legacy/MoveMe.qacfg.json'))).toBe(true)
      expect(fs.existsSync(path.join(USER_QAPPS_DIR, 'Legacy/MoveMe.prompt.json'))).toBe(true)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, 'Legacy/MoveMe.qacfg.json'))).toBe(false)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, 'Legacy/MoveMe.prompt.json'))).toBe(false)
    })

    it('reads bundled qApps as read-only sources', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      await writeBundle(
        BUILTIN_QAPPS_DIR,
        'Builtin/ReadOnly',
        { icon: 'builtin.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'Builtin', version: '1.0.0', source: 'builtin' }, null, 2)
      )

      const cli = new QAppFSCli()
      const items = await cli.listQAppKeys()
      const builtin = findItemByKey(items, 'Builtin/ReadOnly')
      expect(builtin?.isBuiltin).toBe(true)
    })

    it('prefers explicit manifest categories over heuristic workflow signals', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      await writeBundle(
        BUILTIN_QAPPS_DIR,
        '高清放大/柔和_SeedVR2',
        {
          icon: 'seedvr.png',
          inputs: []
        },
        {
          '108': {
            class_type: 'SaveVideo',
            inputs: {
              filename_prefix: 'seedvr'
            }
          }
        },
        JSON.stringify(
          {
            name: '柔和_SeedVR2',
            version: '1.0.0',
            source: 'builtin',
            category: 'image'
          },
          null,
          2
        )
      )

      const cli = new QAppFSCli()
      const items = await cli.listQAppKeys()
      const qapp = findItemByKey(items, '高清放大/柔和_SeedVR2')

      expect(qapp?.isBuiltin).toBe(true)
      expect(qapp?.category).toBe('image')
    })
  })

  describe('getQApp', () => {
    it('reads user qApps from userData', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const key = 'foo/bar'
      await writeBundle(
        USER_QAPPS_DIR,
        key,
        minimalQAppCfg(),
        minimalWorkflow(),
        JSON.stringify({ name: 'bar', version: '1.0.0', source: 'local' }, null, 2)
      )

      const cli = new QAppFSCli()
      const readBundle = await cli.getQApp(key)
      expect(readBundle.cfg.icon).toBe('icon.png')
      expect(Object.keys(readBundle.workflow)).toContain('node1')
      expect(readBundle.manifest.name).toBe('bar')
    })

    it('prefers userData overrides over bundled qApps', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const key = 'dup/app'
      await writeBundle(
        BUILTIN_QAPPS_DIR,
        key,
        { icon: 'builtin.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'dup', version: '1.0.0', source: 'builtin' }, null, 2)
      )
      await writeBundle(
        USER_QAPPS_DIR,
        key,
        { icon: 'user.png', inputs: [] },
        minimalWorkflow(),
        JSON.stringify({ name: 'dup', version: '1.0.0', source: 'local' }, null, 2)
      )

      const cli = new QAppFSCli()
      const readBundle = await cli.getQApp(key)
      expect(readBundle.cfg.icon).toBe('user.png')
    })

    it('throws when the workflow is invalid', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const key = 'inv/not-valid'
      await fsp.mkdir(path.join(USER_QAPPS_DIR, 'inv'), { recursive: true })
      await fsp.writeFile(
        path.join(USER_QAPPS_DIR, `${key}.qacfg.json`),
        JSON.stringify(minimalQAppCfg())
      )
      await fsp.writeFile(path.join(USER_QAPPS_DIR, `${key}.prompt.json`), JSON.stringify(1))

      const cli = new QAppFSCli()
      await expect(cli.getQApp(key)).rejects.toThrow('is not a valid workflow')
    })
  })

  describe('saveQApp', () => {
    it('writes only to userData', async () => {
      const cli = new QAppFSCli()
      const key = 'nested/child/app'
      const wf = minimalWorkflow()
      const cfg = minimalQAppCfg()

      await cli.saveQApp(key, cfg, wf, {
        category: 'video'
      })

      expect(fs.existsSync(path.join(USER_QAPPS_DIR, `${key}.qacfg.json`))).toBe(true)
      expect(fs.existsSync(path.join(USER_QAPPS_DIR, `${key}.prompt.json`))).toBe(true)
      expect(fs.existsSync(path.join(USER_QAPPS_DIR, `${key}.manifest.json`))).toBe(true)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, `${key}.qacfg.json`))).toBe(false)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, `${key}.prompt.json`))).toBe(false)
      const manifest = JSON.parse(
        fs.readFileSync(path.join(USER_QAPPS_DIR, `${key}.manifest.json`), 'utf8')
      ) as { category?: string; source?: string }
      expect(manifest.category).toBe('video')
      expect(manifest.source).toBe('local')
    })
  })

  describe('deleteQApp', () => {
    it('deletes userData bundles without touching bundled qApps', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const key = 'pairapp'
      await writeBundle(
        USER_QAPPS_DIR,
        key,
        minimalQAppCfg(),
        minimalWorkflow(),
        JSON.stringify({ name: 'pairapp', version: '1.0.0', source: 'local' }, null, 2)
      )

      const cli = new QAppFSCli()
      await cli.deleteQApp(key)

      expect(fs.existsSync(path.join(USER_QAPPS_DIR, `${key}.qacfg.json`))).toBe(false)
      expect(fs.existsSync(path.join(USER_QAPPS_DIR, `${key}.prompt.json`))).toBe(false)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, `${key}.qacfg.json`))).toBe(false)
    })

    it('deletes bundled-only qApps from the bundled qApp directory', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const key = 'builtin-only/app'
      await writeBundle(
        BUILTIN_QAPPS_DIR,
        key,
        minimalQAppCfg(),
        minimalWorkflow(),
        JSON.stringify({ name: 'builtin-only', version: '1.0.0', source: 'builtin' }, null, 2)
      )

      const cli = new QAppFSCli()
      await cli.deleteQApp(key)

      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, `${key}.qacfg.json`))).toBe(false)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, `${key}.prompt.json`))).toBe(false)
      expect(fs.existsSync(path.join(BUILTIN_QAPPS_DIR, `${key}.manifest.json`))).toBe(false)
    })

    it('rejects deleting missing qApps', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const cli = new QAppFSCli()
      await expect(cli.deleteQApp('missing/app')).rejects.toThrow('not found')
    })
  })

  describe('renameQApp', () => {
    it.each([
      { key: 'folder', name: 'folder2' },
      { key: path.join('a', 'b'), name: 'b2' }
    ])('renames userData directories: $key -> $name', async ({ key, name }) => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const cli = new QAppFSCli()
      const oldDir = path.join(USER_QAPPS_DIR, key)
      await fsp.mkdir(oldDir, { recursive: true })
      await fsp.writeFile(path.join(oldDir, 'child.txt'), 'x')

      await cli.renameQApp(key, name)

      const newDir = path.join(USER_QAPPS_DIR, key.replace(path.basename(key), name))
      expect(fs.existsSync(newDir)).toBe(true)
      expect(fs.existsSync(path.join(newDir, 'child.txt'))).toBe(true)
      expect(fs.existsSync(oldDir)).toBe(false)
    })

    it.each([
      { key: 'App1', name: 'App2' },
      { key: path.join('folder', 'App1'), name: 'AppNew' }
    ])('renames userData bundles: $key -> $name', async ({ key, name }) => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const cli = new QAppFSCli()
      await writeBundle(USER_QAPPS_DIR, key, minimalQAppCfg(), minimalWorkflow())

      await cli.renameQApp(key, name)

      const baseOld = path.join(USER_QAPPS_DIR, key)
      const baseNew = path.join(USER_QAPPS_DIR, key.replace(path.basename(key), name))
      expect(fs.existsSync(`${baseOld}.qacfg.json`)).toBe(false)
      expect(fs.existsSync(`${baseOld}.prompt.json`)).toBe(false)
      expect(fs.existsSync(`${baseNew}.qacfg.json`)).toBe(true)
      expect(fs.existsSync(`${baseNew}.prompt.json`)).toBe(true)
    })

    it('rejects renaming bundled-only qApps', async () => {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(BUILTIN_QAPPS_DIR, { recursive: true })
      await fsp.mkdir(USER_QAPPS_DIR, { recursive: true })

      const key = 'builtin-only/App1'
      await writeBundle(
        BUILTIN_QAPPS_DIR,
        key,
        minimalQAppCfg(),
        minimalWorkflow(),
        JSON.stringify({ name: 'builtin-only', version: '1.0.0', source: 'builtin' }, null, 2)
      )

      const cli = new QAppFSCli()
      await expect(cli.renameQApp(key, 'App2')).rejects.toThrow('read-only')
    })
  })
})
