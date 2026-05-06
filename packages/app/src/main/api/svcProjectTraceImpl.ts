import type {
  DeleteProjectTraceDocumentReq,
  DeleteProjectTraceDocumentResp,
  AppendProjectTraceEventReq,
  AppendProjectTraceEventResp,
  ExportProjectTraceDocumentReq,
  ExportProjectTraceDocumentResp,
  ExportProjectTraceDocumentsToDirectoryReq,
  ExportProjectTraceDocumentsToDirectoryResp,
  ListProjectTracesReq,
  ListProjectTracesResp,
  ProjectTraceSvc,
  ReadProjectTraceDocumentReq,
  ReadProjectTraceDocumentResp,
  ReadProjectTraceReferencesReq,
  ReadProjectTraceReferencesResp,
  SaveProjectTraceDocumentReq,
  SaveProjectTraceDocumentResp,
  TrustProjectTraceDocumentReq,
  TrustProjectTraceDocumentResp
} from '@shared/api/svcProjectTrace'
import { ProjectTraceFSCli } from '../projectTrace/fs'

export class ProjectTraceSvcImpl implements ProjectTraceSvc {
  listProjectTraces = async (req: ListProjectTracesReq): Promise<ListProjectTracesResp> => {
    const cli = new ProjectTraceFSCli()
    return { traces: await cli.listTraces(req.project) }
  }

  readProjectTraceDocument = async (
    req: ReadProjectTraceDocumentReq
  ): Promise<ReadProjectTraceDocumentResp> => {
    const cli = new ProjectTraceFSCli()
    return { trace: await cli.readTrace(req.project, req.traceId) }
  }

  readProjectTraceReferences = async (
    req: ReadProjectTraceReferencesReq
  ): Promise<ReadProjectTraceReferencesResp> => {
    const cli = new ProjectTraceFSCli()
    return {
      references: await cli.readTraceReferences(req.project, req.traceIds, req.maxCharsPerTrace)
    }
  }

  saveProjectTraceDocument = async (
    req: SaveProjectTraceDocumentReq
  ): Promise<SaveProjectTraceDocumentResp> => {
    const cli = new ProjectTraceFSCli()
    return { trace: await cli.saveTrace(req.project, req.trace) }
  }

  trustProjectTraceDocument = async (
    req: TrustProjectTraceDocumentReq
  ): Promise<TrustProjectTraceDocumentResp> => {
    const cli = new ProjectTraceFSCli()
    return { trace: await cli.trustTraceForReferences(req.project, req.traceId) }
  }

  deleteProjectTraceDocument = async (
    req: DeleteProjectTraceDocumentReq
  ): Promise<DeleteProjectTraceDocumentResp> => {
    const cli = new ProjectTraceFSCli()
    await cli.deleteTrace(req.project, req.traceId)
    return {}
  }

  appendProjectTraceEvent = async (
    req: AppendProjectTraceEventReq
  ): Promise<AppendProjectTraceEventResp> => {
    const cli = new ProjectTraceFSCli()
    return {
      trace: await cli.appendTraceEvent(req.project, req.traceId, req.event)
    }
  }

  exportProjectTraceDocument = async (
    req: ExportProjectTraceDocumentReq
  ): Promise<ExportProjectTraceDocumentResp> => {
    const cli = new ProjectTraceFSCli()
    return cli.exportTrace(req.project, req.traceId)
  }

  exportProjectTraceDocumentsToDirectory = async (
    req: ExportProjectTraceDocumentsToDirectoryReq
  ): Promise<ExportProjectTraceDocumentsToDirectoryResp> => {
    const cli = new ProjectTraceFSCli()
    return {
      savedFiles: await cli.exportTracesToDirectory(req.project, req.traceIds, req.outputDirectory)
    }
  }
}
