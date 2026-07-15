import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/pages/MainPage/projectStore', () => ({
  buildProjectStorageDirName: (projectName: string, projectId: string) =>
    `${projectName}-${projectId}`,
  getProjectById: () => undefined
}))

import { resolveConfiguredProjectRoot, resolveProjectResourceDir } from './projectResourcePaths'

const originalPathDescriptor = Object.getOwnPropertyDescriptor(window, 'path')

const windowsPath = {
  join: (...segments: string[]) => segments.filter(Boolean).join('\\'),
  dirname: (value: string) => value.replace(/[\\/][^\\/]+[\\/]?$/g, '')
}

describe('projectResourcePaths', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'path', {
      configurable: true,
      value: windowsPath
    })
  })

  afterEach(() => {
    if (originalPathDescriptor) {
      Object.defineProperty(window, 'path', originalPathDescriptor)
    } else {
      Reflect.deleteProperty(window, 'path')
    }
  })

  it('uses the configured Projects directory as the project storage root', () => {
    const config = { download_dir: ' C:\\MagicPot\\Projects ' }

    expect(resolveConfiguredProjectRoot(config)).toBe('C:\\MagicPot\\Projects')
    expect(
      resolveProjectResourceDir({
        config,
        projectId: 'project-1',
        projectName: 'Demo',
        segments: ['Images']
      })
    ).toBe('C:\\MagicPot\\Projects\\Demo-project-1\\Images')
  })

  it.each([
    [['.AutoSave', 'Agent'], 'C:\\MagicPot\\AutoSave\\Agent'],
    [['.AutoSave', 'QuickApp', 'Images'], 'C:\\MagicPot\\AutoSave\\QuickApp\\Images'],
    [['.AutoSave', 'QuickApp', 'Texts'], 'C:\\MagicPot\\AutoSave\\QuickApp\\Texts'],
    [['.AutoSave', 'QuickApp', 'Videos'], 'C:\\MagicPot\\AutoSave\\QuickApp\\Videos']
  ])('resolves %j beside Projects', (segments, expected) => {
    expect(
      resolveProjectResourceDir({
        config: { download_dir: 'C:\\MagicPot\\Projects' },
        projectId: 'project-1',
        projectName: 'Demo',
        segments
      })
    ).toBe(expected)
  })

  it('does not repeat Projects or nest AutoSave under a project', () => {
    const projectDir = resolveProjectResourceDir({
      config: { download_dir: 'C:\\MagicPot\\Projects' },
      projectId: 'project-1',
      projectName: 'Demo'
    })
    const autoSaveDir = resolveProjectResourceDir({
      config: { download_dir: 'C:\\MagicPot\\Projects' },
      projectId: 'project-1',
      projectName: 'Demo',
      segments: ['.AutoSave', 'QuickApp', 'Images']
    })

    expect(projectDir).not.toContain('Projects\\Projects')
    expect(autoSaveDir).toBe('C:\\MagicPot\\AutoSave\\QuickApp\\Images')
    expect(autoSaveDir).not.toContain('Demo-project-1')
  })
})
