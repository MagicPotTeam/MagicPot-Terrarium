import { createAdapter, objectSchema } from './helpers'

export const assetToolAdapter = createAdapter([
  {
    name: 'asset.list',
    category: 'asset',
    description: 'List creative assets through a registered asset adapter.',
    inputSchema: objectSchema({
      kind: {
        type: 'string'
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
    name: 'asset.import',
    category: 'asset',
    description: 'Import an asset through a registered asset adapter.',
    inputSchema: objectSchema({
      path: {
        type: 'string'
      },
      url: {
        type: 'string'
      },
      kind: {
        type: 'string'
      }
    }),
    dependency: 'assetImport',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
