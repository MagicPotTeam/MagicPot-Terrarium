import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_TTL_MS,
  FigPluginExecutionAuditStore,
  type FigPluginExecutionAuditEvent
} from './executionAudit'

// Verify append, fsync and reopen against the OS, not the suite-wide memfs mock.
vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots: string[] = []
const event = (index: number, at: number): FigPluginExecutionAuditEvent => ({
  schemaVersion: 1,
  at,
  executionId: index.toString(16).padStart(32, '0'),
  callId: (index + 1).toString(16).padStart(32, '0'),
  requestId: `request_${index}`,
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'project_1',
  state: 'completed',
  completed: 1,
  total: 1,
  effect: 'applied',
  risk: 'low',
  planSha256: 'a'.repeat(64),
  previewSha256: 'b'.repeat(64),
  adapterVersion: 'figma-native-1',
  rollback: 'verified-in-place',
  visualAudit: 'unavailable',
  durationMs: 12
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('bounded persistent FIGPLUGIN execution audit', () => {
  it('retains only the newest bounded records and never stores document values', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-audit-test-'))
    roots.push(root)
    const store = new FigPluginExecutionAuditStore(root, () => 1000)
    for (let index = 0; index < FIGPLUGIN_AUDIT_MAX_RECORDS + 8; index += 1)
      store.record(event(index, 1000))
    await store.flush()
    const records = await store.list()
    expect(records).toHaveLength(FIGPLUGIN_AUDIT_MAX_RECORDS)
    expect(records[0].requestId).toBe('request_8')
    const reopened = new FigPluginExecutionAuditStore(root, () => 1000)
    expect(await reopened.list()).toEqual(records)
    expect(JSON.stringify(records)).not.toMatch(/Old name|New name|layer content/)
    const disk = await fs.readFile(path.join(root, 'execution-audit.jsonl'), 'utf8')
    expect(disk.trimEnd().split('\n')).toHaveLength(FIGPLUGIN_AUDIT_MAX_RECORDS)
    const info = await fs.stat(path.join(root, 'execution-audit.jsonl'))
    if (process.platform !== 'win32') expect(info.mode & 0o077).toBe(0)
  })

  it('stores only paired terminal visual checkpoint summaries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-audit-test-'))
    roots.push(root)
    const store = new FigPluginExecutionAuditStore(root, () => 1000)
    store.record({
      ...event(1, 1000),
      visualAudit: 'hash-only',
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'c'.repeat(64)
    })
    store.record({
      ...event(2, 1000),
      visualAudit: 'hash-only',
      visualEvidenceCount: 1
    } as FigPluginExecutionAuditEvent)
    store.record({
      ...event(3, 1000),
      state: 'failed',
      effect: 'unknown',
      visualAudit: 'hash-only',
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'd'.repeat(64)
    } as FigPluginExecutionAuditEvent)
    await store.flush()
    expect(await store.list()).toEqual([
      expect.objectContaining({
        requestId: 'request_1',
        visualEvidenceCount: 1,
        visualEvidenceSha256: 'c'.repeat(64)
      })
    ])
  })

  it('stores an accepted visual baseline only as complete bounded hashes and timing metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-audit-test-'))
    roots.push(root)
    const store = new FigPluginExecutionAuditStore(root, () => 1000)
    store.record({
      ...event(4, 1000),
      visualAudit: 'hash-only',
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'c'.repeat(64),
      visualBaselineId: 'd'.repeat(32),
      visualBaselineEvidenceSha256: 'c'.repeat(64),
      visualBaselineAcceptedAt: 1000,
      visualBaselineExpiresAt: 2000,
      maxCorrectionRounds: 3
    })
    store.record({
      ...event(5, 1000),
      visualAudit: 'hash-only',
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'c'.repeat(64),
      visualBaselineId: 'e'.repeat(32)
    } as FigPluginExecutionAuditEvent)
    store.record({
      ...event(6, 1000),
      visualAudit: 'hash-only',
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'c'.repeat(64),
      visualBaselineId: 'f'.repeat(32),
      visualBaselineEvidenceSha256: 'c'.repeat(64),
      visualBaselineAcceptedAt: 2000,
      visualBaselineExpiresAt: 2000,
      maxCorrectionRounds: 3
    } as FigPluginExecutionAuditEvent)
    await store.flush()
    const records = await store.list()
    expect(records).toEqual([
      expect.objectContaining({
        requestId: 'request_4',
        visualEvidenceCount: 1,
        visualEvidenceSha256: 'c'.repeat(64),
        visualBaselineId: 'd'.repeat(32),
        visualBaselineEvidenceSha256: 'c'.repeat(64),
        visualBaselineAcceptedAt: 1000,
        visualBaselineExpiresAt: 2000,
        maxCorrectionRounds: 3
      })
    ])
    expect(JSON.stringify(records)).not.toMatch(/Old name|New name|layer content|pixels|imageData/)
  })

  it('stores only a complete bounded visual comparison summary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-audit-test-'))
    roots.push(root)
    const store = new FigPluginExecutionAuditStore(root, () => 1000)
    const valid = {
      ...event(7, 1000),
      visualAudit: 'hash-only' as const,
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'c'.repeat(64),
      visualComparisonBaselineId: 'd'.repeat(32),
      visualComparisonTargetCount: 1,
      visualComparisonChangedCount: 1,
      visualComparisonSha256: 'e'.repeat(64)
    }
    store.record(valid)
    store.record({
      ...event(8, 1000),
      visualAudit: 'hash-only',
      visualEvidenceCount: 1,
      visualEvidenceSha256: 'c'.repeat(64),
      visualComparisonBaselineId: 'd'.repeat(32),
      visualComparisonTargetCount: 1
    } as FigPluginExecutionAuditEvent)
    store.record({
      ...valid,
      executionId: '9'.repeat(32),
      callId: 'a'.repeat(32),
      requestId: 'request_9',
      visualComparisonTargetCount: 2
    } as FigPluginExecutionAuditEvent)
    store.record({
      ...valid,
      executionId: 'a'.repeat(32),
      callId: 'b'.repeat(32),
      requestId: 'request_10',
      visualComparisonChangedCount: 2
    } as FigPluginExecutionAuditEvent)
    await store.flush()
    const records = await store.list()
    expect(records).toEqual([
      expect.objectContaining({
        requestId: 'request_7',
        visualEvidenceCount: 1,
        visualComparisonBaselineId: 'd'.repeat(32),
        visualComparisonTargetCount: 1,
        visualComparisonChangedCount: 1,
        visualComparisonSha256: 'e'.repeat(64)
      })
    ])
    expect(JSON.stringify(records)).not.toMatch(/Old name|New name|layer content|pixels|imageData/)
  })

  it('drops expired and malformed lines without exposing parser failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-audit-test-'))
    roots.push(root)
    const now = FIGPLUGIN_AUDIT_TTL_MS + 1_000_000
    const store = new FigPluginExecutionAuditStore(root, () => now)
    store.record(event(1, now - FIGPLUGIN_AUDIT_TTL_MS - 1))
    store.record(event(2, now))
    await store.flush()
    await fs.appendFile(path.join(root, 'execution-audit.jsonl'), '{PRIVATE malformed}\n')
    const records = await store.list()
    expect(records.map((item) => item.requestId)).toEqual(['request_2'])
    expect(JSON.stringify(records)).not.toContain('PRIVATE')
  })
})

