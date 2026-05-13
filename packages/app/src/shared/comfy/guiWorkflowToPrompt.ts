import { ObjectInfo, ObjectInfoMap, Workflow, WorkflowInputValue, WorkflowNode } from './types'
import { normalizeExecutableWorkflow } from './funcs'

export type GuiNode = {
  id: number
  type: string
  title?: string
  inputs?: {
    name: string
    link?: number | null
    widget?: { name?: string }
  }[]
  outputs?: unknown[]
  widgets_values?: unknown[]
  properties?: {
    'Node name for S&R'?: string
    ue_properties?: {
      widget_ue_connectable?: Record<string, unknown>
    }
    widget_ue_connectable?: Record<string, unknown>
  }
}

export type GuiWorkflow = {
  nodes?: GuiNode[]
  links?: [number, number, number, number, number, string][]
}

export function isGuiWorkflow(gui: unknown): gui is GuiWorkflow {
  if (!gui || typeof gui !== 'object') return false
  const workflow = gui as GuiWorkflow
  return Array.isArray(workflow.nodes) && Array.isArray(workflow.links)
}

function toWorkflowInputValue(value: unknown): WorkflowInputValue | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return null
}

function getNodeClassType(node: GuiNode): string {
  return node.properties?.['Node name for S&R'] || node.type
}

function getOrderedInputFieldNames(objectInfo?: ObjectInfo): string[] {
  if (!objectInfo) return []

  const required = objectInfo.input_order?.required ?? Object.keys(objectInfo.input?.required ?? {})
  const optional = objectInfo.input_order?.optional ?? Object.keys(objectInfo.input?.optional ?? {})

  return [...required, ...optional]
}

function isSeedLikeField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase()
  return lower === 'seed' || lower.endsWith('_seed') || lower === 'noise_seed'
}

function isSeedControlValue(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ['fixed', 'increment', 'decrement', 'randomize'].includes(value.toLowerCase())
  )
}

function fillWidgetInputsFromObjectInfo(
  node: GuiNode,
  widgets: unknown[],
  startIndex: number,
  inputs: WorkflowNode['inputs'],
  objectInfos: ObjectInfoMap
): number {
  const classType = getNodeClassType(node)
  const objectInfo = objectInfos[classType]
  const orderedFields = getOrderedInputFieldNames(objectInfo)
  if (orderedFields.length === 0) {
    return startIndex
  }

  const inputNames = new Set((node.inputs ?? []).map((input) => input.name).filter(Boolean))
  const assignedNames = new Set(Object.keys(inputs))

  let widgetIdx = startIndex
  for (const fieldName of orderedFields) {
    if (widgetIdx >= widgets.length) break
    if (!fieldName || inputNames.has(fieldName) || assignedNames.has(fieldName)) {
      continue
    }

    const value = toWorkflowInputValue(widgets[widgetIdx])
    if (value !== null) {
      inputs[fieldName] = value
      assignedNames.add(fieldName)
    }
    widgetIdx += 1

    if (isSeedLikeField(fieldName) && isSeedControlValue(widgets[widgetIdx])) {
      widgetIdx += 1
    }
  }

  return widgetIdx
}

