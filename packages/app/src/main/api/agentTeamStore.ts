import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentTeamRosterFromLegacy,
  validateAgentTeamIdentity,
  validateAgentTeamRoster,
  type AgentTeamImportResp,
  type AgentTeamRoster,
  type AgentTeamRosterView,
  type AgentTeamScope
} from '@shared/api/agentTeam'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMTeamIdentity } from '@shared/api/svcLLMProxy'
import { getBuildEnv } from '../config/buildEnv'
import { authorizeAgentThreadScope } from './agentThreadScope'
import {
  MagicAgentEventStore,
  ResourceRevisionConflictError
} from '../magicAgentPlatform2/persistence/eventStore'

const KIND = 'llm-team-roster-v1'
const key = (team: LLMTeamIdentity): string =>
  createHash('sha256')
    .update(JSON.stringify([team.scope, team.thread, team.lead]))
    .digest('hex')

type Row = { revision: number; roster: AgentTeamRoster }

/**
 * MAIN's team rosters (S6, KT's graph manifest). Data only: not an IPC identity, a permission or an
 * execution capability; callers establish provenance (authorizeAgentThreadScope). One resource per
 * team, every change a revisioned update. The renderer's chat storage team fields are never written
 * here: the one-time import reads them and leaves them as they are, so a rollback keeps its data.
 */
export class AgentTeamStore {
  constructor(
    private readonly store: MagicAgentEventStore,
    /** Rows per read page of the restart sweep (one row per team). */
    private readonly pageSize = 200
  ) {}

  private read(team: LLMTeamIdentity): Row | undefined {
    const row = this.store.getResource<unknown>(KIND, key(team), { includeDeleted: true })
    if (!row) return undefined
    if (row.deleted) throw new Error('Invalid team roster state.')
    try {
      validateAgentTeamRoster(row.state)
    } catch {
      throw new Error('Invalid team roster state.')
    }
    const roster = row.state
    if (
      roster.team.scope !== team.scope ||
      roster.team.thread !== team.thread ||
      roster.team.lead !== team.lead
    )
      throw new Error('Invalid team roster state.')
    return { revision: row.revision, roster }
  }

  close(): void {
    this.store.close()
  }

  get(team: unknown): AgentTeamRosterView | undefined {
    validateAgentTeamIdentity(team)
    const row = this.read(team)
    return row && { roster: structuredClone(row.roster), revision: row.revision }
  }

  /**
   * Idempotent and non-destructive: the first import of a team creates its roster from the
   * renderer's legacy fields; once a roster exists, any later import (same or different snapshot)
   * changes nothing and returns the roster as it is. An invalid snapshot creates nothing.
   */
  importLegacy(team: unknown, snapshot: unknown, now = Date.now()): AgentTeamImportResp {
    validateAgentTeamIdentity(team)
    const existing = this.read(team)
    if (existing)
      return {
        roster: structuredClone(existing.roster),
        revision: existing.revision,
        imported: false
      }
    const roster = agentTeamRosterFromLegacy(team, snapshot, now)
    const id = key(team)
    try {
      const result = this.store.mutateResource<AgentTeamRoster>({
        operation: 'create',
        kind: KIND,
        id,
        state: roster,
        createdAt: now,
        idempotencyKey: `team-roster-import:${id}`,
        event: this.event(id, 'team-roster-imported', 0, now)
      })
      return {
        roster: structuredClone(result.resource.state),
        revision: result.resource.revision,
        imported: result.inserted
      }
    } catch (error) {
      // Another import won the create: the roster it wrote stands.
      const raced = this.read(team)
      if (raced)
        return { roster: structuredClone(raced.roster), revision: raced.revision, imported: false }
      throw error
    }
  }

  /** The team ended (End team and archive): no member of it runs again. No roster: nothing to change. */
  markEnded(team: unknown, now = Date.now()): void {
    validateAgentTeamIdentity(team)
    this.update(team, now, 'team-roster-ended', (roster) => {
      if (roster.ended) return false
      roster.ended = true
      for (const member of roster.members)
        if (member.state !== 'removed') {
          member.state = 'stopped'
          member.heldBy = 'user'
        }
      return true
    })
  }

