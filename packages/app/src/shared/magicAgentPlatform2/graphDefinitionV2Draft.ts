import type { MagicAgentGraphDefinition } from '../magicAgent/graphTypes'
import { GRAPH_SCHEMA_VERSION } from './versions'

export const GRAPH_DEFINITION_V2_DRAFT_KIND = 'magic-agent.graph-definition.v2-draft' as const
export const GRAPH_RUNTIME_TOPOLOGY_SNAPSHOT_V2_KIND =
  'magic-agent.graph-runtime-topology-snapshot.v2' as const

export const GRAPH_V2_STANDARD_NODE_KINDS = [
  'agent',
  'tool',
  'input',
  'condition',
  'merge',
  'output',
  'subgraph'
] as const
export const GRAPH_V2_STANDARD_EDGE_KINDS = [
  'data',
  'control',
  'message',
  'error',
  'lifecycle'
] as const
export const GRAPH_V2_STANDARD_PORT_ROLES = [
  'data',
  'control',
  'message',
  'error',
  'lifecycle'
] as const
export const GRAPH_V2_STANDARD_VALUE_TYPE_KINDS = [
  'any',
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'artifact',
  'message',
  'control'
] as const

/** The intersection preserves autocomplete for standard values without closing the contract. */
type ExtensibleString<T extends string> = T | (string & {})
export type GraphNodeKindV2 = ExtensibleString<(typeof GRAPH_V2_STANDARD_NODE_KINDS)[number]>
export type GraphEdgeKindV2 = ExtensibleString<(typeof GRAPH_V2_STANDARD_EDGE_KINDS)[number]>
export type GraphPortRoleV2 = ExtensibleString<(typeof GRAPH_V2_STANDARD_PORT_ROLES)[number]>
export type GraphValueTypeKindV2 = ExtensibleString<
  (typeof GRAPH_V2_STANDARD_VALUE_TYPE_KINDS)[number]
>
export type GraphVariableScopeV2 = ExtensibleString<'graph' | 'input' | 'secret' | 'runtime'>
/**
 * JSON-shaped data. TypeScript cannot express finite numbers, safe property names, or
 * descriptor/prototype constraints; validators enforce those requirements at boundaries.
 */
export type GraphJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly GraphJsonValue[]
  | { readonly [key: string]: GraphJsonValue }

export type GraphValueTypeV2 = Readonly<{
  kind: GraphValueTypeKindV2
  schemaRef?: string
  mediaType?: string
}>

export type GraphPortV2 = Readonly<{
  portId: string
  name: string
  direction: 'input' | 'output'
  role: GraphPortRoleV2
  valueType: GraphValueTypeV2
  required?: boolean
  multiple?: boolean
  defaultValue?: GraphJsonValue
}>

export type GraphSubgraphReferenceV2 = Readonly<{
  graphId: string
  version: string
  inputMappings: Readonly<Record<string, string>>
  outputMappings: Readonly<Record<string, string>>
}>

export type GraphNodeV2 = Readonly<{
  nodeId: string
  name: string
  description: string
  kind: GraphNodeKindV2
  position: Readonly<{ x: number; y: number }>
  inputs: readonly GraphPortV2[]
  outputs: readonly GraphPortV2[]
  config: Readonly<Record<string, GraphJsonValue>>
  metadata?: Readonly<Record<string, GraphJsonValue>>
  subgraphRef?: GraphSubgraphReferenceV2
}>

export type GraphEndpointV2 = Readonly<{ nodeId: string; portId: string }>
export type GraphEdgeV2 = Readonly<{
  edgeId: string
  kind: GraphEdgeKindV2
  source: GraphEndpointV2
  target: GraphEndpointV2
  label?: string
  metadata?: Readonly<Record<string, GraphJsonValue>>
}>
export type GraphVariableV2 = Readonly<{
  variableId: string
  name: string
  scope: GraphVariableScopeV2
  valueType: GraphValueTypeV2
  required?: boolean
  defaultValue?: GraphJsonValue
  description?: string
  sensitive?: boolean
}>
export type GraphOutputV2 = Readonly<{
  outputId: string
  name: string
  description: string
  source: GraphEndpointV2
  metadata?: Readonly<Record<string, GraphJsonValue>>
}>

export type GraphVisualPointV2 = Readonly<{ x: number; y: number }>
export type GraphVisualGroupV2 = Readonly<{
  groupId: string
  title: string
  nodeIds: readonly string[]
  color?: string
}>
export type GraphVisualNoteV2 = Readonly<{
  noteId: string
  title?: string
  text: string
  position: GraphVisualPointV2
  color?: string
  width?: number
  height?: number
}>
export type GraphVisualRerouteV2 = Readonly<{
  edgeId: string
  points: readonly GraphVisualPointV2[]
}>
export type GraphVisualAnnotationsV2 = Readonly<{
  groups: readonly GraphVisualGroupV2[]
  notes: readonly GraphVisualNoteV2[]
  reroutes: readonly GraphVisualRerouteV2[]
}>

export type GraphDefinitionV2Draft = Readonly<{
  kind: typeof GRAPH_DEFINITION_V2_DRAFT_KIND
  graphMode: 'design'
  schemaVersion: typeof GRAPH_SCHEMA_VERSION.value
  graphId: string
  name: string
  description: string
  version: string
  tags: readonly string[]
  nodes: readonly GraphNodeV2[]
  edges: readonly GraphEdgeV2[]
  variables: readonly GraphVariableV2[]
  outputs: readonly GraphOutputV2[]
  entryNodeIds: readonly string[]
  visualAnnotations?: GraphVisualAnnotationsV2
  metadata?: Readonly<Record<string, GraphJsonValue>>
  legacySnapshot: MagicAgentGraphDefinition
}>

export type GraphRuntimeTopologySnapshotV2 = Readonly<{
  kind: typeof GRAPH_RUNTIME_TOPOLOGY_SNAPSHOT_V2_KIND
  graphMode: 'runtime'
  definitionGraphId: string
  definitionVersion: string
  runId: string
  revision: number
  nodes: readonly Readonly<{
    nodeId: string
    metadata?: Readonly<Record<string, GraphJsonValue>>
  }>[]
  edges: readonly Readonly<{
    edgeId: string
    sourceNodeId: string
    targetNodeId: string
    metadata?: Readonly<Record<string, GraphJsonValue>>
  }>[]
}>

