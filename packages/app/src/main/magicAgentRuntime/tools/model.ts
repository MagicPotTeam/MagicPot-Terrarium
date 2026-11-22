import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema, statusSchema } from './helpers'

export const modelToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['model.list'],
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
    ...bundledCreativeDeclarations['model.inspect'],
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
    ...bundledCreativeDeclarations['model.status'],
    inputSchema: statusSchema,
    dependency: 'modelStatus'
  }
])
