import { JsonPath, parseJsonPath } from '@shared/utils/jsonPath'
import { ObjectInfoMap, FileItem, Workflow, WorkflowInputRef, WorkflowInputValue } from './types'

/**
 * Find the comfy input option list by class type and field
 * @param objectInfos
 * @param cls
 * @param field
 * @returns
 */
export function findFieldOptions(objectInfos: ObjectInfoMap, cls: string, field: string): string[] {
  try {
    const requiredOptions = objectInfos[cls]?.input?.required?.[field]?.[0]
    const optionalOptions = objectInfos[cls]?.input?.optional?.[field]?.[0]

    // 优先使用 required 中的选项，如果没有则使用 optional 中的
    const options = requiredOptions || optionalOptions || []

    if (Array.isArray(options) && options.every((option) => typeof option === 'string')) {
      return options
    }
    return []
  } catch (error) {
    console.error(
      `findFieldOptions error: ${error}. cls: ${cls}, field: ${field}, objectInfos: ${JSON.stringify(objectInfos)}`
    )
    return []
  }
}

const fileWithMaskPattern = /^(.+)\s+\[(.+)\]$/ // e.g. "clipspace/clipspace-mask-217369.89999961853.png [input]"
/**
 * For Load Image node, parse File Item from input value
 * input value would be:
 * 1. image and no mask
 *    the file name, e.g. "spaceship-launch.jpg"
 *    file item would be { filename: "spaceship-launch.jpg", type: "input"  }
 * 2. image and mask
 *    the composed string, e.g. "clipspace/clipspace-mask-217369.89999961853.png [input]"
 *    file item would be { filename: "clipspace-mask-217369.89999961853.png", type: "input", subfolder: "clipspace" }
 */
export const valueToFileItem = (value: string): FileItem => {
  const match = value.match(fileWithMaskPattern)
  if (match) {
    const fullPath = match[1]
    const type = match[2]
    const pathParts = fullPath.split('/')
    const filename = pathParts[pathParts.length - 1]
    const subfolder = pathParts.length > 1 ? pathParts[0] : undefined

    return {
      filename,
      type,
      ...(subfolder && { subfolder })
    }
  }
  return { filename: value, type: 'input' }
}

/**
 * Reverse of valueToFileItem
 * @param fileItem
 * @returns
 */
export const fileItemToValue = (fileItem: FileItem): string => {
  if (fileItem.subfolder) {
    return `${fileItem.subfolder}/${fileItem.filename} [input]`
  }
  return fileItem.filename ?? ''
}

/**
 * Get the class type and field of the node from the json path
 * @param jsonPath the json path of the node
 * @param workflow the workflow
 * @returns
 */
export const clsAndFieldByJsonPath = (jsonPath: JsonPath, workflow: Workflow): [string, string] => {
  const pathFields = parseJsonPath(jsonPath)
  if (pathFields.length < 2) {
    throw new Error(`jsonPath is not valid: ${jsonPath}`)
  }

  const nodeId = pathFields[0]
  const node = workflow[nodeId]
  if (!node) {
    throw new Error(`node not found: ${nodeId} in workflow`)
  }
  const cls = node.class_type
  const field = pathFields[pathFields.length - 1]
  return [cls, field]
}

/**
 * Get the node id and class type of the node from the json path
 * @param jsonPath
 * @param workflow
 * @returns
 */
export const nodeIdAndClsByJsonPath = (
  jsonPath: JsonPath,
  workflow: Workflow
): [string, string] => {
  const pathFields = parseJsonPath(jsonPath)
  if (pathFields.length < 1) {
    throw new Error(`jsonPath is not valid: ${jsonPath}`)
  }
  const nodeId = pathFields[0]
  const node = workflow[nodeId]
  if (!node) {
    throw new Error(`node not found: ${nodeId} in workflow`)
  }
  const cls = node.class_type
  return [nodeId, cls]
}

/**
 * Get the field of the node from the json path
 * @param jsonPath the json path of the node
 * @param workflow the workflow
 * @returns
 */
export const fieldByJsonPath = (jsonPath: JsonPath, workflow: Workflow): string => {
  const pathFields = parseJsonPath(jsonPath)
  if (pathFields.length < 3) {
    throw new Error(`jsonPath is not valid: ${jsonPath}`)
  }
  const field = pathFields[2]
  return field
}

/**
 * 解析工作流中所有节点和字段，用于生成选项
 * @param workflow
 * @returns
 */