export type GraphContractIssue = Readonly<{ code: string; path: string; message: string }>
export type GraphContractValidationResult = Readonly<{
  valid: boolean
  issues: readonly GraphContractIssue[]
}>

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const V1_NOT_PERSISTABLE_ERROR = 'V1 graph is not persistable JSON.'
const v1NormalizedOptionalKeys = new Set([
  'capabilities',
  'channelId',
  'condition',
  'metadata',
  'required'
])

const cloneJsonSafeValue = <T>(value: T): T => {
  const ancestors = new Set<object>()
  const clone = (current: unknown): GraphJsonValue => {
    try {
      if (current === null || typeof current === 'string' || typeof current === 'boolean')
        return current
      if (typeof current === 'number' && Number.isFinite(current)) return current
      if (typeof current !== 'object' || ancestors.has(current))
        throw new Error(V1_NOT_PERSISTABLE_ERROR)

      const isArray = Array.isArray(current)
      const prototype = Object.getPrototypeOf(current)
      const keys = Reflect.ownKeys(current)
      const descriptors = Object.getOwnPropertyDescriptors(current)
      if (
        (!isArray && prototype !== Object.prototype && prototype !== null) ||
        keys.some((key) => typeof key === 'symbol')
      ) {
        throw new Error(V1_NOT_PERSISTABLE_ERROR)
      }

      ancestors.add(current)
      try {
        if (isArray) {
          const lengthDescriptor = descriptors.length
          if (!lengthDescriptor || typeof lengthDescriptor.value !== 'number')
            throw new Error(V1_NOT_PERSISTABLE_ERROR)
          const result: GraphJsonValue[] = []
          for (let index = 0; index < lengthDescriptor.value; index += 1) {
            const descriptor = descriptors[String(index)]
            if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor))
              throw new Error(V1_NOT_PERSISTABLE_ERROR)
            result.push(clone(descriptor.value))
          }
          if (
            keys.some(
              (key) =>
                typeof key === 'string' &&
                key !== 'length' &&
                (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= lengthDescriptor.value)
            )
          ) {
            throw new Error(V1_NOT_PERSISTABLE_ERROR)
          }
          return result
        }

        const result: Record<string, GraphJsonValue> = Object.create(null)
        for (const key of keys) {
          if (typeof key !== 'string' || dangerousKeys.has(key))
            throw new Error(V1_NOT_PERSISTABLE_ERROR)
          const descriptor = descriptors[key]
          if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor))
            throw new Error(V1_NOT_PERSISTABLE_ERROR)
          if (descriptor.value === undefined && v1NormalizedOptionalKeys.has(key)) continue
          result[key] = clone(descriptor.value)
        }
        return result
      } finally {
        ancestors.delete(current)
      }
    } catch {
      throw new Error(V1_NOT_PERSISTABLE_ERROR)
    }
  }
  return clone(value) as T
}

const isPlainJsonRecord = (value: unknown): value is Record<string, GraphJsonValue> => {
  const validation = new Validation()
  return validation.json(value, '$') && !Array.isArray(value) && value !== null
}

class Validation {
  readonly issues: GraphContractIssue[] = []
  private readonly seenJson = new Set<object>()

  issue(code: string, path: string, message: string): void {
    this.issues.push({ code, path, message })
  }

  record(value: unknown, path: string): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.issue('invalid-record', path, 'Expected a plain record.')
      return false
    }
    let prototype: object | null
    let descriptors: PropertyDescriptorMap
    try {
      prototype = Object.getPrototypeOf(value)
      descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
      this.issue('unsafe-access', path, 'Value could not be inspected safely.')
      return false
    }
    if (prototype !== Object.prototype && prototype !== null) {
      this.issue('invalid-record', path, 'Expected a plain record.')
      return false
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        this.issue('unsafe-accessor', `${path}.${key}`, 'Accessors are not accepted.')
        return false
      }
    }
    return true
  }

  array(value: unknown, path: string): value is unknown[] {
    if (!Array.isArray(value)) {
      this.issue('invalid-array', path, 'Expected an array.')
      return false
    }
    return true
  }

  string(value: unknown, path: string, optional = false): value is string {
    if (optional && value === undefined) return true
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
      this.issue('invalid-string', path, 'Expected a trim-non-empty string.')
      return false
    }
    return true
  }

  boolean(value: unknown, path: string): boolean {
    if (value === undefined || typeof value === 'boolean') return true
    this.issue('invalid-boolean', path, 'Expected a boolean when present.')
    return false
  }

  json(value: unknown, path: string): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return true
      this.issue('not-json-safe', path, 'JSON numbers must be finite.')
      return false
    }
    if (typeof value !== 'object') {
      this.issue('not-json-safe', path, 'Expected a JSON-safe value.')
      return false
    }
    if (this.seenJson.has(value)) {
      this.issue('cyclic-value', path, 'JSON values must not contain cycles.')
      this.issue('not-json-safe', path, 'JSON values must not contain cycles.')
      return false
    }

    let prototype: object | null
    let keys: PropertyKey[]
    let descriptors: PropertyDescriptorMap
    let isArray: boolean
    try {
      isArray = Array.isArray(value)
      prototype = Object.getPrototypeOf(value)
      keys = Reflect.ownKeys(value)
      descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
      this.issue('not-json-safe', path, 'Value could not be inspected safely.')
      return false
    }
    if (
      (!isArray && prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key === 'symbol')
    ) {
      if (!isArray && prototype !== Object.prototype && prototype !== null) {
        this.issue('invalid-record', path, 'Expected a plain record.')
      }
      this.issue('not-json-safe', path, 'Expected only arrays and plain records with string keys.')
      return false
    }

    this.seenJson.add(value)
    let valid = true
    try {
      if (isArray) {
        const lengthDescriptor = descriptors.length
        if (!lengthDescriptor || typeof lengthDescriptor.value !== 'number') valid = false
        else {
          for (let index = 0; index < lengthDescriptor.value; index += 1) {
            const descriptor = descriptors[String(index)]
            if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
              valid = false
              continue
            }
            if (!this.json(descriptor.value, `${path}[${index}]`)) valid = false
          }
        }
        if (
          keys.some(
            (key) => typeof key === 'string' && key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)
          )
        )
          valid = false
      } else {
        for (const key of keys) {
          if (typeof key !== 'string') {
            valid = false
            continue
          }
          const descriptor = descriptors[key]
          if (
            dangerousKeys.has(key) ||
            !descriptor ||
            descriptor.enumerable !== true ||
            !('value' in descriptor)
          ) {
            if (dangerousKeys.has(key)) {
              this.issue('dangerous-key', `${path}.${key}`, 'Dangerous record keys are forbidden.')
            }
            valid = false
            continue
          }
          if (!this.json(descriptor.value, `${path}.${key}`)) valid = false
        }
      }
    } catch {
      valid = false
    } finally {
      this.seenJson.delete(value)
    }
    if (
      !valid &&
      !this.issues.some((issue) => issue.code === 'not-json-safe' && issue.path === path)
    ) {
      this.issue('not-json-safe', path, 'Value must be deeply JSON-safe.')
    }
    return valid
  }
}

