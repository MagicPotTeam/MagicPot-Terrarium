import { isJsonDict, JsonValue, valueIsJsonDict } from '@shared/utils/utilTypes'
import { Workflow, WorkflowNode } from './types'

export function isWorkflowNode(node: JsonValue): node is WorkflowNode {
  return (
    valueIsJsonDict(node) &&
    'class_type' in node &&
    'inputs' in node &&
    valueIsJsonDict(node.inputs)
  )
}

export function isWorkflow(workflow: unknown): workflow is Workflow {
  return (
    isJsonDict(workflow) &&
    Object.entries(workflow).every(([key, value]) => {
      if (key.startsWith('__')) return true
      return isWorkflowNode(value)
    })
  )
}
