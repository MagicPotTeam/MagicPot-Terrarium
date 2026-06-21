import { createAdapter, objectSchema, statusSchema } from './helpers'

export const qAppToolAdapter = createAdapter([
  {
    name: 'qapp.list',
    category: 'qapp',
    description: 'List available QApps through a registered QApp adapter.',
    inputSchema: statusSchema,
    dependency: 'qappList'
  },
  {
    name: 'qapp.get',
    category: 'qapp',
    description: 'Read one QApp configuration by key through a registered QApp adapter.',
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