const validateJsonRecord = (value: unknown, path: string, validation: Validation): boolean => {
  if (!validation.record(value, path)) return false
  return validation.json(value, path)
}

const validateValueType = (
  value: unknown,
  path: string,
  validation: Validation
): value is GraphValueTypeV2 => {
  if (!validation.record(value, path)) return false
  validation.string(value.kind, `${path}.kind`)
  validation.string(value.schemaRef, `${path}.schemaRef`, true)
  validation.string(value.mediaType, `${path}.mediaType`, true)
  return true
}

const validateEndpoint = (
  value: unknown,
  path: string,
  validation: Validation
): value is GraphEndpointV2 => {
  if (!validation.record(value, path)) return false
  validation.string(value.nodeId, `${path}.nodeId`)
  validation.string(value.portId, `${path}.portId`)
  return true
}

const validateMapping = (
  value: unknown,
  path: string,
  parentPortIds: Set<string>,
  validation: Validation
): void => {
  if (!validation.record(value, path)) return
  for (const key of Object.keys(value)) {
    if (dangerousKeys.has(key))
      validation.issue('dangerous-key', `${path}.${key}`, 'Dangerous mapping keys are forbidden.')
    validation.string(key, `${path}.${key}`)
    validation.string(value[key], `${path}.${key}`)
    if (!parentPortIds.has(key)) {
      validation.issue(
        'missing-mapping-port',
        `${path}.${key}`,
        'Mapping key must reference a port on the parent node.'
      )
    }
  }
}

const validateLegacySnapshot = (
  value: Record<string, unknown>,
  graphId: unknown,
  validation: Validation
): void => {
  const path = '$.legacySnapshot'
  for (const field of ['graphId', 'name', 'description', 'version'] as const) {
    validation.string(value[field], `${path}.${field}`)
  }
  if (typeof graphId === 'string' && value.graphId !== graphId) {
    validation.issue(
      'legacy-graph-id-mismatch',
      `${path}.graphId`,
      'Legacy snapshot graphId must match the converted graphId.'
    )
  }

  if (validation.array(value.tags, `${path}.tags`)) {
    value.tags.forEach((tag, index) => validation.string(tag, `${path}.tags[${index}]`))
  }
  const nodeIds = new Set<string>()
  if (validation.array(value.nodes, `${path}.nodes`)) {
    value.nodes.forEach((node, index) => {
      const itemPath = `${path}.nodes[${index}]`
      if (!validation.record(node, itemPath)) return
      for (const field of ['nodeId', 'kind', 'name', 'description'] as const)
        validation.string(node[field], `${itemPath}.${field}`)
      if (typeof node.nodeId === 'string') {
        if (nodeIds.has(node.nodeId))
          validation.issue(
            'duplicate-node-id',
            `${itemPath}.nodeId`,
            `Duplicate legacy node ID: ${node.nodeId}.`
          )
        nodeIds.add(node.nodeId)
      }
    })
    value.nodes.forEach((node, index) => {
      const itemPath = `${path}.nodes[${index}]`
      if (!validation.record(node, itemPath) || !hasOwn(node, 'condition')) return
      const conditionPath = `${itemPath}.condition`
      if (!validation.record(node.condition, conditionPath)) return
      if (hasOwn(node.condition, 'sourceNodeId')) {
        validation.string(node.condition.sourceNodeId, `${conditionPath}.sourceNodeId`)
        if (
          typeof node.condition.sourceNodeId === 'string' &&
          !nodeIds.has(node.condition.sourceNodeId)
        )
          validation.issue(
            'missing-node-reference',
            `${conditionPath}.sourceNodeId`,
            `Referenced legacy node does not exist: ${node.condition.sourceNodeId}.`
          )
      }
    })
  }
  const channelIds = new Set<string>()
  const channelsById = new Map<string, Record<string, unknown>>()
  if (validation.array(value.channels, `${path}.channels`)) {
    value.channels.forEach((channel, index) => {
      const itemPath = `${path}.channels[${index}]`
      if (!validation.record(channel, itemPath)) return
      for (const field of ['channelId', 'kind', 'from', 'to'] as const)
        validation.string(channel[field], `${itemPath}.${field}`)
      if (typeof channel.channelId === 'string') {
        if (channelIds.has(channel.channelId))
          validation.issue(
            'duplicate-channel-id',
            `${itemPath}.channelId`,
            `Duplicate legacy channel ID: ${channel.channelId}.`
          )
        channelIds.add(channel.channelId)
        channelsById.set(channel.channelId, channel)
      }
      for (const field of ['from', 'to'] as const) {
        if (typeof channel[field] === 'string' && !nodeIds.has(channel[field]))
          validation.issue(
            'missing-node-reference',
            `${itemPath}.${field}`,
            `Referenced legacy node does not exist: ${channel[field]}.`
          )
      }
    })
    value.channels.forEach((channel, index) => {
      const itemPath = `${path}.channels[${index}]`
      if (!validation.record(channel, itemPath) || !hasOwn(channel, 'condition')) return
      const conditionPath = `${itemPath}.condition`
      if (!validation.record(channel.condition, conditionPath)) return
      if (hasOwn(channel.condition, 'sourceNodeId')) {
        validation.string(channel.condition.sourceNodeId, `${conditionPath}.sourceNodeId`)
        if (
          typeof channel.condition.sourceNodeId === 'string' &&
          !nodeIds.has(channel.condition.sourceNodeId)
        )
          validation.issue(
            'missing-node-reference',
            `${conditionPath}.sourceNodeId`,
            `Referenced legacy node does not exist: ${channel.condition.sourceNodeId}.`
          )
      }
    })
  }
  const outputIds = new Set<string>()
  if (validation.array(value.outputs, `${path}.outputs`)) {
    value.outputs.forEach((output, index) => {
      const itemPath = `${path}.outputs[${index}]`
      if (!validation.record(output, itemPath)) return
      for (const field of ['outputId', 'name', 'description', 'sourceNodeId'] as const)
        validation.string(output[field], `${itemPath}.${field}`)
      if (typeof output.outputId === 'string') {
        if (outputIds.has(output.outputId))
          validation.issue(
            'duplicate-output-id',
            `${itemPath}.outputId`,
            `Duplicate legacy output ID: ${output.outputId}.`
          )
        outputIds.add(output.outputId)
      }
      if (typeof output.sourceNodeId === 'string' && !nodeIds.has(output.sourceNodeId))
        validation.issue(
          'missing-node-reference',
          `${itemPath}.sourceNodeId`,
          `Referenced legacy node does not exist: ${output.sourceNodeId}.`
        )
      if (typeof output.channelId === 'string') {
        const channel = channelsById.get(output.channelId)
        if (!channel)
          validation.issue(
            'missing-channel-reference',
            `${itemPath}.channelId`,
            `Referenced legacy channel does not exist: ${output.channelId}.`
          )
        else if (output.sourceNodeId !== channel.to)
          validation.issue(
            'output-channel-source-mismatch',
            `${itemPath}.channelId`,
            'Legacy output sourceNodeId must match the referenced channel target node.'
          )
      }
    })
  }
  if (validation.array(value.entryNodeIds, `${path}.entryNodeIds`)) {
    const entries = new Set<string>()
    value.entryNodeIds.forEach((entry, index) => {
      validation.string(entry, `${path}.entryNodeIds[${index}]`)
      if (typeof entry !== 'string') return
      if (!nodeIds.has(entry))
        validation.issue(
          'missing-node-reference',
          `${path}.entryNodeIds[${index}]`,
          `Referenced legacy node does not exist: ${entry}.`
        )
      if (entries.has(entry))
        validation.issue(
          'duplicate-entry-node',
          `${path}.entryNodeIds[${index}]`,
          `Duplicate legacy entry node ID: ${entry}.`
        )
      entries.add(entry)
    })
  }
}

