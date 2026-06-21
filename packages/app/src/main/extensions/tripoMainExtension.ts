import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import { findTripo3DQAppProfile } from '@shared/config/apiProfileSelectors'
import type { MainLlmProxyExtensionV1 } from './generatedRegistry'
import { Tripo3DClient } from '../llmProxy/tripo3dClient'

type Hy3dProfileExtras = {
  animation?: string
  editView?: string
  imageModelVersion?: string
  imageTemplate?: string
  originalTaskId?: string
  rigSpec?: string
  rigType?: string
  sourceFileName?: string
}

const decodeHy3dProfileSegment = (value?: string): string => {
  if (!value) return ''

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const parseHy3dProfileExtras = (segments: string[]): Hy3dProfileExtras => {
  const extras: Hy3dProfileExtras = {}
  let legacySourceFileNameConsumed = false

  for (const segment of segments) {
    if (!segment) continue

    const equalsIndex = segment.indexOf('=')
    if (equalsIndex <= 0) {
      if (!legacySourceFileNameConsumed) {
        extras.sourceFileName = decodeHy3dProfileSegment(segment) || undefined
        legacySourceFileNameConsumed = true
      }
      continue
    }

    const key = segment.slice(0, equalsIndex)
    const value = decodeHy3dProfileSegment(segment.slice(equalsIndex + 1))
    if (!value) continue

    switch (key) {
      case 'animation':
        extras.animation = value
        break
      case 'editView':
        extras.editView = value
        break
      case 'imageModel':
        extras.imageModelVersion = value
        break
      case 'rigSpec':
        extras.rigSpec = value
        break
      case 'rigType':
        extras.rigType = value
        break
      case 'source':
        extras.sourceFileName = value
        break
      case 'task':
        extras.originalTaskId = value
        break
      case 'template':
        extras.imageTemplate = value
        break
      default:
        break
    }
  }

  return extras
}

const handleTripoChatRequest = async (
  req: LLMChatReq,
  options: Parameters<NonNullable<MainLlmProxyExtensionV1['handleChatRequest']>>[1]
): Promise<LLMChatResp | undefined> => {
  const { config } = options
  const [
    baseProfileId,
    hunyuanMode,
    modelVersion,
    generateType,
    faceCount,
    targetFormat,
    faceLevel,
    polygonType,
    enablePBR,
    profileTemplate,
    ...hy3dProfileExtraSegments
  ] = (options.requestedProfileId || req.profileId || '').split('::')

  if (baseProfileId !== 'tripo3d-pro') {
    return undefined
  }

  const tripoProfile = findTripo3DQAppProfile(config)
  if (!tripoProfile?.api_key || !tripoProfile.base_url) {
    throw new Error(
      'No valid Tripo 3D configuration found. Configure the Tripo API Key/Base URL in Settings -> Quick App API.'
    )
  }

  const resolvedMode = hunyuanMode || 'SubmitHunyuanTo3DProJob'
  const hy3dProfileExtras = parseHy3dProfileExtras(hy3dProfileExtraSegments)
  const client = new Tripo3DClient(tripoProfile.api_key, tripoProfile.base_url, {
    fetchImpl: options.fetchImpl,
    signal: options.signal
  })
  const content = await client.generateFromMessages(req.messages, resolvedMode, {
    Animation: hy3dProfileExtras.animation,
    EditView: hy3dProfileExtras.editView,
    EnablePBR: enablePBR === '1',
    FaceCount: faceCount ? parseInt(faceCount, 10) : undefined,
    FaceLevel: faceLevel || 'low',
    GenerateType: generateType,
    ImageModelVersion: hy3dProfileExtras.imageModelVersion,
    ImageTemplate: hy3dProfileExtras.imageTemplate,
    Model: modelVersion,
    OriginalTaskId: hy3dProfileExtras.originalTaskId,
    PolygonType: polygonType || 'triangle',
    ProfileTemplate: profileTemplate || 'DEFAULT',
    RigSpec: hy3dProfileExtras.rigSpec,
    RigType: hy3dProfileExtras.rigType,
    SourceFileName: hy3dProfileExtras.sourceFileName,
    TargetFormat: targetFormat && targetFormat !== 'DEFAULT' ? targetFormat : undefined
  })

  return { content }
}

export const tripoMainLlmProxyExtension: MainLlmProxyExtensionV1 = {
  id: 'tripo',
  async handleChatRequest(req, options) {
    const response = await handleTripoChatRequest(req, options)
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('The request was aborted.')
    }
    return response
  }
}
