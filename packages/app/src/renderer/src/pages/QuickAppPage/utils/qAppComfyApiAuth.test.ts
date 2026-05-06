import { describe, expect, it } from 'vitest'
import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import {
  buildComfyOrgExtraData,
  nodeRequiresComfyOrgAuth,
  workflowRequiresComfyOrgAuth
} from './qAppComfyApiAuth'

describe('qAppComfyApiAuth', () => {
  const objectInfos: ObjectInfoMap = {
    VeoVideoGenerationNode: {
      input: {
        hidden: {
          auth_token_comfy_org: 'AUTH_TOKEN_COMFY_ORG',
          api_key_comfy_org: 'API_KEY_COMFY_ORG'
        }
      }
    },
    SaveImage: {
      input: {
        required: {
          filename_prefix: ['STRING', {}]
        }
      }
    }
  }

  it('detects Comfy Org auth requirements from hidden node metadata', () => {
    expect(nodeRequiresComfyOrgAuth('VeoVideoGenerationNode', objectInfos)).toBe(true)
    expect(nodeRequiresComfyOrgAuth('SaveImage', objectInfos)).toBe(false)
  })

  it('detects when a workflow contains Comfy Org protected nodes', () => {
    const workflow: Workflow = {
      '1': {
        class_type: 'SaveImage',
        inputs: {}
      },
      '2': {
        class_type: 'VeoVideoGenerationNode',
        inputs: {}
      }
    }

    expect(workflowRequiresComfyOrgAuth(workflow, objectInfos)).toBe(true)
  })

  it('builds Comfy Org extra_data only when an API key is present', () => {
    expect(buildComfyOrgExtraData('   ')).toBeUndefined()
    expect(buildComfyOrgExtraData('sk-test')).toEqual({
      api_key_comfy_org: 'sk-test'
    })
  })
})
