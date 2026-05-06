import { JsonDict, JsonValue, Unionize } from '@shared/utils/utilTypes'
import { Outputs } from './types'

export type ExecutionMessageBase = {
  prompt_id: string
  timestamp: number
}

export type StatusWsMessage = {
  status?: {
    exec_info?: {
      queue_remaining?: number
    }
  }
  sid: string
}

export type ProgressWsMessage = {
  value?: number
  max?: number
  prompt_id: string
  node?: string
}

export type ExecutingWsMessage = {
  node: string | null
  display_node?: string
  prompt_id: string
}

export type ExecutedWsMessage = ExecutingWsMessage & {
  output?: Outputs
  merge?: boolean
}

export type ExecutionStartWsMessage = ExecutionMessageBase
export type ExecutionSuccessWsMessage = ExecutionMessageBase
export type ExecutionCachedWsMessage = ExecutionMessageBase & {
  nodes?: string[]
}
export type ExecutionInterruptedWsMessage = ExecutionMessageBase & {
  node_id?: string
  node_type?: string
  executed?: string[] // node_ids
}
export type ExecutionErrorWsMessage = ExecutionMessageBase & {
  node_id?: string
  node_type?: string
  executed?: string[] // node_ids
  exception_message?: string
  exception_type?: string
  traceback?: string[]
  current_inputs: JsonValue
  current_outputs: JsonValue
}

export type LogsWsMessage = {
  size?: {
    cols: number
    rows: number
  }
  entries?: {
    t: string
    m: string
  }[]
}

export type ProgressTextWsMessage = {
  nodeId: string
  text: string
}

export type DisplayComponentWsMessage = {
  node_id: string
  component: 'ChatHistoryWidget'
  props?: Record<string, JsonValue>
}

export type NodeProgressState = {
  value: number
  max: number
  state: 'pending' | 'running' | 'finished' | 'error'
  node_id: string
  prompt_id: string
  display_node_id?: string
  parent_node_id?: string
  real_node_id?: string
}

export type ProgressStateWsMessage = {
  prompt_id: string
  nodes: Record<string, NodeProgressState>
}

export type FeatureFlagsWsMessage = Record<string, JsonValue>

/** Dictionary of Frontend-generated API calls */
interface FrontendApiCalls {
  // graphChanged: ComfyWorkflowJSON
  // promptQueued: { number: number; batchCount: number }
  // graphCleared: never
  // reconnecting: never
  // reconnected: never
}

/** Dictionary of calls originating from ComfyUI core */
type BackendApiCalls = {
  progress: ProgressWsMessage
  executing: ExecutingWsMessage
  executed: ExecutedWsMessage
  status: StatusWsMessage
  execution_start: ExecutionStartWsMessage
  execution_success: ExecutionSuccessWsMessage
  execution_error: ExecutionErrorWsMessage
  execution_interrupted: ExecutionInterruptedWsMessage
  execution_cached: ExecutionCachedWsMessage
  logs: LogsWsMessage
  /** Binary preview/progress data */
  b_preview: Blob
  /** Binary preview with metadata (node_id, prompt_id) */
  b_preview_with_metadata: {
    blob: Blob
    nodeId: string
    parentNodeId: string
    displayNodeId: string
    realNodeId: string
    promptId: string
  }
  progress_text: ProgressTextWsMessage
  progress_state: ProgressStateWsMessage
  display_component: DisplayComponentWsMessage
  feature_flags: FeatureFlagsWsMessage
}

/** Dictionary of all api calls */
interface ApiCalls extends BackendApiCalls, FrontendApiCalls {}

/** Used to create a discriminating union on type value. */
export interface ApiMessage<T extends keyof ApiCalls> {
  type: T
  data: ApiCalls[T]
}

/**
 *  Discriminated union of generic, i.e.:
 * ```ts
 * // Convert
 * type ApiMessageUnion = ApiMessage<'status' | 'executing' | ...>
 * // To
 * type ApiMessageUnion = ApiMessage<'status'> | ApiMessage<'executing'> | ...
 * ```
 */
export type ApiMessageUnion = Unionize<{
  [Key in keyof ApiCalls]: ApiMessage<Key>
}>

// 只保留常用事件
export type ComfyEvent = Unionize<{
  [Key in
    | 'progress'
    | 'executing'
    | 'executed'
    | 'execution_start'
    | 'execution_success'
    | 'execution_error']: ApiMessage<Key>
}>

/**
 * 判断是否为 ComfyEvent
 * 简单判断，没有完全检查 data 中的字段是否符合类型
 * 仅做简化类型判断，需要在外部 try catch 小心处理
 * @param data 需要判断的数据
 * @returns
 */
export function isComfyEvent(data: unknown): data is ComfyEvent {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  const dataObj = data as JsonDict
  return 'type' in dataObj && typeof dataObj.type === 'string' && 'data' in dataObj
}
