import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
const h = vi.hoisted(() => ({ senders: new Map<number, unknown>() }))
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => h.senders.get(id) } }))
vi.mock('./agentThreadScope', () => ({
  authorizeAgentThreadScope: (
    _scope: unknown,
    invocation: { senderId: number; methodName: string },
    method: string
  ) => {
    if (invocation?.methodName !== `svcLLMProxy.${method}`) throw Error('unauthorized')
    return invocation.senderId
  }
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => {
    throw Error('Unexpected production path')
  }
}))
vi.mock('./teamEndStore', () => ({
  getTeamEndStore: () => {
    throw Error('Unexpected End store')
  }
}))
vi.mock(import('../magicAgentPlatform2/persistence/writeLock'), async (original) => {
  const actual = await original()
  return { ...actual, activeInstanceLeasePids: vi.fn(actual.activeInstanceLeasePids) }
})
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import {
  activeInstanceLeasePids,
  instanceLeaseDirectory
} from '../magicAgentPlatform2/persistence/writeLock'
import {
  AgentTeamMessageQueue,
  teamMessageStoreOpener,
  type TeamMessageStoreOpener
} from './agentTeamMessageQueue'
import { createAgentTeamMessageTools } from './agentTeamMessageTools'
import { TEAM_MESSAGE_STATE_KIND, TeamMessageStore } from './teamMessageStore'

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const source = { scope: 'scope', thread: 'pane', lead: 'lead', member: 'member' }
const intent = {
  source,
  kind: 'message' as const,
  hop: 1 as const,
  recipient: 'other',
  text: 'hello'
}
const invoke = (id: number, method: string) => ({
  senderId: id,
  methodName: `svcLLMProxy.${method}`,
  senderUrl: 'file:///fixture',
  frameUrl: 'file:///fixture',
  isMainFrame: true
})
const scope = { route, conversationId: 'lead', storageScope: 'scope' }
const sender = (id: number) => {
  const s = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    getURL: () => 'file:///fixture'
  })
  h.senders.set(id, s)
  return s
}
const options = (id = 1) => ({
  invocation: invoke(id, 'chatStream'),
  route,
  lease: { assertLive: vi.fn() }
})
const list = (q: AgentTeamMessageQueue, id: number, over: Partial<typeof scope> = {}) =>
  q.list({ ...scope, ...over }, invoke(id, 'listAgentTeamMessages'))
const claim = (q: AgentTeamMessageQueue, id: number, requestId: string) =>
  q.claim({ ...scope, id: requestId }, invoke(id, 'claimAgentTeamMessage'))
const directories: string[] = [],
  queues: AgentTeamMessageQueue[] = [],
  databases: MagicAgentEventStore[] = []
