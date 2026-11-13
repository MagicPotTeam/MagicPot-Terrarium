import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECTS_STORAGE_KEY } from '../MainPage/projectStore'
import { readManagementPaneSnapshot } from './managementPaneMetadata'

const project = (id = 'tab-project-p', name = 'Project') => ({ id, name, chatStorageScopePrefix: id, storageDirName: 'PATH_NOT_FOR_DTO', introduction: 'CONTENT_NOT_FOR_DTO' })
const paneKey = (id = 'tab-project-p') => `agent.workspace.${id}`
function fixture(projects = [project()], panes = [{ id: 'agent-1', enabled: true }, { id: 'agent-2', enabled: false }]) {
  const data = new Map([[PROJECTS_STORAGE_KEY, JSON.stringify(projects)], [paneKey(), JSON.stringify(panes)]])
  return { data, getItem: vi.fn((key: string) => data.get(key) ?? null) }
}
beforeEach(() => localStorage.clear())
describe('strict management project/pane metadata snapshot', () => {
  it('projects only known existing enabled associations without normalizing or writing storage', () => {
    const storage = fixture(); const result = readManagementPaneSnapshot(storage)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Expected ready metadata')
    expect(result.owners).toEqual([{ projectId: 'tab-project-p', projectName: 'Project', paneId: 'agent-1', storageScope: 'tab-project-p.agent-1' }])
    expect(JSON.stringify(result.owners)).not.toMatch(/PATH_NOT_FOR_DTO|CONTENT_NOT_FOR_DTO/)
    expect(storage.getItem.mock.calls.map(([key]) => key)).toEqual([PROJECTS_STORAGE_KEY, paneKey()])
    expect(result.isCurrent()).toBe(true)
    storage.data.set(paneKey(), JSON.stringify([{ id: 'agent-1', enabled: false }]))
    expect(result.isCurrent()).toBe(false)
  })
  it('uses canonical empty registry as empty without reading legacy or fabricating default panes', () => {
    const storage = fixture([])
    expect(readManagementPaneSnapshot(storage)).toMatchObject({ status: 'ready', owners: [] })
    expect(storage.getItem).toHaveBeenCalledTimes(1)
  })
  it.each([null, '', '{', '{}', '[null]', '[{"id":"p","name":"P"}]'])('does not migrate/fabricate canonical registry %s', (raw) => {
    const storage = fixture(); if (raw === null) storage.data.delete(PROJECTS_STORAGE_KEY); else storage.data.set(PROJECTS_STORAGE_KEY, raw)
    expect(readManagementPaneSnapshot(storage).status).toBe('unavailable')
  })
  it.each([null, '', '{', '{}', '[null]', '[{"id":"agent-1"}]', '[{"id":"agent-1","enabled":"yes"}]'])('does not default missing/malformed pane metadata %s to agent-1', (raw) => {
    const storage = fixture(); if (raw === null) storage.data.delete(paneKey()); else storage.data.set(paneKey(), raw)
    expect(readManagementPaneSnapshot(storage).status).toBe('unavailable')
  })
  it('accepts valid empty/all-disabled pane lists without enabling or inventing a pane', () => {
    expect(readManagementPaneSnapshot(fixture([project()], []))).toMatchObject({ status: 'ready', owners: [] })
    expect(readManagementPaneSnapshot(fixture([project()], [{ id: 'agent-1', enabled: false }]))).toMatchObject({ status: 'ready', owners: [] })
  })
  it('rejects duplicate project IDs, duplicate pane IDs and inconsistent scope prefix', () => {
    expect(readManagementPaneSnapshot(fixture([project(), project()])).status).toBe('unavailable')
    expect(readManagementPaneSnapshot(fixture([project()], [{ id: 'agent-1', enabled: true }, { id: 'agent-1', enabled: false }])).status).toBe('unavailable')
    expect(readManagementPaneSnapshot(fixture([{ ...project(), chatStorageScopePrefix: 'other' }])).status).toBe('unavailable')
  })
  it('rejects distinct known project/pane tuples that construct the same flattened scope', () => {
    const storage = fixture([project('p.a'), project('p')]); storage.data.set(paneKey('p.a'), '[{"id":"b","enabled":true}]'); storage.data.set(paneKey('p'), '[{"id":"a.b","enabled":true}]')
    expect(readManagementPaneSnapshot(storage).status).toBe('unavailable')
  })
  it('returns unavailable on storage denial and marks a previously ready snapshot stale on later denial', () => {
    const denied = { getItem: () => { throw new Error('Denied') } }; expect(readManagementPaneSnapshot(denied).status).toBe('unavailable')
    const storage = fixture(); const result = readManagementPaneSnapshot(storage); expect(result.status).toBe('ready')
    storage.getItem.mockImplementation(denied.getItem)
    if (result.status === 'ready') expect(result.isCurrent()).toBe(false)
  })
  it.each([0, 1, 31, 127])('rejects ambiguous/control-bearing project and pane identifiers %i', (code) => {
    const bad = `bad${String.fromCharCode(code)}id`
    expect(readManagementPaneSnapshot(fixture([project(bad)])).status).toBe('unavailable')
    expect(readManagementPaneSnapshot(fixture([project()], [{ id: bad, enabled: true }])).status).toBe('unavailable')
  })
  it('treats changed registry/deleted project, overlong input and excess pane count as non-authoritative', () => {
    const storage = fixture()
    const snapshot = readManagementPaneSnapshot(storage)
    expect(snapshot.status).toBe('ready')
    storage.data.set(PROJECTS_STORAGE_KEY, '[]')
    if (snapshot.status === 'ready') expect(snapshot.isCurrent()).toBe(false)
    const huge = fixture(); huge.data.set(PROJECTS_STORAGE_KEY, ' '.repeat(512 * 1024 + 1))
    expect(readManagementPaneSnapshot(huge)).toEqual({ status: 'unavailable', reason: 'limit-exceeded' })
    expect(readManagementPaneSnapshot(fixture([project()], Array.from({ length: 257 }, (_, i) => ({ id: `agent-${i}`, enabled: true }))))).toEqual({ status: 'unavailable', reason: 'limit-exceeded' })
  })
  it('bounds registry and pane cardinality instead of returning a silently partial overview', () => {
    const storage = fixture(Array.from({ length: 257 }, (_, i) => project(`p${i}`)))
    expect(readManagementPaneSnapshot(storage)).toEqual({ status: 'unavailable', reason: 'limit-exceeded' })
  })
})
