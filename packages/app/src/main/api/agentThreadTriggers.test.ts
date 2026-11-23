import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
const h = vi.hoisted(() => ({ senders: new Map<number, unknown>() }))
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => h.senders.get(id) } }))
vi.mock('./agentThreadScope', () => ({
  authorizeAgentThreadScope: (
    scope: { route?: { scopeId?: string } },
    invocation: { senderId: number; methodName: string },
    method: string
  ) => {
    if (invocation?.methodName !== `svcLLMProxy.${method}`) throw Error('unauthorized')
    if (scope.route?.scopeId !== 'project') throw Error('unauthorized')
    return invocation.senderId
  }
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => {
    throw Error('Unexpected production path')
  }
}))
import { canvasThreadStorageScopeOfRoute, getAgentSessionKey } from '@shared/agent'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { AgentThreadInbox, threadInboxStoreOpener } from './agentThreadInbox'
import {
  AgentThreadTriggers,
  nextTriggerSlot,
  scheduleSpec,
  threadTriggerStoreOpener,
  timerSpec,
  TRIGGER_KIND,
  TRIGGER_LIMITS,
  type TriggerInboxPort
} from './agentThreadTriggers'

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const storageScope = canvasThreadStorageScopeOfRoute(route)!
const directories: string[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  h.senders.clear()
  vi.useRealTimers()
})
function dir(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'thread-triggers-'))
  directories.push(directory)
  return directory
}
type Fake = TriggerInboxPort & {
  queued: Array<Parameters<TriggerInboxPort['enqueue']>[0]>
  open: boolean
  pending: Set<string>
}
function fakeInbox(): Fake {
  const fake: Fake = {
    queued: [],
    open: true,
    pending: new Set(),
    enqueue(input) {
      fake.queued.push(input)
      fake.pending.add(input.idempotencyKey)
      return { id: `event-${fake.queued.length}`, duplicate: false }
    },
    isPending: (_session, key) => fake.pending.has(key),
    isOpen: () => fake.open
  }
  return fake
}
function registry(
  file = join(dir(), 'triggers.sqlite'),
  inbox: TriggerInboxPort = fakeInbox(),
  clock = { now: 0 }
) {
  const triggers = new AgentThreadTriggers({
    store: threadTriggerStoreOpener(file),
    inbox,
    now: () => clock.now
  })
  disposers.push(() => triggers.dispose())
  return { triggers, file, clock }
}
const local = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
const timer = (interval = 60, immediate = false) => timerSpec({ interval, immediate })

describe('trigger arguments (KohakuTerrarium add_timer / add_schedule)', () => {
  it('refuses a timer under the 60 s floor with a clear error instead of clamping it', () => {
    expect(() => timerSpec({ interval: 59.5 })).toThrow(/at least 60 seconds \(got 59\.5\)/)
    expect(() => timerSpec({ interval: 0 })).toThrow(/greater than 0/)
    expect(() => timerSpec({ interval: '120' })).toThrow(/greater than 0/)
    expect(() => timerSpec({ interval: 120, immediate: 'yes' })).toThrow(/boolean/)
    expect(timerSpec({ interval: 60 })).toEqual({ kind: 'timer', interval: 60, immediate: false })
    expect(TRIGGER_LIMITS.minimumIntervalSeconds).toBe(60)
  })

  it('needs exactly one schedule mode within KT ranges', () => {
    expect(() => scheduleSpec({})).toThrow(/exactly one/)
    expect(() => scheduleSpec({ every_minutes: 5, hourly_at: 3 })).toThrow(/exactly one/)
    expect(() => scheduleSpec({ every_minutes: 0 })).toThrow(/1 to 1440/)
    expect(() => scheduleSpec({ every_minutes: 1441 })).toThrow(/1 to 1440/)
    expect(() => scheduleSpec({ hourly_at: 60 })).toThrow(/0 to 59/)
    expect(() => scheduleSpec({ daily_at: '24:00' })).toThrow(/HH:MM/)
    expect(() => scheduleSpec({ daily_at: '9:7' })).toThrow(/HH:MM/)
    expect(scheduleSpec({ daily_at: '9:05' })).toEqual({ kind: 'schedule', daily_at: '09:05' })
  })
})

