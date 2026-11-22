import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
const creature = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  modelProfileId: z.string().max(256),
  systemPrompt: z.string().max(32768)
}).strict()
const node = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  address: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:', 'ssh:'].includes(url.protocol) && !!url.hostname &&
        !url.username && !url.password && !url.search && !url.hash
    } catch { return false }
  }, 'Use an HTTP(S) or SSH address without credentials, query or fragment.')
}).strict()
const unique = (items: readonly { id: string }[]) => new Set(items.map(item => item.id)).size === items.length
export const STUDIO_WORKSPACE_MAX_BYTES = 1024 * 1024
export const studioWorkspaceSchema = z.object({
  version: z.literal(1),
  creatures: z.array(creature).max(128).refine(unique, 'Duplicate creature ID.'),
  nodes: z.array(node).max(128).refine(unique, 'Duplicate node ID.')
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength <= STUDIO_WORKSPACE_MAX_BYTES, 'Studio file exceeds 1 MiB.')
export type StudioWorkspace = z.infer<typeof studioWorkspaceSchema>
export type StudioCreature = StudioWorkspace['creatures'][number]
export type StudioNode = StudioWorkspace['nodes'][number]
export const emptyStudioWorkspace = (): StudioWorkspace => ({ version: 1, creatures: [], nodes: [] })

export function parseStudioWorkspaceText(text: string): StudioWorkspace {
  if (text.length > STUDIO_WORKSPACE_MAX_BYTES || new TextEncoder().encode(text).byteLength > STUDIO_WORKSPACE_MAX_BYTES) {
    throw new Error('Studio file exceeds 1 MiB.')
  }
  return studioWorkspaceSchema.parse(JSON.parse(text))
}

/** Manual delivery only: no credentials, provider endpoint, permission or executable grant. */
export function createStudioCreatureBundle(workspace: StudioWorkspace, creatureId: string, nodeId: string) {
  const valid = studioWorkspaceSchema.parse(workspace)
  const selectedCreature = valid.creatures.find(item => item.id === creatureId)
  const selectedNode = valid.nodes.find(item => item.id === nodeId)
  if (!selectedCreature || !selectedNode) throw new Error('Choose an existing creature and target node.')
  return {
    format: 'magicpot-studio-creature-bundle', version: 1,
    creature: selectedCreature, target: selectedNode,
    delivery: 'manual', start: false
  } as const
}
