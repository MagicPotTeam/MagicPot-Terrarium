import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema } from './helpers'

export const assetToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['asset.list'],
    inputSchema: objectSchema({
      kind: {
        type: 'string',
        enum: ['image', 'video', 'audio']
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200
      }
    }),
    dependency: 'assetList'
  },
  {
    ...bundledCreativeDeclarations['asset.import'],
    inputSchema: objectSchema(
      {
        path: {
          type: 'string'
        },
        kind: {
          type: 'string',
          enum: ['image', 'video', 'audio']
        }
      },
      ['path'],
      false
    ),
    dependency: 'assetImport',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
