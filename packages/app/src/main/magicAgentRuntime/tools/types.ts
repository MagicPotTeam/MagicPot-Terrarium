import type { Config } from '@shared/config/config'

export type MagicAgentCreativeToolCategory =
  | 'comfyui'
  | 'qapp'
  | 'canvas'
  | 'image'
  | 'video'
  | 'model'
  | 'asset'
  | 'projectTrace'
  | 'mcp'
  | 'terminal'

export type MagicAgentCreativeToolStatus = 'available' | 'unavailable'

export type MagicAgentCreativeToolPermissionLevel = 'read' | 'write' | 'destructive'

export type MagicAgentCreativeToolDefinition = {
  name: string
  category: MagicAgentCreativeToolCategory
  description: string
  inputSchema: Record<string, unknown>
  status: MagicAgentCreativeToolStatus
  permissionLevel: MagicAgentCreativeToolPermissionLevel
  requiresConfirmation: boolean
  disabledByDefault: boolean
  unavailableReason?: string
}

export type MagicAgentCreativeToolResult = {
  ok: boolean
  toolName: string
  category: MagicAgentCreativeToolCategory
  status: MagicAgentCreativeToolStatus
  unavailableReason?: string
  permissionDenied?: boolean
  data?: unknown
  error?: string
}

export type MagicAgentCreativeToolContext = {
  config?: Config
  signal?: AbortSignal
  dependencies?: Partial<MagicAgentCreativeToolDependencies>
}

export type MagicAgentCreativeToolAdapter = {
  definitions(): MagicAgentCreativeToolDefinition[]
  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: MagicAgentCreativeToolContext
  ): Promise<MagicAgentCreativeToolResult | null>
}

export type MagicAgentCreativeToolDependency<
  TArgs extends Record<string, unknown> = Record<string, unknown>
> = (args: TArgs, context?: MagicAgentCreativeToolContext) => Promise<unknown> | unknown

export type MagicAgentCreativeToolDependencies = {
  comfyStatus: MagicAgentCreativeToolDependency
  comfyQueue: MagicAgentCreativeToolDependency
  comfySubmitWorkflow: MagicAgentCreativeToolDependency
  qappList: MagicAgentCreativeToolDependency
  qappGet: MagicAgentCreativeToolDependency<{ key?: unknown }>
  canvasStatus: MagicAgentCreativeToolDependency
  canvasExport: MagicAgentCreativeToolDependency
  imageInspect: MagicAgentCreativeToolDependency<{ path?: unknown; url?: unknown }>
  imageCreate: MagicAgentCreativeToolDependency
  videoInspect: MagicAgentCreativeToolDependency<{ path?: unknown; url?: unknown }>
  videoCreate: MagicAgentCreativeToolDependency
  modelList: MagicAgentCreativeToolDependency
  modelInspect: MagicAgentCreativeToolDependency<{ path?: unknown; name?: unknown }>
  assetList: MagicAgentCreativeToolDependency
  assetImport: MagicAgentCreativeToolDependency
  projectTraceList: MagicAgentCreativeToolDependency
  projectTraceRead: MagicAgentCreativeToolDependency
  mcpStatus: MagicAgentCreativeToolDependency
  mcpCallTool: MagicAgentCreativeToolDependency
  terminalRun: MagicAgentCreativeToolDependency
}