export const validateGraphDefinitionV2Draft = (input: unknown): GraphContractValidationResult => {
  const validation = new Validation()
  try {
    validation.json(input, '$')
    if (!validation.record(input, '$')) return { valid: false, issues: validation.issues }
    validation.string(input.kind, '$.kind')
    if (input.kind !== GRAPH_DEFINITION_V2_DRAFT_KIND)
      validation.issue(
        'invalid-discriminator',
        '$.kind',
        'Expected the Graph V2 design discriminator.'
      )
    if (input.graphMode !== 'design')
      validation.issue('invalid-graph-mode', '$.graphMode', 'Expected graphMode "design".')
    if (input.schemaVersion !== GRAPH_SCHEMA_VERSION.value)
      validation.issue(
        'invalid-schema-version',
        '$.schemaVersion',
        'Unsupported Graph V2 schema version.'
      )
    for (const field of ['graphId', 'name', 'description', 'version'] as const)
      validation.string(input[field], `$.${field}`)

    if (validation.array(input.tags, '$.tags'))
      input.tags.forEach((tag, index) => validation.string(tag, `$.tags[${index}]`))
    if (hasOwn(input, 'visualAnnotations')) {
      const visual = input.visualAnnotations
      if (validation.record(visual, '$.visualAnnotations')) {
        const nodeIds = new Set<string>()
        if (Array.isArray(input.nodes))
          for (const node of input.nodes) {
            if (validation.record(node, '$.nodes[]') && typeof node.nodeId === 'string')
              nodeIds.add(node.nodeId)
          }
        const edgeIds = new Set<string>()
        if (Array.isArray(input.edges))
          for (const edge of input.edges) {
            if (validation.record(edge, '$.edges[]') && typeof edge.edgeId === 'string')
              edgeIds.add(edge.edgeId)
          }
        const ids = new Set<string>()
        if (validation.array(visual.groups, '$.visualAnnotations.groups'))
          visual.groups.forEach((raw, index) => {
            const path = `$.visualAnnotations.groups[${index}]`
            if (!validation.record(raw, path)) return
            validation.string(raw.groupId, `${path}.groupId`)
            validation.string(raw.title, `${path}.title`)
            validation.string(raw.color, `${path}.color`, true)
            if (typeof raw.groupId === 'string' && ids.has(raw.groupId))
              validation.issue(
                'duplicate-visual-id',
                `${path}.groupId`,
                `Duplicate visual annotation ID: ${raw.groupId}.`
              )
            if (typeof raw.groupId === 'string') ids.add(raw.groupId)
            if (validation.array(raw.nodeIds, `${path}.nodeIds`))
              raw.nodeIds.forEach((id, nodeIndex) => {
                validation.string(id, `${path}.nodeIds[${nodeIndex}]`)
                if (typeof id === 'string' && !nodeIds.has(id))
                  validation.issue(
                    'missing-node-reference',
                    `${path}.nodeIds[${nodeIndex}]`,
                    `Referenced node does not exist: ${id}.`
                  )
              })
          })
        if (validation.array(visual.notes, '$.visualAnnotations.notes'))
          visual.notes.forEach((raw, index) => {
            const path = `$.visualAnnotations.notes[${index}]`
            if (!validation.record(raw, path)) return
            validation.string(raw.noteId, `${path}.noteId`)
            validation.string(raw.title, `${path}.title`, true)
            validation.string(raw.text, `${path}.text`)
            validation.string(raw.color, `${path}.color`, true)
            for (const dimension of ['width', 'height'] as const)
              if (
                raw[dimension] !== undefined &&
                (typeof raw[dimension] !== 'number' ||
                  !Number.isFinite(raw[dimension]) ||
                  raw[dimension] <= 0)
              )
                validation.issue(
                  'invalid-size',
                  `${path}.${dimension}`,
                  'Note dimensions must be positive finite numbers.'
                )
            if (validation.record(raw.position, `${path}.position`))
              for (const axis of ['x', 'y'] as const)
                if (typeof raw.position[axis] !== 'number' || !Number.isFinite(raw.position[axis]))
                  validation.issue(
                    'invalid-position',
                    `${path}.position.${axis}`,
                    'Position coordinates must be finite numbers.'
                  )
            if (typeof raw.noteId === 'string' && ids.has(raw.noteId))
              validation.issue(
                'duplicate-visual-id',
                `${path}.noteId`,
                `Duplicate visual annotation ID: ${raw.noteId}.`
              )
            if (typeof raw.noteId === 'string') ids.add(raw.noteId)
          })
        if (validation.array(visual.reroutes, '$.visualAnnotations.reroutes'))
          visual.reroutes.forEach((raw, index) => {
            const path = `$.visualAnnotations.reroutes[${index}]`
            if (!validation.record(raw, path)) return
            validation.string(raw.edgeId, `${path}.edgeId`)
            if (typeof raw.edgeId === 'string' && !edgeIds.has(raw.edgeId))
              validation.issue(
                'missing-edge-reference',
                `${path}.edgeId`,
                `Referenced edge does not exist: ${raw.edgeId}.`
              )
            if (validation.array(raw.points, `${path}.points`))
              raw.points.forEach((point, pointIndex) => {
                const pointPath = `${path}.points[${pointIndex}]`
                if (validation.record(point, pointPath))
                  for (const axis of ['x', 'y'] as const)
                    if (typeof point[axis] !== 'number' || !Number.isFinite(point[axis]))
                      validation.issue(
                        'invalid-position',
                        `${pointPath}.${axis}`,
                        'Position coordinates must be finite numbers.'
                      )
              })
          })
      }
    }
    if (hasOwn(input, 'metadata')) validateJsonRecord(input.metadata, '$.metadata', validation)
    if (!hasOwn(input, 'legacySnapshot'))
      validation.issue(
        'missing-legacy-snapshot',
        '$.legacySnapshot',
        'A complete V1 legacy snapshot is required.'
      )
    else if (validation.record(input.legacySnapshot, '$.legacySnapshot')) {
      validateLegacySnapshot(input.legacySnapshot, input.graphId, validation)
    }

    const nodes = new Map<
      string,
      { inputs: Map<string, GraphPortV2>; outputs: Map<string, GraphPortV2> }
    >()
    if (validation.array(input.nodes, '$.nodes')) {
      input.nodes.forEach((rawNode, nodeIndex) => {
        const path = `$.nodes[${nodeIndex}]`
        if (!validation.record(rawNode, path)) return
        for (const field of ['nodeId', 'name', 'description', 'kind'] as const)
          validation.string(rawNode[field], `${path}.${field}`)
        const nodeId = typeof rawNode.nodeId === 'string' ? rawNode.nodeId : ''
        if (nodes.has(nodeId))
          validation.issue('duplicate-node-id', `${path}.nodeId`, `Duplicate node ID: ${nodeId}.`)
        const nodePorts = {
          inputs: new Map<string, GraphPortV2>(),
          outputs: new Map<string, GraphPortV2>()
        }
        nodes.set(nodeId, nodePorts)
        if (validation.record(rawNode.position, `${path}.position`)) {
          for (const axis of ['x', 'y'] as const)
            if (
              typeof rawNode.position[axis] !== 'number' ||
              !Number.isFinite(rawNode.position[axis])
            )
              validation.issue(
                'invalid-position',
                `${path}.position.${axis}`,
                'Position coordinates must be finite numbers.'
              )
        }
        validateJsonRecord(rawNode.config, `${path}.config`, validation)
        if (validation.record(rawNode.config, `${path}.config`)) {
          const inputMode = rawNode.config.inputMode
          if (rawNode.kind === 'input') {
            if (inputMode !== undefined && inputMode !== 'run' && inputMode !== 'managed')
              validation.issue(
                'invalid-input-mode',
                `${path}.config.inputMode`,
                'Input node inputMode must be "run" or "managed".'
              )
          } else if (inputMode !== undefined)
            validation.issue(
              'input-mode-on-non-input-node',
              `${path}.config.inputMode`,
              'inputMode is only valid on input nodes.'
            )
        }
        if (hasOwn(rawNode, 'metadata'))
          validateJsonRecord(rawNode.metadata, `${path}.metadata`, validation)
        const allPortIds = new Set<string>()
        for (const group of ['inputs', 'outputs'] as const) {
          if (!validation.array(rawNode[group], `${path}.${group}`)) continue
          rawNode[group].forEach((rawPort, portIndex) => {
            const portPath = `${path}.${group}[${portIndex}]`
            if (!validation.record(rawPort, portPath)) return
            for (const field of ['portId', 'name', 'role'] as const)
              validation.string(rawPort[field], `${portPath}.${field}`)
            const expectedDirection = group === 'inputs' ? 'input' : 'output'
            if (rawPort.direction !== expectedDirection)
              validation.issue(
                'invalid-port-direction',
                `${portPath}.direction`,
                `Ports in ${group} must have direction "${expectedDirection}".`
              )
            validateValueType(rawPort.valueType, `${portPath}.valueType`, validation)
            validation.boolean(rawPort.required, `${portPath}.required`)
            validation.boolean(rawPort.multiple, `${portPath}.multiple`)
            if (hasOwn(rawPort, 'defaultValue'))
              validation.json(rawPort.defaultValue, `${portPath}.defaultValue`)
            const portId = typeof rawPort.portId === 'string' ? rawPort.portId : ''
            if (allPortIds.has(portId))
              validation.issue(
                'duplicate-port-id',
                `${portPath}.portId`,
                `Duplicate port ID on node: ${portId}.`
              )
            allPortIds.add(portId)
            nodePorts[group].set(portId, rawPort as unknown as GraphPortV2)
          })
        }
        if (hasOwn(rawNode, 'subgraphRef')) {
          const refPath = `${path}.subgraphRef`
          if (validation.record(rawNode.subgraphRef, refPath)) {
            validation.string(rawNode.subgraphRef.graphId, `${refPath}.graphId`)
            validation.string(rawNode.subgraphRef.version, `${refPath}.version`)
            validateMapping(
              rawNode.subgraphRef.inputMappings,
              `${refPath}.inputMappings`,
              new Set(nodePorts.inputs.keys()),
              validation
            )
            validateMapping(
              rawNode.subgraphRef.outputMappings,
              `${refPath}.outputMappings`,
              new Set(nodePorts.outputs.keys()),
              validation
            )
          }
        }
      })
    }

    const resolvePort = (
      endpoint: GraphEndpointV2,
      path: string,
      direction: 'input' | 'output'
    ): GraphPortV2 | undefined => {
      const node = nodes.get(endpoint.nodeId)
      if (!node) {
        validation.issue(
          'missing-node-reference',
          `${path}.nodeId`,
          `Referenced node does not exist: ${endpoint.nodeId}.`
        )
        return undefined
      }
      const port = node[direction === 'input' ? 'inputs' : 'outputs'].get(endpoint.portId)
      if (!port)
        validation.issue(
          'missing-port-reference',
          `${path}.portId`,
          `Referenced ${direction} port does not exist: ${endpoint.portId}.`
        )
      return port
    }

    const edgeIds = new Set<string>()
    const targetConnectionCounts = new Map<string, number>()
    if (validation.array(input.edges, '$.edges'))
      input.edges.forEach((rawEdge, index) => {
        const path = `$.edges[${index}]`
        if (!validation.record(rawEdge, path)) return
        validation.string(rawEdge.edgeId, `${path}.edgeId`)
        validation.string(rawEdge.kind, `${path}.kind`)
        validation.string(rawEdge.label, `${path}.label`, true)
        if (hasOwn(rawEdge, 'metadata'))
          validateJsonRecord(rawEdge.metadata, `${path}.metadata`, validation)
        const edgeId = typeof rawEdge.edgeId === 'string' ? rawEdge.edgeId : ''
        if (edgeIds.has(edgeId))
          validation.issue('duplicate-edge-id', `${path}.edgeId`, `Duplicate edge ID: ${edgeId}.`)
        edgeIds.add(edgeId)
        const rawSource = rawEdge.source
        const rawTarget = rawEdge.target
        const sourceValid = validateEndpoint(rawSource, `${path}.source`, validation)
        const targetValid = validateEndpoint(rawTarget, `${path}.target`, validation)
        if (!sourceValid || !targetValid) return
        const source = resolvePort(rawSource, `${path}.source`, 'output')
        const target = resolvePort(rawTarget, `${path}.target`, 'input')
        if (!source || !target) return
        const targetKey = `${rawTarget.nodeId}\u0000${rawTarget.portId}`
        const targetConnectionCount = (targetConnectionCounts.get(targetKey) || 0) + 1
        targetConnectionCounts.set(targetKey, targetConnectionCount)
        if (target.multiple !== true && targetConnectionCount > 1)
          validation.issue(
            'input-port-multiplicity-exceeded',
            `${path}.target`,
            `Input port ${rawTarget.nodeId}.${rawTarget.portId} accepts only one connection.`
          )
        // Conservative rule: roles must match exactly; data is not a wildcard.
        if (source.role !== target.role)
          validation.issue(
            'incompatible-port-role',
            path,
            `Port roles are incompatible: ${source.role} -> ${target.role}.`
          )
        if (
          source.valueType.kind !== 'any' &&
          target.valueType.kind !== 'any' &&
          source.valueType.kind !== target.valueType.kind
        )
          validation.issue(
            'incompatible-value-kind',
            path,
            `Value kinds are incompatible: ${source.valueType.kind} -> ${target.valueType.kind}.`
          )
        for (const field of ['schemaRef', 'mediaType'] as const)
          if (
            source.valueType[field] !== undefined &&
            target.valueType[field] !== undefined &&
            source.valueType[field] !== target.valueType[field]
          )
            validation.issue(
              `incompatible-${field}`,
              path,
              `Value type ${field} values must match when both are present.`
            )
      })

    const variableIds = new Set<string>()
    if (validation.array(input.variables, '$.variables'))
      input.variables.forEach((rawVariable, index) => {
        const path = `$.variables[${index}]`
        if (!validation.record(rawVariable, path)) return
        for (const field of ['variableId', 'name', 'scope'] as const)
          validation.string(rawVariable[field], `${path}.${field}`)
        validation.string(rawVariable.description, `${path}.description`, true)
        validateValueType(rawVariable.valueType, `${path}.valueType`, validation)
        validation.boolean(rawVariable.required, `${path}.required`)
        validation.boolean(rawVariable.sensitive, `${path}.sensitive`)
        const id = typeof rawVariable.variableId === 'string' ? rawVariable.variableId : ''
        if (variableIds.has(id))
          validation.issue(
            'duplicate-variable-id',
            `${path}.variableId`,
            `Duplicate variable ID: ${id}.`
          )
        variableIds.add(id)
        if (hasOwn(rawVariable, 'defaultValue'))
          validation.json(rawVariable.defaultValue, `${path}.defaultValue`)
        if (rawVariable.scope === 'secret') {
          if (rawVariable.sensitive !== true)
            validation.issue(
              'secret-not-sensitive',
              `${path}.sensitive`,
              'Secret variables must set sensitive to true.'
            )
          if (hasOwn(rawVariable, 'defaultValue'))
            validation.issue(
              'secret-default-value',
              `${path}.defaultValue`,
              'Secret variables must not have a default value.'
            )
        }
        if (rawVariable.scope === 'runtime' && hasOwn(rawVariable, 'defaultValue'))
          validation.issue(
            'runtime-default-value',
            `${path}.defaultValue`,
            'Runtime variables must not have a default value.'
          )
      })

    const outputIds = new Set<string>()
    if (validation.array(input.outputs, '$.outputs'))
      input.outputs.forEach((rawOutput, index) => {
        const path = `$.outputs[${index}]`
        if (!validation.record(rawOutput, path)) return
        for (const field of ['outputId', 'name', 'description'] as const)
          validation.string(rawOutput[field], `${path}.${field}`)
        const id = typeof rawOutput.outputId === 'string' ? rawOutput.outputId : ''
        if (outputIds.has(id))
          validation.issue(
            'duplicate-output-id',
            `${path}.outputId`,
            `Duplicate graph output ID: ${id}.`
          )
        outputIds.add(id)
        if (hasOwn(rawOutput, 'metadata'))
          validateJsonRecord(rawOutput.metadata, `${path}.metadata`, validation)
        if (validateEndpoint(rawOutput.source, `${path}.source`, validation))
          resolvePort(rawOutput.source, `${path}.source`, 'output')
      })

    const entries = new Set<string>()
    if (validation.array(input.entryNodeIds, '$.entryNodeIds'))
      input.entryNodeIds.forEach((entry, index) => {
        validation.string(entry, `$.entryNodeIds[${index}]`)
        if (typeof entry === 'string' && !nodes.has(entry))
          validation.issue(
            'missing-entry-node',
            `$.entryNodeIds[${index}]`,
            `Entry node does not exist: ${entry}.`
          )
        if (typeof entry === 'string' && entries.has(entry))
          validation.issue(
            'duplicate-entry-node',
            `$.entryNodeIds[${index}]`,
            `Duplicate entry node ID: ${entry}.`
          )
        if (typeof entry === 'string') entries.add(entry)
      })
  } catch {
    validation.issue('unsafe-access', '$', 'Graph could not be read safely.')
  }
  return { valid: validation.issues.length === 0, issues: validation.issues }
}

