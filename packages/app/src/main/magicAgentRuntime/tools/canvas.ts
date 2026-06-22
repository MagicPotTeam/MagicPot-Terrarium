import { createAdapter, objectSchema, statusSchema } from './helpers'

export const canvasToolAdapter = createAdapter([
  {
    name: 'canvas.status',
    category: 'canvas',
    description: 'Return current creative canvas status through a registered canvas adapter.',
    inputSchema: statusSchema,
    dependency: 'canvasStatus'
  },
  {
    name: 'canvas.export',
    category: 'canvas',
    description: 'Thin wrapper for exporting canvas content through a registered canvas adapter.',
    inputSchema: objectSchema({
      canvasId: {
        type: 'string'
      },
      format: {
        type: 'string',
        enum: ['png', 'webp', 'json']
      }
    }),
    dependency: 'canvasExport',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
