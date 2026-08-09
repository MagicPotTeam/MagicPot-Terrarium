export type MagicAgentInstanceStatus = 'created' | 'running' | 'paused' | 'stopped' | 'removed'

export type MagicAgentInstanceLimits = Readonly<{
  maxChildren: number
  maxDepth: number
  maxConcurrency: number
  maxRuntimeMs: number
  allowedToolNames: readonly string[]
  workspaceRoots: readonly string[]
}>

/** Exact provenance for resources created or adopted by one graph run. */
export type RuntimeTopologyAttribution = Readonly<{
  route: Readonly<{ channel: string; scopeType: string; scopeId: string }>
  sessionKey: string
  graphId: string
  runId: string
  nodeId?: string
  targetNodeId?: string
  sourceChannelId?: string
  sourceResourceId?: string
  targetResourceId?: string
}>

export type MagicAgentInstanceState = Readonly<{
  id: string
  name: string
  definitionId: string
  ownerId?: string
  parentInstanceId?: string
  depth: number
  configVersion: string
  pendingConfigVersion?: string
  previousConfigVersion?: string
  configActivatedAt?: number
  status: MagicAgentInstanceStatus
  limits: MagicAgentInstanceLimits
  runtimeTopologyAttribution?: RuntimeTopologyAttribution
}>
