import { ObjectInfoMap, Workflow, WorkflowInputRef } from '@shared/comfy/types'

/**
 * LoRA 节点绕过工具
 *
 * 用于处理工作流中缺失的 LoRA 文件：
 * 当工作流中引用的 LoRA 文件在 ComfyUI 中不存在时，
 * 自动绕过这些 LoRA 节点，将输入直接连接到输出引用处
 */

/**
 * 从 objectInfo 中获取可用的 LoRA 列表
 */
export function getAvailableLoras(objectInfo: ObjectInfoMap): Set<string> {
  const loraLoader = objectInfo['LoraLoader']
  if (!loraLoader?.input?.required?.lora_name) {
    return new Set()
  }

  const loraNameField = loraLoader.input.required.lora_name
  // lora_name 字段格式: [string[], {...}]
  if (Array.isArray(loraNameField[0])) {
    return new Set(loraNameField[0] as string[])
  }

  return new Set()
}

/**
 * 检测 LoraLoader 节点是否使用了不存在的 LoRA
 */
function isMissingLora(nodeInputs: Record<string, unknown>, availableLoras: Set<string>): boolean {
  const loraName = nodeInputs.lora_name
  if (typeof loraName !== 'string') {
    return false
  }
  return !availableLoras.has(loraName)
}

/**
 * 检查一个值是否是节点引用 [nodeId, outputIndex]
 */
function isNodeRef(value: unknown): value is WorkflowInputRef {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  )
}

/**
 * 绕过缺失 LoRA 的节点
 *
 * LoraLoader 节点结构：
 * - 输入: model (ref), clip (ref), lora_name (string), strength_model (float), strength_clip (float)
 * - 输出: [0] = model, [1] = clip
 *
 * 绕过逻辑：
 * 1. 找到所有引用此节点输出的节点
 * 2. 将这些引用改为指向此节点的输入来源
 * 3. 从工作流中删除此节点
 */
export function bypassMissingLoras(
  workflow: Workflow,
  availableLoras: Set<string>
): { workflow: Workflow; bypassedCount: number; bypassedLoras: string[] } {
  // 深拷贝工作流
  const newWorkflow: Workflow = JSON.parse(JSON.stringify(workflow))
  const bypassedLoras: string[] = []
  let bypassedCount = 0

  // 找出所有需要绕过的 LoraLoader 节点
  const nodesToBypass: string[] = []
  for (const [nodeId, node] of Object.entries(newWorkflow)) {
    if (node.class_type === 'LoraLoader' && isMissingLora(node.inputs, availableLoras)) {
      nodesToBypass.push(nodeId)
      const loraName = node.inputs.lora_name as string
      if (!bypassedLoras.includes(loraName)) {
        bypassedLoras.push(loraName)
      }
    }
  }

  // 逐个绕过节点
  for (const bypassNodeId of nodesToBypass) {
    const bypassNode = newWorkflow[bypassNodeId]
    if (!bypassNode) continue

    // 获取 LoraLoader 的输入引用 (model 和 clip)
    const modelInput = bypassNode.inputs.model
    const clipInput = bypassNode.inputs.clip

    // 遍历所有节点，找到引用此 LoraLoader 输出的节点
    for (const [nodeId, node] of Object.entries(newWorkflow)) {
      if (nodeId === bypassNodeId) continue

      for (const [inputName, inputValue] of Object.entries(node.inputs)) {
        if (isNodeRef(inputValue) && inputValue[0] === bypassNodeId) {
          const outputIndex = inputValue[1]

          // 根据输出索引决定使用哪个输入
          // LoraLoader 输出: [0] = model, [1] = clip
          if (outputIndex === 0 && isNodeRef(modelInput)) {
            // 引用 model 输出 -> 改为引用 LoraLoader 的 model 输入
            node.inputs[inputName] = modelInput
          } else if (outputIndex === 1 && isNodeRef(clipInput)) {
            // 引用 clip 输出 -> 改为引用 LoraLoader 的 clip 输入
            node.inputs[inputName] = clipInput
          }
          // 如果输入不是引用（不太可能），保持原样
        }
      }
    }

    // 从工作流中删除已绕过的节点
    delete newWorkflow[bypassNodeId]
    bypassedCount++
  }

  return { workflow: newWorkflow, bypassedCount, bypassedLoras }
}

/**
 * 处理工作流中的 LoRA 节点
 *
 * @param workflow 原始工作流
 * @param objectInfo ComfyUI 对象信息（包含可用 LoRA 列表）
 * @returns 处理后的工作流和绕过信息
 */
export function processWorkflowLoras(
  workflow: Workflow,
  objectInfo: ObjectInfoMap
): { workflow: Workflow; bypassedCount: number; bypassedLoras: string[] } {
  const availableLoras = getAvailableLoras(objectInfo)

  if (availableLoras.size === 0) {
    console.warn('[LoraBypass] No LoRA list found in objectInfo, skipping bypass')
    return { workflow, bypassedCount: 0, bypassedLoras: [] }
  }

  const result = bypassMissingLoras(workflow, availableLoras)

  if (result.bypassedCount > 0) {
    console.log(
      `[LoraBypass] Bypassed ${result.bypassedCount} LoraLoader nodes with missing LoRAs: ${result.bypassedLoras.join(', ')}`
    )
  }

  return result
}
