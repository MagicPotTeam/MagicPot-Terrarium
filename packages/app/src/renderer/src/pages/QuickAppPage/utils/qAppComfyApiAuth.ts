import { ObjectInfoMap, Workflow } from '@shared/comfy/types'

export const QAPP_COMFY_ORG_API_KEY_FORM_KEY = '__qapp_comfy_org_api_key__'

const COMFY_ORG_HIDDEN_KEYS = new Set(['auth_token_comfy_org', 'api_key_comfy_org'])
const COMFY_ORG_HIDDEN_VALUES = new Set(['AUTH_TOKEN_COMFY_ORG', 'API_KEY_COMFY_ORG'])

export const nodeRequiresComfyOrgAuth = (
  classType: string,
  objectInfos?: ObjectInfoMap
): boolean => {
  if (!objectInfos) {
    return false
  }

  const hidden = objectInfos[classType]?.input?.hidden
  if (!hidden || typeof hidden !== 'object') {
    return false
  }

  const hiddenEntries = hidden as Record<string, unknown>
  return (
    Object.keys(hiddenEntries).some((key) => COMFY_ORG_HIDDEN_KEYS.has(key)) ||
    Object.values(hiddenEntries).some((value) => COMFY_ORG_HIDDEN_VALUES.has(String(value)))
  )
}

export const workflowRequiresComfyOrgAuth = (
  workflow: Workflow,
  objectInfos?: ObjectInfoMap
): boolean => {
  return Object.values(workflow).some((node) =>
    nodeRequiresComfyOrgAuth(node.class_type, objectInfos)
  )
}

export const buildComfyOrgExtraData = (
  apiKey: string
): { api_key_comfy_org: string } | undefined => {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return undefined
  }

  return {
    api_key_comfy_org: trimmed
  }
}