export const validateGraphRuntimeTopologySnapshotV2 = (
  input: unknown
): GraphContractValidationResult => {
  const validation = new Validation()
  try {
    validation.json(input, '$')
    if (!validation.record(input, '$')) return { valid: false, issues: validation.issues }
    if (input.kind !== GRAPH_RUNTIME_TOPOLOGY_SNAPSHOT_V2_KIND)
      validation.issue(
        'invalid-discriminator',
        '$.kind',
        'Expected the Graph V2 runtime topology discriminator.'
      )
    if (input.graphMode !== 'runtime')
      validation.issue('invalid-graph-mode', '$.graphMode', 'Expected graphMode "runtime".')
    for (const field of ['definitionGraphId', 'definitionVersion', 'runId'] as const)
      validation.string(input[field], `$.${field}`)
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0)
      validation.issue(
        'invalid-revision',
        '$.revision',
        'Revision must be a non-negative safe integer.'
      )
    const nodeIds = new Set<string>()
    if (validation.array(input.nodes, '$.nodes'))
      input.nodes.forEach((node, index) => {
        const path = `$.nodes[${index}]`
        if (!validation.record(node, path)) return
        validation.string(node.nodeId, `${path}.nodeId`)
        if (hasOwn(node, 'metadata'))
          validateJsonRecord(node.metadata, `${path}.metadata`, validation)
        const id = typeof node.nodeId === 'string' ? node.nodeId : ''
        if (nodeIds.has(id))
          validation.issue('duplicate-node-id', `${path}.nodeId`, `Duplicate node ID: ${id}.`)
        nodeIds.add(id)
      })
    const edgeIds = new Set<string>()
    if (validation.array(input.edges, '$.edges'))
      input.edges.forEach((edge, index) => {
        const path = `$.edges[${index}]`
        if (!validation.record(edge, path)) return
        for (const field of ['edgeId', 'sourceNodeId', 'targetNodeId'] as const)
          validation.string(edge[field], `${path}.${field}`)
        if (hasOwn(edge, 'metadata'))
          validateJsonRecord(edge.metadata, `${path}.metadata`, validation)
        const id = typeof edge.edgeId === 'string' ? edge.edgeId : ''
        if (edgeIds.has(id))
          validation.issue('duplicate-edge-id', `${path}.edgeId`, `Duplicate edge ID: ${id}.`)
        edgeIds.add(id)
        for (const field of ['sourceNodeId', 'targetNodeId'] as const)
          if (typeof edge[field] === 'string' && !nodeIds.has(edge[field] as string))
            validation.issue(
              'missing-node-reference',
              `${path}.${field}`,
              `Referenced node does not exist: ${edge[field]}.`
            )
      })
  } catch {
    validation.issue('unsafe-access', '$', 'Runtime topology could not be read safely.')
  }
  return { valid: validation.issues.length === 0, issues: validation.issues }
}

