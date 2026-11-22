import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter } from './helpers'
import { configuredLocalFileSchema, executableWorkflowSchema } from './productionSchemas'

export const imageToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['image.inspect'],
    inputSchema: configuredLocalFileSchema,
    dependency: 'imageInspect'
  },
  {
    ...bundledCreativeDeclarations['image.create'],
    inputSchema: executableWorkflowSchema,
    dependency: 'imageCreate',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