export function convertGuiWorkflowToPrompt(
  gui: unknown,
  objectInfos: ObjectInfoMap = {}
): Workflow | null {
  if (!isGuiWorkflow(gui)) {
    return null
  }

  const linkMap = new Map<number, { fromNodeId: string; fromSlot: number }>()
  for (const link of gui.links ?? []) {
    const [linkId, fromNodeId, fromSlot] = link
    linkMap.set(linkId, {
      fromNodeId: String(fromNodeId),
      fromSlot
    })
  }

  const workflow: Workflow = {}

  for (const node of gui.nodes ?? []) {
    const nodeId = String(node.id)
    const classType = getNodeClassType(node)

    const wfNode: WorkflowNode = {
      class_type: classType,
      inputs: {},
      _meta: {
        title: node.title || classType
      }
    }

    const inputs: WorkflowNode['inputs'] = {}
    const nodeInputs = node.inputs ?? []
    const widgets = node.widgets_values ?? []

    const inputUsesLink = new Map<string, boolean>()

    for (const input of nodeInputs) {
      const name = input.name
      if (!name) continue

      if (input.link != null) {
        const linkInfo = linkMap.get(input.link)
        if (linkInfo) {
          inputs[name] = [linkInfo.fromNodeId, linkInfo.fromSlot]
          inputUsesLink.set(name, true)
        }
      }
    }

    const widgetConnectable =
      node.properties?.ue_properties?.widget_ue_connectable ||
      node.properties?.widget_ue_connectable ||
      {}
    const allConnectableWidgetNames = Object.keys(widgetConnectable)

    const widgetNameInInputsWithLink = new Set<string>()
    const widgetNameInInputsWithoutLink = new Set<string>()

    for (const input of nodeInputs) {
      if (!input.widget) continue

      const widgetName = input.widget.name || input.name
      if (inputUsesLink.get(input.name)) {
        widgetNameInInputsWithLink.add(widgetName)
      } else {
        widgetNameInInputsWithoutLink.add(widgetName)
      }
    }

    const pureWidgetNames = allConnectableWidgetNames.filter(
      (name) => !widgetNameInInputsWithLink.has(name) && !widgetNameInInputsWithoutLink.has(name)
    )

    let widgetIdx = 0

    if (allConnectableWidgetNames.length > 0) {
      for (const widgetName of allConnectableWidgetNames) {
        if (widgetIdx >= widgets.length) break

        if (widgetNameInInputsWithLink.has(widgetName)) {
          widgetIdx += 1
        } else if (widgetNameInInputsWithoutLink.has(widgetName)) {
          const value = toWorkflowInputValue(widgets[widgetIdx])
          if (value !== null) {
            inputs[widgetName] = value
          }
          widgetIdx += 1
        } else {
          const value = toWorkflowInputValue(widgets[widgetIdx])
          if (value !== null) {
            inputs[widgetName] = value
          }
          widgetIdx += 1
        }
      }
    } else {
      for (const widgetName of pureWidgetNames) {
        if (widgetIdx >= widgets.length) break
        const value = toWorkflowInputValue(widgets[widgetIdx])
        if (value !== null) {
          inputs[widgetName] = value
        }
        widgetIdx += 1
      }

      for (const input of nodeInputs) {
        if (!input.widget) continue

        const widgetName = input.widget.name || input.name
        if (inputUsesLink.get(input.name)) {
          if (widgetIdx < widgets.length) {
            widgetIdx += 1
          }
        } else if (widgetIdx < widgets.length) {
          const value = toWorkflowInputValue(widgets[widgetIdx])
          if (value !== null) {
            inputs[widgetName] = value
          }
          widgetIdx += 1
        }
      }
    }

    if (widgetIdx < widgets.length && Object.keys(objectInfos).length > 0) {
      widgetIdx = fillWidgetInputsFromObjectInfo(node, widgets, widgetIdx, inputs, objectInfos)
    }

    if (Object.keys(inputs).length === 0 && nodeInputs.length === 0 && widgets.length > 0) {
      const widgetNames = Object.keys(
        node.properties?.ue_properties?.widget_ue_connectable ||
          node.properties?.widget_ue_connectable ||
          {}
      )

      widgetNames.forEach((widgetName, index) => {
        if (index >= widgets.length) return
        const value = toWorkflowInputValue(widgets[index])
        if (value !== null) {
          inputs[widgetName] = value
        }
      })

      if (Object.keys(inputs).length === 0) {
        const value = toWorkflowInputValue(widgets[0])
        if (value !== null) {
          inputs.value = value
        }
      }
    }

    if (wfNode._meta && !wfNode._meta.title) {
      delete wfNode._meta
    }

    wfNode.inputs = inputs
    workflow[nodeId] = wfNode
  }

  return normalizeExecutableWorkflow(workflow)
}
