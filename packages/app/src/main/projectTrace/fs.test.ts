import fs from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV, type BuildEnv } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { buildProjectStorageDirName } from '@shared/projectStorage'
import {
  PROJECT_TRACE_DIR_NAME,
  PROJECT_TRACE_DOCUMENT_FILENAME,
  PROJECT_TRACE_REFERENCE_PACK_FILENAME
} from '@shared/projectTrace'
import { ProjectTraceFSCli } from './fs'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => 'C:\\magicpot-project-trace-user-data'
  }
}))

async function createCli() {
  const tempParent = path.join(process.cwd(), '.tmp', 'project-trace-tests')
  await fs.mkdir(tempParent, { recursive: true })
  const tempRoot = await fs.mkdtemp(path.join(tempParent, 'case-'))
  const projectRoot = path.join(tempRoot, 'projects')
  const dataRoot = path.join(tempRoot, 'data')
  await fs.mkdir(projectRoot, { recursive: true })
  await fs.mkdir(dataRoot, { recursive: true })

  const config: Config = {
    ...DEFAULT_CONFIG,
    download_dir: projectRoot
  }
  const buildEnv: BuildEnv = {
    ...DEFAULT_BUILD_ENV,
    pathMap: {
      resources: tempRoot,
      file: tempRoot,
      data: dataRoot
    }
  }
  const projectId = 'canvas-1'
  const projectName = 'Trace Project'
  const projectStorageDirName = buildProjectStorageDirName(projectName, projectId)
  const project = {
    projectId,
    projectName,
    projectStorageDirName,
    projectRootDir: path.join(projectRoot, projectStorageDirName)
  }

  return {
    cli: new ProjectTraceFSCli(config, buildEnv),
    config,
    buildEnv,
    project,
    tempRoot
  }
}

