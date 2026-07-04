import { beforeEach, describe, expect, it } from 'vitest'
import { vol } from 'memfs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'path'

import { MagicAgentPackageStore } from './store'
import { validateMagicAgentPackageManifest } from './manifest'
import {
  MAGIC_AGENT_PACKAGE_AGENT_MAX_TOOL_ITERATIONS,
  MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION,
  MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_COUNT,
  MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS,
  MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS,
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
          kind: 'agent',
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

  it('accepts only data-only contribution kinds and rejects executable package contributions', () => {
    const accepted = validateMagicAgentPackageManifest({
      ...manifest({ contributions: undefined }),
      contributions: [
        { id: 'demo-agent', kind: 'agent', entry: 'agent.json' },
        { id: 'demo-graph', kind: 'graph', entry: 'graph.json' }
      ]
    })
    expect(accepted.ok).toBe(true)

    for (const kind of MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS) {
      const executableContribution = validateMagicAgentPackageManifest(
        manifest({ contributions: [{ id: `demo-${kind}`, kind, entry: `${kind}.json` }] })
      )
      expect(executableContribution.ok).toBe(false)
      if (!executableContribution.ok) {
        expect(executableContribution.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'contributions.0.kind',
              message: expect.stringMatching(/Executable contribution kind/)
            })
          ])
        )
      }
    }
    expect(MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS).toEqual(
      expect.arrayContaining([
        'agent',
        'graph',
        ...MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS
      ])
    )

    const unknownKind = validateMagicAgentPackageManifest(
      manifest({ contributions: [{ id: 'demo-workflow', kind: 'workflow' }] })
    )
    expect(unknownKind.ok).toBe(false)
    if (!unknownKind.ok) {
      expect(unknownKind.errors.map((issue) => issue.path)).toContain('contributions.0.kind')
    }

    for (const kind of ['agent', 'graph'] as const) {
      const contributionWithoutEntry = validateMagicAgentPackageManifest(
        manifest({ contributions: [{ id: `demo-${kind}`, kind }] })
      )
      expect(contributionWithoutEntry.ok).toBe(false)
      if (!contributionWithoutEntry.ok) {
        expect(contributionWithoutEntry.errors.map((issue) => issue.path)).toContain(
          'contributions.0.entry'
        )
      }

      const contributionWithExecutableEntry = validateMagicAgentPackageManifest(
        manifest({ contributions: [{ id: `demo-${kind}`, kind, entry: `${kind}.js` }] })
      )
      expect(contributionWithExecutableEntry.ok).toBe(false)
      if (!contributionWithExecutableEntry.ok) {
        expect(contributionWithExecutableEntry.errors.map((issue) => issue.path)).toContain(
          'contributions.0.entry'
        )
      }
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
      contributions: [{ id: 'missing-entry', kind: 'agent', entry: 'missing.json' }]
    })

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)

    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors[0].path).toBe('contributions.0.entry')
    }
  })

  it('rejects absolute, Windows, UNC, backslash traversal, and parent contribution entries', () => {
    for (const entry of [
      '/tmp/outside.json',
      'C:/Users/Jane/outside.json',
      'C:\\Users\\Jane\\outside.json',
      '\\\\server\\share\\outside.json',
      'agents\\..\\outside.json',
      '../outside.json'
    ]) {
      const result = validateMagicAgentPackageManifest(
        manifest({ contributions: [{ id: 'unsafe-entry', kind: 'agent', entry }] })
      )
      expect(result.ok, `entry=${entry}`).toBe(false)
      if (!result.ok) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'contributions.0.entry',
              message: expect.stringMatching(/relative package path/)
            })
          ])
        )
      }
    }
  })

  it('rejects contribution entries that escape the package root', async () => {
    const packageDir = path.join(ROOT, 'escape-entry')
    await writePackage(packageDir, {
      contributions: [{ id: 'escape-entry', kind: 'agent', entry: '../outside.json' }]
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

  it('rejects executable package contributions during scan and before staging install data', async () => {
    for (const kind of MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS) {
      vol.reset()
      const packageDir = path.join(ROOT, `executable-${kind}`)
      await writePackage(packageDir, {
        contributions: [{ id: `demo-${kind}`, kind, entry: `${kind}.json` }]
      })
      const store = new MagicAgentPackageStore(ROOT, STORE)
      const inspection = await store.scanLocalDirectory(packageDir)

      expect(inspection.validation.ok, `kind=${kind}`).toBe(false)
      if (!inspection.validation.ok) {
        expect(inspection.validation.errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: 'contributions.0.kind' })])
        )
      }
      await expect(store.install(packageDir)).rejects.toThrow(/Executable contribution kind/)
      expect(fs.existsSync(path.join(STORE, 'demo.package'))).toBe(false)
      expect(
        fs.existsSync(STORE)
          ? fs.readdirSync(STORE).filter((entry) => entry.startsWith('.install-'))
          : []
      ).toEqual([])
    }
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

  it('rejects unsafe or unbounded package agent spec permissions before install', async () => {
    const packageDir = path.join(ROOT, 'unsafe-agent-package')
    await writePackage(packageDir, {
      contributions: [{ id: 'unsafe-agent', kind: 'agent', entry: 'agents/unsafe.json' }]
    })
    await fsp.mkdir(path.join(packageDir, 'agents'), { recursive: true })
    await fsp.writeFile(
      path.join(packageDir, 'agents', 'unsafe.json'),
      JSON.stringify(
        {
          schemaVersion: MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION,
          name: 'Unsafe Agent',
          toolNames: [
            'session.status',
            'bad tool name',
            ...Array.from(
              { length: MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_COUNT },
              (_, index) => `extra.tool.${index}`
            )
          ],
          maxToolIterations: MAGIC_AGENT_PACKAGE_AGENT_MAX_TOOL_ITERATIONS + 1,
          profileId: '../secret-profile'
        },
        null,
        2
      )
    )

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)
    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'contributions.0.entry',
            message: expect.stringMatching(
              /toolNames|MagicAgent tool name rules|maxToolIterations|profileId/
            )
          })
        ])
      )
    }
    await expect(store.install(packageDir)).rejects.toThrow(/Invalid agent contribution spec/)
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

  it('loads installed package graphs as read-only data-only definitions', async () => {
    const packageDir = path.join(ROOT, 'graph-package')
    await writePackage(packageDir, {
      contributions: [
        {
          id: 'concept-graph',
          kind: 'graph',
          title: 'Concept Graph',
          entry: 'graphs/concept.json'
        }
      ]
    })
    await fsp.mkdir(path.join(packageDir, 'graphs'), { recursive: true })
    await fsp.writeFile(
      path.join(packageDir, 'graphs', 'concept.json'),
      JSON.stringify(
        {
          graphId: 'package.graph.concept',
          name: 'Package Concept Graph',
          description: 'A read-only graph contribution.',
          version: '1.0.0',
          tags: ['package', 'graph'],
          entryNodeIds: ['planner'],
          nodes: [
            {
              nodeId: 'planner',
              kind: 'agent',
              name: 'Planner',
              description: 'Plans from package data only.'
            },
            {
              nodeId: 'final',
              kind: 'output',
              name: 'Final',
              description: 'Final output.'
            }
          ],
          channels: [
            {
              channelId: 'planner-to-final',
              from: 'planner',
              to: 'final',
              kind: 'artifact',
              required: true
            }
          ],
          outputs: [
            {
              outputId: 'final-output',
              name: 'Final Output',
              description: 'Final output.',
              sourceNodeId: 'final',
              channelId: 'planner-to-final',
              mimeType: 'text/markdown'
            }
          ]
        },
        null,
        2
      )
    )

    const store = new MagicAgentPackageStore(ROOT, STORE)
    await store.install(packageDir)

    const graphs = await store.listGraphs()
    expect(graphs).toHaveLength(1)
    expect(graphs[0]).toMatchObject({
      graphId: 'package.graph.concept',
      sourcePackageId: 'demo.package',
      contributionId: 'concept-graph',
      contributionTitle: 'Concept Graph',
      runnable: false,
      unavailableReason: expect.stringMatching(/read-only/)
    })
    expect((globalThis as Record<string, unknown>).__magicPackageExecuted).toBeUndefined()
  })

  it('rejects invalid package graph definitions before install', async () => {
    const packageDir = path.join(ROOT, 'bad-graph-package')
    await writePackage(packageDir, {
      contributions: [{ id: 'bad-graph', kind: 'graph', entry: 'graphs/bad.json' }]
    })
    await fsp.mkdir(path.join(packageDir, 'graphs'), { recursive: true })
    await fsp.writeFile(
      path.join(packageDir, 'graphs', 'bad.json'),
      JSON.stringify(
        {
          graphId: 'bad.graph',
          name: 'Bad Graph',
          description: 'Invalid graph.',
          version: '1.0.0',
          tags: ['bad'],
          entryNodeIds: ['missing'],
          nodes: [
            {
              nodeId: 'planner',
              kind: 'agent',
              name: 'Planner',
              description: 'Planner.'
            }
          ],
          channels: [
            {
              channelId: 'planner-to-missing',
              from: 'planner',
              to: 'missing',
              kind: 'artifact'
            }
          ],
          outputs: [
            {
              outputId: 'bad-output',
              name: 'Bad Output',
              description: 'Bad output.',
              sourceNodeId: 'missing',
              channelId: 'missing-channel'
            }
          ]
        },
        null,
        2
      )
    )

    const store = new MagicAgentPackageStore(ROOT, STORE)
    const inspection = await store.scanLocalDirectory(packageDir)
    expect(inspection.validation.ok).toBe(false)
    if (!inspection.validation.ok) {
      expect(inspection.validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'contributions.0.entry',
            message: expect.stringMatching(/Invalid graph contribution definition/)
          })
        ])
      )
    }
    await expect(store.install(packageDir)).rejects.toThrow(/Invalid graph contribution definition/)
  })

  it('rejects duplicate package graph ids during read-only discovery', async () => {
    const firstPackageDir = path.join(ROOT, 'graph-package-one')
    const secondPackageDir = path.join(ROOT, 'graph-package-two')
    for (const [packageDir, packageId] of [
      [firstPackageDir, 'graph.package.one'],
      [secondPackageDir, 'graph.package.two']
    ] as const) {
      await writePackage(packageDir, {
        id: packageId,
        contributions: [{ id: 'concept-graph', kind: 'graph', entry: 'graphs/concept.json' }]
      })
      await fsp.mkdir(path.join(packageDir, 'graphs'), { recursive: true })
      await fsp.writeFile(
        path.join(packageDir, 'graphs', 'concept.json'),
        JSON.stringify(
          {
            graphId: 'duplicate.graph',
            name: 'Duplicate Graph',
            description: 'Duplicate graph id.',
            version: '1.0.0',
            tags: ['duplicate'],
            entryNodeIds: ['input'],
            nodes: [
              {
                nodeId: 'input',
                kind: 'input',
                name: 'Input',
                description: 'Input.'
              }
            ],
            channels: [],
            outputs: [
              {
                outputId: 'input-output',
                name: 'Input Output',
                description: 'Input output.',
                sourceNodeId: 'input'
              }
            ]
          },
          null,
          2
        )
      )
    }

    const store = new MagicAgentPackageStore(ROOT, STORE)
    await store.install(firstPackageDir)
    await store.install(secondPackageDir)

    await expect(store.listGraphs()).rejects.toThrow(/Duplicate package graph id: duplicate.graph/)
  })
})
