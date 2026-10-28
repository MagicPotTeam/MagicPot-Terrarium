import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_TTL_MS,
  FigPluginPlanningAuditStore,
  getFigPluginPlanningAuditStore,
  flushFigPluginPlanningAuditStores,
  type FigPluginPlanningAuditEvent
} from './planningAudit'
import { FigPluginExecutionAuditStore, type FigPluginExecutionAuditEvent } from './executionAudit'
import { auditStoreKey, BoundedAuditStore } from './boundedAuditStore'
import { figPluginPlanningAuditEventSchema } from '@shared/figplugin/planningAudit'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots: string[] = []
const prefix = path.join(os.tmpdir(), 'figplugin-planning-audit-test-')
const ownedRoot = async () => {
  const root = await fs.mkdtemp(prefix)
  roots.push(root)
  return root
}
const event = (index = 1, at = 1000): FigPluginPlanningAuditEvent => ({
  schemaVersion: 1,
  kind: 'planning',
  at,
  callId: index.toString(16).padStart(32, '0'),
  correlationId: (index + 1).toString(16).padStart(32, '0'),
  sequence: 4,
  requestId: `request_${index}`,
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'owned-project',
  profileId: 'owned-profile',
  profileRevision: 'a'.repeat(64),
  featureId: 'plan-preview',
  state: 'completed',
  durationMs: 10,
  inputBytes: 400,
  estimatedInputTokens: 4200,
  nodeCount: 1,
  imageCount: 1,
  imageBytes: 70,
  provider: 'openai',
  modelName: 'Owned model',
  resultBytes: 100,
  reportedTotalTokens: 123
})
const execution = (at = 1000): FigPluginExecutionAuditEvent => ({
  schemaVersion: 1,
  at,
  executionId: 'e'.repeat(32),
  callId: 'a'.repeat(32),
  requestId: 'execution-request',
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'owned-project',
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
  durationMs: 1
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root)
    if (
      !absolute.startsWith(path.resolve(prefix)) ||
      path.dirname(absolute) !== path.resolve(os.tmpdir())
    )
      throw new Error('Unexpected planning audit test cleanup target')
    await fs.rm(absolute, { recursive: true, force: true })
  }
})

