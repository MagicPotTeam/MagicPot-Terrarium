const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const z = require('zod/v4')

const server = new McpServer({
  name: 'magicpot-echo-server',
  version: '1.0.0'
})

server.registerTool(
  'echo',
  {
    description: 'Echo a short message for MCP client smoke tests.',
    inputSchema: {
      message: z.string().describe('Message to echo back.')
    },
    outputSchema: {
      echoed: z.string()
    }
  },
  async ({ message }) => ({
    content: [
      {
        type: 'text',
        text: `echo:${message}`
      }
    ],
    structuredContent: {
      echoed: `echo:${message}`
    }
  })
)

server.registerTool(
  'fail',
  {
    description: 'Return an MCP tool error for failure handling tests.',
    inputSchema: {
      reason: z.string().optional()
    },
    outputSchema: {
      ok: z.boolean(),
      reason: z.string()
    }
  },
  async ({ reason }) => ({
    isError: true,
    content: [
      {
        type: 'text',
        text: `fail:${reason || 'unknown'}`
      }
    ],
    structuredContent: {
      ok: false,
      reason: String(reason || 'unknown')
    }
  })
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
