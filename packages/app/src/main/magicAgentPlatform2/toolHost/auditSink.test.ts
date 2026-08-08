import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { MagicAgentEventStore } from '../persistence/eventStore'
import { createMagicAgentToolAuditSink, TOOL_AUDIT_STREAM_ID } from './auditSink'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable tool audit sink', () => {
  it('survives close/reopen with ordered content-free tool-call and file-change events', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'magic-agent-tool-audit-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'audit.sqlite')
    const store = new MagicAgentEventStore(databasePath)
    const fileSink = createMagicAgentToolAuditSink(store, 'files:stable-call')
    const notebookSink = createMagicAgentToolAuditSink(store, 'notebook:stable-call')
    const gitSink = createMagicAgentToolAuditSink(store, 'git:stable-call')

    await Promise.all([
      fileSink({
        tool: 'files.write',
        authorizationId: 'AUTH_SECRET',
        path: 'ROUTE_SESSION_SENTINEL.txt',
        outcome: 'completed',
        bytes: 25,
        beforeSha256: 'a'.repeat(64),
        afterSha256: 'b'.repeat(64),
        durationMs: 1
      }),
      notebookSink({
        tool: 'notebook.replace',
        path: 'NOTEBOOK_ROUTE_SENTINEL.ipynb',
        outcome: 'completed',
        beforeSha256: 'c'.repeat(64),
        afterSha256: 'd'.repeat(64),
        cellIds: ['SOURCE_SECRET_SENTINEL'],
        cellCount: 1
      }),
      gitSink({
        tool: 'git.status',
        authorizationId: 'GIT_AUTH_SECRET',
        repository: 'GIT_ROUTE_SENTINEL',
        pathspecs: ['GIT_OUTPUT_SECRET_SENTINEL'],
        outcome: 'completed',
        count: 1,
        durationMs: 1
      })
    ])
    store.close()

    const reopened = new MagicAgentEventStore(databasePath)
    const events = reopened.readStream(TOOL_AUDIT_STREAM_ID, { limit: 20 })
    reopened.close()

    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index))
    expect(events.filter((event) => event.type.endsWith('tool-call.v1'))).toHaveLength(3)
    expect(events.filter((event) => event.type.endsWith('file-change.v1'))).toHaveLength(2)
    const persisted = JSON.stringify(events)
    for (const sentinel of [
      'AUTH_SECRET',
      'ROUTE_SESSION_SENTINEL',
      'NOTEBOOK_ROUTE_SENTINEL',
      'SOURCE_SECRET_SENTINEL',
      'GIT_AUTH_SECRET',
      'GIT_ROUTE_SENTINEL',
      'GIT_OUTPUT_SECRET_SENTINEL'
    ]) {
      expect(persisted).not.toContain(sentinel)
    }
  })

  it('is idempotent for a stable call identity after reopen', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'magic-agent-tool-audit-replay-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'audit.sqlite')
    let store = new MagicAgentEventStore(databasePath)
    await createMagicAgentToolAuditSink(
      store,
      'files:replay'
    )({
      tool: 'files.read',
      authorizationId: 'one',
      path: 'secret-one',
      outcome: 'completed',
      returnedBytes: 3,
      durationMs: 1
    })
    store.close()
    store = new MagicAgentEventStore(databasePath)
    await createMagicAgentToolAuditSink(
      store,
      'files:replay'
    )({
      tool: 'files.read',
      authorizationId: 'two',
      path: 'secret-two',
      outcome: 'completed',
      returnedBytes: 3,
      durationMs: 99
    })
    expect(store.readStream(TOOL_AUDIT_STREAM_ID)).toHaveLength(1)
    store.close()
  })
})
