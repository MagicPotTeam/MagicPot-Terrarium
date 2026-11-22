import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, statusSchema } from './helpers'
import { executableWorkflowSchema } from './productionSchemas'

export const comfyUiToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['comfyui.status'],
    inputSchema: statusSchema,
    dependency: 'comfyStatus'
  },
  {
    ...bundledCreativeDeclarations['comfyui.queue'],
    inputSchema: statusSchema,
    dependency: 'comfyQueue'
  },
  {
    ...bundledCreativeDeclarations['comfyui.workflow.submit'],
    inputSchema: executableWorkflowSchema,
    dependency: 'comfySubmitWorkflow',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
