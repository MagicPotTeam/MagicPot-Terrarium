import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSQLiteAdapter } from './sqliteAdapter'
import { RESOURCES_DDL } from './schema'
import { decodeAgentInstanceIdentityCandidate, type AgentInstanceIdentityCandidate } from '../agents/agentInstanceIdentityCandidate'
import { AGENT_INSTANCE_IDENTITY_PROJECTION_LIMITS as limits, projectAgentInstanceIdentityRow, type AgentInstanceIdentityProjection } from '../agents/agentInstanceIdentityProjection'

// TEST-LOCAL hypotheses only. No EventStore/private adapter access or production query wiring.
// Native BLOB-length evaluation may load oversized values; no strict CPU/I/O bound is claimed.
const HEADER_SQL = `SELECT resource_id AS instanceId, revision AS instanceRevision,
  deleted AS instanceDeleted,
  CASE WHEN typeof(state_json) = 'text' THEN
    CASE WHEN length(CAST(state_json AS BLOB)) <= 16384 THEN state_json ELSE NULL END
    ELSE NULL END AS instanceStateJson
FROM resources WHERE resource_kind = 'agent-instance' AND resource_id = ? LIMIT 1`
const FINAL_SQL = `SELECT i.resource_id AS instanceId, i.revision AS instanceRevision,
  i.deleted AS instanceDeleted,
  CASE WHEN typeof(i.state_json) = 'text' THEN
    CASE WHEN length(CAST(i.state_json AS BLOB)) <= 16384 THEN i.state_json ELSE NULL END
    ELSE NULL END AS instanceStateJson,
  c.resource_id AS configId, c.revision AS configRevision, c.deleted AS configDeleted,
  CASE WHEN typeof(c.state_json) = 'text' THEN
    CASE WHEN length(CAST(c.state_json AS BLOB)) <= 65536 THEN c.state_json ELSE NULL END
    ELSE NULL END AS configStateJson
FROM resources AS i LEFT JOIN resources AS c
  ON c.resource_kind = 'magic-agent-config' AND c.resource_id = ?
WHERE i.resource_kind = 'agent-instance' AND i.resource_id = ? LIMIT 1`
const INSERT_SQL = `INSERT INTO resources
(resource_kind,resource_id,revision,state_json,deleted,created_at,updated_at) VALUES (?,?,?,?,?,0,0)`
const UPDATE_SQL = `UPDATE resources SET state_json = ?, revision = ?, deleted = ?, updated_at = ?
WHERE resource_kind = ? AND resource_id = ?`
const unavailable = Object.freeze({ status: 'unavailable', reason: 'unavailable' } as const)
type Available = Extract<AgentInstanceIdentityProjection, { status: 'available' }>
type Fixture = { adapter: NodeSQLiteAdapter; logicalClosed: boolean }
const owned: NodeSQLiteAdapter[] = []
const open = (): Fixture => {
  const adapter = new NodeSQLiteAdapter(':memory:'); owned.push(adapter)
  adapter.exec(RESOURCES_DDL)
  return { adapter, logicalClosed: false }
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const instance = (extra: Record<string, unknown> = {}) => ({ id: 'instance-a', definitionId: 'definition-a', configVersion: 'config-v7', status: 'created', ...extra })
const config = (extra: Record<string, unknown> = {}) => ({ version: 'config-v7', definitionId: 'definition-a', prompt: 'INERT-SECRET-CANARY', ...extra })
const insert = (fixture: Fixture, kind: string, id: string, text: string, revision = 9, deleted = 0) => fixture.adapter.prepare(INSERT_SQL).run(kind, id, revision, text, deleted)
const update = (fixture: Fixture, kind: string, id: string, text: string, revision: number, deleted = 0) => fixture.adapter.prepare(UPDATE_SQL).run(text, revision, deleted, revision, kind, id)
const seed = (fixture: Fixture, instanceText = canonical(instance()), configText = canonical(config()), id = 'instance-a', configId = 'config-v7') => {
  insert(fixture, 'agent-instance', id, instanceText, 9)
  insert(fixture, 'magic-agent-config', configId, configText, 2)
}
const validId = (id: unknown): id is string => {
  if (typeof id !== 'string' || id.length === 0 || id.length > limits.identityBytes || id !== id.trim() || Buffer.byteLength(id) > limits.identityBytes || !id.isWellFormed()) return false
  for (let index = 0; index < id.length; index++) if (id.charCodeAt(index) <= 31 || id.charCodeAt(index) === 127) return false
  return true
}
// This logical flag is ONLY a fixture model, not MagicAgentEventStore's actual private closed flag.
const readFenced = (fixture: Fixture, sql: string, ...params: string[]): Record<string, unknown> | undefined => {
  try {
    if (fixture.logicalClosed || !fixture.adapter.database.isOpen) return undefined
    const row = fixture.adapter.get(sql, ...params)
    if (fixture.logicalClosed || !fixture.adapter.database.isOpen) return undefined
    return row
  } catch { return undefined }
}
const header = (fixture: Fixture, id: unknown): AgentInstanceIdentityCandidate | null =>
  validId(id) ? decodeAgentInstanceIdentityCandidate(id, readFenced(fixture, HEADER_SQL, id)) : null
const finish = (fixture: Fixture, pinned: AgentInstanceIdentityCandidate): AgentInstanceIdentityProjection => {
  const final = projectAgentInstanceIdentityRow(pinned.instanceId, readFenced(fixture, FINAL_SQL, pinned.configVersion, pinned.instanceId))
  if (final.status !== 'available' || final.instanceId !== pinned.instanceId || final.definitionId !== pinned.definitionId || final.configVersion !== pinned.configVersion || final.instanceRevision !== pinned.instanceRevision) return unavailable
  return final
}
const revalidate = (fixture: Fixture, pinned: AgentInstanceIdentityCandidate, previous: Available): AgentInstanceIdentityProjection => {
  const final = finish(fixture, pinned)
  return final.status === 'available' && final.instanceId === previous.instanceId && final.definitionId === previous.definitionId && final.configVersion === previous.configVersion && final.instanceRevision === previous.instanceRevision && final.configRevision === previous.configRevision ? final : unavailable
}
const requireHeader = (fixture: Fixture, id = 'instance-a') => {
  const value = header(fixture, id); expect(value).not.toBeNull()
  if (!value) throw new Error('Synthetic header fixture must be accepted')
  return value
}
const requireFinal = (fixture: Fixture, pinned: AgentInstanceIdentityCandidate) => {
  const value = finish(fixture, pinned); expect(value.status).toBe('available')
  if (value.status !== 'available') throw new Error('Synthetic final fixture must be accepted')
  return value
}
const padded = (document: Record<string, unknown>, cap: number, multibyte: boolean, extraBytes = 0) => {
  const empty = canonical({ ...document, padding: '' }), needed = cap + extraBytes - Buffer.byteLength(empty)
  const padding = multibyte ? '界'.repeat(Math.floor(needed / 3)) + 'x'.repeat(needed % 3) : 'x'.repeat(needed)
  const text = canonical({ ...document, padding }); expect(Buffer.byteLength(text)).toBe(cap + extraBytes); return text
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const adapter of owned.splice(0)) adapter.close()
})

