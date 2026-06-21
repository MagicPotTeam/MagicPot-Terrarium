import { createAdapter, objectSchema, statusSchema } from './helpers'

export const modelToolAdapter = createAdapter([
  {
    name: 'model.list',
    category: 'model',
    description: 'List creative model assets through a registered model browser adapter.',
    inputSchema: objectSchema({
      type: {
        type: 'string'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200
      }
    }),
    dependency: 'modelList'
  },
  {
    name: 'model.inspect',
    category: 'model',
    description: 'Inspect one model by path or name through a registered model adapter.',
    inputSchema: objectSchema({
      path: {
        type: 'string'
      },
      name: {
        type: 'string'
      }
    }),
    dependency: 'modelInspect'
  },
  {
    name: 'model.status',
    category: 'model',
    description: 'Return model subsystem availability for MagicAgent.',
    inputSchema: statusSchema
  }
])
