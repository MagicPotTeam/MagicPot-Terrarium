import type { GraphJsonValue, GraphPortV2 } from './graphDefinitionV2Draft'

export const GRAPH_V2_FIRST_PARTY_NODE_CATEGORIES = [
  'Control',
  'Agent',
  'Communication',
  'Automation',
  'LLM',
  'Tool',
  'MCP',
  'Memory',
  'Coding',
  'ComfyUI',
  'Reusable subgraph'
] as const

export type GraphV2NodeCategory = (typeof GRAPH_V2_FIRST_PARTY_NODE_CATEGORIES)[number]
export type GraphV2ConfigFieldSchema = Readonly<{
  type: 'string' | 'boolean' | 'number' | 'object'
  title: string
  description?: string
  default?: GraphJsonValue
  enum?: readonly GraphJsonValue[]
  required?: boolean
}>
export type GraphV2NodeExecution =
  | Readonly<{
      mode: 'legacy-runtime'
      legacyKind: 'input' | 'condition' | 'merge' | 'output' | 'agent' | 'tool'
    }>
  | Readonly<{ mode: 'subgraph-runtime' }>
  | Readonly<{
      mode: 'tool-runtime'
      toolName: string
      inputField?: string
      configToolNameField?: string
    }>
  | Readonly<{ mode: 'unsupported'; reason: string }>
export type GraphV2NodeDescriptor = Readonly<{
  kind: string
  category: GraphV2NodeCategory
  title: string
  description: string
  executable: boolean
  disabledReason?: string
  configurationNeeded?: string
  execution: GraphV2NodeExecution
  configSchema: Readonly<{
    type: 'object'
    additionalProperties: false
    properties: Readonly<Record<string, GraphV2ConfigFieldSchema>>
  }>
  defaultConfig: Readonly<Record<string, GraphJsonValue>>
  defaultInputs: readonly GraphPortV2[]
  defaultOutputs: readonly GraphPortV2[]
}>

const port = (
  portId: string,
  direction: 'input' | 'output',
  options: Partial<GraphPortV2> = {}
): GraphPortV2 => ({
  portId,
  name: portId,
  direction,
  role: 'data',
  valueType: { kind: 'any' },
  ...(direction === 'input' ? { required: true } : {}),
  ...options
})
const schema = (
  properties: Readonly<Record<string, GraphV2ConfigFieldSchema>> = {}
): GraphV2NodeDescriptor['configSchema'] => ({
  type: 'object',
  additionalProperties: false,
  properties
})
const unsupported = (reason: string): GraphV2NodeExecution => ({ mode: 'unsupported', reason })
const legacy = (
  legacyKind: Extract<GraphV2NodeExecution, { mode: 'legacy-runtime' }>['legacyKind']
): GraphV2NodeExecution => ({ mode: 'legacy-runtime', legacyKind })
const toolRuntime = (
  toolName: string,
  options: Omit<Extract<GraphV2NodeExecution, { mode: 'tool-runtime' }>, 'mode' | 'toolName'> = {}
): GraphV2NodeExecution => ({ mode: 'tool-runtime', toolName, ...options })