describe('trigger slots', () => {
  it('counts whole timer intervals from the install time', () => {
    expect(nextTriggerSlot(timer(60), 1000, 1000)).toBe(61_000)
    expect(nextTriggerSlot(timer(60), 1000, 61_000)).toBe(121_000)
    expect(nextTriggerSlot(timer(60), 1000, 200_000)).toBe(241_000)
  })

  it('aligns every_minutes to local midnight and rolls over the day like KT', () => {
    const spec = scheduleSpec({ every_minutes: 30 })
    expect(nextTriggerSlot(spec, 0, local(2026, 5, 4, 10, 7))).toBe(local(2026, 5, 4, 10, 30))
    expect(nextTriggerSlot(spec, 0, local(2026, 5, 4, 10, 30))).toBe(local(2026, 5, 4, 11, 0))
    // 1440 % 7 != 0: the last slot of the day is 23:55, then the next midnight.
    expect(nextTriggerSlot(scheduleSpec({ every_minutes: 7 }), 0, local(2026, 5, 4, 23, 56))).toBe(
      local(2026, 5, 5)
    )
  })

  it('finds daily and hourly slots on the local clock, across a DST change', () => {
    const daily = scheduleSpec({ daily_at: '09:30' })
    expect(nextTriggerSlot(daily, 0, local(2026, 5, 4, 9, 29))).toBe(local(2026, 5, 4, 9, 30))
    expect(nextTriggerSlot(daily, 0, local(2026, 5, 4, 9, 30))).toBe(local(2026, 5, 5, 9, 30))
    // Around the 2026 spring-forward weekends of both hemispheres' common zones: still 09:30 local.
    for (const [m, d] of [
      [3, 8],
      [3, 29],
      [10, 4]
    ] as const) {
      const at = new Date(nextTriggerSlot(daily, 0, local(2026, m, d, 12)))
      expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([d + 1, 9, 30])
    }
    const hourly = scheduleSpec({ hourly_at: 15 })
    expect(nextTriggerSlot(hourly, 0, local(2026, 5, 4, 10, 15))).toBe(local(2026, 5, 4, 11, 15))
    expect(nextTriggerSlot(hourly, 0, local(2026, 5, 4, 23, 20))).toBe(local(2026, 5, 5, 0, 15))
  })
})