describe('ProjectTraceFSCli', () => {
  it('does not create trace storage when listing or reading missing traces', async () => {
    const { cli, project } = await createCli()
    const traceDir = path.join(project.projectRootDir, 'traces')

    await expect(fs.stat(traceDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(cli.listTraces(project)).resolves.toEqual([])
    await expect(cli.readTrace(project, 'missing-trace')).resolves.toBeNull()
    await expect(fs.stat(traceDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects trace directories that resolve outside the project trace root', async () => {
    const { cli, config, buildEnv, project, tempRoot } = await createCli()
    const outsideDownloadDir = path.join(tempRoot, 'outside-projects')
    const outsideProject = {
      ...project,
      projectRootDir: path.join(outsideDownloadDir, project.projectStorageDirName || '')
    }
    const outsideCli = new ProjectTraceFSCli(
      {
        ...config,
        download_dir: outsideDownloadDir
      },
      buildEnv
    )
    const outsideTrace = await outsideCli.saveTrace(outsideProject, {
      id: 'trace-escape',
      name: 'Outside trace',
      sourceKind: 'manual',
      markdown: 'This trace lives outside the allowed project root.'
    })
    const traceRoot = await cli.getProjectTraceDir(project)
    const linkPath = path.join(traceRoot, outsideTrace.manifest.id)
    const outsideTraceDir = path.join(
      outsideProject.projectRootDir,
      'traces',
      outsideTrace.manifest.id
    )

    try {
      await fs.symlink(outsideTraceDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        return
      }
      throw error
    }

    await expect(cli.readTrace(project, outsideTrace.manifest.id)).rejects.toThrow(
      /escaped the trace directory/
    )
  })

  it('rejects symlinked project parents before creating trace storage', async () => {
    const { cli, config, project, tempRoot } = await createCli()
    const outsideBase = path.join(tempRoot, 'outside-parent-target')
    const linkedParent = path.join(config.download_dir, 'linked-parent')
    const escapedProject = {
      ...project,
      projectRootDir: path.join(linkedParent, project.projectStorageDirName || '')
    }
    const escapedTraceDir = path.join(escapedProject.projectRootDir, 'traces')

    await fs.mkdir(outsideBase, { recursive: true })
    try {
      await fs.symlink(outsideBase, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        return
      }
      throw error
    }

    await expect(cli.getProjectTraceDir(escapedProject)).rejects.toThrow(
      /outside the allowed project storage roots/
    )
    await expect(fs.stat(escapedTraceDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects trace files that resolve outside the trace directory', async () => {
    const { cli, project, tempRoot } = await createCli()
    const saved = await cli.saveTrace(project, {
      id: 'trace-file-escape',
      name: 'File escape',
      sourceKind: 'manual',
      markdown: 'Original safe trace document.'
    })
    const outsideDocument = path.join(tempRoot, 'outside-document.md')
    const traceDocumentPath = path.join(
      project.projectRootDir,
      PROJECT_TRACE_DIR_NAME,
      saved.manifest.id,
      PROJECT_TRACE_DOCUMENT_FILENAME
    )

    await fs.writeFile(outsideDocument, 'Outside content must not be read.', 'utf8')
    await fs.rm(traceDocumentPath)
    try {
      await fs.symlink(outsideDocument, traceDocumentPath, 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        return
      }
      throw error
    }

    await expect(cli.readTrace(project, saved.manifest.id)).rejects.toThrow(
      /Project trace file escaped the trace directory/
    )
  })

  it('stores redacted project trace documents under the project trace directory', async () => {
    const { cli, project } = await createCli()

    const trace = await cli.saveTrace(project, {
      name: 'Target run',
      sourceKind: 'canvas_target',
      markdown:
        'Used C:\\Users\\alice\\secret\\file.png with token=abcd123456 and email a@example.com.',
      eventSummaries: [
        {
          id: 'event-1',
          at: '2026-05-03T08:00:00.000Z',
          scope: 'target',
          action: 'run_target',
          status: 'success',
          safeSummary: 'Completed with sk-testsecretvalue1234567890'
        }
      ]
    })

    expect(trace.manifest.redaction.containsSensitiveData).toBe(false)
    expect(trace.markdown).toContain('[redacted-local-path]')
    expect(trace.markdown).toContain('token=[redacted]')
    expect(trace.markdown).toContain('[redacted-email]')
    expect(trace.eventSummaries?.[0].safeSummary).toContain('[redacted-api-key]')
    expect(trace.skillSummary?.summary).toContain('1 个脱敏操作摘要')
    expect(trace.executableRules?.rules).toEqual([])
    expect(trace.referencePack?.contentBrief).not.toContain('C:\\Users\\alice')
    expect(trace.referencePack?.runtimePolicy).toMatchObject({
      allowRealtime: true,
      allowTargetReference: true,
      allowModelReview: true,
      allowTerminal: false
    })

    const traces = await cli.listTraces(project)
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      id: trace.manifest.id,
      storageRelativePath: `traces/${trace.manifest.id}`,
      containsSensitiveData: false
    })
    expect(traces[0].referencePack?.contentBrief).toBeTruthy()
    const references = await cli.readTraceReferences(project, [trace.manifest.id], 4000)
    expect(references[0].contentPreview.length).toBeLessThanOrEqual(1603)
    expect(references[0].referencePack?.contentBrief).toBe(references[0].contentPreview)
  })

  it('exports a trace zip for manual project-folder transfer', async () => {
    const { cli, project } = await createCli()
    const saved = await cli.saveTrace(project, {
      name: 'Reusable trace',
      sourceKind: 'manual',
      description: '目的：记录图片移动限制。实时规则：指标：单次移动距离，触发条件：> 500px。',
      markdown: 'Safe reusable workflow notes.'
    })

    const exported = await cli.exportTrace(project, saved.manifest.id)
    expect(exported.mimeType).toBe('application/zip')
    expect(exported.fileName).toContain(saved.manifest.id)
    expect(exported.data.byteLength).toBeGreaterThan(0)

    const zip = await JSZip.loadAsync(exported.data)
    expect(zip.file(`${saved.manifest.id}/manifest.json`)).toBeTruthy()
    expect(zip.file(`${saved.manifest.id}/document.md`)).toBeTruthy()
    expect(zip.file(`${saved.manifest.id}/skill-summary.json`)).toBeTruthy()
    expect(zip.file(`${saved.manifest.id}/executable-rules.json`)).toBeTruthy()
    expect(zip.file(`${saved.manifest.id}/${PROJECT_TRACE_REFERENCE_PACK_FILENAME}`)).toBeTruthy()
    expect(zip.file(`${saved.manifest.id}/redaction-report.json`)).toBeTruthy()
    expect(zip.file(`${saved.manifest.id}/integrity.json`)).toBeTruthy()

    await cli.deleteTrace(project, saved.manifest.id)
    const traceRoot = await cli.getProjectTraceDir(project)
    for (const file of Object.values(zip.files)) {
      if (file.dir) continue
      const targetPath = path.join(traceRoot, file.name)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, await file.async('nodebuffer'))
    }

    const traces = await cli.listTraces(project)
    expect(traces).toHaveLength(1)
    expect(traces[0].id).toBe(saved.manifest.id)
    const imported = await cli.readTrace(project, saved.manifest.id)
    expect(imported?.executableRules?.rules[0]?.condition.value).toBe(500)
    expect(imported?.manifest.runtimePolicy?.allowTargetReference).toBe(false)
    await expect(cli.readTraceReferences(project, [saved.manifest.id])).resolves.toEqual([])
    await cli.trustTraceForReferences(project, saved.manifest.id)
    await expect(cli.readTraceReferences(project, [saved.manifest.id])).resolves.toHaveLength(1)
    expect((await cli.listTraces(project))[0].runtimePolicy?.allowTargetReference).toBe(true)
  })

  it('does not expose references from traces bound to a different project id', async () => {
    const { cli, project } = await createCli()
    const saved = await cli.saveTrace(project, {
      id: 'trace-foreign-project',
      name: 'Foreign project trace',
      sourceKind: 'manual',
      projectId: 'another-project',
      markdown: 'This trace was copied from another project.'
    })

    await expect(cli.readTraceReferences(project, [saved.manifest.id])).resolves.toEqual([])
    await expect(cli.readTrace(project, saved.manifest.id)).resolves.toMatchObject({
      manifest: {
        id: saved.manifest.id,
        projectId: 'another-project'
      }
    })
  })

  it('does not expose references for trace files copied without this machine trust registry', async () => {
    const { cli, config, buildEnv, project, tempRoot } = await createCli()
    const saved = await cli.saveTrace(project, {
      id: 'trace-copied-without-registry',
      name: 'Copied trace',
      sourceKind: 'manual',
      markdown: 'A trace folder exists but has not been trusted on this machine.'
    })
    const freshDataRoot = path.join(tempRoot, 'fresh-local-data')
    await fs.mkdir(freshDataRoot, { recursive: true })
    const freshCli = new ProjectTraceFSCli(config, {
      ...buildEnv,
      pathMap: {
        ...buildEnv.pathMap,
        data: freshDataRoot
      }
    })

    await expect(freshCli.readTrace(project, saved.manifest.id)).resolves.toMatchObject({
      manifest: {
        id: saved.manifest.id
      }
    })
    expect((await freshCli.listTraces(project))[0].localTrust).toMatchObject({
      trusted: false,
      reason: 'missing_local_trust'
    })
    await expect(freshCli.readTraceReferences(project, [saved.manifest.id])).resolves.toEqual([])
    await freshCli.trustTraceForReferences(project, saved.manifest.id)
    await expect(freshCli.readTraceReferences(project, [saved.manifest.id])).resolves.toHaveLength(
      1
    )

    await fs.appendFile(
      path.join(
        project.projectRootDir,
        PROJECT_TRACE_DIR_NAME,
        saved.manifest.id,
        PROJECT_TRACE_DOCUMENT_FILENAME
      ),
      '\nThe same trace file name now has different document content.',
      'utf8'
    )

    await expect(freshCli.readTraceReferences(project, [saved.manifest.id])).resolves.toEqual([])
    expect((await freshCli.listTraces(project))[0].localTrust).toMatchObject({
      trusted: false,
      reason: 'content_changed'
    })
    await expect(cli.readTraceReferences(project, [saved.manifest.id])).resolves.toEqual([])
  })

  it('exports selected traces as zip files into a chosen directory', async () => {
    const { cli, project, tempRoot } = await createCli()
    const first = await cli.saveTrace(project, {
      name: 'First reusable trace',
      sourceKind: 'manual',
      markdown: 'First safe trace.'
    })
    const second = await cli.saveTrace(project, {
      name: 'Second reusable trace',
      sourceKind: 'manual',
      markdown: 'Second safe trace.'
    })
    const exportDir = path.join(tempRoot, 'exports')

    const savedFiles = await cli.exportTracesToDirectory(
      project,
      [first.manifest.id, second.manifest.id],
      exportDir
    )

    expect(savedFiles).toHaveLength(2)
    expect((await fs.stat(savedFiles[0])).isFile()).toBe(true)
    expect((await fs.stat(savedFiles[1])).isFile()).toBe(true)
    expect(path.dirname(savedFiles[0])).toBe(exportDir)
    expect(path.basename(savedFiles[0])).toContain(first.manifest.id)
    expect(path.basename(savedFiles[1])).toContain(second.manifest.id)
  })

  it('falls back to copying the trace directory when Windows blocks rename', async () => {
    const { cli, project } = await createCli()
    const renameSpy = vi.spyOn(fs, 'rename')
    const renameError = Object.assign(new Error('EPERM rename'), { code: 'EPERM' })
    renameSpy.mockRejectedValueOnce(renameError)

    try {
      const saved = await cli.saveTrace(project, {
        name: 'Rename fallback',
        sourceKind: 'manual',
        markdown: 'Saved through the copy fallback.'
      })

      const traces = await cli.listTraces(project)
      expect(traces).toHaveLength(1)
      expect(traces[0].id).toBe(saved.manifest.id)
      expect((await cli.readTrace(project, saved.manifest.id))?.markdown).toContain(
        'Saved through the copy fallback.'
      )
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('appends redacted operation events without changing trace creation time', async () => {
    const { cli, project } = await createCli()
    const saved = await cli.saveTrace(project, {
      name: 'Active capture',
      sourceKind: 'canvas',
      markdown: 'Safe starting point.'
    })

    const appended = await cli.appendTraceEvent(project, saved.manifest.id, {
      id: 'event-append',
      at: '2026-05-03T09:00:00.000Z',
      scope: 'agent',
      action: 'agent_message',
      status: 'success',
      safeSummary: 'Used bearer abcdefghijklmnopqrstuvwxyz123456 in a request.',
      inputKinds: ['image'],
      createdItemCount: 1,
      movementDistancePx: 123.45
    })

    expect(appended.manifest.createdAt).toBe(saved.manifest.createdAt)
    expect(appended.manifest.updatedAt).not.toBe(saved.manifest.updatedAt)
    expect(appended.manifest.eventCount).toBe(1)
    expect(appended.manifest.files.eventsSummary).toBe('events.summary.jsonl')
    expect(appended.markdown).toContain('## Appended Operation')
    expect(appended.eventSummaries?.[0].safeSummary).toContain('[redacted-token]')
    expect(appended.eventSummaries?.[0].movementDistancePx).toBe(123.45)
    expect(appended.eventSummaries?.[0].safeSummary).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(appended.redactionReport.containsSensitiveData).toBe(false)
  })

  it('rejects a project root outside configured project storage roots', async () => {
    const { cli, project, tempRoot } = await createCli()
    const outsideRoot = path.join(tempRoot, 'outside', project.projectStorageDirName)

    await expect(
      cli.listTraces({
        ...project,
        projectRootDir: outsideRoot
      })
    ).rejects.toThrow(/outside the allowed/)
  })
})
