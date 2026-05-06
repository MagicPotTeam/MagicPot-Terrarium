import { JsonDict } from '@shared/utils/utilTypes'
import { PromptError } from './error'

//////////////////////////
// Object Info
//////////////////////////

export type SelectFieldType = string[]
// not enough, but it's fine for now
export type FieldType =
  | 'STRING'
  | 'FLOAT'
  | 'INT'
  | 'BOOLEAN'
  | 'CLIP'
  | 'MODEL'
  | 'CONDITIONING'
  | 'CLIP'
  | 'VAE'
  | 'LATENT'
  | 'IMAGE'
  | 'MASK'
  | 'CUSTOM'
  | 'CONTROL_NET'
  | SelectFieldType
export type ObjectInfoInputField = [FieldType, unknown]

export type ObjectInfo = {
  input?: {
    required?: {
      [field: string]: ObjectInfoInputField
    }
    optional?: {
      [field: string]: ObjectInfoInputField
    }
    hidden?: {
      [field: string]: unknown
    }
  }
  input_order?: {
    required?: string[]
    optional?: string[]
  }
  output?: FieldType[]
  output_name?: string[]
  name?: string
  display_name?: string
  output_node?: boolean
}

/**
 * ComfyUI /object_info 的返回类型
 */
export type ObjectInfoMap = {
  [classType: string]: ObjectInfo
}

//////////////////////////
// Queue
//////////////////////////

export type QueueItemMeta = {
  client_id: string
  created_at?: number
}

// [?, prompt_id, workflow, { client_id, created_at? }, [node_ids]]
export type QueueItem = [number, string, Workflow, QueueItemMeta, string[]]

/**
 * ComfyUI /queue 的返回类型
 */
export type ComfyQueueResp = {
  queue_running: QueueItem[]
  queue_pending: QueueItem[]
}

//////////////////////////
// Workflow Prompt
//////////////////////////

export type WorkflowInputRef = [string, number] // [node_id, field_index]
export type WorkflowInputValue = string | number | boolean | WorkflowInputRef

export type WorkflowNode = {
  class_type: string
  inputs: {
    [field: string]: WorkflowInputValue
  }
  _meta?: {
    title?: string
  }
}

export type Workflow = {
  [nodeId: string]: WorkflowNode
}

//////////////////////////
// Result & History
//////////////////////////

export type FileItem = {
  filename?: string
  subfolder?: string
  type?: string
  format?: string
}

// 现在只处理 images
export type Outputs = {
  tags?: string[]
  text?: string[]
  images?: FileItem[]
  video?: FileItem[]
  videos?: FileItem[]
  gifs?: FileItem[]
  animated?: FileItem[]
}

/**
 * ComfyHistoryPromptErrorMessage
 * 是一个内部虚构的 ComfyHistoryExecutionMessage
 * 用于表示 prompt 提交失败时返回的结果
 * 由于后端内部代理了 ComfyUI 的排队，导致 prompt 调用时无法直接返回 prompt error
 * 所以需要在 History 返回时，手动伪造一个 prompt_error 消息
 */
export type ComfyHistoryPromptErrorMessage = [
  'prompt_error',
  {
    prompt_id: string
    timestamp: number
  } & PromptError
]

export type ComfyHistoryExecutionMessage =
  | ComfyHistoryPromptErrorMessage
  | [
      'execution_error',
      {
        prompt_id: string
        timestamp: number
        node_id: string
        node_type: string
        executed: string[]
        exception_message: string
        exception_type: string
        traceback: string[]
        current_inputs: unknown
        current_outputs: string[]
      }
    ]
  | [
      'execution_start' | 'execution_cached' | 'execution_success',
      {
        prompt_id: string
        timestamp: number
      }
    ]

export type ComfyHistory = {
  prompt: QueueItem
  outputs: Record<string, Outputs>
  status: {
    status_str: 'error' | 'success'
    completed: boolean
    messages: ComfyHistoryExecutionMessage[]
  }
}
// map<promptId, { outputs: map<nodeId, Outputs> }>
export type ComfyHistoryResp = Record<string, ComfyHistory>
