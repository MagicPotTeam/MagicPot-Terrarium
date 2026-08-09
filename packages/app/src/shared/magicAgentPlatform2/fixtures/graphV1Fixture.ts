import type { MagicAgentGraphDefinition } from '@shared/magicAgent'

export const graphV1Fixture = {
  graphId: 'legacy-compat-graph',
  name: 'Legacy compatibility graph',
  description: 'Frozen Graph V1 exercising every node kind.',
  version: '1.2.3',
  tags: ['legacy', 'compatibility'],
  nodes: [
    {
      nodeId: 'input-1',
      kind: 'input',
      name: 'Input',
      description: 'Input node',
      metadata: {
        fixture: true
      }
    },
    {
      nodeId: 'agent-2',
      kind: 'agent',
      name: 'Planner',
      description: 'Planner node',
      agentId: 'assistant',
      instruction: 'Plan a concise answer.',
      metadata: {
        fixture: true
      }
    },
    {
      nodeId: 'tool-3',
      kind: 'tool',
      name: 'Lookup',
      description: 'Lookup node',
      toolName: 'knowledge.search',
      config: {
        limit: 3
      },
      metadata: {
        fixture: true
      }
    },
    {
      nodeId: 'condition-4',
      kind: 'condition',
      name: 'Check',
      description: 'Check node',
      condition: {
        sourceNodeId: 'tool-3',
        operator: 'truthy'
      },
      metadata: {
        fixture: true
      }
    },
    {
      nodeId: 'merge-5',
      kind: 'merge',
      name: 'Merge',
      description: 'Merge node',
      metadata: {
        fixture: true
      }
    },
    {
      nodeId: 'output-6',
      kind: 'output',
      name: 'Output',
      description: 'Output node',
      metadata: {
        fixture: true
      }
    }
  ],
  channels: [
    {
      channelId: 'input-agent',
      from: 'input-1',
      to: 'agent-2',
      kind: 'message',
      required: true
    },
    {
      channelId: 'agent-tool',
      from: 'agent-2',
      to: 'tool-3',
      kind: 'handoff'
    },
    {
      channelId: 'tool-check',
      from: 'tool-3',
      to: 'condition-4',
      kind: 'control'
    },
    {
      channelId: 'check-merge',
      from: 'condition-4',
      to: 'merge-5',
      kind: 'message',
      condition: {
        sourceNodeId: 'condition-4',
        operator: 'truthy'
      }
    },
    {
      channelId: 'merge-output',
      from: 'merge-5',
      to: 'output-6',
      kind: 'artifact'
    }
  ],
  outputs: [
    {
      outputId: 'answer',
      name: 'Answer',
      description: 'Final answer',
      sourceNodeId: 'output-6',
      channelId: 'merge-output',
      mimeType: 'text/plain'
    }
  ],
  entryNodeIds: ['input-1'],
  metadata: {
    schema: 'graph-v1',
    owner: 'compatibility-suite'
  }
} as const satisfies MagicAgentGraphDefinition

export const graphV1FixtureSource =
  '{\n  "graphId": "legacy-compat-graph",\n  "name": "Legacy compatibility graph",\n  "description": "Frozen Graph V1 exercising every node kind.",\n  "version": "1.2.3",\n  "tags": ["legacy", "compatibility"],\n  "nodes": [\n    {\n      "nodeId": "input-1",\n      "kind": "input",\n      "name": "Input",\n      "description": "Input node",\n      "metadata": {\n        "fixture": true\n      }\n    },\n    {\n      "nodeId": "agent-2",\n      "kind": "agent",\n      "name": "Planner",\n      "description": "Planner node",\n      "agentId": "assistant",\n      "instruction": "Plan a concise answer.",\n      "metadata": {\n        "fixture": true\n      }\n    },\n    {\n      "nodeId": "tool-3",\n      "kind": "tool",\n      "name": "Lookup",\n      "description": "Lookup node",\n      "toolName": "knowledge.search",\n      "config": {\n        "limit": 3\n      },\n      "metadata": {\n        "fixture": true\n      }\n    },\n    {\n      "nodeId": "condition-4",\n      "kind": "condition",\n      "name": "Check",\n      "description": "Check node",\n      "condition": {\n        "sourceNodeId": "tool-3",\n        "operator": "truthy"\n      },\n      "metadata": {\n        "fixture": true\n      }\n    },\n    {\n      "nodeId": "merge-5",\n      "kind": "merge",\n      "name": "Merge",\n      "description": "Merge node",\n      "metadata": {\n        "fixture": true\n      }\n    },\n    {\n      "nodeId": "output-6",\n      "kind": "output",\n      "name": "Output",\n      "description": "Output node",\n      "metadata": {\n        "fixture": true\n      }\n    }\n  ],\n  "channels": [\n    {\n      "channelId": "input-agent",\n      "from": "input-1",\n      "to": "agent-2",\n      "kind": "message",\n      "required": true\n    },\n    {\n      "channelId": "agent-tool",\n      "from": "agent-2",\n      "to": "tool-3",\n      "kind": "handoff"\n    },\n    {\n      "channelId": "tool-check",\n      "from": "tool-3",\n      "to": "condition-4",\n      "kind": "control"\n    },\n    {\n      "channelId": "check-merge",\n      "from": "condition-4",\n      "to": "merge-5",\n      "kind": "message",\n      "condition": {\n        "sourceNodeId": "condition-4",\n        "operator": "truthy"\n      }\n    },\n    {\n      "channelId": "merge-output",\n      "from": "merge-5",\n      "to": "output-6",\n      "kind": "artifact"\n    }\n  ],\n  "outputs": [\n    {\n      "outputId": "answer",\n      "name": "Answer",\n      "description": "Final answer",\n      "sourceNodeId": "output-6",\n      "channelId": "merge-output",\n      "mimeType": "text/plain"\n    }\n  ],\n  "entryNodeIds": ["input-1"],\n  "metadata": {\n    "schema": "graph-v1",\n    "owner": "compatibility-suite"\n  }\n}\n'
