import { beforeEach, describe, expect, it } from 'vitest'
import { vol } from 'memfs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'path'

import { MagicAgentPackageStore } from './store'
import { validateMagicAgentPackageManifest } from './manifest'
import {
  MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION,
  MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS,
  MAGIC_AGENT_PACKAGE_MANIFEST_FILE
} from '@shared/magicAgentRuntime/packageContracts'

const ROOT = '/magic-agent-packages'
const STORE = '/magic-agent-store'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo.package',
    name: 'Demo Package',
    version: '1.0.0',
    description: 'A package that must never be executed by the store.',
    contributions: [
      {
        id: 'demo-tool',
        kind: 'tool',
        title: 'Demo Tool',
        entry: 'contributions/demo.json'
      }
    ],
    ...overrides
  }
}

async function writePackage(
  packageDir: string,
  manifestOverrides: Record<string, unknown> = {}
): Promise<void> {
  await fsp.mkdir(path.join(packageDir, 'contributions'), { recursive: true })
  await fsp.writeFile(
    path.join(packageDir, MAGIC_AGENT_PACKAGE_MANIFEST_FILE),
    JSON.stringify(manifest(manifestOverrides), null, 2)
  )
  await fsp.writeFile(
    path.join(packageDir, 'contributions', 'demo.json'),
    JSON.stringify({ command: 'metadata only' }, null, 2)
  )
  await fsp.writeFile(
    path.join(packageDir, 'do-not-run.js'),
    'globalThis.__magicPackageExecuted = true'
  )
}

