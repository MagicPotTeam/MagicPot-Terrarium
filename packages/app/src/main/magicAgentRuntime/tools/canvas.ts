import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema } from './helpers'

export const canvasToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['canvas.status'],
    inputSchema: objectSchema(
      { path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      undefined,
      false
    ),
    dependency: 'canvasStatus'
  },
  {
    ...bundledCreativeDeclarations['canvas.export'],
    inputSchema: objectSchema(
      {
        path: {
          type: 'string'
        },
        outputPath: { type: 'string' },
        format: {
          type: 'string',
          enum: ['json']
        }
      },
      ['path', 'outputPath'],
      false
    ),
    dependency: 'canvasExport',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
