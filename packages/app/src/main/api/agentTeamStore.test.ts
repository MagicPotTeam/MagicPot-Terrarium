import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => {
    throw new Error('Unexpected production path')
  }
}))
import type {
  AgentTeamLegacySnapshot,
  AgentTeamMember,
  AgentTeamRoster
} from '@shared/api/agentTeam'
import { agentTeamRosterFromLegacy, validateAgentTeamRoster } from '@shared/api/agentTeam'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { AgentTeamStore } from './agentTeamStore'

// Synthetic data only.
const team = { scope: 'canvas:synthetic', thread: 'thread-1', lead: 'lead-1' }
const KIND = 'llm-team-roster-v1'
const rosterId = createHash('sha256')
  .update(JSON.stringify([team.scope, team.thread, team.lead]))
  .digest('hex')
const legacy = (): AgentTeamLegacySnapshot => ({
  lead: { id: 'lead-1', teamGeneration: 2 },
  members: [
    {
      id: 'm-1',
      teamLeadId: 'lead-1',
      title: 'Writer',
      teamMemberName: 'writer',
      teamRole: 'drafts text',
      teamMemberGeneration: 2,
      createdAt: 10
    },
    {
      id: 'm-2',
      teamLeadId: 'lead-1',
      title: 'Reviewer',
      teamMemberName: 'reviewer',
      teamMemberGeneration: 2,
      memberModelChoice: { version: 1, profileId: 'profile-synthetic' },
      createdAt: 11
    },
    // An earlier generation (a team ended before) and an archived member: not in today's team rows.
    {
      id: 'm-old',
      teamLeadId: 'lead-1',
      title: 'Old',
      teamMemberName: 'old',
      teamMemberGeneration: 1
    },
    {
      id: 'm-arch',
      teamLeadId: 'lead-1',
      title: 'Gone',
      teamMemberName: 'gone',
      teamMemberGeneration: 2,
      archived: true
    }
  ]
})

const dirs: string[] = []
const dbs: MagicAgentEventStore[] = []
function open(file?: string) {
  const path = file ?? join(mkdtempSync(join(tmpdir(), 'team-roster-')), 'db.sqlite')
  if (!file) dirs.push(dirname(path))
  const db = new MagicAgentEventStore(path)
  dbs.push(db)
  return { db, path, store: new AgentTeamStore(db) }
}
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const event = (id: string, sequence: number, resourceId = rosterId) => ({
  protocolVersion: '2.0.0',
  id,
  type: 'test',
  createdAt: 1,
  payload: {},
  envelopeKind: 'event' as const,
  streamId: `test:${id}`,
  sequence,
  resource: { kind: KIND, id: resourceId },
  revision: sequence
})
function seed(db: MagicAgentEventStore, members: AgentTeamMember[]) {
  const base = agentTeamRosterFromLegacy(team, { lead: { id: 'lead-1' }, members: [] }, 1)
  const roster: AgentTeamRoster = { ...base, origin: 'main', members }
  validateAgentTeamRoster(roster)
  db.mutateResource({
    operation: 'create',
    kind: KIND,
    id: rosterId,
    state: roster,
    createdAt: 1,
    idempotencyKey: 'seed',
    event: event('seed', 0)
  })
}
const member = (
  id: string,
  state: AgentTeamMember['state'],
  heldBy?: AgentTeamMember['heldBy']
): AgentTeamMember => ({
  id,
  name: id,
  role: 'r',
  profileId: null,
  state,
  ...(heldBy ? { heldBy } : {}),
  createdAt: 1
})

