export type CanvasTargetArtifactType =
  | 'user_input'
  | 'model_output'
  | 'quickapp_output'
  | 'canvas_item'
  | 'media_attachment'
  | 'crop'
  | 'snapshot'
  | 'final_evidence'
  | 'text'
  | 'image'
  | 'json'
  | 'table'
  | 'video'
  | 'model3d'
  | 'asset_bundle'

export type CanvasTargetArtifactMetadata = Record<string, unknown>

export type CanvasTargetArtifact = {
  id: string
  type: CanvasTargetArtifactType
  source: string
  stageId: string
  createdAt: string
  canvasItemId?: string
  metadata?: CanvasTargetArtifactMetadata
}

export type CanvasTargetArtifactGraph = {
  artifactsById: Record<string, CanvasTargetArtifact>
  artifactOrder: string[]
}

export type CanvasTargetArtifactQuery = {
  source?: string | string[]
  stageId?: string | string[]
  type?: CanvasTargetArtifactType | CanvasTargetArtifactType[]
}

function matchesQueryValue<T extends string>(value: T, queryValue: T | T[] | undefined) {
  if (queryValue === undefined) return true
  return Array.isArray(queryValue) ? queryValue.includes(value) : value === queryValue
}

function compareArtifactsByCreatedAtThenOrder(
  left: CanvasTargetArtifact,
  right: CanvasTargetArtifact,
  orderIndexById: Map<string, number>
) {
  const leftCreatedAt = Date.parse(left.createdAt)
  const rightCreatedAt = Date.parse(right.createdAt)
  const leftSortTime = Number.isNaN(leftCreatedAt) ? Number.POSITIVE_INFINITY : leftCreatedAt
  const rightSortTime = Number.isNaN(rightCreatedAt) ? Number.POSITIVE_INFINITY : rightCreatedAt

  if (leftSortTime !== rightSortTime) {
    return leftSortTime - rightSortTime
  }

  const leftOrder = orderIndexById.get(left.id) ?? Number.POSITIVE_INFINITY
  const rightOrder = orderIndexById.get(right.id) ?? Number.POSITIVE_INFINITY
  return leftOrder - rightOrder
}

export function createCanvasTargetArtifactGraph(
  artifacts: CanvasTargetArtifact[] = []
): CanvasTargetArtifactGraph {
  const initialGraph: CanvasTargetArtifactGraph = {
    artifactsById: {},
    artifactOrder: []
  }
  return artifacts.reduce<CanvasTargetArtifactGraph>(
    (graph, artifact) => registerCanvasTargetArtifact(graph, artifact),
    initialGraph
  )
}

export function registerCanvasTargetArtifact(
  graph: CanvasTargetArtifactGraph,
  artifact: CanvasTargetArtifact
): CanvasTargetArtifactGraph {
  const hasArtifact = Object.prototype.hasOwnProperty.call(graph.artifactsById, artifact.id)

  return {
    artifactsById: {
      ...graph.artifactsById,
      [artifact.id]: { ...artifact }
    },
    artifactOrder: hasArtifact ? graph.artifactOrder.slice() : [...graph.artifactOrder, artifact.id]
  }
}

export function linkCanvasTargetArtifactToCanvasItem(
  graph: CanvasTargetArtifactGraph,
  artifactId: string,
  canvasItemId: string
): CanvasTargetArtifactGraph {
  const artifact = graph.artifactsById[artifactId]
  if (!artifact) return graph

  return registerCanvasTargetArtifact(graph, {
    ...artifact,
    canvasItemId
  })
}

export function findCanvasTargetArtifact(
  graph: CanvasTargetArtifactGraph,
  artifactId: string
): CanvasTargetArtifact | undefined {
  return graph.artifactsById[artifactId]
}

export function listCanvasTargetArtifacts(
  graph: CanvasTargetArtifactGraph,
  query: CanvasTargetArtifactQuery = {}
): CanvasTargetArtifact[] {
  const orderIndexById = new Map(graph.artifactOrder.map((id, index) => [id, index]))

  return Object.values(graph.artifactsById)
    .filter(
      (artifact) =>
        matchesQueryValue(artifact.source, query.source) &&
        matchesQueryValue(artifact.stageId, query.stageId) &&
        matchesQueryValue(artifact.type, query.type)
    )
    .sort((left, right) => compareArtifactsByCreatedAtThenOrder(left, right, orderIndexById))
}

export function resolveCanvasTargetArtifactCanvasItemId(
  graph: CanvasTargetArtifactGraph,
  artifactId: string
): string | undefined {
  return findCanvasTargetArtifact(graph, artifactId)?.canvasItemId
}