it('persists bounded correction lineage and consumption without design text or targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-audit-test-'))
  roots.push(root)
  const store = new FigPluginExecutionAuditStore(root, () => 1000)
  const correctionAttempt = {
    authorizationId: 'a'.repeat(32),
    baselineId: 'b'.repeat(32),
    sourceExecutionId: 'c'.repeat(32),
    round: 1,
    maxCorrectionRounds: 3 as const,
    targetCount: 1,
    consumed: true
  }
  store.record({ ...event(1, 1000), correctionAttempt })
  store.record({ ...event(2, 1000), correctionAttempt: { ...correctionAttempt, consumed: false } })
  store.record({ ...event(3, 1000), correctionAttempt: { ...correctionAttempt, round: 4 } })
  store.record({
    ...event(4, 1000),
    correctionAttempt: { ...correctionAttempt, plan: 'PRIVATE-DESIGN' }
  } as FigPluginExecutionAuditEvent)
  await store.flush()
  expect(await store.list()).toEqual([
    expect.objectContaining({ requestId: 'request_1', correctionAttempt })
  ])
  const text = await fs.readFile(path.join(root, 'execution-audit.jsonl'), 'utf8')
  expect(text).not.toMatch(/PRIVATE-DESIGN|authorizedTargetIds|Drifted name|New name/)
})

async function ownedRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-history-test-'))
  roots.push(root)
  return root
}

