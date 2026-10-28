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
  ASSISTANT_WORKSPACE_RETENTION,
  ensureAssistantWorkspaceBinding,
  clearAssistantReusableContext,
  getAssistantWorkspaceIdentityState,
  getAssistantWorkspaceState,
  readAssistantContextSnapshotFromFile,
  readAssistantTaskContextFromFile,
  readAssistantWorkspaceMetaById,
  persistAssistantContextSnapshot,
  updateAssistantTaskContext,
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
    vi.useRealTimers()
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

  it('expires completed task context while preserving an active run', async () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 9, 26, 12, 0, 0)
    vi.setSystemTime(now)
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'task-retention' }
    const workspace = getAssistantWorkspaceState(route, 'task-retention')
    const staleAt = now - ASSISTANT_WORKSPACE_RETENTION.taskContextTtlMs - 1

    await updateAssistantTaskContext(workspace, {
      route,
      runId: 'completed-run',
      workspaceId: workspace.workspaceId,
      status: 'completed',
      updatedAt: staleAt
    })
    expect(await readAssistantTaskContextFromFile(workspace.taskContextFile)).toBeUndefined()
    await expect(fs.access(workspace.taskContextFile)).rejects.toMatchObject({ code: 'ENOENT' })

    await updateAssistantTaskContext(workspace, {
      route,
      runId: 'active-run',
      workspaceId: workspace.workspaceId,
      status: 'running',
      updatedAt: staleAt
    })
    expect(await readAssistantTaskContextFromFile(workspace.taskContextFile)).toMatchObject({
      latestStatus: 'running',
      recentRuns: [expect.objectContaining({ runId: 'active-run', status: 'running' })]
    })
  })

  it('fails closed when persisted task timestamps are missing', async () => {
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'task-invalid-time' }
    const workspace = getAssistantWorkspaceState(route, 'task-invalid-time')
    await fs.mkdir(path.dirname(workspace.taskContextFile), { recursive: true })
    await fs.writeFile(
      workspace.taskContextFile,
      JSON.stringify({
        route,
        updatedAt: Date.now(),
        recentRuns: [{ runId: 'run-without-time', status: 'completed' }]
      }),
      'utf8'
    )
    expect(await readAssistantTaskContextFromFile(workspace.taskContextFile)).toBeUndefined()
    await expect(fs.access(workspace.taskContextFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent task updates without dropping recent runs', async () => {
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'task-concurrency' }
    const workspace = getAssistantWorkspaceState(route, 'task-concurrency')
    const runIds = Array.from({ length: 8 }, (_, index) => `run-${index + 1}`)

    await Promise.all(
      runIds.map((runId) =>
        updateAssistantTaskContext(workspace, {
          route,
          runId,
          workspaceId: workspace.workspaceId,
          status: 'completed',
          requestText: runId
        })
      )
    )

    const persisted = await readAssistantTaskContextFromFile(workspace.taskContextFile)
    expect(persisted?.recentRuns.map((run) => run.runId).sort()).toEqual(runIds)
    expect(persisted?.recentRuns.map((run) => run.requestText).sort()).toEqual(runIds)
  })

  it('removes oversized persisted context before parsing it', async () => {
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'context-quota' }
    const workspace = getAssistantWorkspaceState(route, 'context-quota')
    await fs.mkdir(path.dirname(workspace.contextFile), { recursive: true })
    await fs.writeFile(
      workspace.contextFile,
      JSON.stringify({
        payload: 'x'.repeat(ASSISTANT_WORKSPACE_RETENTION.maxContextSnapshotBytes)
      }),
      'utf8'
    )
    expect(await readAssistantContextSnapshotFromFile(workspace.contextFile)).toBeUndefined()
    await expect(fs.access(workspace.contextFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes expired context snapshots before returning reusable state', async () => {
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'context-expiry' }
    const workspace = getAssistantWorkspaceState(route, 'context-expiry')
    await fs.mkdir(path.dirname(workspace.contextFile), { recursive: true })
    await fs.writeFile(
      workspace.contextFile,
      JSON.stringify({
        generatedAt: Date.now() - ASSISTANT_WORKSPACE_RETENTION.contextSnapshotTtlMs - 1
      }),
      'utf8'
    )
    expect(await readAssistantContextSnapshotFromFile(workspace.contextFile)).toBeUndefined()
    await expect(fs.access(workspace.contextFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears the context snapshot together with reusable session state', async () => {
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'context-clear' }
    const workspace = getAssistantWorkspaceState(route, 'context-clear')
    await persistAssistantContextSnapshot(workspace, {
      clientId: 'client-1',
      sessionKey: 'generic:dm:context-clear',
      workspaceId: workspace.workspaceId,
      route,
      generatedAt: Date.now(),
      workflowDir: 'workflow',
      outputDir: 'output',
      downloadDir: 'download',
      useRemoteComfyUI: false,
      useRemoteLLM: false,
      localLLMServerEnabled: false
    })
    await clearAssistantReusableContext(workspace)
    await expect(fs.access(workspace.contextFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the last context snapshot when an atomic replacement fails', async () => {
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'snapshot-atomic' }
    const workspace = getAssistantWorkspaceState(route, 'snapshot-atomic')
    const first = {
      clientId: 'client-1',
      sessionKey: 'generic:dm:snapshot-atomic',
      workspaceId: workspace.workspaceId,
      route,
      generatedAt: 1,
      workflowDir: 'workflow-a',
      outputDir: 'output-a',
      downloadDir: 'download-a',
      useRemoteComfyUI: false,
      useRemoteLLM: false,
      localLLMServerEnabled: false
    }
    await persistAssistantContextSnapshot(workspace, first)
    const committed = await fs.readFile(workspace.contextFile, 'utf8')
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))

    await expect(
      persistAssistantContextSnapshot(workspace, { ...first, generatedAt: 2 })
    ).rejects.toThrow('rename failed')

    expect(await fs.readFile(workspace.contextFile, 'utf8')).toBe(committed)
    expect(
      (await fs.readdir(path.dirname(workspace.contextFile))).filter((name) =>
        name.endsWith('.tmp')
      )
    ).toEqual([])
    renameSpy.mockRestore()
  })

  it('fails closed when sanitized workspace ids resolve to one identity directory', async () => {
    const first = getAssistantWorkspaceIdentityState('team/a')
    const colliding = getAssistantWorkspaceIdentityState('team_a')
    expect(colliding.workspaceMetaFile).toBe(first.workspaceMetaFile)

    await updateAssistantWorkspaceMeta(first, { title: 'first workspace' })

    await expect(readAssistantWorkspaceMetaById(colliding.workspaceId)).rejects.toThrow(
      'Workspace identity collision'
    )
    await expect(
      updateAssistantWorkspaceMeta(colliding, { title: 'must not overwrite' })
    ).rejects.toThrow('Workspace identity collision')

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'collision' }
    const collidingState = getAssistantWorkspaceState(route, colliding.workspaceId)
    await expect(ensureAssistantWorkspaceBinding(collidingState, route)).rejects.toThrow(
      'Workspace identity collision'
    )

    await expect(readAssistantWorkspaceMetaById(first.workspaceId)).resolves.toMatchObject({
      workspaceId: first.workspaceId,
      title: 'first workspace'
    })
  })
})
