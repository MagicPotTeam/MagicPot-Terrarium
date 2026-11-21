import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { _crashTesting } from '../magicAgentPlatform2/persistence/crashHooks'
import {
  MagicAgentEventStore,
  type ResourceMutationInput
} from '../magicAgentPlatform2/persistence/eventStore'
import { instanceLeaseDirectory } from '../magicAgentPlatform2/persistence/writeLock'
import {
  TEAM_MESSAGE_KIND,
  TEAM_MESSAGE_STATE_KIND,
  TeamMessageStore,
  type TeamMessageAppend
} from './teamMessageStore'

const team = { scope: 'canvas:one', thread: 'thread', lead: 'lead' }
const source = { ...team, member: 'alice' }
const direct: TeamMessageAppend = {
  source,
  routeKey: 'route',
  kind: 'message',
  hop: 1,
  recipient: 'bob',
  text: 'hello bob'
}
const channel: TeamMessageAppend = {
  source,
  routeKey: 'route',
  kind: 'channel',
  hop: 2,
  text: 'hello team'
}
const directories: string[] = [],
  databases: MagicAgentEventStore[] = [],
  children: ChildProcess[] = []

function file(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'team-messages-'))
  directories.push(directory)
  return join(directory, 'messages.sqlite')
}
function database(path: string): MagicAgentEventStore {
  const db = new MagicAgentEventStore(path)
  databases.push(db)
  return db
}
function open(path: string, boot: string): { db: MagicAgentEventStore; store: TeamMessageStore } {
  const db = database(path)
  return { db, store: new TeamMessageStore(db, boot) }
}
const row = (db: MagicAgentEventStore, id: string, kind = TEAM_MESSAGE_STATE_KIND) =>
  db.getResource<Record<string, unknown>>(kind, id)
const status = (db: MagicAgentEventStore, id: string) => row(db, id)?.state.status
const revision = (db: MagicAgentEventStore, id: string) => row(db, id)?.revision