const channelSemantics = (
  kind: string
): { role: GraphPortRoleV2; valueKind: GraphValueTypeKindV2 } => {
  if (kind === 'message') return { role: 'message', valueKind: 'message' }
  if (kind === 'artifact') return { role: 'data', valueKind: 'artifact' }
  if (kind === 'handoff' || kind === 'control') return { role: 'control', valueKind: 'control' }
  return { role: 'data', valueKind: 'any' }
}

const assertValidV1MigrationTopology = (graph: MagicAgentGraphDefinition): void => {
  const fail = (message: string): never => {
    throw new Error(`Graph V1 migration validation error: ${message}`)
  }
  const unique = (values: readonly string[], kind: string): void => {
    const seen = new Set<string>()
    for (const value of values) {
      if (seen.has(value)) fail(`duplicate ${kind} ID: ${value}.`)
      seen.add(value)
    }
  }
  unique(
    graph.nodes.map((node) => node.nodeId),
    'node'
  )
  unique(
    graph.channels.map((channel) => channel.channelId),
    'channel'
  )
  unique(
    graph.outputs.map((output) => output.outputId),
    'output'
  )
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId))
  for (const node of graph.nodes) {
    const sourceNodeId = node.condition?.sourceNodeId
    if (sourceNodeId !== undefined && !nodeIds.has(sourceNodeId))
      fail(`node ${node.nodeId} condition has dangling sourceNodeId: ${sourceNodeId}.`)
  }
  for (const channel of graph.channels) {
    if (!nodeIds.has(channel.from))
      fail(`channel ${channel.channelId} has dangling from node: ${channel.from}.`)
    if (!nodeIds.has(channel.to))
      fail(`channel ${channel.channelId} has dangling to node: ${channel.to}.`)
    const sourceNodeId = channel.condition?.sourceNodeId
    if (sourceNodeId !== undefined && !nodeIds.has(sourceNodeId))
      fail(`channel ${channel.channelId} condition has dangling sourceNodeId: ${sourceNodeId}.`)
  }
  const channelsById = new Map(graph.channels.map((channel) => [channel.channelId, channel]))
  for (const output of graph.outputs) {
    if (!nodeIds.has(output.sourceNodeId))
      fail(`output ${output.outputId} has dangling sourceNodeId: ${output.sourceNodeId}.`)
    if (output.channelId !== undefined) {
      const channel = channelsById.get(output.channelId)
      if (!channel) fail(`output ${output.outputId} has dangling channelId: ${output.channelId}.`)
      else if (output.sourceNodeId !== channel.to)
        fail(
          `output ${output.outputId} sourceNodeId ${output.sourceNodeId} does not match channel ${output.channelId} target: ${channel.to}.`
        )
    }
  }
  for (const entryNodeId of graph.entryNodeIds)
    if (!nodeIds.has(entryNodeId)) fail(`dangling entryNodeId: ${entryNodeId}.`)
}