describe('AgentThreadTriggers', () => {
  const install = (
    triggers: AgentThreadTriggers,
    over: Partial<Parameters<AgentThreadTriggers['install']>[0]> = {}
  ) =>
    triggers.install({
      tool: 'add_timer',
      route,
      conversationId: 'session-a',
      spec: timer(),
      prompt: 'synthetic check',
      ...over
    })

  it('persists definitions per session across a reopen and lists them read-only', () => {
    const { triggers, file, clock } = registry()
    clock.now = 5_000
    const { triggerId } = install(triggers)
    expect(triggerId).toMatch(/^trigger_[0-9a-f]{8}$/)
    clock.now = 6_000
    install(triggers, {
      name: 'nightly',
      tool: 'add_schedule',
      spec: scheduleSpec({ daily_at: '02:00' })
    })
    install(triggers, { conversationId: 'session-b', name: 'other' })
    triggers.dispose()
    const reopened = registry(file, fakeInbox(), clock).triggers
    const listed = reopened.list(route, 'session-a')
    expect(listed.map((t) => [t.id, t.type, t.running])).toEqual([
      [triggerId, 'TimerTrigger', true],
      ['nightly', 'SchedulerTrigger', true]
    ])
    expect(listed[0]).toMatchObject({
      createdAt: 5_000,
      nextFireAt: 65_000,
      prompt: 'synthetic check'
    })
    expect(reopened.list(route, 'session-b').map((t) => t.id)).toEqual(['other'])
    expect(reopened.list({ ...route, threadId: 'another-pane' }, 'session-a')).toEqual([])
  })

  it('refuses a duplicate name, keeps the per-session limit and lets a deleted name be reused', () => {
    const { triggers } = registry()
    install(triggers, { name: 'tick' })
    expect(() => install(triggers, { name: 'tick' })).toThrow('Trigger already exists: tick')
    expect(() => install(triggers, { name: 'bad name' })).toThrow(/name must be/)
    expect(() => install(triggers, { prompt: '  ' })).toThrow(/prompt/)
    expect(() => install(triggers, { prompt: 'x'.repeat(2001) })).toThrow(/2000/)
    expect(() => install(triggers, { route: { channel: 'chat' } as never })).toThrow(
      /canvas Agent thread/
    )
    expect(triggers.remove(route, 'session-a', 'tick')).toBe(true)
    expect(triggers.remove(route, 'session-a', 'tick')).toBe(false)
    install(triggers, { name: 'tick' })
    for (let i = 1; i < TRIGGER_LIMITS.perSession; i++) install(triggers)
    expect(() => install(triggers)).toThrow(/already has 16 triggers/)
  })

  it('fires only while the project is open, keyed per trigger and slot', () => {
    const inbox = fakeInbox()
    const { triggers, clock } = registry(undefined, inbox)
    install(triggers, { name: 'tick' })
    inbox.open = false
    clock.now = 60_000
    expect(triggers.tick()).toEqual([])
    expect(triggers.list(route, 'session-a')[0].nextFireAt).toBe(60_000) // still due while closed
    inbox.open = true
    expect(triggers.tick()).toEqual(['event-1'])
    expect(inbox.queued[0]).toEqual({
      route,
      storageScope,
      conversationId: 'session-a',
      type: 'trigger_fire',
      source: 'tick',
      text: 'synthetic check',
      idempotencyKey: `trigger_fire:tick:${new Date(60_000).toISOString()}`
    })
    expect(triggers.list(route, 'session-a')[0].nextFireAt).toBe(120_000)
    expect(triggers.tick()).toEqual([]) // not due yet
  })

  it('catches up once per trigger, however many slots were missed while closed', () => {
    const inbox = fakeInbox()
    const { triggers, clock } = registry(undefined, inbox)
    install(triggers, { name: 'tick' })
    inbox.open = false
    clock.now = 10 * 60_000 + 30_000
    triggers.tick()
    inbox.open = true
    triggers.tick()
    triggers.tick()
    expect(inbox.queued).toHaveLength(1)
    expect(inbox.queued[0].idempotencyKey).toBe(
      `trigger_fire:tick:${new Date(60_000).toISOString()}`
    )
    expect(inbox.queued[0].text).toMatch(/^synthetic check\n\n\(Catch-up: 10 scheduled fires/)
    expect(triggers.list(route, 'session-a')[0].nextFireAt).toBe(11 * 60_000)
  })

  it('keeps one waiting fire per trigger while the last one is still queued (busy or stopped)', () => {
    const inbox = fakeInbox()
    const { triggers, clock } = registry(undefined, inbox)
    install(triggers, { name: 'tick' })
    clock.now = 60_000
    triggers.tick()
    clock.now = 120_000
    triggers.tick() // the first fire still waits: nothing new, the slot moves on
    expect(inbox.queued).toHaveLength(1)
    expect(triggers.list(route, 'session-a')[0].nextFireAt).toBe(180_000)
    inbox.pending.clear() // the turn ran
    clock.now = 180_000
    triggers.tick()
    expect(inbox.queued.map((q) => q.idempotencyKey)).toEqual([
      `trigger_fire:tick:${new Date(60_000).toISOString()}`,
      `trigger_fire:tick:${new Date(180_000).toISOString()}`
    ])
  })

  it('fires an immediate timer right away, then on its interval', () => {
    const inbox = fakeInbox()
    const { triggers, clock } = registry(undefined, inbox)
    clock.now = 1_000
    install(triggers, { name: 'now', spec: timer(120, true) })
    triggers.tick()
    expect(inbox.queued[0].idempotencyKey).toBe(`trigger_fire:now:${new Date(1_000).toISOString()}`)
    expect(triggers.list(route, 'session-a')[0].nextFireAt).toBe(121_000)
  })

  it('keeps a slot due when the inbox refuses it (full or unavailable)', () => {
    const inbox = fakeInbox()
    inbox.enqueue = () => {
      throw new Error('full')
    }
    const { triggers, clock } = registry(undefined, inbox)
    install(triggers, { name: 'tick' })
    clock.now = 60_000
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(triggers.tick()).toEqual([])
    expect(triggers.list(route, 'session-a')[0].nextFireAt).toBe(60_000)
  })

  it("deletes a removed session's triggers and no others", () => {
    const { triggers } = registry()
    install(triggers, { name: 'a1' })
    install(triggers, { name: 'a2' })
    install(triggers, { conversationId: 'session-b', name: 'b1' })
    expect(triggers.removeSession(route, 'session-a')).toBe(2)
    expect(triggers.list(route, 'session-a')).toEqual([])
    expect(triggers.list(route, 'session-b').map((t) => t.id)).toEqual(['b1'])
  })

  it('never fires an unreadable or tampered definition', () => {
    const { triggers, file } = registry()
    install(triggers, { name: 'tick' })
    triggers.dispose()
    const db = new MagicAgentEventStore(file)
    const [row] = db.listResources({ kind: TRIGGER_KIND })
    db.mutateResourcesBatch([
      {
        operation: 'update',
        kind: TRIGGER_KIND,
        id: row.id,
        idempotencyKey: `tamper:${randomUUID()}`,
        state: { ...(row.state as Record<string, unknown>), conversationId: 'session-b' },
        createdAt: row.updatedAt,
        expectedRevision: row.revision,
        event: {
          protocolVersion: '2.0.0',
          id: randomUUID(),
          type: 'tamper',
          createdAt: row.updatedAt,
          payload: {},
          envelopeKind: 'event',
          streamId: `${TRIGGER_KIND}:${row.id}`,
          sequence: row.revision + 1
        }
      }
    ])
    db.close()
    const inbox = fakeInbox()
    const reopened = registry(file, inbox, { now: 10 ** 9 }).triggers
    expect(reopened.list(route, 'session-b')).toEqual([])
    expect(reopened.tick()).toEqual([])
  })
})

describe('triggers and the thread inbox', () => {
  const invocation = (method: string) => ({
    senderId: 7,
    methodName: `svcLLMProxy.${method}`,
    senderUrl: 'file:///fixture',
    frameUrl: 'file:///fixture',
    isMainFrame: true
  })
  function wired() {
    h.senders.set(
      7,
      Object.assign(new EventEmitter(), {
        id: 7,
        isDestroyed: () => false,
        getURL: () => 'file:///fixture'
      })
    )
    const directory = dir()
    const clock = { now: 0, mono: 0 }
    const inbox = new AgentThreadInbox({
      store: threadInboxStoreOpener(join(directory, 'events.sqlite'), randomUUID()),
      clock: () => clock.mono
    })
    disposers.push(() => inbox.dispose())
    const triggers = new AgentThreadTriggers({
      store: threadTriggerStoreOpener(join(directory, 'triggers.sqlite')),
      inbox: {
        enqueue: (input) => inbox.enqueue(input),
        isPending: (session, key) => inbox.isPending(session, key),
        isOpen: (scope, routeKey) => inbox.isOpen(scope, routeKey)
      },
      now: () => clock.now
    })
    disposers.push(() => triggers.dispose())
    const list = () => inbox.list({ route, storageScope }, invocation('listAgentThreadEvents'))
    return { inbox, triggers, clock, list }
  }

  it('treats a pane as open only while its pump lists, and collapses a refire of the same slot', () => {
    const { inbox, triggers, clock, list } = wired()
    triggers.install({
      tool: 'add_timer',
      route,
      conversationId: 'session-a',
      name: 'tick',
      spec: timer(),
      prompt: 'synthetic tick'
    })
    clock.now = 60_000
    expect(triggers.tick()).toEqual([]) // no pump has listed: the project is closed
    const opened = vi.fn()
    inbox.onOpen = opened
    expect(list()).toEqual([])
    expect(opened).toHaveBeenCalledTimes(1)
    const [id] = triggers.tick()
    expect(list()).toEqual([
      expect.objectContaining({ id, type: 'trigger_fire', source: 'tick', text: 'synthetic tick' })
    ])
    // A restart that lost the slot advance fires the same slot again: the inbox collapses it.
    const again = inbox.enqueue({
      route,
      storageScope,
      conversationId: 'session-a',
      type: 'trigger_fire',
      source: 'tick',
      text: 'synthetic tick',
      idempotencyKey: `trigger_fire:tick:${new Date(60_000).toISOString()}`
    })
    expect(again).toEqual({ id, duplicate: true })
    // The pump stops listing (project closed): later slots wait.
    clock.mono = 16_000
    expect(inbox.isOpen(storageScope, getAgentSessionKey(route))).toBe(false)
    clock.now = 600_000
    expect(triggers.tick()).toEqual([])
    list()
    expect(opened).toHaveBeenCalledTimes(2)
  })

  it('removing a session through the inbox path deletes its triggers; a stop keeps them', () => {
    const { inbox, triggers } = wired()
    triggers.install({
      tool: 'add_timer',
      route,
      conversationId: 'session-a',
      name: 'tick',
      spec: timer(),
      prompt: 'synthetic tick'
    })
    inbox.setHold(
      { route, storageScope, conversationId: 'session-a', held: true },
      invocation('setAgentThreadEventHold')
    )
    expect(triggers.list(route, 'session-a').map((t) => t.id)).toEqual(['tick'])
    expect(triggers.removeSession(route, 'session-a')).toBe(1)
    expect(triggers.list(route, 'session-a')).toEqual([])
  })
})