export const GRAPH_V2_FIRST_PARTY_NODE_REGISTRY: readonly GraphV2NodeDescriptor[] = [
  {
    kind: 'input',
    category: 'Control',
    title: 'Input',
    description: 'Reads Graph run or managed input.',
    executable: true,
    execution: legacy('input'),
    configSchema: schema({
      inputMode: { type: 'string', title: 'Input mode', default: 'run', enum: ['run', 'managed'] }
    }),
    defaultConfig: { inputMode: 'run' },
    defaultInputs: [],
    defaultOutputs: [port('value', 'output')]
  },
  {
    kind: 'condition',
    category: 'Control',
    title: 'Condition',
    description: 'Selects a route using the production condition operation.',
    executable: true,
    execution: legacy('condition'),
    configSchema: schema({
      expression: { type: 'string', title: 'Expression', default: '' },
      policy: { type: 'object', title: 'Policy' }
    }),
    defaultConfig: { expression: '' },
    defaultInputs: [port('value', 'input')],
    defaultOutputs: [port('true', 'output'), port('false', 'output')]
  },
  {
    kind: 'merge',
    category: 'Control',
    title: 'Merge',
    description: 'Merges incoming values in the production Graph runtime.',
    executable: true,
    execution: legacy('merge'),
    configSchema: schema({
      strategy: { type: 'string', title: 'Merge strategy', default: 'all' },
      policy: { type: 'object', title: 'Policy' }
    }),
    defaultConfig: { strategy: 'all' },
    defaultInputs: [port('values', 'input', { multiple: true })],
    defaultOutputs: [port('value', 'output')]
  },
  {
    kind: 'output',
    category: 'Control',
    title: 'Output',
    description: 'Publishes a Graph output.',
    executable: true,
    execution: legacy('output'),
    configSchema: schema({
      outputId: { type: 'string', title: 'Output ID', default: '' },
      schema: { type: 'object', title: 'Output schema' }
    }),
    defaultConfig: { outputId: '' },
    defaultInputs: [port('value', 'input')],
    defaultOutputs: []
  },
  {
    kind: 'agent',
    category: 'Agent',
    title: 'Agent',
    description: 'Runs the production Agent runtime operation represented by the V1 snapshot.',
    executable: true,
    execution: legacy('agent'),
    configSchema: schema({
      agentId: { type: 'string', title: 'Agent ID', default: '' },
      instruction: { type: 'string', title: 'Instruction', default: '' },
      policy: { type: 'object', title: 'Policy' }
    }),
    defaultConfig: { agentId: '', instruction: '' },
    defaultInputs: [port('input', 'input')],
    defaultOutputs: [port('output', 'output')]
  },
  {
    kind: 'channel-message',
    category: 'Communication',
    title: 'Channel message',
    description: 'Publishes through the policy-gated production Runtime Channel tool adapter.',
    executable: true,
    execution: toolRuntime('runtime-channel.publish', { inputField: 'message' }),
    configSchema: schema({
      channelId: { type: 'string', title: 'Channel ID', default: '', required: true },
      publisherMemberId: {
        type: 'string',
        title: 'Publisher member ID',
        default: '',
        required: true
      }
    }),
    defaultConfig: { channelId: '', publisherMemberId: '' },
    defaultInputs: [port('message', 'input', { role: 'message', valueType: { kind: 'message' } })],
    defaultOutputs: [port('receipt', 'output')]
  },
  {
    kind: 'automation-trigger',
    category: 'Automation',
    title: 'Fire automation trigger',
    description: 'Fires a configured Trigger through the production workflow command adapter.',
    executable: true,
    execution: toolRuntime('trigger.manual-fire', { inputField: 'input' }),
    configSchema: schema({
      triggerId: { type: 'string', title: 'Trigger ID', default: '', required: true }
    }),
    defaultConfig: { triggerId: '' },
    defaultInputs: [port('input', 'input', { required: false })],
    defaultOutputs: [
      port('occurrence', 'output', { role: 'lifecycle', valueType: { kind: 'object' } })
    ]
  },
  {
    kind: 'llm',
    category: 'LLM',
    title: 'LLM completion',
    description: 'Runs inference through the configured production LLM provider adapter.',
    executable: true,
    execution: toolRuntime('llm.infer', { inputField: 'prompt' }),
    configSchema: schema({
      model: { type: 'string', title: 'Model/profile ID', default: '', required: true },
      agentId: { type: 'string', title: 'Agent ID', default: 'graph-llm', required: true },
      systemPrompt: { type: 'string', title: 'System prompt', default: '' }
    }),
    defaultConfig: { model: '', agentId: 'graph-llm', systemPrompt: '' },
    defaultInputs: [port('prompt', 'input', { valueType: { kind: 'string' } })],
    defaultOutputs: [port('completion', 'output', { valueType: { kind: 'string' } })]
  },
  {
    kind: 'tool',
    category: 'Tool',
    title: 'Tool',
    description:
      'Invokes a registered production Tool through Policy, approval, and permit checks.',
    executable: true,
    execution: legacy('tool'),
    configSchema: schema({
      toolName: { type: 'string', title: 'Tool name', default: '', required: true },
      inputSchema: { type: 'object', title: 'Input schema' },
      policy: { type: 'object', title: 'Policy' }
    }),
    defaultConfig: { toolName: '' },
    defaultInputs: [port('input', 'input')],
    defaultOutputs: [port('output', 'output')]
  },
  {
    kind: 'mcp-tool',
    category: 'MCP',
    title: 'MCP tool',
    description: 'Invokes a discovered MCP alias through Policy, approval, and permit enforcement.',
    executable: true,
    execution: toolRuntime('', { configToolNameField: 'mcpAlias', inputField: 'args' }),
    configSchema: schema({
      mcpAlias: {
        type: 'string',
        title: 'Configured MCP alias',
        description: 'Exact dynamic alias exposed by the configured MCP server.',
        default: '',
        required: true
      }
    }),
    defaultConfig: { mcpAlias: '' },
    defaultInputs: [port('input', 'input')],
    defaultOutputs: [port('output', 'output')]
  },
  {
    kind: 'memory-search',
    category: 'Memory',
    title: 'Semantic memory search',
    description:
      'Searches the production semantic-memory service through its policy-gated tool adapter.',
    executable: true,
    execution: toolRuntime('memory.search', { inputField: 'query' }),
    configSchema: schema({
      scope: { type: 'string', title: 'Scope', default: 'session', enum: ['session', 'agent'] },
      agentId: {
        type: 'string',
        title: 'Agent ID',
        description: 'Required when Scope is agent.',
        default: ''
      },
      limit: { type: 'number', title: 'Limit', default: 5 }
    }),
    defaultConfig: { scope: 'session', agentId: '', limit: 5 },
    defaultInputs: [port('query', 'input', { valueType: { kind: 'string' } })],
    defaultOutputs: [port('matches', 'output', { valueType: { kind: 'array' } })]
  },
  {
    kind: 'coding-task',
    category: 'Coding',
    title: 'Coding tool operation',
    description:
      'Runs one controlled Files, Commands, Python, Git, or Notebook Tool Host operation.',
    executable: true,
    execution: toolRuntime('', { configToolNameField: 'operation', inputField: 'input' }),
    configSchema: schema({
      operation: {
        type: 'string',
        title: 'Allowlisted Assistant tool name',
        description: 'Exact existing AssistantToolRegistry name allowed for this node.',
        default: '',
        required: true
      }
    }),
    defaultConfig: { operation: '' },
    defaultInputs: [port('input', 'input')],
    defaultOutputs: [port('result', 'output')]
  },
  {
    kind: 'comfyui-workflow',
    category: 'ComfyUI',
    title: 'ComfyUI workflow',
    description:
      'Submits a workflow through the configured production ComfyUI creative-tool adapter.',
    executable: true,
    execution: toolRuntime('comfyui.workflow.submit', { inputField: 'workflow' }),
    configSchema: schema({
      workflowId: { type: 'string', title: 'Workflow ID', default: '', required: true }
    }),
    defaultConfig: { workflowId: '' },
    defaultInputs: [port('parameters', 'input', { valueType: { kind: 'object' } })],
    defaultOutputs: [
      port('artifacts', 'output', {
        role: 'artifact',
        valueType: { kind: 'artifact' },
        multiple: true
      })
    ]
  },
  {
    kind: 'subgraph',
    category: 'Reusable subgraph',
    title: 'Reusable subgraph',
    description: 'References a published reusable Graph definition.',
    executable: true,
    execution: { mode: 'subgraph-runtime' },
    configSchema: schema({
      graphId: { type: 'string', title: 'Graph ID', default: '', required: true },
      version: { type: 'string', title: 'Version', default: '', required: true }
    }),
    defaultConfig: { graphId: '', version: '' },
    defaultInputs: [port('input', 'input')],
    defaultOutputs: [port('output', 'output')]
  }
] as const

