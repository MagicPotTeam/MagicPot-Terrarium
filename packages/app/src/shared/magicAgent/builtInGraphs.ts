import type { MagicAgentGraphDefinition } from './graphTypes'

export const gameConceptTeamGraph: MagicAgentGraphDefinition = {
  graphId: 'builtin.game-concept-team',
  name: 'Game Concept Team',
  description:
    'A multi-agent team for turning a seed idea into a concise game concept pitch, mechanics, art direction, and production risks.',
  version: '1.0.0',
  tags: ['built-in', 'game', 'concept', 'team'],
  entryNodeIds: ['creative-director'],
  nodes: [
    {
      nodeId: 'creative-director',
      kind: 'agent',
      name: 'Creative Director',
      description: 'Frames the player fantasy, pillars, and final pitch.',
      instruction:
        'Summarize the core player fantasy, design pillars, target audience, and final pitch.'
    },
    {
      nodeId: 'systems-designer',
      kind: 'agent',
      name: 'Systems Designer',
      description: 'Designs core loops, progression, and interaction mechanics.',
      instruction:
        'Create core loop, progression beats, moment-to-moment mechanics, and failure states.'
    },
    {
      nodeId: 'world-artist',
      kind: 'agent',
      name: 'World Artist',
      description: 'Defines visual tone, locations, characters, and mood-board prompts.',
      instruction:
        'Describe visual style, world tone, characters, environments, and key art prompts.'
    },
    {
      nodeId: 'producer',
      kind: 'agent',
      name: 'Producer',
      description: 'Identifies scope, milestones, dependencies, and risks.',
      instruction: 'Assess MVP scope, milestone plan, dependencies, risks, and validation steps.'
    },
    {
      nodeId: 'pitch-output',
      kind: 'output',
      name: 'Concept Pitch',
      description: 'Assembled game concept team deliverable.'
    }
  ],
  channels: [
    {
      channelId: 'vision-to-systems',
      from: 'creative-director',
      to: 'systems-designer',
      kind: 'handoff',
      label: 'Vision brief',
      required: true
    },
    {
      channelId: 'vision-to-art',
      from: 'creative-director',
      to: 'world-artist',
      kind: 'handoff',
      label: 'Art direction brief',
      required: true
    },
    {
      channelId: 'design-to-producer',
      from: 'systems-designer',
      to: 'producer',
      kind: 'handoff',
      label: 'Mechanics and scope handoff',
      required: true
    },
    {
      channelId: 'art-to-producer',
      from: 'world-artist',
      to: 'producer',
      kind: 'handoff',
      label: 'Content scope handoff',
      required: true
    },
    {
      channelId: 'producer-to-pitch',
      from: 'producer',
      to: 'pitch-output',
      kind: 'artifact',
      label: 'Final concept pitch',
      required: true
    }
  ],
  outputs: [
    {
      outputId: 'game-concept-pitch',
      name: 'Game Concept Pitch',
      description: 'A concise pitch document with design, art, and production sections.',
      sourceNodeId: 'pitch-output',
      channelId: 'producer-to-pitch',
      mimeType: 'text/markdown'
    }
  ],
  metadata: {
    builtIn: true,
    teamKind: 'game-concept'
  }
}

export const comfyWorkflowBuilderTeamGraph: MagicAgentGraphDefinition = {
  graphId: 'builtin.comfy-workflow-builder-team',
  name: 'Comfy Workflow Builder Team',
  description:
    'A multi-agent team for translating an image-generation goal into a ComfyUI workflow plan, node graph, and validation checklist.',
  version: '1.0.0',
  tags: ['built-in', 'comfy', 'workflow', 'team'],
  entryNodeIds: ['workflow-architect'],
  nodes: [
    {
      nodeId: 'workflow-architect',
      kind: 'agent',
      name: 'Workflow Architect',
      description: 'Breaks the creative goal into ComfyUI pipeline stages.',
      instruction:
        'Plan the workflow stages, data flow, required models, and user-controlled parameters.'
    },
    {
      nodeId: 'node-specialist',
      kind: 'agent',
      name: 'Node Specialist',
      description: 'Maps stages to ComfyUI node types and connection semantics.',
      instruction: 'Specify node choices, connections, parameter defaults, and alternative nodes.'
    },
    {
      nodeId: 'prompt-engineer',
      kind: 'agent',
      name: 'Prompt Engineer',
      description: 'Creates positive/negative prompt strategy and style controls.',
      instruction:
        'Draft prompt templates, negative prompts, style slots, and seed/variation strategy.'
    },
    {
      nodeId: 'workflow-qa',
      kind: 'agent',
      name: 'Workflow QA',
      description: 'Checks graph completeness, reproducibility, and output handling.',
      instruction: 'Validate required inputs, model assumptions, output paths, and failure modes.'
    },
    {
      nodeId: 'workflow-output',
      kind: 'output',
      name: 'Workflow Blueprint',
      description: 'Assembled Comfy workflow builder deliverable.'
    }
  ],
  channels: [
    {
      channelId: 'architecture-to-nodes',
      from: 'workflow-architect',
      to: 'node-specialist',
      kind: 'handoff',
      label: 'Pipeline plan',
      required: true
    },
    {
      channelId: 'architecture-to-prompts',
      from: 'workflow-architect',
      to: 'prompt-engineer',
      kind: 'handoff',
      label: 'Prompt requirements',
      required: true
    },
    {
      channelId: 'nodes-to-qa',
      from: 'node-specialist',
      to: 'workflow-qa',
      kind: 'handoff',
      label: 'Node graph draft',
      required: true
    },
    {
      channelId: 'prompts-to-qa',
      from: 'prompt-engineer',
      to: 'workflow-qa',
      kind: 'handoff',
      label: 'Prompt pack draft',
      required: true
    },
    {
      channelId: 'qa-to-output',
      from: 'workflow-qa',
      to: 'workflow-output',
      kind: 'artifact',
      label: 'Validated workflow blueprint',
      required: true
    }
  ],
  outputs: [
    {
      outputId: 'comfy-workflow-blueprint',
      name: 'Comfy Workflow Blueprint',
      description:
        'A markdown workflow blueprint with nodes, prompts, parameters, and QA checklist.',
      sourceNodeId: 'workflow-output',
      channelId: 'qa-to-output',
      mimeType: 'text/markdown'
    }
  ],
  metadata: {
    builtIn: true,
    teamKind: 'comfy-workflow-builder'
  }
}

export const builtInMagicAgentGraphs: MagicAgentGraphDefinition[] = [
  gameConceptTeamGraph,
  comfyWorkflowBuilderTeamGraph
]

export const getBuiltInMagicAgentGraph = (graphId: string): MagicAgentGraphDefinition | undefined =>
  builtInMagicAgentGraphs.find((graph) => graph.graphId === graphId)