it('physically removes expired/malformed/future events when reopened below the byte quota', async () => {
  const root = await ownedRoot()
  const file = path.join(root, 'execution-audit.jsonl')
  let now = 1_000_000
  const store = new FigPluginExecutionAuditStore(root, () => now)
  store.record(event(1, now))
  await store.flush()
  now += FIGPLUGIN_AUDIT_TTL_MS
  await fs.appendFile(
    file,
    [JSON.stringify(event(2, now)), JSON.stringify(event(3, now + 1)), '{PRIVATE broken}', ''].join(
      '\n'
    )
  )
  const reopened = new FigPluginExecutionAuditStore(root, () => now)
  expect(await reopened.list()).toEqual([event(2, now)])
  expect(await fs.readFile(file, 'utf8')).toBe(`${JSON.stringify(event(2, now))}\n`)
})

it('orders independent store instances for the same main-process root without lost records', async () => {
  const root = await ownedRoot()
  const left = new FigPluginExecutionAuditStore(root, () => 1000)
  const right = new FigPluginExecutionAuditStore(root, () => 1000)
  for (let index = 0; index < 30; index++) (index % 2 ? left : right).record(event(index, 1000))
  await Promise.all([left.flush(), right.flush()])
  expect((await right.list()).map((entry) => entry.requestId)).toEqual(
    Array.from({ length: 30 }, (_, index) => `request_${index}`)
  )
  expect(await left.list()).toEqual(await right.list())
})

it('keeps the last valid log and removes its own temporary after a failed atomic replacement', async () => {
  const root = await ownedRoot()
  const store = new FigPluginExecutionAuditStore(root, () => 1000)
  store.record(event(1, 1000))
  await store.flush()
  const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('PRIVATE disk path failure'))
  store.record(event(2, 1000))
  await store.flush()
  expect(store.writeFailed).toBe(true)
  expect(await store.list()).toEqual([event(1, 1000)])
  expect(await fs.readdir(root)).toEqual(['execution-audit.jsonl'])
  rename.mockRestore()
  store.record(event(3, 1000))
  await store.flush()
  // New writes recover, but the missing second event remains missing.
  expect(store.writeFailed).toBe(true)
  expect((await store.list()).map((entry) => entry.requestId)).toEqual(['request_1', 'request_3'])
})

it('refuses oversized logs before allocating or opening file data, without truncating them', async () => {
  const root = await ownedRoot()
  const file = path.join(root, 'execution-audit.jsonl')
  const size = 2 * 1024 * 1024 + 1
  await fs.writeFile(file, Buffer.alloc(size, 32))
  const store = new FigPluginExecutionAuditStore(root, () => 1000)
  const open = vi.spyOn(fs, 'open')
  await expect(store.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
  expect(open).not.toHaveBeenCalled()
  store.record(event(1, 1000))
  await store.flush()
  expect(store.writeFailed).toBe(true)
  expect((await fs.stat(file)).size).toBe(size)
})

it('refuses hardlinked audit files without altering the unrelated file', async () => {
  const root = await ownedRoot()
  const outside = path.join(root, 'owned-unrelated.txt')
  await fs.writeFile(outside, 'DO_NOT_MODIFY')
  await fs.link(outside, path.join(root, 'execution-audit.jsonl'))
  const store = new FigPluginExecutionAuditStore(root, () => 1000)
  await expect(store.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
  store.record(event(1, 1000))
  await store.flush()
  expect(store.writeFailed).toBe(true)
  expect(await fs.readFile(outside, 'utf8')).toBe('DO_NOT_MODIFY')
})

it('refuses linked ancestor directories without creating an audit in their target', async () => {
  const root = await ownedRoot()
  const outside = path.join(root, 'target')
  await fs.mkdir(outside)
  const linked = path.join(root, 'linked')
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const store = new FigPluginExecutionAuditStore(path.join(linked, 'audit'), () => 1000)
  await expect(store.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
  store.record(event(1, 1000))
  await store.flush()
  expect(store.writeFailed).toBe(true)
  expect(await fs.readdir(outside)).toEqual([])
})

it('does not create missing directories during an empty history read', async () => {
  const root = await ownedRoot()
  const missingRoot = path.join(root, 'not-created')
  const store = new FigPluginExecutionAuditStore(missingRoot, () => 1000)
  expect(await store.list()).toEqual([])
  expect(await fs.readdir(root)).toEqual([])
})