  /**
   * The app (re)started: a member that was live or held by the agent comes back stopped, held by
   * 'restart' (a dormant row the user resumes). A member the user held stays held by the user.
   * Running it again changes nothing.
   */
  settleRestart(now = Date.now()): number {
    // Every team first, then the updates: rows are listed in updated_at order, so updating while
    // paging would move rows behind the offset and skip others.
    const teams: LLMTeamIdentity[] = []
    for (let offset = 0; ; offset += this.pageSize) {
      const rows = this.store.listResources({ kind: KIND, limit: this.pageSize, offset })
      for (const row of rows) {
        try {
          validateAgentTeamRoster(row.state)
          teams.push(row.state.team)
        } catch {
          console.warn('[TeamRoster] A roster that does not validate is left as it is.')
        }
      }
      if (rows.length < this.pageSize) break
    }
    let changed = 0
    for (const team of teams) {
      try {
        const updated = this.update(team, now, 'team-roster-restarted', (roster) => {
          let dirty = false
          for (const member of roster.members)
            if (
              member.state === 'live' ||
              ((member.state === 'paused' || member.state === 'stopped') &&
                member.heldBy === 'agent')
            ) {
              member.state = 'stopped'
              member.heldBy = 'restart'
              dirty = true
            }
          return dirty
        })
        if (updated) changed += 1
      } catch {
        // One team's failure does not stop the others (or the app start); nothing of it runs anyway.
        console.warn('[TeamRoster] A team could not be settled after the restart.')
      }
    }
    return changed
  }

  /** Applies `change` to a copy; writes only when it returns true, as one update at the read revision. */
  private update(
    team: LLMTeamIdentity,
    now: number,
    type: string,
    change: (roster: AgentTeamRoster) => boolean
  ): boolean {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = this.read(team)
      if (!row) return false
      const roster = structuredClone(row.roster)
      if (!change(roster)) return false
      validateAgentTeamRoster(roster)
      const id = key(team)
      try {
        this.store.mutateResource({
          operation: 'update',
          kind: KIND,
          id,
          state: roster,
          expectedRevision: row.revision,
          createdAt: now,
          idempotencyKey: `${type}:${id}:${row.revision}`,
          event: this.event(id, type, row.revision + 1, now)
        })
        return true
      } catch (error) {
        if (!(error instanceof ResourceRevisionConflictError)) throw error
      }
    }
    throw new Error('Team roster changed; try again.')
  }

  private event(id: string, type: string, revision: number, createdAt: number) {
    return {
      protocolVersion: '2.0.0',
      id: randomUUID(),
      type,
      createdAt,
      payload: {},
      envelopeKind: 'event' as const,
      streamId: `team-roster:${id}`,
      sequence: revision,
      resource: { kind: KIND, id },
      revision
    }
  }
}

/**
 * The sender's own canvas thread pane (authorizeAgentThreadScope), and a team of that same thread.
 * Returns a copy of the team identity with exactly its three fields.
 */
export function authorizeAgentTeamScope(
  req: AgentTeamScope,
  invocation: ServiceInvocationContext | undefined,
  method: string
): LLMTeamIdentity {
  authorizeAgentThreadScope(req, invocation, method)
  const team: unknown = req.team
  validateAgentTeamIdentity(team)
  // A team of this pane's own thread, asked for by its lead's conversation.
  if (team.thread !== req.route.threadId || team.lead !== req.conversationId)
    throw new Error('Agent interaction access denied.')
  return { scope: team.scope, thread: team.thread, lead: team.lead }
}

let singleton: AgentTeamStore | undefined
/** Closes the file; the next use opens it again (app shutdown, and tests that delete the data dir). */
export function closeAgentTeamStore(): void {
  const store = singleton
  singleton = undefined
  store?.close()
}
/** Opened on first use in this process; that first open is the app start, so it settles the restart once. */
export function getAgentTeamStore(): AgentTeamStore {
  if (!singleton) {
    const dir = join(getBuildEnv().pathMap.data, 'team-roster')
    mkdirSync(dir, { recursive: true })
    const db = new MagicAgentEventStore(join(dir, 'roster.sqlite'))
    const store = new AgentTeamStore(db)
    try {
      store.settleRestart()
    } catch (error) {
      // No half-open store is kept: the next use opens the file again.
      db.close()
      throw error
    }
    singleton = store
  }
  return singleton
}
