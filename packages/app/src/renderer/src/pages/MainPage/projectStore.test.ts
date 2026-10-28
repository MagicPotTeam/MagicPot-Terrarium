import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_PROJECTS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  PROJECTS_CHANGED_EVENT,
  buildProjectStorageDirName,
  createProjectRecord,
  getProjectById,
  listProjects,
  saveProjects,
  trySaveProjects,
  setProjectDefaultQAppKey,
  touchProjectOpen,
  updateProjectName,
  updateProjectAnalysisDetails
} from './projectStore'

const base = { id: 'tab-project-1', name: 'Project 1', createdAt: 1711324800000 }

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('projectStore', () => {
  it('prefixes generated project storage root names with a dot', () => {
    expect(buildProjectStorageDirName('Project 1', 'tab-project-1')).toBe(
      '.Project 1__tab-project-1'
    )
  })

  it('migrates the legacy homepage project list without adding optional analysis fields', () => {
    localStorage.setItem(LEGACY_PROJECTS_STORAGE_KEY, JSON.stringify([base]))
    expect(listProjects()).toEqual([
      {
        ...base,
        updatedAt: base.createdAt,
        canvasStorageKey: base.id,
        chatStorageScopePrefix: base.id,
        defaultQAppKey: '',
        storageDirName: buildProjectStorageDirName(base.name, base.id)
      }
    ])
    expect(JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) || '[]')).toHaveLength(1)
  })

  it('normalizes stored legacy project root names to hidden generated roots', () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ ...base, storageDirName: 'Project 1__tab-project-1' }])
    )
    expect(listProjects()[0]?.storageDirName).toBe('.Project 1__tab-project-1')
  })

  it('falls back to a generated hidden project root when stored root names are invalid', () => {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ ...base, storageDirName: '...' }]))
    expect(listProjects()[0]?.storageDirName).toBe('.Project 1__tab-project-1')
  })

  it('tracks the default quick app selection inside the unified project record', () => {
    saveProjects([createProjectRecord(base)])
    setProjectDefaultQAppKey(base.id, '~builtin/hunyuan3d/concept')
    expect(getProjectById(base.id)?.defaultQAppKey).toBe('~builtin/hunyuan3d/concept')
  })

  it('creates manual records and roundtrips a maximum-length multiline introduction and model reference', () => {
    const introduction = 'Line one\n' + 'x'.repeat(3990) + '\n'
    const analysisProfileId = 'p'.repeat(512)
    expect(introduction).toHaveLength(4000)
    const record = createProjectRecord({ ...base, introduction, analysisProfileId })
    saveProjects([record])
    expect(getProjectById(base.id)).toEqual(record)
    expect(record.analysisMode).toBe('manual')
    expect(JSON.parse(localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY) ?? '[]')).toEqual([base])
  })

  it('preserves analysis details, storage identity, qapp and open fields across name edits', () => {
    const record = {
      ...createProjectRecord({
        ...base,
        introduction: 'First\n second\n',
        analysisProfileId: 'profile-1'
      }),
      lastOpenedAt: 100,
      defaultQAppKey: 'chosen'
    }
    saveProjects([record])
    updateProjectName(base.id, 'Renamed')
    expect(getProjectById(base.id)).toEqual({
      ...record,
      name: 'Renamed',
      updatedAt: expect.any(Number)
    })
    touchProjectOpen(base.id)
    setProjectDefaultQAppKey(base.id, 'next')
    expect(getProjectById(base.id)).toMatchObject({
      name: 'Renamed',
      introduction: record.introduction,
      analysisProfileId: 'profile-1',
      analysisMode: 'manual',
      storageDirName: record.storageDirName,
      defaultQAppKey: 'next',
      lastOpenedAt: expect.any(Number)
    })
  })

  it('updates only supplied details and makes explicitly configured comparison projects manual', () => {
    localStorage.setItem(LEGACY_PROJECTS_STORAGE_KEY, JSON.stringify([base]))
    updateProjectAnalysisDetails(base.id, {
      introduction: '  Context\n',
      analysisProfileId: 'missing-profile'
    })
    expect(getProjectById(base.id)).toMatchObject({
      introduction: '  Context\n',
      analysisProfileId: 'missing-profile'
    })
    expect(getProjectById(base.id)?.analysisMode).toBe('manual')
    updateProjectAnalysisDetails(base.id, { introduction: 'Changed' })
    expect(getProjectById(base.id)?.analysisProfileId).toBe('missing-profile')
    updateProjectAnalysisDetails(base.id, { introduction: '', analysisProfileId: '' })
    expect(getProjectById(base.id)?.introduction).toBe('')
    expect(getProjectById(base.id)).not.toHaveProperty('analysisProfileId')
  })

  it.each([
    { introduction: 123, analysisProfileId: { api_key: 'secret' }, analysisMode: 'realtime' },
    { introduction: 'x'.repeat(4001), analysisProfileId: 'x'.repeat(513), analysisMode: false },
    { introduction: null, analysisProfileId: '   ', analysisMode: {} }
  ])('ignores invalid legacy optional fields without dropping the project', (invalid) => {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ ...base, ...invalid }]))
    const [project] = listProjects()
    expect(project.id).toBe(base.id)
    expect(project).not.toHaveProperty('introduction')
    expect(project).not.toHaveProperty('analysisProfileId')
    expect(project).not.toHaveProperty('analysisMode')
  })

  it('rejects oversize explicit details instead of silently truncating', () => {
    expect(() => createProjectRecord({ ...base, name: '' })).toThrow('Invalid project name.')
    expect(() => createProjectRecord({ ...base, name: 'x'.repeat(121) })).toThrow(
      'Invalid project name.'
    )
    expect(() => createProjectRecord({ ...base, introduction: 'x'.repeat(4001) })).toThrow(
      'Invalid project analysis details.'
    )
    expect(() => createProjectRecord({ ...base, analysisProfileId: 'x'.repeat(513) })).toThrow(
      'Invalid project analysis details.'
    )
    expect(() => updateProjectAnalysisDetails(base.id, { introduction: 'x'.repeat(4001) })).toThrow(
      'Invalid project analysis details.'
    )
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBeNull()
    expect(createProjectRecord({ ...base, name: 'x'.repeat(120) }).name).toHaveLength(120)
  })

  it('persists only known scalar fields, never profile objects, URLs or credentials', () => {
    const record = {
      ...createProjectRecord({ ...base, analysisProfileId: 'profile-chat' }),
      profile: { api_key: 'secret' },
      baseURL: 'https://private.invalid',
      apiKey: 'secret',
      analysisProfile: { id: 'profile-chat' }
    }
    saveProjects([record])
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY) ?? ''
    expect(raw).not.toMatch(/secret|private\.invalid|apiKey|baseURL|analysisProfile"/)
    expect(listProjects()[0]?.analysisProfileId).toBe('profile-chat')
  })

  it('reports explicit persistence failure without events while preserving best-effort legacy reads', () => {
    localStorage.setItem(LEGACY_PROJECTS_STORAGE_KEY, JSON.stringify([base]))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private error')
    })
    const changed = vi.fn()
    window.addEventListener(PROJECTS_CHANGED_EVENT, changed)
    try {
      expect(trySaveProjects([createProjectRecord(base)])).toBeNull()
      expect(changed).not.toHaveBeenCalled()
      expect(listProjects()[0]?.id).toBe(base.id)
      expect(() => updateProjectAnalysisDetails(base.id, { introduction: 'New' })).toThrow(
        'Unable to save project details.'
      )
      expect(changed).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(PROJECTS_CHANGED_EVENT, changed)
    }
  })

  it('treats a successful registry write as success even if the legacy mirror is unavailable', () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === LEGACY_PROJECTS_STORAGE_KEY) throw new Error('mirror unavailable')
      original.call(this, key, value)
    })
    const record = createProjectRecord(base)
    expect(trySaveProjects([record])).toEqual([record])
    expect(JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) ?? '[]')).toEqual([record])
  })
})
