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
    name: 'project.trace.list',
    category: 'projectTrace',
    description: 'List project trace summaries through a registered project trace adapter.',
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
    name: 'project.trace.read',
    category: 'projectTrace',
    description: 'Read one project trace document through a registered project trace adapter.',
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
