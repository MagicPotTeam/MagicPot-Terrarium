// 这个文件中最好不要引入其他文件，用于生成 JSON Schema
// npx ts-json-schema-generator --path 'packages/app/src/shared/qApp/cfgTypes.ts' -f config/tsconfig/tsconfig.web.json --no-type-check --type QAppCfg > .vscode/QAppCfg.schema.json

import { JsonPath } from '@shared/utils/jsonPath'

export type QAppCfgSection = {
  label: string
  component: 'Section'
  defaultExpanded?: boolean // default to true
  gridStyle?: 'wide' | 'split' // default to split
}

export type QAppCfgDescription = {
  label: string
  component: 'Description'
  title: string // Title 为空时，不显示标题
  variant: 'info' | 'warning' | 'error' | 'success' // 默认为 info
  description: string
}

/**
 * QAppCfgInputBase 是 QAppCfgInput 的基类
 * 用于快速构建 QAppCfgInput 的子类型
 */
export type QAppCfgInputBase<Component extends string, Cfg = { slot: JsonPath }> = {
  label: string
  component: Component
} & Cfg

export type QAppCfgInputPrompt = QAppCfgInputBase<'InputPrompt'> & {
  placeholder?: string
  suffixPrompt?: string
  /**
   * 提示词最大长度限制，如果小于等于 0 ，则不限制
   */
  maxLength?: number
  /**
   * 提示词描述，用于生成随机提示词
   */
  promptDescription?: string
}
export type QAppCfgInputComfyImage = QAppCfgInputBase<'InputComfyImage'>
export type QAppCfgInputComfyVideo = QAppCfgInputBase<'InputComfyVideo'>
export type QAppCfgInputComfyImageMask = QAppCfgInputBase<'InputComfyImageMask'>
export type QAppCfgInputVideoBoundaryFrames = QAppCfgInputBase<'InputVideoBoundaryFrames', {}> & {
  firstFrameSlot: JsonPath
  lastFrameSlot: JsonPath
}
export type QAppCfgInputSeed = QAppCfgInputBase<'InputSeed'>
export type QAppCfgInputNumber = QAppCfgInputBase<'InputNumber'> & {
  min?: number
  max?: number
  step?: number
}
export type QAppCfgInputText = QAppCfgInputBase<'InputText'> & {
  placeholder?: string
}
export type QAppCfgInputComfySelect = QAppCfgInputBase<'InputComfySelect'>
export type QAppCfgInputImageSize = QAppCfgInputBase<'InputImageSize', {}> &
  (
    | {
        seperateSlots?: false
        nodeSlot: JsonPath // the slot to the node that has width and height fields
      }
    | {
        seperateSlots: true
        widthSlot: JsonPath // the slot to the width field
        heightSlot: JsonPath // the slot to the height field
      }
  )
export type QAppCfgInputSlider = QAppCfgInputBase<'InputSlider'> & {
  min: number
  max: number
  step: number
}
export type QAppCfgInputCamera3D = QAppCfgInputBase<'InputCamera3D', {}> & {
  horizontalSlot: JsonPath
  verticalSlot: JsonPath
  zoomSlot: JsonPath
}
export type QAppCfgInputLoRAChain = QAppCfgInputBase<'InputLoRAChain', {}> & {
  outputModelSlots: JsonPath[] // the slots that receive model from LoRA chain
  outputClipSlots: JsonPath[] // the slots that receive clip from LoRA chain
  inputModel: [string, number] // [nodeId, fieldIndex]
  inputClip: [string, number] // [nodeId, fieldIndex]
}
export type QAppCfgInputLLMAPI = QAppCfgInputBase<'InputLLMAPI', {}> &
  (
    | {
        seperateSlots?: false
        nodeSlot: JsonPath // the slot to the node that has model_name, base_url and api_key fields
      }
    | {
        seperateSlots: true
        modelNameSlot: JsonPath // the slot to the model_name field
        baseUrlSlot: JsonPath // the slot to the base_url field
        apiKeySlot: JsonPath // the slot to the api_key field
        isOllamaSlot: JsonPath // the slot to the is_ollama field
      }
  ) & {
    needVisionModel?: boolean // if true, only vision model is allowed
  }

