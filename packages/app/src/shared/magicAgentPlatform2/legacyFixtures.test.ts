import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../main/config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: process.cwd() } })
}))

import { AssistantSessionStore } from '../../main/assistantRuntime/sessionStore'
import { normalizeMagicAgentGraphDefinition } from '../../main/magicAgentRuntime/graph/graphDefinition'
import { validateMagicAgentPackageManifest } from '../../main/magicAgentRuntime/package/manifest'
import { validateServiceValue } from '../api/apiUtils/serviceValidation'
import { magicAgentPlatformSvcDef } from '../api/svcMagicAgentPlatform'
import type { MagicAgentGraphDefinition } from '../magicAgent/graphTypes'
import { convertGraphDefinitionV1ToV2Draft } from './index'

const fixtureDir = path.resolve(
  process.cwd(),
  'packages/app/src/shared/magicAgentPlatform2/fixtures'
)
const memfsRoot = path.join(tmpdir(), 'magicagent-platform2-legacy-fixtures')
const temporaryDirs: string[] = []
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function readFrozenFixture(name: string): Promise<{ bytes: Buffer; value: unknown }> {
  const bytes = await realFs.readFile(path.join(fixtureDir, name))
  return { bytes, value: JSON.parse(bytes.toString('utf8')) }
}

async function copySessionFixture(name: string): Promise<{ filePath: string; before: Buffer }> {
  const directory = path.join(memfsRoot, `${name}-${crypto.randomUUID()}`)
  await mkdir(directory, { recursive: true })
  temporaryDirs.push(directory)
  const filePath = path.join(directory, 'chat-sessions.json')
  const before = await realFs.readFile(path.join(fixtureDir, name))
  await writeFile(filePath, before)
  return { filePath, before }
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('frozen legacy compatibility fixtures', () => {
  it('validates, normalizes, and converts Graph V1 without changing bytes or input', async () => {
    const { bytes, value } = await readFrozenFixture('graph-v1.json')
    const inputBefore = structuredClone(value)
    const graph = normalizeMagicAgentGraphDefinition(value)
    const converted = convertGraphDefinitionV1ToV2Draft(graph)

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'input',
      'agent',
      'tool',
      'condition',
      'merge',
      'output'
    ])
    expect(value).toEqual(inputBefore)
    expect(converted.legacySnapshot).toEqual(graph)
    expect(converted.legacySnapshot).not.toBe(graph)
    expect(digest(await realFs.readFile(path.join(fixtureDir, 'graph-v1.json')))).toBe(
      digest(bytes)
    )
  })

  for (const version of [1, 2, 3] as const) {
    it(`loads and atomically migrates Session v${version} through AssistantSessionStore`, async () => {
      const { filePath, before } = await copySessionFixture(`session-v${version}.json`)
      const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: `legacy-v${version}` }
      const session = await new AssistantSessionStore(filePath).getSession(route)

      expect(session).toMatchObject({
        sessionKey: `generic:dm:legacy-v${version}`,
        route,
        messages: [{ role: 'user', content: `session v${version}` }]
      })
      if (version === 1) {
        expect(session?.runs).toEqual([])
      } else {
        expect(session?.runs[0]).toMatchObject({ runId: `run-v${version}`, status: 'completed' })
      }
      if (version === 3) {
        expect(session?.runs[0].taskGroup).toMatchObject({
          taskGroupId: 'fixture-group',
          status: 'approved'
        })
      }
      const after = JSON.parse(String(await readFile(filePath))) as { version: number }
      expect(after.version).toBe(4)
      expect((await readFile(`${filePath}.v${version}.bak`)).equals(before)).toBe(true)
      expect(digest(await readFile(`${filePath}.v${version}.bak`))).toBe(digest(before))
    })
  }

  it('validates the package manifest without changing its bytes', async () => {
    const { bytes, value } = await readFrozenFixture('magicpot-package-v1.json')
    const result = validateMagicAgentPackageManifest(value)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.manifestVersion).toBe(1)
    expect(
      (await realFs.readFile(path.join(fixtureDir, 'magicpot-package-v1.json'))).equals(bytes)
    ).toBe(true)
  })

  it('validates the existing runGraph request contract without changing its bytes', async () => {
    const { bytes, value } = await readFrozenFixture('run-graph-request.json')
    const request = validateServiceValue(value, magicAgentPlatformSvcDef.runGraph.request, {
      label: 'runGraph request'
    })

    expect(request).toMatchObject({
      graphId: 'legacy-compat-graph',
      runId: 'fixture-run-001',
      outputIds: ['answer']
    })
    expect(
      (await realFs.readFile(path.join(fixtureDir, 'run-graph-request.json'))).equals(bytes)
    ).toBe(true)
  })
})
