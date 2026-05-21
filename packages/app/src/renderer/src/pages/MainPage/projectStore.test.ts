import { beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_PROJECTS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  buildProjectStorageDirName,
  getProjectById,
  listProjects,
  saveProjects,
  setProjectDefaultQAppKey
} from './projectStore'

describe('projectStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prefixes generated project storage root names with a dot', () => {
    expect(buildProjectStorageDirName('Project 1', 'tab-project-1')).toBe(
      '.Project 1__tab-project-1'
    )
  })

  it('migrates the legacy homepage project list into the unified project registry', () => {
    localStorage.setItem(
      LEGACY_PROJECTS_STORAGE_KEY,
      JSON.stringify([{ id: 'tab-project-1', name: 'Project 1', createdAt: 1711324800000 }])
    )

    const projects = listProjects()

    expect(projects).toEqual([
      {
        id: 'tab-project-1',
        name: 'Project 1',
        createdAt: 1711324800000,
        updatedAt: 1711324800000,
        canvasStorageKey: 'tab-project-1',
        chatStorageScopePrefix: 'tab-project-1',
        defaultQAppKey: '',
        storageDirName: buildProjectStorageDirName('Project 1', 'tab-project-1')
      }
    ])
    expect(JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) || '[]')).toHaveLength(1)
  })

  it('normalizes stored legacy project root names to hidden generated roots', () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'tab-project-1',
          name: 'Project 1',
          createdAt: 1711324800000,
          updatedAt: 1711324800000,
          canvasStorageKey: 'tab-project-1',
          chatStorageScopePrefix: 'tab-project-1',
          defaultQAppKey: '',
          storageDirName: 'Project 1__tab-project-1'
        }
      ])
    )

    expect(listProjects()[0]?.storageDirName).toBe('.Project 1__tab-project-1')
  })

  it('falls back to a generated hidden project root when stored root names are invalid', () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'tab-project-1',
          name: 'Project 1',
          createdAt: 1711324800000,
          updatedAt: 1711324800000,
          storageDirName: '...'
        }
      ])
    )

    expect(listProjects()[0]?.storageDirName).toBe('.Project 1__tab-project-1')
  })

  it('tracks the default quick app selection inside the unified project record', () => {
    saveProjects([
      {
        id: 'tab-project-2',
        name: 'Project 2',
        createdAt: 1711324800000,
        updatedAt: 1711324800000,
        canvasStorageKey: 'tab-project-2',
        chatStorageScopePrefix: 'tab-project-2',
        defaultQAppKey: '',
        storageDirName: buildProjectStorageDirName('Project 2', 'tab-project-2')
      }
    ])

    setProjectDefaultQAppKey('tab-project-2', '~builtin/hunyuan3d/concept')

    expect(getProjectById('tab-project-2')?.defaultQAppKey).toBe('~builtin/hunyuan3d/concept')
  })
})