describe('TEST ONLY exact identity SQL on owned memory; not production read/native-work acceptance', () => {
  it('uses real native exact four/eight-column rows and independent revisions to return frozen whitelist DTOs', () => {
    expect(limits.instanceBytes).toBe(16384); expect(limits.configBytes).toBe(65536)
    const fixture = open(); seed(fixture)
    expect(fixture.adapter.path).toBe(':memory:'); expect(fixture.adapter.database.isOpen).toBe(true)
    const calls = vi.spyOn(fixture.adapter, 'get'), pinned = requireHeader(fixture), value = requireFinal(fixture, pinned)
    expect(pinned).toEqual({ stage: 'provisional', instanceId: 'instance-a', definitionId: 'definition-a', configVersion: 'config-v7', instanceRevision: 9 })
    expect(value).toEqual({ status: 'available', instanceId: 'instance-a', definitionId: 'definition-a', configVersion: 'config-v7', instanceRevision: 9, configRevision: 2 })
    expect(Object.isFrozen(pinned)).toBe(true); expect(Object.isFrozen(value)).toBe(true)
    expect(calls.mock.calls).toEqual([[HEADER_SQL, 'instance-a'], [FINAL_SQL, 'config-v7', 'instance-a']])
    expect(Object.keys(calls.mock.results[0].value as object).sort()).toEqual(['instanceDeleted', 'instanceId', 'instanceRevision', 'instanceStateJson'])
    expect(Object.keys(calls.mock.results[1].value as object).sort()).toEqual(['configDeleted', 'configId', 'configRevision', 'configStateJson', 'instanceDeleted', 'instanceId', 'instanceRevision', 'instanceStateJson'])
    expect(JSON.stringify(value)).not.toMatch(/INERT-SECRET|prompt|StateJson|deleted|path|time|health/)
  })
  it('binds exact kind and identifier, ignoring same-ID decoys and not selecting arbitrary config rows', () => {
    const fixture = open(); seed(fixture)
    insert(fixture, 'decoy-instance', 'instance-a', 'not-json'); insert(fixture, 'decoy-config', 'config-v7', 'not-json')
    insert(fixture, 'agent-instance', 'instance-other', canonical(instance({ id: 'instance-other' })))
    insert(fixture, 'magic-agent-config', 'config-other', canonical(config({ version: 'config-other' })))
    const pinned = requireHeader(fixture); requireFinal(fixture, pinned)
    expect(header(fixture, 'missing')).toBeNull()
    expect(finish(fixture, Object.freeze({ ...pinned, configVersion: 'config-other' }))).toEqual(unavailable)
  })
  it('rejects an otherwise-valid decoy-only instance kind before decoding or joining its genuine config', () => {
    const fixture = open()
    insert(fixture, 'decoy-instance', 'instance-a', canonical(instance()), 9)
    insert(fixture, 'magic-agent-config', 'config-v7', canonical(config()), 2)
    expect(fixture.adapter.get(HEADER_SQL, 'instance-a')).toBeUndefined()
    expect(fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a')).toBeUndefined()
    expect(header(fixture, 'instance-a')).toBeNull()
  })
  it('returns NULL config columns when only an otherwise-valid wrong-kind config exists', () => {
    const fixture = open()
    insert(fixture, 'agent-instance', 'instance-a', canonical(instance()), 9)
    insert(fixture, 'decoy-config', 'config-v7', canonical(config()), 2)
    const pinned = requireHeader(fixture), raw = fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a')
    expect(raw?.instanceId).toBe('instance-a')
    expect(raw?.configId).toBeNull(); expect(raw?.configRevision).toBeNull()
    expect(raw?.configDeleted).toBeNull(); expect(raw?.configStateJson).toBeNull()
    expect(finish(fixture, pinned)).toEqual(unavailable)
  })
  it('treats SQL-looking IDs as literal bound values, not SQL or a list query', () => {
    const fixture = open(), id = "instance-' OR 1=1 --", version = "config-' OR 1=1 --"
    seed(fixture, canonical(instance({ id, configVersion: version })), canonical(config({ version })), id, version)
    insert(fixture, 'agent-instance', 'instance-a', canonical(instance()))
    const pinned = requireHeader(fixture, id), value = requireFinal(fixture, pinned)
    expect(value.instanceId).toBe(id); expect(value.configVersion).toBe(version)
    expect(header(fixture, "not-there' OR 1=1 --")).toBeNull()
  })
  it.each([null, 1, '', ' padded ', '\ud800', 'x'.repeat(257), '界'.repeat(86)])('rejects invalid selection before any SQL (case %#)', id => {
    const fixture = open(), get = vi.spyOn(fixture.adapter, 'get')
    expect(header(fixture, id)).toBeNull(); expect(get).not.toHaveBeenCalled()
  })
  it('denies absent instance and absent config independently, with LEFT JOIN nulls not a config fallback', () => {
    const fixture = open(); expect(header(fixture, 'instance-a')).toBeNull()
    insert(fixture, 'agent-instance', 'instance-a', canonical(instance()))
    const pinned = requireHeader(fixture), raw = fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a')
    expect(raw?.configId).toBeNull(); expect(raw?.configStateJson).toBeNull(); expect(finish(fixture, pinned)).toEqual(unavailable)
  })
  it.each(['instance', 'config', 'removed'])('denies live-row tombstone/status variant %s', mode => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture)
    if (mode === 'instance') update(fixture, 'agent-instance', 'instance-a', canonical(instance()), 10, 1)
    else if (mode === 'config') update(fixture, 'magic-agent-config', 'config-v7', canonical(config()), 3, 1)
    else update(fixture, 'agent-instance', 'instance-a', canonical(instance({ status: 'removed' })), 10)
    expect(finish(fixture, pinned)).toEqual(unavailable)
    if (mode !== 'config') expect(header(fixture, 'instance-a')).toBeNull()
  })
  it.each(['instance-id', 'instance-definition', 'instance-reference', 'config-version', 'config-definition'])('denies row/state relationship mismatch %s', mode => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture)
    // Deliberately malformed fixture states retain both revisions to isolate relationship guards.
    if (mode === 'instance-id') update(fixture, 'agent-instance', 'instance-a', canonical(instance({ id: 'different' })), 9)
    else if (mode === 'instance-definition') update(fixture, 'agent-instance', 'instance-a', canonical(instance({ definitionId: 'different' })), 9)
    else if (mode === 'instance-reference') update(fixture, 'agent-instance', 'instance-a', canonical(instance({ configVersion: 'different' })), 9)
    else update(fixture, 'magic-agent-config', 'config-v7', canonical(config(mode === 'config-version' ? { version: 'different' } : { definitionId: 'different' })), 2)
    const raw = fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a')
    expect(raw?.instanceRevision).toBe(pinned.instanceRevision); expect(raw?.configRevision).toBe(2)
    expect(projectAgentInstanceIdentityRow('instance-a', raw)).toEqual(unavailable)
    expect(finish(fixture, pinned)).toEqual(unavailable)
  })
  it.each(['instance-ascii', 'instance-multibyte', 'config-ascii', 'config-multibyte'])('returns complete exact-cap text for %s and never truncates one extra byte into acceptance', mode => {
    const fixture = open(), isInstance = mode.startsWith('instance'), multibyte = mode.endsWith('multibyte'), cap = isInstance ? limits.instanceBytes : limits.configBytes
    const exact = padded(isInstance ? instance() : config(), cap, multibyte)
    seed(fixture, isInstance ? exact : canonical(instance()), isInstance ? canonical(config()) : exact)
    const pinned = requireHeader(fixture); requireFinal(fixture, pinned)
    const raw = fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a'); expect(raw?.[isInstance ? 'instanceStateJson' : 'configStateJson']).toBe(exact)
    const oversized = padded(isInstance ? instance() : config(), cap, multibyte, 1)
    update(fixture, isInstance ? 'agent-instance' : 'magic-agent-config', isInstance ? 'instance-a' : 'config-v7', oversized, isInstance ? 10 : 3)
    const denied = fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a'); expect(denied?.[isInstance ? 'instanceStateJson' : 'configStateJson']).toBeNull()
    expect(finish(fixture, pinned)).toEqual(unavailable)
    if (isInstance) { expect(fixture.adapter.get(HEADER_SQL, 'instance-a')?.instanceStateJson).toBeNull(); expect(header(fixture, 'instance-a')).toBeNull() }
  })
  it.each(['malformed', 'duplicate', 'noncanonical', 'depth'])('transports bounded config text without SQL JSON parsing then denies %s in the application codec', mode => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture)
    let text = canonical(config())
    if (mode === 'malformed') text = '{'
    else if (mode === 'duplicate') text = text.slice(0, -1) + ',"version":"config-v7"}'
    else if (mode === 'noncanonical') text = ' ' + text
    else { let nested: unknown = 0; for (let count = 0; count < 33; count++) nested = [nested]; text = canonical(config({ x: nested })) }
    update(fixture, 'magic-agent-config', 'config-v7', text, 3)
    expect(fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a')?.configStateJson).toBe(text)
    expect(finish(fixture, pinned)).toEqual(unavailable)
  })
  it('denies changed reference without rediscovering or querying its valid successor config', () => {
    const fixture = open(); seed(fixture); insert(fixture, 'magic-agent-config', 'config-v8', canonical(config({ version: 'config-v8' })), 50)
    const get = vi.spyOn(fixture.adapter, 'get'), pinned = requireHeader(fixture)
    update(fixture, 'agent-instance', 'instance-a', canonical(instance({ configVersion: 'config-v8' })), 10)
    expect(finish(fixture, pinned)).toEqual(unavailable)
    expect(get.mock.calls).toEqual([[HEADER_SQL, 'instance-a'], [FINAL_SQL, 'config-v7', 'instance-a']])
  })
  it('denies supported A-to-B-to-A changes by pinned instance revision, not by claiming continuous reference history', () => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture)
    update(fixture, 'agent-instance', 'instance-a', canonical(instance({ configVersion: 'config-v8' })), 10)
    update(fixture, 'agent-instance', 'instance-a', canonical(instance()), 11)
    const row = fixture.adapter.get(FINAL_SQL, 'config-v7', 'instance-a'); expect(projectAgentInstanceIdentityRow('instance-a', row).status).toBe('available')
    expect(finish(fixture, pinned)).toEqual(unavailable)
  })
  it('revalidates unchanged exact pinned identities and both revisions without a new header query', () => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture), previous = requireFinal(fixture, pinned), get = vi.spyOn(fixture.adapter, 'get')
    expect(revalidate(fixture, pinned, previous)).toEqual(previous)
    expect(get.mock.calls).toEqual([[FINAL_SQL, 'config-v7', 'instance-a']])
  })
  it.each(['config-revision', 'config-deleted', 'instance-revision', 'instance-deleted'])('denies pinned tuple revalidation after %s changes', mode => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture), previous = requireFinal(fixture, pinned)
    if (mode.startsWith('config')) update(fixture, 'magic-agent-config', 'config-v7', canonical(config()), 3, mode.endsWith('deleted') ? 1 : 0)
    else update(fixture, 'agent-instance', 'instance-a', canonical(instance()), 10, mode.endsWith('deleted') ? 1 : 0)
    const get = vi.spyOn(fixture.adapter, 'get'); expect(revalidate(fixture, pinned, previous)).toEqual(unavailable)
    expect(get.mock.calls).toEqual([[FINAL_SQL, 'config-v7', 'instance-a']])
  })
  it.each(['logical', 'native'])('denies %s close before reads without reopening or calling SQL', mode => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture), previous = requireFinal(fixture, pinned)
    if (mode === 'logical') { fixture.logicalClosed = true; expect(fixture.adapter.database.isOpen).toBe(true) }
    else { fixture.adapter.database.close(); expect(fixture.logicalClosed).toBe(false) }
    const get = vi.spyOn(fixture.adapter, 'get'), reopen = vi.spyOn(fixture.adapter.database, 'open')
    expect(header(fixture, 'instance-a')).toBeNull(); expect(finish(fixture, pinned)).toEqual(unavailable); expect(revalidate(fixture, pinned, previous)).toEqual(unavailable)
    expect(get).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled()
  })
  it.each(['header-logical', 'header-native', 'final-logical', 'final-native'])('checks %s close again after native get before returning a result', mode => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture), original = fixture.adapter.get.bind(fixture.adapter)
    const get = vi.spyOn(fixture.adapter, 'get').mockImplementation((sql, ...params) => {
      const value = original(sql, ...params)
      if (mode.endsWith('logical')) fixture.logicalClosed = true; else fixture.adapter.database.close()
      return value
    })
    if (mode.startsWith('header')) expect(header(fixture, 'instance-a')).toBeNull(); else expect(finish(fixture, pinned)).toEqual(unavailable)
    expect(get).toHaveBeenCalledTimes(1)
  })
  it('denies actual native statement errors and reads no diagnostics or reopen fallback', () => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture), reopen = vi.spyOn(fixture.adapter.database, 'open')
    fixture.adapter.exec('DROP TABLE resources')
    expect(header(fixture, 'instance-a')).toBeNull(); expect(finish(fixture, pinned)).toEqual(unavailable); expect(reopen).not.toHaveBeenCalled()
  })
  it('never inspects hostile thrown diagnostic proxies in the test-local read catch', () => {
    const fixture = open(); seed(fixture); const pinned = requireHeader(fixture), touched = vi.fn((): never => { throw new Error('No diagnostics') })
    const error = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched }), original = Object.getOwnPropertyDescriptor(fixture.adapter, 'get'); let calls = 0
    let candidateResult: AgentInstanceIdentityCandidate | null | undefined, finalResult: AgentInstanceIdentityProjection | undefined
    try {
      Object.defineProperty(fixture.adapter, 'get', { configurable: true, writable: true, value: () => { calls++; throw error } })
      candidateResult = header(fixture, 'instance-a'); finalResult = finish(fixture, pinned)
    } finally { if (original) Object.defineProperty(fixture.adapter, 'get', original); else Reflect.deleteProperty(fixture.adapter, 'get') }
    expect(candidateResult).toBeNull(); expect(finalResult).toEqual(unavailable)
    expect(calls).toBe(2); expect(touched).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptor(fixture.adapter, 'get')).toEqual(original)
  })
  it('functionally applies a native length limit ONLY on a dedicated owned fixture, not an execution-work budget', () => {
    const fixture = open(), control = open(), oversized = 'x'.repeat(8192); seed(fixture)
    insert(fixture, 'magic-agent-config', 'oversized', oversized)
    const original = fixture.adapter.database.limits.length, controlLimit = control.adapter.database.limits.length
    expect(Number.isSafeInteger(original)).toBe(true); expect(original).toBeGreaterThan(8192)
    try {
      fixture.adapter.database.limits.length = 4096
      expect(fixture.adapter.database.limits.length).toBe(4096)
      expect(() => fixture.adapter.get('SELECT state_json FROM resources WHERE resource_kind = ? AND resource_id = ?', 'magic-agent-config', 'oversized')).toThrow()
      expect(() => insert(fixture, 'magic-agent-config', 'too-big', oversized)).toThrow()
      expect(fixture.adapter.get('SELECT revision FROM resources WHERE resource_kind = ? AND resource_id = ?', 'magic-agent-config', 'oversized')?.revision).toBe(9)
      requireFinal(fixture, requireHeader(fixture)); expect(control.adapter.database.limits.length).toBe(controlLimit)
    } finally { fixture.adapter.database.limits.length = original }
    expect(fixture.adapter.database.limits.length).toBe(original)
  })
  it.each(['ascii', '界', 'a\u0000界', '😀'])('checks octet_length compatibility for exact UTF8 counts only (case %#)', text => {
    const fixture = open(); expect(fixture.adapter.get('SELECT octet_length(?) AS bytes', text)?.bytes).toBe(Buffer.byteLength(text))
    // Availability/correct counts do not establish metadata-only native payload work.
  })
})
