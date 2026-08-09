import { HttpAgentTransport, MagicAgentClient } from '../src/index.js'

const baseUrl = process.env.MAGICPOT_SDK_URL
const token = process.env.MAGICPOT_SDK_TOKEN
if (!baseUrl || !token) throw new Error('Set MAGICPOT_SDK_URL and MAGICPOT_SDK_TOKEN.')

const client = new MagicAgentClient(new HttpAgentTransport({ baseUrl, token }))
const result = await client.run({
  agentId: process.env.MAGICPOT_AGENT_ID ?? 'default',
  input: { prompt: process.argv.slice(2).join(' ') || 'Hello from the TypeScript SDK' }
})
console.log(JSON.stringify(result, null, 2))
