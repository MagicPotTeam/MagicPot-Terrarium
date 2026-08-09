export const NOTEBOOK_EXECUTION_MODE = Object.freeze({
  executionMode: 'stateless' as const,
  kernelPersistent: false as const,
  variablesPersisted: false as const
})

export type NotebookExecutionState =
  | 'starting'
  | 'running'
  | 'completed-applied'
  | 'completed-not-applied'
  | 'failed'
  | 'interrupted'
  | 'crashed'

export type NotebookExecutionManifest = Readonly<{
  version: 1
  executionId: string
  idempotencyKey: string
  routeKey: string
  sessionId: string
  notebookPath: string
  notebookSha256: string
  generation: number
  selectedCellIds: readonly string[]
  declaredArtifactPaths?: readonly string[]
  artifacts?: readonly NotebookExecutionArtifact[]
  state: NotebookExecutionState
  createdAt: number
  updatedAt: number
  jobId?: string
  resultSha256?: string
  snapshotId?: string
  error?: string
}>

export type NotebookExecutionStatus = NotebookExecutionManifest & typeof NOTEBOOK_EXECUTION_MODE

export type NotebookExecutionArtifact = Readonly<{
  path: string
  size: number
  sha256: string
  modifiedAt: number
}>

export type NotebookExecutionMime =
  | 'text/plain'
  | 'text/markdown'
  | 'application/json'
  | 'image/png'
  | 'image/jpeg'
  | 'image/svg+xml'