afterEach(async () => {
  _crashTesting.setHook(null)
  vi.restoreAllMocks()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const db of databases.splice(0))
    try {
      db.close()
    } catch {
      /* already closed */
    }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable team message store, real SQLite', () => {
  it('runs every transition once and refuses every transition out of a final state', () => {
    const { db, store } = open(':memory:', 'boot-a')
    const message = store.append(direct).intent.id
    expect(row(db, message, TEAM_MESSAGE_KIND)?.state).toMatchObject({
      v: 1,
      id: message,
      source,
      routeKey: 'route',
      kind: 'message',
      hop: 1,
      recipient: 'bob',
      text: 'hello bob'
    })
    expect(row(db, message)?.state).toEqual({
      v: 1,
      id: message,
      team,
      status: 'queued',
      starts: []
    })
    expect(() => store.start(message, 'bob')).toThrow('not claimed')
    expect(store.closeClaim(message)).toBe('queued')
    expect(revision(db, message)).toBe(0)
    expect(store.claim(message)?.state).toMatchObject({
      status: 'claimed',
      claim: { boot: 'boot-a' }
    })
    expect(store.claim(message)).toBeUndefined()
    expect(() => store.start(message, 'carol')).toThrow('recipient')
    expect(store.start(message, 'bob')).toBe('started')
    expect(row(db, message)?.state).toMatchObject({
      status: 'closed',
      claim: { boot: 'boot-a' },
      starts: [{ recipient: 'bob' }]
    })
    const closed = revision(db, message)
    expect(store.start(message, 'bob')).toBe('already')
    expect(() => store.start(message, 'carol')).toThrow()
    expect(store.claim(message)).toBeUndefined()
    expect(store.closeClaim(message)).toBe('closed')
    expect(store.endQueued(message)).toBe('closed')
    expect(revision(db, message)).toBe(closed)

    const broadcast = store.append(channel).intent.id
    store.claim(broadcast)
    expect(() => store.start(broadcast, 'alice')).toThrow('recipient')
    expect(store.start(broadcast, 'bob')).toBe('started')
    const once = revision(db, broadcast)
    expect(store.start(broadcast, 'bob')).toBe('already')
    expect(revision(db, broadcast)).toBe(once)
    expect(store.start(broadcast, 'carol')).toBe('started')
    expect(row(db, broadcast)?.state).toMatchObject({
      status: 'claimed',
      starts: [{ recipient: 'bob' }, { recipient: 'carol' }]
    })
    expect(store.closeClaim(broadcast)).toBe('closed')
    expect(() => store.start(broadcast, 'dave')).toThrow()
    expect(row(db, broadcast)?.state).toMatchObject({
      status: 'closed',
      starts: [{ recipient: 'bob' }, { recipient: 'carol' }]
    })

    const silent = store.append(channel).intent.id
    store.claim(silent)
    expect(store.closeClaim(silent)).toBe('unknown')
    const unknown = revision(db, silent)
    expect(store.claim(silent)).toBeUndefined()
    expect(() => store.start(silent, 'bob')).toThrow()
    expect(store.closeClaim(silent)).toBe('unknown')
    expect(store.endTeam(team)).toBe(0)
    expect(revision(db, silent)).toBe(unknown)

    const ended = store.append(direct).intent.id
    expect(store.endTeam(team)).toBe(1)
    expect(status(db, ended)).toBe('ended')
    const final = revision(db, ended)
    expect(store.claim(ended)).toBeUndefined()
    expect(() => store.start(ended, 'bob')).toThrow()
    expect(store.closeClaim(ended)).toBe('ended')
    expect(store.endQueued(ended)).toBe('ended')
    expect(revision(db, ended)).toBe(final)
    expect(store.queued()).toEqual([])
  })

  it('bounds the starts of a channel message', () => {
    const { db, store } = open(':memory:', 'boot-a')
    const id = store.append(channel).intent.id
    store.claim(id)
    for (let i = 0; i < 256; i++) expect(store.start(id, `m${i}`)).toBe('started')
    expect(() => store.start(id, 'one-more')).toThrow('limit')
    expect((row(db, id)?.state.starts as unknown[]).length).toBe(256)
  })

  it('lets only one of two claims of one id win', () => {
    const path = file(),
      db = database(path)
    const first = new TeamMessageStore(db, 'boot-a')
    const id = first.append(direct).intent.id
    const second = new TeamMessageStore(db, 'boot-a')
    expect(second.peek(id)?.state.status).toBe('queued')
    expect(first.claim(id)).toBeDefined()
    expect(second.claim(id)).toBeUndefined()
    expect(second.peek(id)?.state.status).toBe('claimed')
    expect(revision(db, id)).toBe(1)
  })

  it('appends the text record and its state record together or not at all', () => {
    const path = file(),
      { db, store } = open(path, 'boot-a')
    const original = db.mutateResourcesBatch.bind(db)
    vi.spyOn(db, 'mutateResourcesBatch').mockImplementation((inputs, fence) => {
      // A crash just before COMMIT of any write that carries a state record.
      if (inputs.some((input) => input.kind === TEAM_MESSAGE_STATE_KIND))
        _crashTesting.setHook((stage) => {
          if (stage === 'resource.before-commit') throw new Error('crash')
        })
      try {
        return original(inputs, fence)
      } finally {
        _crashTesting.setHook(null)
      }
    })
    expect(() => store.append(direct)).toThrow('crash')
    expect(db.countResources({ kind: TEAM_MESSAGE_KIND })).toBe(0)
    expect(db.countResources({ kind: TEAM_MESSAGE_STATE_KIND })).toBe(0)
    expect(store.queued()).toEqual([])
    vi.restoreAllMocks()
    db.close()
    expect(open(path, 'boot-b').store.queued()).toEqual([])
  })

  it('recovers the claims of another boot once and keeps queued messages with their text', () => {
    const path = file()
    let { db, store } = open(path, 'boot-a')
    const queued = store.append(direct).intent.id
    const claimed = store.append(direct).intent.id
    const started = store.append(channel).intent.id
    const closed = store.append(direct).intent.id
    const ended = store.append({ ...direct, source: { ...source, lead: 'other-lead' } }).intent.id
    const unknown = store.append(channel).intent.id
    store.claim(claimed)
    store.claim(started)
    store.start(started, 'bob')
    store.claim(closed)
    store.start(closed, 'bob')
    store.endTeam({ ...team, lead: 'other-lead' })
    store.claim(unknown)
    store.closeClaim(unknown)
    const finals = [closed, ended, unknown].map((id) => [id, revision(db, id)])
    db.close()

    ;({ db, store } = open(path, 'boot-b'))
    expect(row(db, queued)?.state).toMatchObject({ status: 'queued', starts: [] })
    expect(store.queued().map((entry) => entry.intent)).toEqual([
      expect.objectContaining({ id: queued, text: 'hello bob', recipient: 'bob' })
    ])
    expect(row(db, claimed)?.state).toMatchObject({
      status: 'unknown',
      claim: { boot: 'boot-a' },
      starts: []
    })
    expect(row(db, started)?.state).toMatchObject({
      status: 'closed',
      claim: { boot: 'boot-a' },
      starts: [{ recipient: 'bob' }]
    })
    for (const [id, before] of finals) expect(revision(db, id as string)).toBe(before)
    expect(() => store.start(claimed, 'bob')).toThrow()
    expect(store.claim(claimed)).toBeUndefined()
    const settled = [queued, claimed, started, closed, ended, unknown].map((id) => [
      id,
      revision(db, id)
    ])
    db.close()

    ;({ db } = open(path, 'boot-c'))
    for (const [id, before] of settled) expect(revision(db, id as string)).toBe(before)
  })

  it('changes nothing when reopened by the same boot', () => {
    const path = file()
    let { db, store } = open(path, 'boot-a')
    const id = store.append(channel).intent.id
    store.claim(id)
    store.start(id, 'bob')
    db.close()
    ;({ db, store } = open(path, 'boot-a'))
    expect(row(db, id)?.state).toMatchObject({ status: 'claimed', starts: [{ recipient: 'bob' }] })
    expect(revision(db, id)).toBe(2)
    expect(store.start(id, 'carol')).toBe('started')
  })

  it('refuses a start of a message an earlier boot closed, even for its recipient', () => {
    const path = file()
    const first = open(path, 'boot-a')
    const id = first.store.append(direct).intent.id
    first.store.claim(id)
    first.store.start(id, 'bob')
    first.db.close()
    const { db, store } = open(path, 'boot-b')
    expect(() => store.start(id, 'bob')).toThrow('not claimed')
    expect(revision(db, id)).toBe(2)
  })

  it('converges when a recovery fails in the middle and runs again', () => {
    const path = file()
    let { db, store } = open(path, 'boot-a')
    const ids = [store.append(direct), store.append(channel), store.append(direct)].map(
      (entry) => entry.intent.id
    )
    for (const id of ids) store.claim(id)
    store.start(ids[1], 'bob')
    db.close()

    db = database(path)
    const original = db.mutateResourcesBatch.bind(db)
    let writes = 0
    vi.spyOn(db, 'mutateResourcesBatch').mockImplementation((inputs, fence) => {
      if (++writes === 2) throw new Error('disk full')
      return original(inputs, fence)
    })
    expect(() => new TeamMessageStore(db, 'boot-b')).toThrow('disk full')
    expect(ids.map((id) => status(db, id)).filter((value) => value === 'claimed')).toHaveLength(2)
    vi.restoreAllMocks()
    db.close()

    ;({ db, store } = open(path, 'boot-c'))
    expect(ids.map((id) => status(db, id))).toEqual(['unknown', 'closed', 'unknown'])
    const settled = ids.map((id) => revision(db, id))
    db.close()
    ;({ db } = open(path, 'boot-d'))
    expect(ids.map((id) => revision(db, id))).toEqual(settled)
  })

  it('skips a record of another version or an unknown status and never rewrites it', () => {
    const path = file()
    let { db, store } = open(path, 'boot-a')
    const normal = store.append(direct).intent.id
    const write = (
      kind: string,
      id: string,
      state: Record<string, unknown>,
      sequence = 0
    ): ResourceMutationInput => {
      const eventId = randomUUID()
      return {
        operation: 'create',
        kind,
        id,
        idempotencyKey: `fixture:${eventId}`,
        state,
        createdAt: Date.now(),
        event: {
          protocolVersion: '2.0.0',
          id: eventId,
          type: 'fixture',
          createdAt: Date.now(),
          payload: {},
          envelopeKind: 'event',
          streamId: `fixture:${kind}:${id}`,
          sequence
        }
      }
    }
    const text = (id: string, v = 1) => ({
      v,
      id,
      source,
      routeKey: 'route',
      kind: 'message',
      hop: 1,
      recipient: 'bob',
      text: 'fixture',
      createdAt: 1
    })
    const future = randomUUID(),
      strange = randomUUID(),
      newer = randomUUID()
    db.mutateResourcesBatch([
      write(TEAM_MESSAGE_KIND, future, text(future, 2)),
      write(TEAM_MESSAGE_STATE_KIND, future, {
        v: 2,
        id: future,
        team,
        status: 'claimed',
        claim: { boot: 'boot-old', at: 1 },
        starts: []
      }),
      write(TEAM_MESSAGE_KIND, strange, text(strange)),
      write(TEAM_MESSAGE_STATE_KIND, strange, {
        v: 1,
        id: strange,
        team,
        status: 'future',
        starts: []
      }),
      write(TEAM_MESSAGE_KIND, newer, text(newer, 2)),
      write(TEAM_MESSAGE_STATE_KIND, newer, { v: 1, id: newer, team, status: 'queued', starts: [] })
    ])
    db.close()
    ;({ db, store } = open(path, 'boot-b'))
    expect(store.queued().map((entry) => entry.intent.id)).toEqual([normal])
    for (const id of [future, strange, newer]) {
      expect(revision(db, id)).toBe(0)
      expect(store.get(id)).toBeUndefined()
      expect(store.claim(id)).toBeUndefined()
      expect(store.closeClaim(id)).toBeUndefined()
      expect(revision(db, id)).toBe(0)
    }
    expect(store.claim(normal)).toBeDefined()
  })

  it('ends only the queued messages of its own team', () => {
    const { db, store } = open(':memory:', 'boot-a')
    const other = { ...team, thread: 'other-thread' }
    const a1 = store.append(direct).intent.id,
      a2 = store.append(channel).intent.id,
      a3 = store.append(direct).intent.id
    const b1 = store.append({ ...direct, source: { ...other, member: 'alice' } }).intent.id
    store.claim(a3)
    expect(store.queuedCount(team)).toBe(2)
    expect(store.endTeam(team)).toBe(2)
    expect([a1, a2, a3, b1].map((id) => status(db, id))).toEqual([
      'ended',
      'ended',
      'claimed',
      'queued'
    ])
    expect(store.queuedCount()).toBe(1)
    expect(store.start(a3, 'bob')).toBe('started')
  })

  it('serves nothing and recovers nothing while another live process holds the file', async () => {
    const path = file()
    let { db, store } = open(path, 'boot-a')
    const queued = store.append(direct).intent.id
    const claimed = store.append(direct).intent.id
    store.claim(claimed)
    db.close()
    // Another process holds the file: its MagicAgentEventStore's instance lease, as acquireInstanceLease takes it
    // (the lease file, then its proper-lockfile lock).
    const script =
      "const fs = require('node:fs'); const lease = require('node:path').join(process.argv[1], process.pid + '-' + require('node:crypto').randomUUID() + '.lease'); fs.writeFileSync(lease, '{}', { flag: 'wx' }); require('proper-lockfile').lockSync(lease, { realpath: false, stale: 30000, update: 10000, retries: 0 }); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"
    const child = spawn(process.execPath, ['-e', script, instanceLeaseDirectory(path)], {
      cwd: join(__dirname, '../../../../..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    children.push(child)
    await new Promise<void>((resolve) =>
      child.stdout!.on('data', (chunk) => {
        if (String(chunk).includes('READY')) resolve()
      })
    )

    ;({ db, store } = open(path, 'boot-b'))
    expect(store.unavailable).toBe(true)
    expect(store.queued()).toEqual([])
    expect(store.peek(queued)).toBeUndefined()
    expect(() => store.append(direct)).toThrow('Team queue unavailable.')
    expect(() => store.claim(queued)).toThrow('Team queue unavailable.')
    expect(status(db, claimed)).toBe('claimed')
    expect(revision(db, claimed)).toBe(1)
    db.close()

    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    ;({ db, store } = open(path, 'boot-c'))
    expect(store.unavailable).toBe(false)
    expect(status(db, claimed)).toBe('unknown')
    expect(store.queued().map((entry) => entry.intent.id)).toEqual([queued])
  })

  it('fails closed on a failed write and never deletes, truncates or replaces the file', () => {
    const path = file(),
      { db, store } = open(path, 'boot-a')
    const id = store.append(direct).intent.id
    const before = statSync(path)
    vi.spyOn(db, 'mutateResourcesBatch').mockImplementation(() => {
      throw new Error('write failed')
    })
    expect(() => store.append(direct)).toThrow('write failed')
    expect(() => store.claim(id)).toThrow('write failed')
    expect(store.queued().map((entry) => entry.intent.id)).toEqual([id])
    expect(status(db, id)).toBe('queued')
    vi.restoreAllMocks()
    const after = statSync(path)
    expect([after.ino, after.dev]).toEqual([before.ino, before.dev])
    expect(after.size).toBeGreaterThanOrEqual(before.size)
    expect(store.claim(id)).toBeDefined()
  })

  it('keeps a transition working when the clock goes back', () => {
    const { store } = open(':memory:', 'boot-a')
    const id = store.append(direct).intent.id
    vi.spyOn(Date, 'now').mockReturnValue(1)
    expect(store.claim(id)?.state.status).toBe('claimed')
    expect(store.start(id, 'bob')).toBe('started')
  })

  it('measures open time and file size after 5000 settled messages of 4000 characters', () => {
    const path = file()
    let { db, store } = open(path, 'boot-a')
    // The exact mutations the store writes for append, claim and start, batched only to build the fixture fast.
    const build = (
      store as unknown as {
        mutation(
          operation: 'create' | 'update',
          kind: string,
          id: string,
          state: unknown,
          createdAt: number,
          expectedRevision?: number
        ): ResourceMutationInput
      }
    ).mutation.bind(store)
    for (let batch = 0; batch < 20; batch++) {
      const inputs: ResourceMutationInput[] = []
      for (let i = 0; i < 250; i++) {
        const id = randomUUID(),
          at = Date.now()
        const queued = { v: 1, id, team, status: 'queued', starts: [] }
        inputs.push(
          build(
            'create',
            TEAM_MESSAGE_KIND,
            id,
            {
              v: 1,
              id,
              source,
              routeKey: 'route',
              kind: 'message',
              hop: 1,
              recipient: 'bob',
              text: 'x'.repeat(4000),
              createdAt: at
            },
            at
          )
        )
        inputs.push(build('create', TEAM_MESSAGE_STATE_KIND, id, queued, at))
        inputs.push(
          build(
            'update',
            TEAM_MESSAGE_STATE_KIND,
            id,
            { ...queued, status: 'claimed', claim: { boot: 'boot-a', at } },
            at,
            0
          )
        )
        inputs.push(
          build(
            'update',
            TEAM_MESSAGE_STATE_KIND,
            id,
            {
              ...queued,
              status: 'closed',
              claim: { boot: 'boot-a', at },
              starts: [{ recipient: 'bob', at }]
            },
            at,
            1
          )
        )
      }
      db.mutateResourcesBatch(inputs)
    }
    db.checkpoint('TRUNCATE')
    db.close()
    const size =
      statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)
    const started = performance.now()
    db = database(path)
    const audited = performance.now() - started
    store = new TeamMessageStore(db, 'boot-b')
    const opened = performance.now() - started
    process.stdout.write(
      `[B13 measure] 5000 settled messages of 4000 characters: open ${opened.toFixed(0)} ms (event store audit ${audited.toFixed(0)} ms), file ${(size / 1024 / 1024).toFixed(1)} MiB\n`
    )
    expect(store.queued()).toEqual([])
    expect(db.countResources({ kind: TEAM_MESSAGE_STATE_KIND })).toBe(5000)
  }, 120_000)
})
