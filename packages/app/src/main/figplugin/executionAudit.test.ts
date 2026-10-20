import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_TTL_MS,
  FigPluginExecutionAuditStore,
  type FigPluginExecutionAuditEvent
} from './executionAudit'

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
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('bounded persistent FIGPLUGIN execution audit', () => {
  it('retains only the newest bounded records and never stores document values', async () => {
    const root = path.join(path.parse(process.cwd()).root, `.figplugin-audit-test-${randomUUID()}`)
    await fs.mkdir(root, { recursive: true })
    roots.push(root)
    const store = new FigPluginExecutionAuditStore(root, () => 1000)
    for (let index = 0; index < FIGPLUGIN_AUDIT_MAX_RECORDS + 8; index += 1)
      store.record(event(index, 1000))
    await store.flush()
    const records = await store.list()
    expect(records).toHaveLength(FIGPLUGIN_AUDIT_MAX_RECORDS)
    expect(records[0].requestId).toBe('request_8')
    expect(JSON.stringify(records)).not.toMatch(/Old name|New name|layer content/)
    const info = await fs.stat(path.join(root, 'execution-audit.jsonl'))
    if (process.platform !== 'win32') expect(info.mode & 0o077).toBe(0)
  })

  it('stores only paired terminal visual checkpoint summaries', async () => {
    const root = path.join(path.parse(process.cwd()).root, `.figplugin-audit-test-${randomUUID()}`)
    await fs.mkdir(root, { recursive: true })
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

  it('drops expired and malformed lines without exposing parser failures', async () => {
    const root = path.join(path.parse(process.cwd()).root, `.figplugin-audit-test-${randomUUID()}`)
    await fs.mkdir(root, { recursive: true })
    roots.push(root)
    const now = 1_000_000
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
