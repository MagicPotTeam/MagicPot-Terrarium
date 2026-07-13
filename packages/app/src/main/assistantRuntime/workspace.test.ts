import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const { buildDataDirRef } = vi.hoisted(() => ({
  buildDataDirRef: { current: process.cwd() }
}))

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({
    pathMap: {
      data: buildDataDirRef.current
    }
  })
}))

import {
  getAssistantWorkspaceIdentityState,
  readAssistantWorkspaceMetaById,
  updateAssistantWorkspaceMeta
} from './workspace'

describe('assistant workspace metadata persistence', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await createNodeTestArtifactDir('assistant-workspace-metadata')
    buildDataDirRef.current = tempDir
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    buildDataDirRef.current = process.cwd()
    vi.restoreAllMocks()
  })

  it('serializes concurrent updates to the same workspace without losing changes', async () => {
    const workspace = getAssistantWorkspaceIdentityState('concurrent-updates')
    const notes = Array.from({ length: 8 }, (_, index) => `note-${index + 1}`)

    await Promise.all(
      notes.map((appendSharedNote) =>
        updateAssistantWorkspaceMeta(workspace, {
          appendSharedNote
        })
      )
    )

    const persisted = await readAssistantWorkspaceMetaById(workspace.workspaceId)
    expect(persisted?.sharedNotes).toEqual(notes)
    expect(JSON.parse(await fs.readFile(workspace.workspaceMetaFile, 'utf8')).sharedNotes).toEqual(
      notes
    )
  })

  it('preserves committed metadata and accepts later mutations after an atomic write fails', async () => {
    const workspace = getAssistantWorkspaceIdentityState('failed-write-recovery')
    await updateAssistantWorkspaceMeta(workspace, {
      title: 'Committed title',
      appendSharedNote: 'committed note'
    })
    const committedFile = await fs.readFile(workspace.workspaceMetaFile, 'utf8')
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))

    await expect(
      updateAssistantWorkspaceMeta(workspace, {
        title: 'Uncommitted title',
        appendSharedNote: 'uncommitted note'
      })
    ).rejects.toThrow('rename failed')

    expect(await fs.readFile(workspace.workspaceMetaFile, 'utf8')).toBe(committedFile)
    expect(
      (await fs.readdir(path.dirname(workspace.workspaceMetaFile))).filter((name) =>
        name.endsWith('.tmp')
      )
    ).toEqual([])

    renameSpy.mockRestore()
    await updateAssistantWorkspaceMeta(workspace, { appendSharedNote: 'recovered note' })

    expect(await readAssistantWorkspaceMetaById(workspace.workspaceId)).toMatchObject({
      title: 'Committed title',
      sharedNotes: ['committed note', 'recovered note']
    })
  })
})
