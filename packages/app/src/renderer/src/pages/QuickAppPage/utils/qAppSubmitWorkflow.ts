import type { SubmitWorkflowReq } from '@shared/api/svcComfy'
import { normalizeExecutableWorkflow } from '@shared/comfy/funcs'
import type { Workflow } from '@shared/comfy/types'
import type { JsonDict } from '@shared/utils/utilTypes'

type BuildQAppSubmitWorkflowRequestOptions = {
  prompt: Workflow
  qAppKey?: string
  clientId?: string | null
  sessionKey?: string | null
  /** Defaults to false so consecutive quick-app generations keep local ComfyUI models warm. */
  cleanupAfterRun?: boolean
  extraData?: JsonDict
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

export const buildQAppSubmitWorkflowRequest = (
  options: BuildQAppSubmitWorkflowRequestOptions
): SubmitWorkflowReq => ({
  prompt: normalizeExecutableWorkflow(options.prompt),
  ...(cleanString(options.qAppKey) ? { qAppKey: cleanString(options.qAppKey) } : {}),
  ...(cleanString(options.clientId) ? { clientId: cleanString(options.clientId) } : {}),
  ...(cleanString(options.sessionKey) ? { sessionKey: cleanString(options.sessionKey) } : {}),
  cleanupAfterRun: options.cleanupAfterRun ?? false,
  ...(options.extraData ? { extra_data: options.extraData } : {})
})
