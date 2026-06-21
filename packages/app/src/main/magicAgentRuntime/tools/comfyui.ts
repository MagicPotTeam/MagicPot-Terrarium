import { createAdapter, objectSchema, statusSchema } from './helpers'

export const comfyUiToolAdapter = createAdapter([
  {
    name: 'comfyui.status',
    category: 'comfyui',
    description: 'Return ComfyUI runtime availability and connection status for MagicAgent.',
    inputSchema: statusSchema,
    dependency: 'comfyStatus'
  },
  {
    name: 'comfyui.queue',
    category: 'comfyui',
    description: 'Return the current ComfyUI queue snapshot when a ComfyUI adapter is registered.',
    inputSchema: statusSchema,
    dependency: 'comfyQueue'
  },
  {
    name: 'comfyui.workflow.submit',
    category: 'comfyui',
    description:
      'Thin wrapper for submitting a ComfyUI workflow through a registered runtime adapter.',
    inputSchema: objectSchema(
      {
        prompt: {
          type: 'object'
        },
        workflow: {
          type: 'object'
        },
        clientId: {
          type: 'string'
        },
        qAppKey: {
          type: 'string'
        }
      },
      undefined,
      true
    ),
    dependency: 'comfySubmitWorkflow',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
