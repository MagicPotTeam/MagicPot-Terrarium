import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POISONED_RECORD,
  createFakeChatIndexedDb,
  type FakeChatIndexedDb
} from '../../testUtils/fakeChatIndexedDb'

vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

const STORE = 'sessions-v2'
const LEGACY_STORE = 'sessions'

const stored = (scope: string, id: string, extra: Record<string, unknown> = {}) => ({
  storageKey: `${scope}\u0000${id}`,
  storageScope: scope,
  id,
  title: `${scope}/${id}`,
  messages: [],
  ...extra
})

/** A conversation of another project: reading it fails the request and is counted. */
const poisoned = (scope: string, id: string) => ({
  key: `${scope}\u0000${id}`,
  value: POISONED_RECORD
})

async function openStorage(db: FakeChatIndexedDb) {
  db.install(vi.stubGlobal)
  return import('./chatStorage')
}

describe('chatStorage scoped reads', () => {
  let db: FakeChatIndexedDb

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    localStorage.clear()
    db = createFakeChatIndexedDb()
    db.setVersion(2)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('hands out only the records of the requested scope', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('project-a.agent-1', 'newer', { createdAt: 20 }),
      stored('project-a.agent-1', 'older', { createdAt: 10 }),
      stored('project-a.agent-2', 'other-pane'),
      stored('default', 'default-session'),
      stored('project-b.agent-1', 'other-project')
    ])
    // Reading any of these would fail the whole request, as an unranged getAll() does.
    db.seedRows(STORE, [
      poisoned('project-0.agent-1', 'old-with-inline-images'),
      poisoned('project-a.agent-10', 'neighbour'),
      poisoned('project-z.agent-1', 'old-with-inline-images')
    ])
    const storage = await openStorage(db)

    const sessions = await storage.loadAllSessions('project-a.agent-1')

    expect(sessions.map((session) => session.id)).toEqual(['older', 'newer'])
    expect(sessions.every((session) => session.storageScope === 'project-a.agent-1')).toBe(true)
    expect(db.stats.handedOut).toEqual([
      'project-a.agent-1\u0000newer',
      'project-a.agent-1\u0000older'
    ])
    expect(db.stats.unrangedValueScans).toBe(0)
    expect(db.stats.poisonedReads).toBe(0)
  })

  it('keeps scopes that are prefixes of each other apart', async () => {
    const scopes = [
      'tab-1',
      'tab-10',
      'tab-1.agent-1',
      'tab-1.agent-11',
      'tab-',
      'tab',
      // A scope may contain any character, including the separator and the range bound.
      'tab-1\u0000x',
      'tab-1\u0001',
      'tab-1￿'
    ]
    db.seedStore(
      STORE,
      'storageKey',
      scopes.flatMap((scope) => [
        stored(scope, 'a'),
        stored(scope, 'z'),
        // Ids at both ends of the code unit range stay inside their own scope.
        stored(scope, '\u0000'),
        stored(scope, '￿￿')
      ])
    )
    const storage = await openStorage(db)

    for (const scope of scopes) {
      db.resetStats()
      const sessions = await storage.loadAllSessions(scope)
      expect(sessions.map((session) => session.title).sort()).toEqual(
        ['a', 'z', '\u0000', '￿￿'].map((id) => `${scope}/${id}`).sort()
      )
      expect(sessions.every((session) => session.storageScope === scope)).toBe(true)
    }

    // The range of 'tab-1' also covers the keys of 'tab-1\u0000x'; the scope check drops them.
    db.resetStats()
    await storage.loadAllSessions('tab-1')
    expect(db.stats.handedOut).toHaveLength(8)
    // No other scope reaches into a neighbour at all.
    db.resetStats()
    await storage.loadAllSessions('tab-10')
    expect(db.stats.handedOut).toHaveLength(4)
    db.resetStats()
    await storage.loadAllSessions('tab')
    expect(db.stats.handedOut).toHaveLength(4)
  })

  it('treats a missing scope as the default scope and reads only that range', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('default', 'one'),
      // Written before scopes existed in the record: the key carries the default scope.
      { storageKey: 'default\u0000two', id: 'two', title: 'no scope field', messages: [] }
    ])
    db.seedRows(STORE, [
      poisoned('defaul', 'x'),
      poisoned('default-2', 'x'),
      poisoned('p.agent-1', 'x')
    ])
    const storage = await openStorage(db)

    expect((await storage.loadAllSessions()).map((session) => session.id).sort()).toEqual([
      'one',
      'two'
    ])
    expect((await storage.loadAllSessions('')).map((session) => session.id).sort()).toEqual([
      'one',
      'two'
    ])
    expect(db.stats.poisonedReads).toBe(0)
  })

  it('still shows records stored under a key without the scope prefix', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('project-a.agent-1', 'regular', { createdAt: 5 }),
      stored('project-b.agent-1', 'foreign')
    ])
    db.seedRows(STORE, [
      // No separator at all, and a numeric key: unreachable through any scope range.
      {
        key: 'stray-key',
        value: { ...stored('project-a.agent-1', 'stray'), storageKey: 'stray-key', createdAt: 5 }
      },
      { key: 7, value: { storageKey: 7, id: 'numeric', title: 'numeric', messages: [] } },
      poisoned('project-c.agent-1', 'never-read')
    ])
    const storage = await openStorage(db)

    // Same order as an unranged scan followed by the stable createdAt sort: by primary key.
    expect(
      (await storage.loadAllSessions('project-a.agent-1')).map((session) => session.id)
    ).toEqual(['regular', 'stray'])
    expect((await storage.loadAllSessions('default')).map((session) => session.id)).toEqual([
      'numeric'
    ])
    expect(
      (await storage.loadAllSessions('project-b.agent-1')).map((session) => session.id)
    ).toEqual(['foreign'])
    // The key listing is keys only and runs once per connection, not once per read.
    expect(db.stats.calls.getAllKeys).toBe(1)
    expect(db.stats.unrangedValueScans).toBe(0)
    expect(db.stats.poisonedReads).toBe(0)
  })

  it('replaces one scope without reading or touching another', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('scope-a', 'old-1'),
      stored('scope-a', 'old-2'),
      stored('scope-ab', 'kept')
    ])
    db.seedRows(STORE, [poisoned('scope-b', 'kept-unread')])
    const storage = await openStorage(db)

    await storage.saveAllSessions([{ id: 'new', title: 'New', messages: [] }], 'scope-a')

    expect(db.keys(STORE)).toEqual([
      'scope-a\u0000new',
      'scope-ab\u0000kept',
      'scope-b\u0000kept-unread'
    ])
    expect(db.stats.poisonedReads).toBe(0)
    expect(db.stats.unrangedValueScans).toBe(0)
  })

  it('runs the team transactions on the records of their own scope only', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('other-scope', 'lead', { title: 'Same id elsewhere' })
    ])
    db.seedRows(STORE, [poisoned('another-project.agent-1', 'old')])
    const storage = await openStorage(db)
    const lead = {
      id: 'lead',
      title: 'Lead',
      messages: [],
      teamSettings: { maxMembers: 2, defaultModel: null, autoCleanup: true }
    }
    const member = {
      id: 'member',
      title: 'Member',
      messages: [],
      teamLeadId: 'lead',
      teamMemberName: 'writer'
    }
    await storage.saveSessionToDB(lead, 'team-scope')

    const admitted = await storage.createTeamMemberInDB({
      scope: 'team-scope',
      expectedLead: lead,
      member
    })
    expect(admitted.member.teamMemberGeneration).toBe(0)
    await expect(
      storage.createTeamMemberInDB({
        scope: 'team-scope',
        expectedLead: lead,
        member: { ...member, id: 'member-2' }
      })
    ).rejects.toThrow('name is already used')
    const chosen = await storage.setTeamMemberModelChoiceInDB({
      scope: 'team-scope',
      expectedLead: lead,
      expectedMember: admitted.member,
      profileId: 'profile-1'
    })
    expect(chosen.member.memberModelChoice).toEqual({ version: 1, profileId: 'profile-1' })
    const ended = await storage.endTeamInDB({ scope: 'team-scope', expectedLead: lead })

    expect(ended.lead).toMatchObject({ teamEnded: true, teamGeneration: 1 })
    expect(ended.members).toEqual([expect.objectContaining({ id: 'member', archived: true })])
    expect(await storage.loadSessionFromDB('lead', 'other-scope')).toMatchObject({
      title: 'Same id elsewhere'
    })
    expect(
      db.stats.handedOut.every(
        (key) => String(key).startsWith('team-scope\u0000') || key === 'other-scope\u0000lead'
      )
    ).toBe(true)
    expect(db.stats.poisonedReads).toBe(0)
    expect(db.stats.unrangedValueScans).toBe(0)
  })

  it('surfaces a failed scope read instead of returning a partial list', async () => {
    db.seedStore(STORE, 'storageKey', [stored('scope-a', 'fine')])
    db.seedRows(STORE, [poisoned('scope-a', 'broken')])
    const storage = await openStorage(db)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(storage.loadAllSessions('scope-a')).rejects.toThrow()
    expect(db.keys(STORE)).toEqual(['scope-a\u0000broken', 'scope-a\u0000fine'])
    consoleError.mockRestore()
  })

  it('moves the legacy store over one record at a time and shows it in the default scope', async () => {
    db.setVersion(1)
    db.seedStore(LEGACY_STORE, 'id', [
      { id: 'legacy-1', title: 'Legacy one', messages: [], createdAt: 1 },
      { id: 'legacy-2', title: 'Legacy two', messages: [], createdAt: 2 },
      { id: 'legacy-deleted', title: 'Deleted before the upgrade', messages: [] }
    ])
    const storage = await openStorage(db)
    storage.setSessionDeleteTombstone('legacy-deleted', 'default', true)

    const sessions = await storage.loadAllSessions('default')

    expect(sessions.map((session) => session.title)).toEqual(['Legacy one', 'Legacy two'])
    expect(db.keys(STORE)).toEqual(['default\u0000legacy-1', 'default\u0000legacy-2'])
    // The legacy store itself is left as it was.
    expect(db.keys(LEGACY_STORE)).toEqual(['legacy-1', 'legacy-2', 'legacy-deleted'])
    // One cursor over the legacy store; no getAll() of either store without a range.
    expect(db.stats.calls.openCursor).toBe(1)
    expect(db.stats.calls.getAll).toBe(1)
    expect(db.stats.unrangedValueScans).toBe(1)
    expect(await storage.loadSessionFromDB('legacy-2', 'default')).toMatchObject({
      title: 'Legacy two'
    })
  })
})
