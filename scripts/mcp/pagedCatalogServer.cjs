// Local integration fixture only; exercises real SDK cursor and structured-output behavior.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const schema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }
const tool = name => ({ name, description: `Local paginated ${name}`, inputSchema: schema, outputSchema: schema })
const fillerCount = Number(process.argv[2] || 0), resultMode = process.argv[3] || 'text'
if (![0, 20].includes(fillerCount) || !['text', 'structured'].includes(resultMode)) throw new Error('Invalid fixture configuration')
const server = new Server({ name: 'magicpot-paged-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async request => {
  if (request.params?.cursor === undefined) return { tools: [tool('early'), ...Array.from({ length: fillerCount }, (_, i) => tool(`filler_${i}`))], nextCursor: 'opaque-page-two' }
  if (request.params.cursor !== 'opaque-page-two') throw new Error('Unexpected opaque cursor')
  return { tools: [tool('later')] }
})
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (!['early', 'later'].includes(request.params.name) || typeof request.params.arguments?.message !== 'string') throw new Error('Invalid fixture call')
  const message = `${request.params.name}:${request.params.arguments.message}`
  return { content: resultMode === 'structured' ? [] : [{ type: 'text', text: message }], structuredContent: { message } }
})
server.connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1 })
