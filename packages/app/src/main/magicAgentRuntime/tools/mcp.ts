import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema, statusSchema } from './helpers'

export const mcpToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['mcp.status'],
    inputSchema: statusSchema,
    dependency: 'mcpStatus'
  },
  {
    ...bundledCreativeDeclarations['mcp.tool.call'],
    inputSchema: objectSchema(
      {
        toolName: {
          type: 'string'
        },
        args: {
          type: 'object'
        }
      },
      ['toolName']
    ),
    dependency: 'mcpCallTool',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
