import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema } from './helpers'

const projectSchema = objectSchema(
  {
    projectId: {
      type: 'string'
    },
    projectName: {
      type: 'string'
    },
    projectStorageDirName: {
      type: 'string'
    },
    projectRootDir: {
      type: 'string'
    }
  },
  ['projectId'],
  false
)

export const projectTraceToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['project.trace.list'],
    inputSchema: objectSchema(
      {
        project: projectSchema,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        }
      },
      ['project']
    ),
    dependency: 'projectTraceList'
  },
  {
    ...bundledCreativeDeclarations['project.trace.read'],
    inputSchema: objectSchema(
      {
        project: projectSchema,
        traceId: {
          type: 'string'
        }
      },
      ['project', 'traceId']
    ),
    dependency: 'projectTraceRead'
  }
])