describe('MagicAgentPackageStore', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('validates manifest shape without normalizing invalid packages into success', () => {
    const result = validateMagicAgentPackageManifest({
      manifestVersion: 1,
      id: '../bad',
      name: '',
      version: 'latest'
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['id', 'name', 'version'])
      )
    }
  })

  it('strictly rejects unknown fields, null or non-string optional text, and unsafe package ids', () => {
    const result = validateMagicAgentPackageManifest({
      manifestVersion: 1,
      id: 'demo..package',
      name: 'Demo Package',
      version: '1.0.0',
      description: 123,
      author: null,
      homepage: null,
      unexpected: true,
      keywords: ['valid', 42],
      contributions: [
        {
          id: 'demo-tool',
          kind: 'tool',
          title: ['not a title'],
          description: null,
          entry: null,
          extra: true
        }
      ]
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          'id',
          'description',
          'author',
          'homepage',
          'unexpected',
          'keywords.1',
          'contributions.0.title',
          'contributions.0.description',
          'contributions.0.entry',
          'contributions.0.extra'
        ])
      )
    }
  })

  it('accepts only known contribution kinds and requires agent JSON entries', () => {
    const accepted = validateMagicAgentPackageManifest({
      ...manifest({ contributions: undefined }),
      contributions: MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS.map((kind) => ({
        id: `demo-${kind}`,
        kind,
        ...(kind === 'agent' ? { entry: 'agent.json' } : {})
      }))
    })
    expect(accepted.ok).toBe(true)

    const unknownKind = validateMagicAgentPackageManifest(
      manifest({ contributions: [{ id: 'demo-workflow', kind: 'workflow' }] })
    )
    expect(unknownKind.ok).toBe(false)
    if (!unknownKind.ok) {
      expect(unknownKind.errors.map((issue) => issue.path)).toContain('contributions.0.kind')
    }

    const agentWithoutEntry = validateMagicAgentPackageManifest(
      manifest({ contributions: [{ id: 'demo-agent', kind: 'agent' }] })
    )
    expect(agentWithoutEntry.ok).toBe(false)
    if (!agentWithoutEntry.ok) {
      expect(agentWithoutEntry.errors.map((issue) => issue.path)).toContain('contributions.0.entry')
    }

    const agentWithExecutableEntry = validateMagicAgentPackageManifest(
      manifest({ contributions: [{ id: 'demo-agent', kind: 'agent', entry: 'agent.js' }] })
    )
    expect(agentWithExecutableEntry.ok).toBe(false)
    if (!agentWithExecutableEntry.ok) {
      expect(agentWithExecutableEntry.errors.map((issue) => issue.path)).toContain(
        'contributions.0.entry'
      )
    }

    const duplicateContributionId = validateMagicAgentPackageManifest(
      manifest({
        contributions: [
          { id: 'duplicate-agent', kind: 'agent', entry: 'agents/one.json' },
          { id: 'duplicate-agent', kind: 'agent', entry: 'agents/two.json' }
        ]
      })
    )
    expect(duplicateContributionId.ok).toBe(false)
    if (!duplicateContributionId.ok) {
      expect(duplicateContributionId.errors.map((issue) => issue.path)).toContain(
        'contributions.1.id'
      )
    }
  })

  it('scans a local directory and reports missing contribution entries', async () => {
    const packageDir = path.join(ROOT, 'bad-entry')
    await writePackage(packageDir, {
      contributions: [{ id: 'missing-entry', kind: 'tool', entry: 'missing.json' }]
    })

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)

    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors[0].path).toBe('contributions.0.entry')
    }
  })

  it('rejects contribution entries that escape the package root', async () => {
    const packageDir = path.join(ROOT, 'escape-entry')
    await writePackage(packageDir, {
      contributions: [{ id: 'escape-entry', kind: 'tool', entry: '../outside.json' }]
    })

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)

    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'contributions.0.entry',
            message: expect.stringMatching(/relative package path|unsafe contribution entry path/)
          })
        ])
      )
    }
  })

  it('rejects top-level package directory symlinks before scanning outside the approved root', async () => {
    const outsideDir = '/outside-package-source'
    await writePackage(outsideDir)
    await fsp.mkdir(ROOT, { recursive: true })
    const packageLink = path.join(ROOT, 'linked-package')
    await fsp.symlink(outsideDir, packageLink)

    const store = new MagicAgentPackageStore(ROOT, STORE)

    await expect(store.scanLocalDirectory(packageLink)).rejects.toThrow(
      /must not be a symbolic link/
    )
    await expect(store.install(packageLink)).rejects.toThrow(/must not be a symbolic link/)
  })

  it('rejects symbolic links during install and cleans up staged package data without leaking local paths', async () => {
    const packageDir = path.join(ROOT, 'symlink')
    await writePackage(packageDir)
    await fsp.symlink('/outside/secret.txt', path.join(packageDir, 'secret-link'))

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)
    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors[0].message).toBe(
        'Package contains unsupported symbolic link.'
      )
      expect(inspection.validation.errors[0].message).not.toContain(packageDir)
    }

    await expect(store.install(packageDir)).rejects.toThrow(/unsupported symbolic link/)
    expect(fs.existsSync(path.join(STORE, 'demo.package'))).toBe(false)
    expect(
      fs.existsSync(STORE)
        ? fs.readdirSync(STORE).filter((entry) => entry.startsWith('.install-'))
        : []
    ).toEqual([])
  })

  it('reports missing package directories without leaking local paths', async () => {
    const packageDir = path.join(ROOT, 'missing-package')
    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)

    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors[0].message).toBe(
        'Unable to inspect package directory resources.'
      )
      expect(inspection.validation.errors[0].message).not.toContain(packageDir)
    }
    await expect(store.install(packageDir)).rejects.not.toThrow(packageDir)
  })

  it('reports unreadable or invalid manifests without leaking manifest paths', async () => {
    const packageDir = path.join(ROOT, 'invalid-json')
    await fsp.mkdir(packageDir, { recursive: true })
    await fsp.writeFile(path.join(packageDir, MAGIC_AGENT_PACKAGE_MANIFEST_FILE), '{')

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)

    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors[0].message).toBe(
        'Unable to read or parse package manifest.'
      )
      expect(inspection.validation.errors[0].message).not.toContain(packageDir)
    }
  })

  it('rejects packages that exceed resource limits before install copy', async () => {
    const tooManyFilesDir = path.join(ROOT, 'too-many-files')
    await writePackage(tooManyFilesDir)
    for (let index = 0; index < 2001; index += 1) {
      await fsp.writeFile(path.join(tooManyFilesDir, `extra-${index}.txt`), 'x')
    }

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const tooManyFilesInspection = await store.scanLocalDirectory(tooManyFilesDir)
    expect(tooManyFilesInspection.validation.ok).toBe(false)
    if (!tooManyFilesInspection.validation.ok) {
      expect(tooManyFilesInspection.validation.errors[0].message).toMatch(/maximum file count/)
    }
    await expect(store.install(tooManyFilesDir)).rejects.toThrow(
      /Invalid MagicPot package manifest|maximum file count/
    )

    let deepDir = path.join(ROOT, 'too-deep')
    await fsp.mkdir(deepDir, { recursive: true })
    await fsp.writeFile(
      path.join(deepDir, MAGIC_AGENT_PACKAGE_MANIFEST_FILE),
      JSON.stringify(manifest({ contributions: undefined }), null, 2)
    )
    for (let depth = 0; depth < 14; depth += 1) {
      deepDir = path.join(deepDir, `d${depth}`)
      await fsp.mkdir(deepDir, { recursive: true })
    }
    await fsp.writeFile(path.join(deepDir, 'leaf.txt'), 'x')

    const tooDeepInspection = await store.scanLocalDirectory(path.join(ROOT, 'too-deep'))
    expect(tooDeepInspection.validation.ok).toBe(false)
    if (!tooDeepInspection.validation.ok) {
      expect(tooDeepInspection.validation.errors[0].message).toMatch(/maximum directory depth/)
    }
  })

  it('installs, lists, inspects, replaces, and uninstalls from caller-provided directories', async () => {
    const packageDir = path.join(ROOT, 'demo')
    await writePackage(packageDir)

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const firstInstall = await store.install(packageDir)

    expect(firstInstall.replaced).toBe(false)
    expect(firstInstall.installed.id).toBe('demo.package')
    expect(fs.existsSync(path.join(STORE, 'demo.package', 'package', 'do-not-run.js'))).toBe(true)
    expect((globalThis as Record<string, unknown>).__magicPackageExecuted).toBeUndefined()

    await fsp.writeFile(
      path.join(packageDir, MAGIC_AGENT_PACKAGE_MANIFEST_FILE),
      JSON.stringify(manifest({ version: '1.1.0' }), null, 2)
    )

    const secondInstall = await store.install(packageDir)
    expect(secondInstall.replaced).toBe(true)
    expect(secondInstall.installed.version).toBe('1.1.0')

    const listed = await store.list()
    expect(listed.map((entry) => `${entry.id}@${entry.version}`)).toEqual(['demo.package@1.1.0'])

    const installedInspection = await store.inspect('demo.package')
    expect(installedInspection.validation.ok).toBe(true)
    expect(installedInspection.installed?.packagePath).toBe(path.resolve(STORE, 'demo.package'))

    await expect(store.inspect('/does-not-exist')).resolves.toMatchObject({
      validation: { ok: false }
    })

    const cwdRelativePackage = 'cwd-relative-package'
    await writePackage(cwdRelativePackage, { id: 'cwd.relative.package' })
    const unknownBareInspection = await store.inspect(cwdRelativePackage)
    expect(unknownBareInspection.validation.ok).toBe(false)
    if (!unknownBareInspection.validation.ok) {
      expect(unknownBareInspection.validation.errors[0].message).toMatch(/not installed/)
    }
    expect(unknownBareInspection.packagePath).toBe('')

    await expect(store.uninstall('demo.package')).resolves.toBe(true)
    await expect(store.uninstall('demo.package')).resolves.toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('loads installed package agents from data-only JSON specs without executing package code', async () => {
    const packageDir = path.join(ROOT, 'agent-package')
    await writePackage(packageDir, {
      contributions: [
        {
          id: 'assistant',
          kind: 'agent',
          title: 'Package Assistant',
          entry: 'agents/assistant.json'
        }
      ]
    })
    await fsp.mkdir(path.join(packageDir, 'agents'), { recursive: true })
    await fsp.writeFile(
      path.join(packageDir, 'agents', 'assistant.json'),
      JSON.stringify(
        {
          schemaVersion: MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION,
          name: 'Installed Assistant',
          description: 'Loaded from a package JSON file.',
          systemPrompt: 'Use only package metadata.',
          toolNames: ['session.status', 'artifact.create'],
          maxToolIterations: 2,
          profileId: 'package-profile'
        },
        null,
        2
      )
    )

    const store = new MagicAgentPackageStore(ROOT, STORE)
    await store.install(packageDir)

    const agents = await store.listAgents()
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: 'package.demo.package.assistant',
      name: 'Installed Assistant',
      sourcePackageId: 'demo.package',
      contributionId: 'assistant',
      toolNames: ['session.status', 'artifact.create'],
      maxToolIterations: 2,
      profileId: 'package-profile'
    })
    expect((globalThis as Record<string, unknown>).__magicPackageExecuted).toBeUndefined()
  })

  it('fails closed when a package agent spec is invalid', async () => {
    const packageDir = path.join(ROOT, 'bad-agent-package')
    await writePackage(packageDir, {
      contributions: [{ id: 'bad-agent', kind: 'agent', entry: 'agents/bad.json' }]
    })
    await fsp.mkdir(path.join(packageDir, 'agents'), { recursive: true })
    await fsp.writeFile(path.join(packageDir, 'agents', 'bad.json'), JSON.stringify({ name: '' }))

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)
    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'contributions.0.entry',
            message: expect.stringMatching(/Invalid agent contribution spec/)
          })
        ])
      )
    }
    await expect(store.install(packageDir)).rejects.toThrow(/Invalid agent contribution spec/)
  })
})