describe('legacy team import (S6-1)', () => {
  it('maps exactly the members the renderer shows today, dormant, with their model choice', () => {
    expect(agentTeamRosterFromLegacy(team, legacy(), 99)).toEqual<AgentTeamRoster>({
      version: 1,
      team,
      generation: 2,
      ended: false,
      members: [
        {
          id: 'm-1',
          name: 'writer',
          role: 'drafts text',
          profileId: null,
          state: 'stopped',
          heldBy: 'restart',
          createdAt: 10
        },
        {
          id: 'm-2',
          name: 'reviewer',
          role: 'team member',
          profileId: 'profile-synthetic',
          state: 'stopped',
          heldBy: 'restart',
          createdAt: 11
        }
      ],
      channels: [],
      wires: [],
      origin: 'legacy-import'
    })
  })

  it('imports a role the renderer could store with a pasted tab or newline, as one line', () => {
    const snapshot = legacy()
    snapshot.members[0].teamRole = '  drafts\ttext\r\nand edits  '
    snapshot.members[1].teamRole = '\t\n'
    const { roster } = open().store.importLegacy(team, snapshot, 1)
    expect(roster.members.map((m) => m.role)).toEqual(['drafts text and edits', 'team member'])
    // The stored field itself is not changed.
    expect(snapshot.members[0].teamRole).toBe('  drafts\ttext\r\nand edits  ')
  })

  it('does not modify the snapshot it reads (the old fields stay as they are)', () => {
    const snapshot = legacy()
    const before = structuredClone(snapshot)
    open().store.importLegacy(team, snapshot, 1)
    expect(snapshot).toEqual(before)
  })

  it('is idempotent: a second import, even of a different snapshot, changes nothing', () => {
    const { store, db } = open()
    const first = store.importLegacy(team, legacy(), 1)
    expect(first.imported).toBe(true)
    const changed = legacy()
    changed.members[0].teamMemberName = 'renamed'
    changed.members.push({ id: 'm-3', teamLeadId: 'lead-1', title: 'New', teamMemberGeneration: 2 })
    const events = db.countEvents()
    expect(store.importLegacy(team, changed, 2)).toEqual({ ...first, imported: false })
    expect(store.importLegacy(team, legacy(), 3)).toEqual({ ...first, imported: false })
    expect(db.countEvents()).toBe(events)
    expect(store.get(team)).toEqual({ roster: first.roster, revision: first.revision })
  })

  it('creates nothing from an invalid snapshot, so the old fields stay in use', () => {
    const { store } = open()
    const badName = legacy()
    badName.members[0].teamMemberName = 'has space'
    expect(() => store.importLegacy(team, badName, 1)).toThrow('Invalid legacy team member.')
    expect(() => store.importLegacy(team, { ...legacy(), injected: true }, 1)).toThrow(
      'Invalid legacy team.'
    )
    const otherLead = legacy()
    otherLead.lead.id = 'lead-2'
    expect(() => store.importLegacy(team, otherLead, 1)).toThrow('Invalid legacy team.')
    const tooMany = legacy()
    for (let i = 0; i < 6; i += 1)
      tooMany.members.push({
        id: `x-${i}`,
        teamLeadId: 'lead-1',
        title: `x${i}`,
        teamMemberGeneration: 2
      })
    expect(() => store.importLegacy(team, tooMany, 1)).toThrow('Invalid team members.')
    const duplicate = legacy()
    duplicate.members[1].teamMemberName = 'writer'
    expect(() => store.importLegacy(team, duplicate, 1)).toThrow('Invalid team members.')
    expect(store.get(team)).toBeUndefined()
  })

  it('imports an ended team as ended, with no members', () => {
    const snapshot = legacy()
    snapshot.lead.teamEnded = true
    const { roster } = open().store.importLegacy(team, snapshot, 1)
    expect(roster.ended).toBe(true)
    expect(roster.members).toEqual([])
  })

  it('keeps teams apart and survives reopening the file', () => {
    const { store, db, path } = open()
    store.importLegacy(team, legacy(), 1)
    expect(store.get({ ...team, thread: 'thread-2' })).toBeUndefined()
    const saved = store.get(team)
    db.close()
    expect(open(path).store.get(team)).toEqual(saved)
  })
})

