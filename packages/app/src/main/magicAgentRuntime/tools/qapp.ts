import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema } from './helpers'

export const qAppToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['qapp.list'],
    inputSchema: objectSchema(
      { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      undefined,
      false
    ),
    dependency: 'qappList'
  },
  {
    ...bundledCreativeDeclarations['qapp.get'],
    inputSchema: objectSchema(
      {
        key: {
          type: 'string'
        }
      },
      ['key'],
      false
    ),
    dependency: 'qappGet'
  }
])
