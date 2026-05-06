import { FieldType, ObjectInfo, ObjectInfoInputField } from '@shared/comfy/types'

type FieldCondition = (objectInfos: ObjectInfo, objInfoField: ObjectInfoInputField) => boolean

/**
 * @description 判断字段类型是否符合条件
 * @param inputTypes
 * @returns
 */
export const conditionFieldTypeIs = (...inputTypes: FieldType[]): FieldCondition => {
  const isFieldType = (toBefieldType: FieldType, fieldType: FieldType): boolean => {
    if (Array.isArray(toBefieldType)) {
      return Array.isArray(fieldType)
    }
    return fieldType === toBefieldType
  }
  return (objectInfos, objInfoField) => {
    return inputTypes.some((toBefieldType) => isFieldType(toBefieldType, objInfoField[0]))
  }
}

const prepareNodeCondition = (objInfoNode: ObjectInfo) => {
  const requiredInputs = objInfoNode?.input?.required
  const optionalInputs = objInfoNode?.input?.optional

  // 可能存在于 required 和 optional 中, 所以两边都要判断
  // (comfyui-lora-auto-trigger-words 的 clip 字段就在 optional 中)
  const hasField = (field: string, fieldType: FieldType) => {
    const requiredObjInfoField = requiredInputs?.[field]
    const optionalObjInfoField = optionalInputs?.[field]
    return (
      (requiredObjInfoField &&
        conditionFieldTypeIs(fieldType)(objInfoNode, requiredObjInfoField)) ||
      (optionalObjInfoField &&
        conditionFieldTypeIs(fieldType)(objInfoNode, optionalObjInfoField)) ||
      false
    )
  }

  const outputIs = (index: number, fieldType: Exclude<FieldType, string[]>) => {
    const outputFieldType = objInfoNode?.output?.[index]
    if (!outputFieldType) {
      return false
    }
    return outputFieldType === fieldType
  }

  return {
    hasField,
    outputIs
  }
}

/**
 * @description 判断字段是否为图片上传字段
 * @param objectInfos
 * @param objInfoField
 * @returns
 */
export const conditionFieldImageUpload = (
  objectInfos: ObjectInfo,
  objInfoField: ObjectInfoInputField
) => {
  return objInfoField[1]?.['image_upload'] === true
}

export const conditionFieldVideoUpload = (
  objectInfos: ObjectInfo,
  objInfoField: ObjectInfoInputField
) => {
  if (objInfoField[0] !== 'STRING') {
    return false
  }

  const meta = objInfoField[1]
  if (!meta || typeof meta !== 'object') {
    return false
  }

  const accept = typeof meta['accept'] === 'string' ? meta['accept'].toLowerCase() : ''
  const mediaType = typeof meta['media_type'] === 'string' ? meta['media_type'].toLowerCase() : ''
  const fileType = Array.isArray(meta['file_type'])
    ? meta['file_type'].map((item) => String(item).toLowerCase())
    : []

  return (
    meta['video_upload'] === true ||
    accept.includes('video/') ||
    accept.includes('.mp4') ||
    accept.includes('.mov') ||
    mediaType === 'video' ||
    fileType.includes('video')
  )
}

/**
 * @description 判断字段是否为ComfyUI下拉框字段
 * @param objectInfos
 * @param objInfoField
 * @returns
 */
export const conditionFieldComfySelect = (
  objectInfos: ObjectInfo,
  objInfoField: ObjectInfoInputField
) => {
  return Array.isArray(objInfoField[0])
}

/**
 * @description 判断字段是否为随机种子字段
 * @param objectInfos
 * @param objInfoField
 * @returns
 */
export const conditionFieldSeed = (objectInfos: ObjectInfo, objInfoField: ObjectInfoInputField) => {
  return objInfoField[0] === 'INT' && objInfoField[1]?.['control_after_generate'] === true
}

type NodeCondition = (objInfoNode: ObjectInfo) => boolean

/**
 * @description 判断节点是否有宽度和高度的输入字段
 * @param objInfoNode
 * @returns
 */
export const conditionNodeImageSize = (objInfoNode: ObjectInfo) => {
  const inputs = objInfoNode?.input?.required
  if (!inputs) {
    return false
  }
  return 'width' in inputs && 'height' in inputs
}

/**
 * @description 判断节点是否可作为LoRA链的节点
 *
 * 完全为 QAppInLoRAChain 服务。
 * QAppInLoRAChain 通过 input 的字段名与 output 的 index 进行连接，
 * 因此这个条件判断也通过 input 的字段名与 output 的 index 进行判断。
 * @param objInfoNode
 * @returns
 */
export const conditionNodeLoRALoader = (objInfoNode: ObjectInfo) => {
  const { hasField, outputIs } = prepareNodeCondition(objInfoNode)

  return (
    hasField('lora_name', []) &&
    hasField('strength_model', 'FLOAT') &&
    hasField('strength_clip', 'FLOAT') &&
    hasField('model', 'MODEL') &&
    hasField('clip', 'CLIP') &&
    outputIs(0, 'MODEL') &&
    outputIs(1, 'CLIP')
  )
}

/**
 * @description 判断节点是否为LLM API节点
 * @param objInfoNode
 * @returns
 */
export const conditionNodeLLMAPI = (objInfoNode: ObjectInfo) => {
  const { hasField } = prepareNodeCondition(objInfoNode)
  return (
    hasField('model_name', 'STRING') &&
    hasField('base_url', 'STRING') &&
    hasField('api_key', 'STRING')
  )
}

/**
 * @description 判断节点是否为输出节点
 * @param objInfoNode
 * @returns
 */
export const conditionNodeIsOutputNode = (objInfoNode: ObjectInfo) => {
  return objInfoNode?.output_node === true
}