describe('real-filesystem bounded planning audit storage', () => {
  it('persists/reopens only metadata, detaches caller changes, and preserves execution history separately', async () => {
    const root = await ownedRoot()
    const planning = new FigPluginPlanningAuditStore(root, () => 1000)
    const existing = new FigPluginExecutionAuditStore(root, () => 1000)
    const value = event()
    planning.record(value)
    value.modelName = 'later caller mutation'
    existing.record(execution())
    await Promise.all([planning.flush(), existing.flush()])
    expect(await new FigPluginPlanningAuditStore(root, () => 1000).list()).toEqual([event()])
    expect(await existing.list()).toEqual([execution()])
    expect((await fs.readdir(root)).sort()).toEqual([
      'execution-audit.jsonl',
      'planning-audit.jsonl'
    ])
    const file = path.join(root, 'planning-audit.jsonl')
    const text = await fs.readFile(file, 'utf8')
    expect(text).toBe(`${JSON.stringify(event())}\n`)
    expect(text).not.toMatch(/prompt|contextImage|bytesBase64|PRIVATE|later caller mutation/)
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0)
  })

  it('retains at most 256 recent records and enforces TTL, future and corrupt entry cleanup on disk', async () => {
    const root = await ownedRoot()
    let now = 1000
    const store = new FigPluginPlanningAuditStore(root, () => now)
    for (let index = 0; index < FIGPLUGIN_AUDIT_MAX_RECORDS + 3; index++)
      store.record(event(index, now))
    await store.flush()
    const records = await store.list()
    expect(records).toHaveLength(256)
    expect(records[0].requestId).toBe('request_3')
    const file = path.join(root, 'planning-audit.jsonl')
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(FIGPLUGIN_AUDIT_MAX_BYTES)
    now += FIGPLUGIN_AUDIT_TTL_MS
    await fs.appendFile(
      file,
      [
        JSON.stringify(event(300, now)),
        JSON.stringify(event(301, now + 1)),
        '{PRIVATE broken}',
        ''
      ].join('\n')
    )
    expect(await store.list()).toEqual([event(300, now)])
    expect(await fs.readFile(file, 'utf8')).toBe(`${JSON.stringify(event(300, now))}\n`)
  })

  it('rejects payload fields before persistence and exposes sticky loss only for the planning file', async () => {
    const root = await ownedRoot()
    const store = new FigPluginPlanningAuditStore(root, () => 1000)
    const other = new FigPluginExecutionAuditStore(root, () => 1000)
    for (const key of ['prompt', 'context', 'bytesBase64', 'errorMessage', 'attachments'])
      store.record({ ...event(), [key]: 'PRIVATE' } as FigPluginPlanningAuditEvent)
    expect(store.writeFailed).toBe(true)
    expect(other.writeFailed).toBe(false)
    store.record(event())
    await store.flush()
    expect(store.writeFailed).toBe(true)
    expect(new FigPluginPlanningAuditStore(root).writeFailed).toBe(true)
    expect(await store.list()).toEqual([event()])
    expect(await fs.readFile(path.join(root, 'planning-audit.jsonl'), 'utf8')).not.toContain(
      'PRIVATE'
    )
  })

  it('orders independent planning instances by file without dropping simultaneous events', async () => {
    const root = await ownedRoot()
    const left = new FigPluginPlanningAuditStore(root, () => 1000)
    const right = new FigPluginPlanningAuditStore(root, () => 1000)
    for (let index = 0; index < 30; index++) (index % 2 ? left : right).record(event(index))
    await Promise.all([left.flush(), right.flush()])
    expect((await right.list()).map((value) => value.requestId)).toEqual(
      Array.from({ length: 30 }, (_, index) => `request_${index}`)
    )
  })

  it('does not serialize execution history behind a stalled planning-file operation', async () => {
    const root = await ownedRoot()
    const planning = new FigPluginPlanningAuditStore(root, () => 1000)
    const existing = new FigPluginExecutionAuditStore(root, () => 1000)
    const actualOpen = fs.open.bind(fs)
    let release!: () => void
    let opened!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrived = new Promise<void>((resolve) => {
      opened = resolve
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).includes('planning-audit.jsonl.')) {
        opened()
        await gate
      }
      return actualOpen(...args)
    })
    planning.record(event())
    await arrived
    existing.record(execution())
    try {
      await existing.flush()
      expect(await existing.list()).toEqual([execution()])
    } finally {
      release()
      await planning.flush()
    }
    expect(await planning.list()).toEqual([event()])
  })

  it('retains the previous file and removes only its own temporary on replacement failure', async () => {
    const root = await ownedRoot()
    const store = new FigPluginPlanningAuditStore(root, () => 1000)
    store.record(event())
    await store.flush()
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('PRIVATE disk error'))
    store.record(event(2))
    await store.flush()
    expect(store.writeFailed).toBe(true)
    expect(await store.list()).toEqual([event()])
    expect(await fs.readdir(root)).toEqual(['planning-audit.jsonl'])
    rename.mockRestore()
    store.record(event(3))
    await store.flush()
    expect(await store.list()).toEqual([event(), event(3)])
    expect(store.writeFailed).toBe(true)
  })

  it('refuses a target replaced after reading rather than overwriting the replacement', async () => {
    const root = await ownedRoot()
    const file = path.join(root, 'planning-audit.jsonl')
    const store = new FigPluginPlanningAuditStore(root, () => 1000)
    store.record(event())
    await store.flush()
    const actualOpen = fs.open.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args)
      if (!replaced && String(args[0]).startsWith(file + '.')) {
        replaced = true
        await fs.rename(file, path.join(root, 'previous-owned-log'))
        await fs.writeFile(file, 'DO_NOT_MODIFY')
      }
      return handle
    })
    store.record(event(2))
    await store.flush()
    expect(store.writeFailed).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe('DO_NOT_MODIFY')
    expect((await fs.readdir(root)).sort()).toEqual(['planning-audit.jsonl', 'previous-owned-log'])
  })

  it('refuses oversized or invalid UTF-8 logs without truncating or leaking their content', async () => {
    const root = await ownedRoot()
    const file = path.join(root, 'planning-audit.jsonl')
    const store = new FigPluginPlanningAuditStore(root, () => 1000)
    await fs.writeFile(file, Buffer.alloc(FIGPLUGIN_AUDIT_MAX_BYTES * 2 + 1, 32))
    const open = vi.spyOn(fs, 'open')
    await expect(store.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
    expect(open).not.toHaveBeenCalled()
    expect((await fs.stat(file)).size).toBe(FIGPLUGIN_AUDIT_MAX_BYTES * 2 + 1)
    open.mockRestore()
    const invalid = Buffer.from([0x50, 0xff, 0xfe, 0x0a])
    await fs.writeFile(file, invalid)
    await expect(store.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
    store.record(event())
    await store.flush()
    expect(store.writeFailed).toBe(true)
    expect(await fs.readFile(file)).toEqual(invalid)
  })

  it('refuses hardlinked files and linked ancestors without modifying other targets', async () => {
    const root = await ownedRoot()
    const outside = path.join(root, 'unrelated.txt')
    await fs.writeFile(outside, 'DO_NOT_MODIFY')
    await fs.link(outside, path.join(root, 'planning-audit.jsonl'))
    const store = new FigPluginPlanningAuditStore(root, () => 1000)
    await expect(store.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
    store.record(event())
    await store.flush()
    expect(store.writeFailed).toBe(true)
    expect(await fs.readFile(outside, 'utf8')).toBe('DO_NOT_MODIFY')
    const target = path.join(root, 'target')
    await fs.mkdir(target)
    const link = path.join(root, 'linked')
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const linked = new FigPluginPlanningAuditStore(path.join(link, 'audit'), () => 1000)
    await expect(linked.list()).rejects.toThrow('FIGPLUGIN_AUDIT_UNAVAILABLE')
    linked.record(event())
    await linked.flush()
    expect(linked.writeFailed).toBe(true)
    expect(await fs.readdir(target)).toEqual([])
  })

  it('does not create directories on an empty read, and accepts only fixed file names and absolute local roots', async () => {
    const root = await ownedRoot()
    const missing = path.join(root, 'not-created')
    expect(await new FigPluginPlanningAuditStore(missing).list()).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
    for (const filename of [
      '../other.jsonl',
      'other.jsonl',
      'planning-audit.jsonl\\extra',
      'C:\\other'
    ])
      expect(
        () =>
          new BoundedAuditStore(
            root,
            filename as 'planning-audit.jsonl',
            figPluginPlanningAuditEventSchema
          )
      ).toThrow('INVALID_AUDIT_FILE')
    for (const invalid of ['relative', root + '\0', '\\\\server\\audit'])
      expect(() => new FigPluginPlanningAuditStore(invalid)).toThrow('INVALID_AUDIT_ROOT')
    expect(auditStoreKey(root, 'execution-audit.jsonl')).not.toBe(
      auditStoreKey(root, 'planning-audit.jsonl')
    )
  })

  it('reuses root-scoped planning factories and flushes pending persistence', async () => {
    const root = await ownedRoot()
    const store = getFigPluginPlanningAuditStore(root)
    expect(getFigPluginPlanningAuditStore(path.join(root, '.'))).toBe(store)
    const value = event(1, Date.now())
    store.record(value)
    await flushFigPluginPlanningAuditStores()
    expect(await new FigPluginPlanningAuditStore(root).list()).toEqual([value])
  })
})