export const convertGraphDefinitionV1ToV2Draft = (
  graph: MagicAgentGraphDefinition
): GraphDefinitionV2Draft => {
  const snapshot = cloneJsonSafeValue(graph)
  assertValidV1MigrationTopology(snapshot)
  const portIds = new Map<string, Set<string>>()
  const allocatePort = (nodeId: string, preferred: string): string => {
    const used = portIds.get(nodeId) ?? new Set<string>()
    portIds.set(nodeId, used)
    let id = preferred
    let suffix = 2
    while (used.has(id)) id = `${preferred}-${suffix++}`
    used.add(id)
    return id
  }
  const edgeIds = new Set<string>()
  const allocateEdge = (preferred: string): string => {
    let id = preferred
    let suffix = 2
    while (edgeIds.has(id)) id = `${preferred}-${suffix++}`
    edgeIds.add(id)
    return id
  }
  const inputs = new Map<string, GraphPortV2[]>()
  const outputs = new Map<string, GraphPortV2[]>()
  const edges: GraphEdgeV2[] = snapshot.channels.map((channel) => {
    const semantics = channelSemantics(channel.kind)
    const sourcePortId = allocatePort(channel.from, `channel-${channel.channelId}-out`)
    const targetPortId = allocatePort(channel.to, `channel-${channel.channelId}-in`)
    const sourcePort: GraphPortV2 = {
      portId: sourcePortId,
      name: channel.label ?? channel.channelId,
      direction: 'output',
      role: semantics.role,
      valueType: { kind: semantics.valueKind }
    }
    const targetPort: GraphPortV2 = {
      portId: targetPortId,
      name: channel.label ?? channel.channelId,
      direction: 'input',
      role: semantics.role,
      valueType: { kind: semantics.valueKind },
      ...(channel.required === undefined ? {} : { required: channel.required })
    }
    outputs.set(channel.from, [...(outputs.get(channel.from) ?? []), sourcePort])
    inputs.set(channel.to, [...(inputs.get(channel.to) ?? []), targetPort])
    return {
      edgeId: allocateEdge(channel.channelId),
      kind: channel.kind,
      source: { nodeId: channel.from, portId: sourcePortId },
      target: { nodeId: channel.to, portId: targetPortId },
      ...(channel.label === undefined ? {} : { label: channel.label }),
      metadata: {
        legacyV1: cloneJsonSafeValue({
          channelId: channel.channelId,
          from: channel.from,
          to: channel.to,
          kind: channel.kind,
          ...(channel.label === undefined ? {} : { label: channel.label }),
          ...(channel.required === undefined ? {} : { required: channel.required }),
          ...(channel.condition === undefined ? {} : { condition: channel.condition }),
          ...(channel.metadata === undefined ? {} : { metadata: channel.metadata })
        }) as GraphJsonValue
      }
    }
  })
  const graphOutputs: GraphOutputV2[] = snapshot.outputs.map((output) => {
    const portId = allocatePort(output.sourceNodeId, `graph-output-${output.outputId}`)
    const port: GraphPortV2 = {
      portId,
      name: output.name,
      direction: 'output',
      role: 'data',
      valueType: {
        kind: 'any',
        ...(output.mimeType === undefined ? {} : { mediaType: output.mimeType })
      }
    }
    outputs.set(output.sourceNodeId, [...(outputs.get(output.sourceNodeId) ?? []), port])
    return {
      outputId: output.outputId,
      name: output.name,
      description: output.description,
      source: { nodeId: output.sourceNodeId, portId },
      metadata: { legacyV1: cloneJsonSafeValue(output) as GraphJsonValue }
    }
  })
  const columns = Math.max(1, Math.ceil(Math.sqrt(snapshot.nodes.length)))
  const nodes: GraphNodeV2[] = snapshot.nodes.map((node, index) => {
    const legacyV1: Record<string, GraphJsonValue> = Object.create(null)
    for (const [key, value] of Object.entries(node)) {
      if (!['nodeId', 'kind', 'name', 'description', 'config'].includes(key))
        legacyV1[key] = value as GraphJsonValue
    }
    return {
      nodeId: node.nodeId,
      name: node.name,
      description: node.description,
      kind: node.kind,
      position: { x: (index % columns) * 240, y: Math.floor(index / columns) * 160 },
      inputs: inputs.get(node.nodeId) ?? [],
      outputs: outputs.get(node.nodeId) ?? [],
      config: { legacyV1, config: cloneJsonSafeValue(node.config ?? {}) as GraphJsonValue }
    }
  })
  const incoming = new Set(snapshot.channels.map((channel) => channel.to))
  const converted: GraphDefinitionV2Draft = {
    kind: GRAPH_DEFINITION_V2_DRAFT_KIND,
    graphMode: 'design',
    schemaVersion: GRAPH_SCHEMA_VERSION.value,
    graphId: snapshot.graphId,
    name: snapshot.name,
    description: snapshot.description,
    version: snapshot.version,
    tags: cloneJsonSafeValue(snapshot.tags),
    nodes,
    edges,
    variables: [],
    outputs: graphOutputs,
    entryNodeIds:
      snapshot.entryNodeIds.length > 0
        ? cloneJsonSafeValue(snapshot.entryNodeIds)
        : snapshot.nodes.filter((node) => !incoming.has(node.nodeId)).map((node) => node.nodeId),
    ...(snapshot.metadata !== undefined && isPlainJsonRecord(snapshot.metadata)
      ? { metadata: { legacyV1: cloneJsonSafeValue(snapshot.metadata) } }
      : {}),
    legacySnapshot: snapshot
  }
  const result = validateGraphDefinitionV2Draft(converted)
  if (!result.valid)
    throw new Error(
      `Converted Graph V2 draft failed validation: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`
    )
  return converted
}