export type QAppCfgInput =
  | QAppCfgInputPrompt
  | QAppCfgInputComfyImage
  | QAppCfgInputComfyVideo
  | QAppCfgInputComfyImageMask
  | QAppCfgInputVideoBoundaryFrames
  | QAppCfgInputSeed
  | QAppCfgInputNumber
  | QAppCfgInputText
  | QAppCfgInputComfySelect
  | QAppCfgInputImageSize
  | QAppCfgInputSlider
  | QAppCfgInputCamera3D
  | QAppCfgInputLoRAChain
  | QAppCfgInputLLMAPI
export type QAppCfgInputType = QAppCfgInput['component']
export type QAppCfgInputTypeMap = {
  [K in QAppCfgInputType]: Extract<QAppCfgInput, { component: K }>
}

export type QAppCfgAutoBase<Component extends string, Cfg = { slot: JsonPath }> = {
  label: string
  component: Component
} & Cfg

export type QAppCfgAutoSeed = QAppCfgAutoBase<'AutoSeed'>
export type QAppCfgAutoLLMAPI = QAppCfgAutoBase<'AutoLLMAPI', {}> &
  (
    | {
        seperateSlots?: false
        nodeSlot: JsonPath // the slot to the node that has model_name, base_url and api_key fields
      }
    | {
        seperateSlots: true
        modelNameSlot: JsonPath // the slot to the model_name field
        baseUrlSlot: JsonPath // the slot to the base_url field
        apiKeySlot: JsonPath // the slot to the api_key field
        isOllamaSlot: JsonPath // the slot to the is_ollama field
      }
  ) & {
    needVisionModel?: boolean // if true, only vision model is allowed
  }
export type QAppCfgAuto = QAppCfgAutoSeed | QAppCfgAutoLLMAPI
export type QAppCfgAutoType = QAppCfgAuto['component']
export type QAppCfgAutoTypeMap = {
  [K in QAppCfgAutoType]: Extract<QAppCfgAuto, { component: K }>
}

export type QAppCfgAllComponent = QAppCfgInput | QAppCfgSection | QAppCfgDescription | QAppCfgAuto
export type QAppCfgAllComponentType = QAppCfgAllComponent['component']
export type QAppCfgAllComponentTypeMap = {
  [K in QAppCfgAllComponentType]: Extract<QAppCfgAllComponent, { component: K }>
}

export type QAppRequiredModel = {
  /** 模型文件名 */
  name: string
  /** 文件大小描述 */
  size: string
  /** Base directory for dir. Defaults to ComfyUI. */
  baseDir?: 'comfyui' | 'portableHome'
  /** 模型放置目录（相对于 baseDir 对应目录），如 models/unet */
  dir: string
  /** 下载链接 */
  url: string
}

/**
 * Quick App Creative Fabrication Graph
 */
export type QAppCfg = {
  icon: string
  /**
   * ComfyUI 自定义节点 URL 列表
   * 如果 QApp 的 workflow 中使用了自定义节点，则可以在此处指定自定义节点的 URL
   * 在这里定义后，检测到有节点不存在，则提示用户安装该节点
   */
  customNodeUrls?: string[]
  /**
   * 所需模型列表
   * 列出该快应用所需的所有模型文件，包括文件名、大小、放置目录和下载链接
   * 如果检测到模型文件不存在，则在快应用界面提示用户下载
   */
  requiredModels?: QAppRequiredModel[]
  autoInputs?: QAppCfgAuto[]
  inputs: (QAppCfgInput | QAppCfgSection | QAppCfgDescription)[]
  /**
   * 输出节点 ID 列表
   * 当 outputNodeIds 不为空时， QApp 只会把 outputNodeIds 节点的输出作为结果显示
   */
  outputNodeIds?: string[]
  /**
   * 批量处理配置
   * 启用后，快应用会显示"批量处理"按钮
   */
  batchProcess?: {
    /**
     * 是否启用批量处理
     */
    enabled: boolean
    /**
     * 图片输入的 JSON Path
     * 批量处理时会自动替换这个 slot 的值为待处理的图片
     */
    imageInputSlot: JsonPath
    /**
     * 批量处理专用工作流文件名（可选）
     * 如果指定，批量处理时会使用这个工作流而不是默认工作流
     * 这对于需要编译时间的工作流很有用（如 TorchCompile）
     * 文件名相对于当前快应用所在目录
     */
    batchWorkflow?: string
    /**
     * 批量工作流中图片输入的 JSON Path（可选）
     * 如果 batchWorkflow 使用了不同的节点 ID，需要指定这个字段
     * 如果未指定，将使用 imageInputSlot
     */
    batchImageInputSlot?: JsonPath
  }
}
