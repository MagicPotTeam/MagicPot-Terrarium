# @magicpot/agent-sdk

Dependency-free ESM TypeScript SDK for MagicAgent Platform 2.0. Version 2.0.0 supports Node.js 18+ and modern runtimes with `fetch`, `ReadableStream`, and `TextDecoderStream`.

```sh
npm add @magicpot/agent-sdk@^2.0.0
```

```ts
import { HttpAgentTransport, MagicAgentClient } from '@magicpot/agent-sdk'

const client = new MagicAgentClient(
  new HttpAgentTransport({
    baseUrl: 'http://127.0.0.1:3000',
    token: process.env.MAGICPOT_AGENT_TOKEN
  })
)
const result = await client.run({ agentId: 'example', input: { prompt: 'hello' } })

// Graph Studio's canonical Graph V2 definition is available without a lossy conversion.
const saved = await client.saveGraphV2({ graph: definition, route, replace: true })
const read = await client.getGraphV2({ graphId: definition.graphId, route })
```

`saveGraphV2` invokes the production `saveGraphV2` service, including its existing `graph.save` Policy/approval boundary; the gateway never writes graph files directly. `getGraphV2` returns the persisted normalized definition in `definitionV2`.

The transport posts JSON to `/v2/sdk/<method>` and graph-run attachment uses a closable NDJSON stream. The root export includes the client, contracts, HTTP and memory transports, command/event parsers, policy helpers, and Platform 2.0 version constants. See [`../../docs/magic-agent-platform-2.md`](../../docs/magic-agent-platform-2.md) for the API and security guide.
