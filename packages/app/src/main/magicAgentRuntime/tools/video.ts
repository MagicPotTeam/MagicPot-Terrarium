import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter } from './helpers'
import { configuredLocalFileSchema, executableWorkflowSchema } from './productionSchemas'

export const videoToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['video.inspect'],
    inputSchema: configuredLocalFileSchema,
    dependency: 'videoInspect'
  },
  {
    ...bundledCreativeDeclarations['video.create'],
    inputSchema: executableWorkflowSchema,
    dependency: 'videoCreate',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