describe('restart and end (S6-1)', () => {
  it('brings live and agent-held members back dormant; user-held stays user-held; a second run changes nothing', () => {
    const { store, db } = open()
    seed(db, [
      member('live', 'live'),
      member('agentPaused', 'paused', 'agent'),
      member('userPaused', 'paused', 'user'),
      member('userStopped', 'stopped', 'user'),
      member('gone', 'removed')
    ])
    expect(store.settleRestart(5)).toBe(1)
    const { roster, revision } = store.get(team)!
    expect(Object.fromEntries(roster.members.map((m) => [m.id, [m.state, m.heldBy]]))).toEqual({
      live: ['stopped', 'restart'],
      agentPaused: ['stopped', 'restart'],
      userPaused: ['paused', 'user'],
      userStopped: ['stopped', 'user'],
      gone: ['removed', undefined]
    })
    expect(store.settleRestart(6)).toBe(0)
    expect(store.get(team)!.revision).toBe(revision)
  })

  it('settles every team even when the sweep pages and each update moves its row to the end', () => {
    const { db } = open()
    const store = new AgentTeamStore(db, 2)
    const teams = [1, 2, 3, 4, 5].map((n) => ({ ...team, lead: `lead-${n}` }))
    for (const [index, each] of teams.entries()) {
      const snapshot = {
        lead: { id: each.lead },
        members: [{ id: `m-${index}`, teamLeadId: each.lead, title: `w${index}` }]
      }
      store.importLegacy(each, snapshot, 1)
      // Make each member live (as S6-2 will), so the sweep has to update every row.
      const id = createHash('sha256')
        .update(JSON.stringify([each.scope, each.thread, each.lead]))
        .digest('hex')
      const current = store.get(each)!
      db.mutateResource({
        operation: 'update',
        kind: KIND,
        id,
        expectedRevision: current.revision,
        state: {
          ...current.roster,
          members: current.roster.members.map(({ heldBy: _heldBy, ...m }) => ({
            ...m,
            state: 'live'
          }))
        },
        createdAt: 1,
        idempotencyKey: `live-${index}`,
        event: event(`live-${index}`, 1, id)
      })
    }
    expect(store.settleRestart(9)).toBe(5)
    for (const each of teams)
      expect(store.get(each)!.roster.members.map((m) => [m.state, m.heldBy])).toEqual([
        ['stopped', 'restart']
      ])
  })

  it('marks an ended team once: every member still in it is held by the user', () => {
    const { store, db } = open()
    seed(db, [member('a', 'live'), member('b', 'stopped', 'restart'), member('c', 'removed')])
    store.markEnded(team, 2)
    const ended = store.get(team)!
    expect(ended.roster.ended).toBe(true)
    expect(ended.roster.members.map((m) => [m.state, m.heldBy])).toEqual([
      ['stopped', 'user'],
      ['stopped', 'user'],
      ['removed', undefined]
    ])
    store.markEnded(team, 3)
    expect(store.get(team)!.revision).toBe(ended.revision)
    // A team with no roster: nothing is created.
    store.markEnded({ ...team, lead: 'lead-x' }, 4)
    expect(store.get({ ...team, lead: 'lead-x' })).toBeUndefined()
  })

  it('refuses a roster row that does not validate, and the restart sweep leaves it as it is', () => {
    const { store, db } = open()
    seed(db, [member('a', 'live')])
    const current = store.get(team)!
    db.mutateResource({
      operation: 'update',
      kind: KIND,
      id: rosterId,
      expectedRevision: current.revision,
      state: { ...current.roster, extra: 1 },
      createdAt: 2,
      idempotencyKey: 'corrupt',
      event: event('corrupt', 1)
    })
    expect(() => store.get(team)).toThrow('Invalid team roster state.')
    expect(() => store.importLegacy(team, legacy(), 3)).toThrow('Invalid team roster state.')
    expect(store.settleRestart(4)).toBe(0)
  })
})