function path(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'team-queue-'))
  directories.push(directory)
  return join(directory, 'team-messages', 'messages.sqlite')
}
function queue(
  file = path(),
  boot = randomUUID(),
  assertTeamActive = vi.fn()
): { q: AgentTeamMessageQueue; file: string; store: TeamMessageStoreOpener } {
  const store = teamMessageStoreOpener(file, boot),
    q = new AgentTeamMessageQueue({ store, assertTeamActive })
  queues.push(q)
  return { q, file, store }
}
/** Reads the stored state with its own connection, after the queue's store is closed. */
function stored(file: string, id: string): Record<string, unknown> | undefined {
  const db = new MagicAgentEventStore(file)
  try {
    return db.getResource<Record<string, unknown>>(TEAM_MESSAGE_STATE_KIND, id)?.state
  } finally {
    db.close()
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  // Back to the real check, with no one-time answer left over from a test that stopped early.
  vi.mocked(activeInstanceLeasePids).mockReset()
  h.senders.clear()
  for (const q of queues.splice(0)) q.dispose()
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable team message queue', () => {
  it('keeps a message after its request lease ends, gives the lease out once, and nothing to other identities', () => {
    sender(1)
    sender(2)
    const { q } = queue(),
      o = options()
    const { requestId } = q.enqueue(intent, o)
    o.lease.assertLive.mockImplementation(() => {
      throw Error('disposed')
    })
    expect(list(q, 1)).toEqual([{ id: requestId, ...intent }])
    expect(list(q, 2)).toEqual([])
    expect(list(q, 1, { conversationId: 'other' })).toEqual([])
    expect(list(q, 1, { storageScope: 'other' })).toEqual([])
    expect(
      q.claim(
        { ...scope, id: requestId, route: { ...route, threadId: 'other' } },
        invoke(1, 'claimAgentTeamMessage')
      )
    ).toBeUndefined()
    expect(claim(q, 2, requestId)).toBeUndefined()
    expect(() => q.claim({ ...scope, id: requestId }, invoke(1, 'listAgentTeamMessages'))).toThrow(
      'unauthorized'
    )
    const claimed = claim(q, 1, requestId)
    expect(claimed).toEqual({
      id: requestId,
      ...intent,
      lease: expect.stringMatching(/^[0-9a-f-]{36}$/)
    })
    expect(claim(q, 1, requestId)).toBeUndefined()
    expect(claim(q, 2, requestId)).toBeUndefined()
    expect(list(q, 1)).toEqual([])
  })

  it('carries a message over a restart: another authorised sender lists it once, claims it once', () => {
    sender(1)
    sender(2)
    const first = queue(),
      { requestId } = first.q.enqueue(intent, options(1))
    first.q.dispose()
    const { q, file } = queue(first.file, randomUUID())
    expect(list(q, 2)).toEqual([{ id: requestId, ...intent, carriedOver: true }])
    expect(list(q, 1)).toEqual([{ id: requestId, ...intent, carriedOver: true }])
    expect(claim(q, 2, requestId)).toMatchObject({
      id: requestId,
      carriedOver: true,
      lease: expect.any(String),
      text: 'hello'
    })
    expect(claim(q, 1, requestId)).toBeUndefined()
    expect(list(q, 1)).toEqual([])
    expect(list(q, 2)).toEqual([])
    q.dispose()
    expect(stored(file, requestId)).toMatchObject({ status: 'claimed', starts: [] })
    // The claim of the earlier boot is over at the next start: never delivered again.
    const next = queue(file, randomUUID())
    expect(list(next.q, 2)).toEqual([])
    next.q.dispose()
    expect(stored(file, requestId)).toMatchObject({ status: 'unknown' })
  })

  it('keeps a fresh message from every other sender until its document ends', () => {
    const one = sender(1)
    sender(2)
    const { q } = queue()
    const { requestId } = q.enqueue(intent, options(1))
    expect(list(q, 2)).toEqual([])
    expect(claim(q, 2, requestId)).toBeUndefined()
    one.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    one.emit('did-start-navigation', {}, 'file:///frame', false, false)
    expect(list(q, 2)).toEqual([])
    one.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(list(q, 2)).toEqual([{ id: requestId, ...intent, carriedOver: true }])
    expect(list(q, 1)).toEqual([{ id: requestId, ...intent, carriedOver: true }])
    for (const event of ['render-process-gone', 'destroyed', 'did-start-navigation']) {
      const s = sender(3)
      const { requestId: next } = q.enqueue(intent, options(3))
      expect(list(q, 2).map((item) => item.id)).not.toContain(next)
      s.emit(
        event,
        ...(event === 'did-start-navigation' ? [{}, 'file:///fixture', false, true] : [])
      )
      expect(list(q, 2).find((item) => item.id === next)).toMatchObject({ carriedOver: true })
    }
  })

  it.each([
    ['destroyed', []],
    ['render-process-gone', [{ reason: 'crashed' }]],
    ['a reload', [{ isMainFrame: true, isSameDocument: false }]],
    ['a legacy reload', [{}, 'file:///fixture', false, true]]
  ] as const)('ends the claims of a document on %s: unknown, never listed again', (_name, args) => {
    const a = sender(1)
    sender(2)
    const { q, file } = queue()
    const { requestId } = q.enqueue(intent, options(1))
    expect(claim(q, 1, requestId)?.lease).toBeDefined()
    a.emit(
      _name === 'destroyed' || _name === 'render-process-gone' ? _name : 'did-start-navigation',
      ...args
    )
    expect(list(q, 2)).toEqual([])
    expect(list(q, 1)).toEqual([])
    q.dispose()
    expect(stored(file, requestId)).toMatchObject({ status: 'unknown', starts: [] })
  })

  it.each([
    ['modern', [{ isMainFrame: true, isSameDocument: true }]],
    ['legacy', [{}, 'file:///fixture#/canvas', true, true]]
  ] as const)(
    'keeps the claims of a document over a %s same-document navigation',
    (_name, args) => {
      const a = sender(1)
      const { q, file } = queue()
      const { requestId } = q.enqueue(intent, options(1))
      claim(q, 1, requestId)
      a.emit('did-start-navigation', ...args)
      q.dispose()
      expect(stored(file, requestId)).toMatchObject({ status: 'claimed' })
    }
  )

  it('rejects cancellation, failed lease and malformed input without enqueuing', () => {
    sender(1)
    const { q } = queue(),
      o = options(),
      controller = new AbortController()
    controller.abort()
    expect(() => q.enqueue(intent, { ...o, signal: controller.signal })).toThrow()
    o.lease.assertLive.mockImplementation(() => {
      throw Error('expired')
    })
    expect(() => q.enqueue(intent, o)).toThrow('expired')
    expect(() => q.enqueue({ ...intent, recipient: source.member }, options())).toThrow()
    expect(() => q.enqueue({ ...intent, hop: 3 as 1 }, options())).toThrow()
    expect(() => q.enqueue({ ...intent, hop: 0 as 1 }, options())).toThrow()
    expect(list(q, 1)).toEqual([])
  })

  it('bounds queued messages per team and in all; claimed and settled messages do not count', () => {
    for (let id = 1; id <= 9; id++) sender(id)
    const { q } = queue()
    const ids = Array.from({ length: 128 }, () => q.enqueue(intent, options()).requestId)
    expect(() => q.enqueue(intent, options())).toThrow('Team queue capacity reached.')
    expect(() =>
      q.enqueue({ ...intent, source: { ...source, lead: 'lead-0' } }, options())
    ).not.toThrow()
    claim(q, 1, ids[0])
    expect(() => q.enqueue(intent, options())).not.toThrow()
    expect(() => q.enqueue(intent, options())).toThrow('Team queue capacity reached.')
    // 128 + 1 (lead-0) + 1 queued now; 1024 in all is reached with seven more full teams.
    for (let team = 1; team <= 7; team++)
      for (let i = 0; i < (team < 7 ? 128 : 127); i++)
        q.enqueue({ ...intent, source: { ...source, lead: `lead-${team}` } }, options())
    expect(() =>
      q.enqueue({ ...intent, source: { ...source, lead: 'lead-8' } }, options())
    ).toThrow('Team queue capacity reached.')
    q.endTeam({ scope: 'scope', thread: 'pane', lead: 'lead-1' })
    expect(() =>
      q.enqueue({ ...intent, source: { ...source, lead: 'lead-8' } }, options())
    ).not.toThrow()
  }, 60_000)

  it('settles a message as ended when its team ended before the claim', () => {
    sender(1)
    const ended = vi.fn((_member: unknown) => {
      throw Error('Team has ended.')
    })
    const { q, file } = queue(undefined, undefined, ended)
    const { requestId } = q.enqueue(intent, options())
    expect(claim(q, 1, requestId)).toBeUndefined()
    expect(ended).toHaveBeenCalledWith(source)
    expect(list(q, 1)).toEqual([])
    q.dispose()
    expect(stored(file, requestId)).toMatchObject({ status: 'ended' })
  })

  it('ends the queued messages of a team, not those of another team', () => {
    sender(1)
    const { q, file } = queue()
    const mine = q.enqueue(intent, options()).requestId,
      other = q.enqueue({ ...intent, source: { ...source, lead: 'lead-2' } }, options()).requestId
    q.endTeam({ scope: 'scope', thread: 'pane', lead: 'lead' })
    expect(list(q, 1, {}).map((item) => item.id)).toEqual([])
    expect(list(q, 1, { conversationId: 'lead-2' }).map((item) => item.id)).toEqual([other])
    q.dispose()
    expect(stored(file, mine)).toMatchObject({ status: 'ended' })
  })

  it('creates nothing for list, claim and End on a profile without the file', () => {
    sender(1)
    const { q, file } = queue()
    expect(list(q, 1)).toEqual([])
    expect(claim(q, 1, randomUUID())).toBeUndefined()
    q.endTeam({ scope: 'scope', thread: 'pane', lead: 'lead' })
    expect(existsSync(join(file, '..'))).toBe(false)
  })

  it('answers the tool call with an error and lists nothing when the store cannot write', async () => {
    sender(1)
    const { q, store } = queue()
    store.open(true)
    vi.spyOn(TeamMessageStore.prototype, 'append').mockImplementation(() => {
      throw Error('disk full')
    })
    const tools = createAgentTeamMessageTools({
      source,
      outgoingHop: 1,
      route,
      lease: { assertLive: vi.fn() },
      assertInvocation: vi.fn(),
      assertNotEnded: vi.fn(),
      enqueue: async (i) => q.enqueue(i, options())
    })
    await expect(
      tools.callTool('send_message', { recipient: 'other', text: 'hello' }, { route, runId: 'run' })
    ).rejects.toThrow('disk full')
    expect(list(q, 1)).toEqual([])
  })

  it('fails closed on a file it cannot open: no fallback, no reopen on every poll, the file untouched', () => {
    sender(1)
    const { q, file } = queue()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'not a database')
    vi.mocked(activeInstanceLeasePids).mockClear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Nothing is listed (the poll gets no error to log every 500 ms); a tool call gets the error.
    expect(list(q, 1)).toEqual([])
    expect(list(q, 1)).toEqual([])
    expect(() => q.enqueue(intent, options())).toThrow()
    // One open attempt, logged once; the next ones within the retry window answer with the same failure.
    expect(activeInstanceLeasePids).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(readFileSync(file, 'utf8')).toBe('not a database')
  })

  it('waits longer after each failed open of the file, and checks for another holder every 30 s', () => {
    sender(1)
    let now = Math.floor(performance.now())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    // The middle of the spread: each wait is exactly its nominal length.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const attempts = vi.mocked(activeInstanceLeasePids)
    // Each attempt starts with the check for another holder: one call per attempt.
    const pollsAt = (poll: () => void, waits: number[]): void => {
      attempts.mockClear()
      let at = now
      poll()
      for (const [index, wait] of waits.entries()) {
        now = at + wait - 1
        poll()
        expect(attempts).toHaveBeenCalledTimes(index + 1)
        now = at += wait
        poll()
        expect(attempts).toHaveBeenCalledTimes(index + 2)
      }
    }
    // A file that cannot be opened: every attempt reads and audits it on the main thread.
    const broken = queue()
    mkdirSync(join(broken.file, '..'), { recursive: true })
    writeFileSync(broken.file, 'not a database')
    pollsAt(
      () => expect(list(broken.q, 1)).toEqual([]),
      [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]
    )
    expect(readFileSync(broken.file, 'utf8')).toBe('not a database')
    // Another live process holds the file (it refreshes its lock): only the cheap check, every 30 s.
    const held = queue()
    mkdirSync(instanceLeaseDirectory(held.file), { recursive: true })
    const lease = join(instanceLeaseDirectory(held.file), `${process.ppid}-${randomUUID()}.lease`)
    writeFileSync(lease, '{}')
    mkdirSync(`${lease}.lock`)
    writeFileSync(held.file, '')
    let refreshes = 0
    const refresh = () => {
      const at = new Date(Date.now() - (refreshes += 1) * 1_000)
      utimesSync(`${lease}.lock`, at, at)
    }
    pollsAt(() => {
      refresh()
      expect(list(held.q, 1)).toEqual([])
    }, [30_000, 30_000, 30_000, 30_000])
  })

  it('spreads each wait, keeps it at 30 s while another process holds the file, and never lengthens it when the clock is set back', () => {
    sender(1)
    let now = Math.floor(performance.now())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = queue()
    first.q.enqueue(intent, options())
    first.q.dispose()
    const { q } = queue(first.file)
    const attempts = vi.mocked(activeInstanceLeasePids)
    // Two processes opened the file together: the check before the open saw no other holder, the
    // one after it (after the audit of the whole file) sees the other process.
    const collide = () => attempts.mockReturnValueOnce([]).mockReturnValueOnce([process.ppid])
    attempts.mockClear()
    collide()
    expect(list(q, 1)).toEqual([])
    expect(attempts).toHaveBeenCalledTimes(2)
    // Not a failure of the file: the wait does not double. The other process still holds it.
    for (const round of [1, 2, 3]) {
      now += 30_000 - 1
      expect(list(q, 1)).toEqual([])
      expect(attempts).toHaveBeenCalledTimes(2 * round)
      now += 1
      collide()
      expect(list(q, 1)).toEqual([])
      expect(attempts).toHaveBeenCalledTimes(2 * round + 2)
    }
    // Spread between 15 s and 45 s: the two processes do not come back in step.
    random.mockReturnValue(0)
    now += 30_000
    collide()
    expect(list(q, 1)).toEqual([])
    expect(attempts).toHaveBeenCalledTimes(10)
    now += 15_000
    random.mockReturnValue(0.999)
    collide()
    expect(list(q, 1)).toEqual([])
    expect(attempts).toHaveBeenCalledTimes(12)
    now += 44_000
    expect(list(q, 1)).toEqual([])
    expect(attempts).toHaveBeenCalledTimes(12)
    // The wall clock set back by a day changes nothing: the wait runs on the monotonic clock.
    const wall = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => wall - 24 * 60 * 60_000)
    now += 1_000
    expect(list(q, 1)).toHaveLength(1)
    expect(attempts).toHaveBeenCalledTimes(14)
  })

  it('logs each distinct failure once, also when the check for another holder fails', () => {
    sender(1)
    let now = Math.floor(performance.now())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { q, file } = queue()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '')
    const attempts = vi.mocked(activeInstanceLeasePids)
    attempts.mockClear()
    // The lease directory cannot be read (EACCES from readdir or lstat): the check itself fails.
    const denied = Object.assign(
      new Error(`EACCES: permission denied, scandir '${instanceLeaseDirectory(file)}'`),
      { code: 'EACCES' }
    )
    const failCheck = () =>
      attempts.mockImplementationOnce(() => {
        throw denied
      })
    failCheck()
    expect(list(q, 1)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0].join(' ')).toContain('EACCES: permission denied')
    // The same failure at each later check, every 30 s: logged once only.
    for (let check = 0; check < 3; check += 1) {
      now += 30_000
      failCheck()
      expect(list(q, 1)).toEqual([])
    }
    expect(attempts).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledOnce()
    // Another failure is logged, once.
    for (let check = 0; check < 2; check += 1) {
      now += 30_000
      attempts.mockReturnValueOnce([process.ppid])
      expect(list(q, 1)).toEqual([])
    }
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1].join(' ')).toContain('Team queue unavailable.')
    // The first failure again, after the other one: logged again.
    now += 30_000
    failCheck()
    expect(list(q, 1)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(3)
    expect(attempts).toHaveBeenCalledTimes(7)
  })

  it('serves nothing while another live process holds the file', () => {
    sender(1)
    const { q, file } = queue()
    mkdirSync(instanceLeaseDirectory(file), { recursive: true })
    // The holder's lease and its lock (refreshed just now), as acquireInstanceLease keeps them.
    const lease = join(instanceLeaseDirectory(file), `${process.ppid}-${randomUUID()}.lease`)
    writeFileSync(lease, '{}')
    mkdirSync(`${lease}.lock`)
    writeFileSync(file, '')
    expect(list(q, 1)).toEqual([])
    expect(() => q.enqueue(intent, options())).toThrow('Team queue unavailable.')
    expect(readdirSync(join(file, '..')).sort()).toEqual([
      'messages.sqlite',
      'messages.sqlite.magicagent.instances'
    ])
  })

  it('serves on after earlier runs left their leases behind, also when their PIDs are in use again', () => {
    sender(1)
    const first = queue()
    const { requestId } = first.q.enqueue(intent, options())
    first.q.dispose()
    // An earlier run that exited (its lock removed at exit) and one that was killed (its lock not refreshed for
    // hours); their PIDs now belong to a live process.
    const exited = join(instanceLeaseDirectory(first.file), `${process.ppid}-${randomUUID()}.lease`)
    const killed = join(instanceLeaseDirectory(first.file), `${process.ppid}-${randomUUID()}.lease`)
    writeFileSync(exited, '{}')
    writeFileSync(killed, '{}')
    mkdirSync(`${killed}.lock`)
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60_000)
    utimesSync(`${killed}.lock`, hoursAgo, hoursAgo)
    const { q } = queue(first.file)
    let now = Math.floor(performance.now())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // One look cannot tell the killed run's lock from that of a holder that has just woken up
    // from a long sleep: it is held at first.
    expect(list(q, 1)).toEqual([])
    now += 30_000
    expect(list(q, 1)).toEqual([])
    // Seen unrefreshed for 30 s, and 10 s more: its holder is gone, whoever has its PID now.
    now += 30_000
    expect(list(q, 1)).toEqual([{ id: requestId, ...intent, carriedOver: true }])
    expect(() => q.enqueue(intent, options())).not.toThrow()
    expect(existsSync(exited) && existsSync(killed)).toBe(true)
  })

  it('serves nothing when another process took the file while it was being opened', () => {
    sender(1)
    const first = queue()
    first.q.enqueue(intent, options())
    first.q.dispose()
    const { q, file } = queue(first.file)
    // The check before the open saw no holder; the one after it does.
    vi.mocked(activeInstanceLeasePids).mockReturnValueOnce([]).mockReturnValueOnce([process.ppid])
    expect(list(q, 1)).toEqual([])
    expect(() => q.enqueue(intent, options())).toThrow('Team queue unavailable.')
    // The file was closed again: this process holds no lease that would block the other one.
    expect(
      readdirSync(instanceLeaseDirectory(file)).filter((name) => name.endsWith('.lease'))
    ).toEqual([])
  })
})
