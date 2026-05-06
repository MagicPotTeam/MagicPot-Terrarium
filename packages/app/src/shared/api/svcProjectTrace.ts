import type {
  ProjectTraceDocument,
  ProjectTraceDocumentDraft,
  ProjectTraceDocumentSummary,
  ProjectTraceEventSummary,
  ProjectTraceProjectRef,
  ProjectTraceReference
} from '@shared/projectTrace'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ListProjectTracesReq = {
  project: ProjectTraceProjectRef
}
export type ListProjectTracesResp = {
  traces: ProjectTraceDocumentSummary[]
}

export type ReadProjectTraceDocumentReq = {
  project: ProjectTraceProjectRef
  traceId: string
}
export type ReadProjectTraceDocumentResp = {
  trace: ProjectTraceDocument | null
}

export type ReadProjectTraceReferencesReq = {
  project: ProjectTraceProjectRef
  traceIds: string[]
  maxCharsPerTrace?: number
}
export type ReadProjectTraceReferencesResp = {
  references: ProjectTraceReference[]
}

export type SaveProjectTraceDocumentReq = {
  project: ProjectTraceProjectRef
  trace: ProjectTraceDocumentDraft
}
export type SaveProjectTraceDocumentResp = {
  trace: ProjectTraceDocument
}

export type TrustProjectTraceDocumentReq = {
  project: ProjectTraceProjectRef
  traceId: string
}
export type TrustProjectTraceDocumentResp = {
  trace: ProjectTraceDocument | null
}

export type DeleteProjectTraceDocumentReq = {
  project: ProjectTraceProjectRef
  traceId: string
}
export type DeleteProjectTraceDocumentResp = {}

export type AppendProjectTraceEventReq = {
  project: ProjectTraceProjectRef
  traceId: string
  event: ProjectTraceEventSummary
}
export type AppendProjectTraceEventResp = {
  trace: ProjectTraceDocument
}

export type ExportProjectTraceDocumentReq = {
  project: ProjectTraceProjectRef
  traceId: string
}
export type ExportProjectTraceDocumentResp = {
  fileName: string
  mimeType: 'application/zip'
  data: Uint8Array
}

export type ExportProjectTraceDocumentsToDirectoryReq = {
  project: ProjectTraceProjectRef
  traceIds: string[]
  outputDirectory: string
}
export type ExportProjectTraceDocumentsToDirectoryResp = {
  savedFiles: string[]
}

export type ProjectTraceSvc = {
  listProjectTraces(req: ListProjectTracesReq): Promise<ListProjectTracesResp>
  readProjectTraceDocument(req: ReadProjectTraceDocumentReq): Promise<ReadProjectTraceDocumentResp>
  readProjectTraceReferences(
    req: ReadProjectTraceReferencesReq
  ): Promise<ReadProjectTraceReferencesResp>
  saveProjectTraceDocument(req: SaveProjectTraceDocumentReq): Promise<SaveProjectTraceDocumentResp>
  trustProjectTraceDocument(
    req: TrustProjectTraceDocumentReq
  ): Promise<TrustProjectTraceDocumentResp>
  deleteProjectTraceDocument(
    req: DeleteProjectTraceDocumentReq
  ): Promise<DeleteProjectTraceDocumentResp>
  appendProjectTraceEvent(req: AppendProjectTraceEventReq): Promise<AppendProjectTraceEventResp>
  exportProjectTraceDocument(
    req: ExportProjectTraceDocumentReq
  ): Promise<ExportProjectTraceDocumentResp>
  exportProjectTraceDocumentsToDirectory(
    req: ExportProjectTraceDocumentsToDirectoryReq
  ): Promise<ExportProjectTraceDocumentsToDirectoryResp>
}

export const projectTraceSvcDef: ServiceDefSheet<ProjectTraceSvc> = {
  listProjectTraces: { type: 'unary' },
  readProjectTraceDocument: { type: 'unary' },
  readProjectTraceReferences: { type: 'unary' },
  saveProjectTraceDocument: { type: 'unary' },
  trustProjectTraceDocument: { type: 'unary' },
  deleteProjectTraceDocument: { type: 'unary' },
  appendProjectTraceEvent: { type: 'unary' },
  exportProjectTraceDocument: { type: 'unary' },
  exportProjectTraceDocumentsToDirectory: { type: 'unary' }
}
