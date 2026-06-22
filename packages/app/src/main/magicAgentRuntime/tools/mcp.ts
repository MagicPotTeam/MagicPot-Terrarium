import { createAdapter, objectSchema, statusSchema } from './helpers'

export const mcpToolAdapter = createAdapter([
  {
    name: 'mcp.status',
    category: 'mcp',
    description: 'Return MCP client/server status through a registered MCP adapter.',
    inputSchema: statusSchema,
    dependency: 'mcpStatus'
  },
  {
    name: 'mcp.tool.call',
    category: 'mcp',
    description: 'Call a discovered MCP tool through a registered MCP adapter.',
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