export const getGraphV2NodeDescriptor = (kind: string): GraphV2NodeDescriptor | undefined =>
  GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.find((descriptor) => descriptor.kind === kind)

export const validateGraphV2FirstPartyNodeConfig = (
  kind: string,
  config: Readonly<Record<string, GraphJsonValue>>
): readonly string[] => {
  const descriptor = getGraphV2NodeDescriptor(kind)
  if (!descriptor) return [`Unsupported first-party Graph V2 node kind: ${kind}.`]
  const issues: string[] = []
  for (const [key, field] of Object.entries(descriptor.configSchema.properties)) {
    const value = config[key]
    if (
      field.required &&
      (value === undefined ||
        (field.type === 'string' && typeof value === 'string' && !value.trim()))
    )
      issues.push(`Required ${kind} config field is unconfigured: ${key}.`)
  }
  for (const key of Object.keys(config)) {
    const field = descriptor.configSchema.properties[key]
    if (!field) issues.push(`Unsupported ${kind} config field: ${key}.`)
    else if (
      field.type === 'number'
        ? typeof config[key] !== 'number'
        : field.type === 'object'
          ? typeof config[key] !== 'object' || config[key] === null || Array.isArray(config[key])
          : typeof config[key] !== field.type
    )
      issues.push(`Invalid ${kind} config field type: ${key}.`)
    else if (field.enum && !field.enum.includes(config[key]))
      issues.push(`Invalid ${kind} config field value: ${key}.`)
  }
  return issues
}

export const getGraphV2NodePreflightIssues = (
  kind: string,
  config: Readonly<Record<string, GraphJsonValue>>
): readonly string[] => {
  const descriptor = getGraphV2NodeDescriptor(kind)
  if (!descriptor) return [`Unsupported first-party Graph V2 node kind: ${kind}.`]
  const configIssues = validateGraphV2FirstPartyNodeConfig(kind, config)
  if (configIssues.length) return configIssues
  return descriptor.execution.mode === 'unsupported' ? [descriptor.execution.reason] : []
}