export function parseAllNodeIdAndField(workflow: Workflow): { nodeId: string; field: string }[] {
  return Object.entries(workflow)
    .filter(([key]) => !key.startsWith('__')) // Filter out metadata keys
    .filter(([, node]) => !isComfyFrontendOnlyNodeClassType(node.class_type))
    .flatMap(([nodeId, node]) => {
      return Object.keys(node.inputs).map((field) => {
        return { nodeId, field }
      })
    })
}

/**
 * ComfyUI 内置核心节点列表
 * 这些节点是 ComfyUI 自带的，不需要安装，应该被排除在未安装节点检查之外
 */
export const COMFYUI_FRONTEND_ONLY_NODE_TYPES = new Set(['Note', 'Reroute'])

const COMFYUI_BUILTIN_NODES = COMFYUI_FRONTEND_ONLY_NODE_TYPES

export function isComfyFrontendOnlyNodeClassType(classType: string | undefined): boolean {
  return !!classType && COMFYUI_FRONTEND_ONLY_NODE_TYPES.has(classType)
}

function isWorkflowInputRef(value: unknown): value is WorkflowInputRef {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    typeof value[1] === 'number'
  )
}

function normalizeWorkflowInputRef(value: WorkflowInputRef): WorkflowInputRef {
  return [String(value[0]), value[1]]
}

function getFirstInputRef(node: { inputs?: Record<string, unknown> }): WorkflowInputRef | null {
  for (const inputValue of Object.values(node.inputs ?? {})) {
    if (isWorkflowInputRef(inputValue)) {
      return normalizeWorkflowInputRef(inputValue)
    }
  }
  return null
}

function resolveExecutableInputRef(
  workflow: Workflow,
  inputRef: WorkflowInputRef,
  visitedNodeIds: Set<string> = new Set()
): WorkflowInputRef | null {
  const normalizedRef = normalizeWorkflowInputRef(inputRef)
  const [sourceNodeId] = normalizedRef
  const sourceNode = workflow[sourceNodeId]

  if (!sourceNode) {
    return normalizedRef
  }

  if (sourceNode.class_type === 'Reroute') {
    if (visitedNodeIds.has(sourceNodeId)) {
      return null
    }
    visitedNodeIds.add(sourceNodeId)

    const rerouteInputRef = getFirstInputRef(sourceNode)
    return rerouteInputRef
      ? resolveExecutableInputRef(workflow, rerouteInputRef, visitedNodeIds)
      : null
  }

  if (isComfyFrontendOnlyNodeClassType(sourceNode.class_type)) {
    return null
  }

  return normalizedRef
}

/**
 * Remove ComfyUI UI-only nodes from an API prompt.
 *
 * GUI exports can contain nodes such as Note and Reroute. They are useful in the
 * editor, but ComfyUI's prompt endpoint does not execute them and reports
 * "Node type not found" when they are submitted as class_type entries.
 */
export function normalizeExecutableWorkflow(workflow: Workflow): Workflow {
  const normalized: Workflow = {}
  const normalizedRecord = normalized as unknown as Record<string, unknown>

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (nodeId.startsWith('__')) {
      normalizedRecord[nodeId] = node
      continue
    }

    if (isComfyFrontendOnlyNodeClassType(node.class_type)) {
      continue
    }

    const inputs: Record<string, WorkflowInputValue> = {}
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (isWorkflowInputRef(inputValue)) {
        const resolvedInputRef = resolveExecutableInputRef(workflow, inputValue)
        if (resolvedInputRef) {
          inputs[inputName] = resolvedInputRef
        }
        continue
      }

      inputs[inputName] = inputValue
    }

    normalized[nodeId] = {
      ...node,
      inputs
    }
  }

  return normalized
}

/**
 * Find the not installed node class type in the workflow
 * @param workflow the workflow
 * @param objectInfos the object infos
 * @returns the not installed node class type list
 */
export function findNotInstalledNodeInfo(workflow: Workflow, objectInfos: ObjectInfoMap): string[] {
  // Filter out metadata keys (starting with __) before processing
  const nodes = Object.entries(workflow)
    .filter(([key]) => !key.startsWith('__'))
    .map(([, node]) => node)
  const nodeClsList = nodes.map((node) => node.class_type)
  const uniqueNodeClsList = Array.from(new Set(nodeClsList))
  const installedNodeClsSet = new Set(Object.keys(objectInfos))
  return uniqueNodeClsList.filter(
    (cls) => !installedNodeClsSet.has(cls) && !COMFYUI_BUILTIN_NODES.has(cls)
  )
}
