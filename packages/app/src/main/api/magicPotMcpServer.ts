import { createExecutionPreparation, executionPreparationSchema } from '@shared/executionPreparation'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export const MAGIC_POT_MCP_CAPABILITIES = Object.freeze({
  format: 'magicpot-mcp-capabilities', version: 1,
  tools: Object.freeze(['magicpot_capabilities', 'magicpot_validate_execution_preparation']),
  scope: 'preparation-tools-only',
  execution: false, desktopAccess: false, credentials: false,
  notice: 'This preparation tool group exposes no desktop data, provider requests or execution grants. Other tools on the canonical application server are outside this declaration.'
})

/** Transport-neutral factory. Does not listen, connect, read config or boot the app.
 * The canonical authenticated application server lives at ../mcp/serverBridge.ts.
 * This isolated preparation service is not a replacement or a second listener.
 * A future listener must supply its own authenticated lifecycle; this factory is not that listener.
 */
export function registerMagicPotPreparationTools(server: McpServer): void {
  server.registerTool('magicpot_capabilities', {
    title: 'MagicPot capabilities',
    description: 'Read the static, non-sensitive capability contract of this minimal MCP server. Not desktop authorization.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(MAGIC_POT_MCP_CAPABILITIES) }] }))
  server.registerTool('magicpot_validate_execution_preparation', {
    title: 'Validate offline execution preparation',
    description: 'Validate only the supplied non-secret SSH/Docker/SQLite preparation declaration. Does not resolve targets, connect, read files, save settings, run code or grant permission.',
    inputSchema: z.object({ preparation: executionPreparationSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ preparation }) => ({ content: [{ type: 'text' as const, text: JSON.stringify(createExecutionPreparation(preparation)) }] }))
}

/** Isolated memory-test/service factory, not the canonical application listener. */
export function createMagicPotPreparationMcpServer(): McpServer {
  const server = new McpServer({ name: 'magicpot-preparation', version: '1.0.0' }, { maxToolInputElements: 16 })
  registerMagicPotPreparationTools(server)
  return server
}
