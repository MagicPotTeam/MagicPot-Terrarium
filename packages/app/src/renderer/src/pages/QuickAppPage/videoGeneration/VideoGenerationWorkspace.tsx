import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Divider,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { DownloadOutlined, MovieCreationOutlined, OpenInNewOutlined } from '@mui/icons-material'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { api } from '@renderer/utils/windowUtils'
import { downloadFile, fileToDataUrl, selectFile } from '@renderer/utils/fileUtils'
import type { ChatAttachment, LLMChatResp, LLMProfileScope } from '@shared/api/svcLLMProxy'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import type {
  VideoGenerationCameraPreset,
  VideoGenerationCameraSimpleControls,
  VideoGenerationJsonObject,
  VideoGenerationOptions,
  VideoGenerationReferenceRole
} from '@shared/llm/types'
import type { ResultItem } from '@shared/qApp/resultTypes'
import { dispatchQAppResultsToCanvas } from '../utils/qAppCanvasDispatch'
import React from 'react'
import { useTranslation } from 'react-i18next'

const VIDEO_GENERATION_RESULT_PROMPT_ID = 'builtin-video-generation'
const KLING_ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1'] as const
const SEEDANCE_ASPECT_RATIO_OPTIONS = [
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
  'adaptive'
] as const
const KLING_DURATION_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const
const SEEDANCE_DURATION_OPTIONS = [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const
const KLING_MODE_OPTIONS = ['std', 'pro', '4k'] as const
const KLING_CAMERA_PRESET_OPTIONS: VideoGenerationCameraPreset[] = [
  'none',
  'down_back',
  'forward_up',
  'right_turn_forward',
  'left_turn_forward'
]
const KLING_CAMERA_SIMPLE_CONTROL_KEYS: Array<keyof VideoGenerationCameraSimpleControls> = [
  'horizontal',
  'vertical',
  'pan',
  'tilt',
  'roll',
  'zoom'
]
const KLING_CAMERA_SIMPLE_CONTROL_MIN = -10
const KLING_CAMERA_SIMPLE_CONTROL_MAX = 10
const SEEDANCE_RESOLUTION_OPTIONS = ['480p', '720p', '1080p'] as const
const SEEDANCE_REFERENCE_ROLE_OPTIONS: Array<VideoGenerationReferenceRole | 'auto'> = [
  'auto',
  'first_frame',
  'last_frame',
  'reference_image'
]

const ASSET_SLOT_KEYS = [
  'firstFrame',
  'lastFrame',
  'referenceImage',
  'referenceVideo',
  'referenceAudio'
] as const
const IMAGE_ASSET_SLOT_KEYS = ['firstFrame', 'lastFrame', 'referenceImage'] as const
const NON_IMAGE_ASSET_SLOT_KEYS = ['referenceVideo', 'referenceAudio'] as const

const ASSET_SLOT_ROLES: Record<
  (typeof IMAGE_ASSET_SLOT_KEYS)[number],
  VideoGenerationReferenceRole
> = {
  firstFrame: 'first_frame',
  lastFrame: 'last_frame',
  referenceImage: 'reference_image'
}

const ASSET_SLOT_REFERENCE_ROLES: Record<
  (typeof ASSET_SLOT_KEYS)[number],
  VideoGenerationReferenceRole
> = {
  firstFrame: 'first_frame',
  lastFrame: 'last_frame',
  referenceImage: 'reference_image',
  referenceVideo: 'reference_video',
  referenceAudio: 'reference_audio'
}

const ASSET_SLOT_CONFIG: Record<
  (typeof ASSET_SLOT_KEYS)[number],
  {
    kind: 'image' | 'video' | 'audio'
    extensions: string[]
    fallbackMimeType: string
  }
> = {
  firstFrame: {
    kind: 'image',
    extensions: ['png', 'jpg', 'jpeg'],
    fallbackMimeType: 'image/png'
  },
  lastFrame: {
    kind: 'image',
    extensions: ['png', 'jpg', 'jpeg'],
    fallbackMimeType: 'image/png'
  },
  referenceImage: {
    kind: 'image',
    extensions: ['png', 'jpg', 'jpeg'],
    fallbackMimeType: 'image/png'
  },
  referenceVideo: {
    kind: 'video',
    extensions: ['mp4', 'webm', 'mov', 'm4v'],
    fallbackMimeType: 'video/mp4'
  },
  referenceAudio: {
    kind: 'audio',
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg'],
    fallbackMimeType: 'audio/mpeg'
  }
}

type AssetSlotKey = (typeof ASSET_SLOT_KEYS)[number]
type ImageAssetSlotKey = (typeof IMAGE_ASSET_SLOT_KEYS)[number]
type NonImageAssetSlotKey = (typeof NON_IMAGE_ASSET_SLOT_KEYS)[number]
type AssetKind = (typeof ASSET_SLOT_CONFIG)[AssetSlotKey]['kind']
type AssetSlotState = {
  dataUrl: string
  fileName: string
  mimeType: string
  source?: 'file' | 'url'
}
type KlingCameraSimpleControlKey = keyof VideoGenerationCameraSimpleControls
type KlingCameraSimpleControlInputState = Record<KlingCameraSimpleControlKey, string>
type ExtendedVideoGenerationOptions = VideoGenerationOptions & Record<string, unknown>
type AdvancedJsonParseResult = {
  value?: VideoGenerationJsonObject
  error?: string
}
type ValidationState = {
  errors: string[]
  warnings: string[]
}

const createEmptyAssetSlot = (): AssetSlotState => ({ dataUrl: '', fileName: '', mimeType: '' })

const createEmptyAssetSlots = (): Record<AssetSlotKey, AssetSlotState> => ({
  firstFrame: createEmptyAssetSlot(),
  lastFrame: createEmptyAssetSlot(),
  referenceImage: createEmptyAssetSlot(),
  referenceVideo: createEmptyAssetSlot(),
  referenceAudio: createEmptyAssetSlot()
})

const createEmptyKlingCameraSimpleControls = (): KlingCameraSimpleControlInputState => ({
  horizontal: '',
  vertical: '',
  pan: '',
  tilt: '',
  roll: '',
  zoom: ''
})

const resolveErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const getDataUrlMimeType = (dataUrl: string): string | undefined =>
  dataUrl.match(/^data:([^;,]+)[;,]/i)?.[1]

const getFileExtension = (fileName: string): string =>
  fileName.split('.').pop()?.trim().toLowerCase() || ''

const isExpectedFileKind = (
  file: File,
  kind: AssetKind,
  extensions: readonly string[]
): boolean => {
  if (file.type) {
    return file.type.startsWith(`${kind}/`)
  }
  return extensions.includes(getFileExtension(file.name))
}

const getAssetMimeType = (slotKey: AssetSlotKey, asset: AssetSlotState): string =>
  asset.mimeType || getDataUrlMimeType(asset.dataUrl) || ASSET_SLOT_CONFIG[slotKey].fallbackMimeType

const hasSelectedAsset = (asset: AssetSlotState): boolean => Boolean(asset.dataUrl)

const getSelectedImageAssetSlots = (
  assetSlots: Record<AssetSlotKey, AssetSlotState>
): ImageAssetSlotKey[] =>
  IMAGE_ASSET_SLOT_KEYS.filter((slotKey) => hasSelectedAsset(assetSlots[slotKey]))

const getSelectedNonImageAssetSlots = (
  assetSlots: Record<AssetSlotKey, AssetSlotState>
): NonImageAssetSlotKey[] =>
  NON_IMAGE_ASSET_SLOT_KEYS.filter((slotKey) => hasSelectedAsset(assetSlots[slotKey]))

const getProviderImageAssetSlots = (
  provider: VideoProvider | undefined,
  assetSlots: Record<AssetSlotKey, AssetSlotState>
): ImageAssetSlotKey[] => {
  if (provider === 'kling') {
    const slots: ImageAssetSlotKey[] = []
    if (hasSelectedAsset(assetSlots.firstFrame)) {
      slots.push('firstFrame')
    } else if (hasSelectedAsset(assetSlots.referenceImage)) {
      slots.push('referenceImage')
    }
    if (hasSelectedAsset(assetSlots.lastFrame)) {
      slots.push('lastFrame')
    }
    return slots
  }

  return getSelectedImageAssetSlots(assetSlots)
}

const getSeedanceReferenceRoleForOptions = (
  roleSelection: VideoGenerationReferenceRole | 'auto',
  selectedImageSlots: readonly ImageAssetSlotKey[]
): VideoGenerationReferenceRole | undefined => {
  if (roleSelection !== 'auto') {
    return roleSelection
  }
  if (selectedImageSlots.length === 1) {
    return ASSET_SLOT_ROLES[selectedImageSlots[0]]
  }
  return undefined
}

const parsePositiveInteger = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined
  }
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const isValidHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const isValidReferenceAssetUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'asset:'
  } catch {
    return false
  }
}

const isDataUrlAsset = (asset: AssetSlotState): boolean => asset.dataUrl.startsWith('data:')

const isPlainJsonObject = (value: unknown): value is VideoGenerationJsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseAdvancedJsonInput = (value: string): AdvancedJsonParseResult => {
  const trimmed = value.trim()
  if (!trimmed) {
    return {}
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainJsonObject(parsed)) {
      return { error: 'Advanced JSON must be a JSON object.' }
    }
    return { value: parsed }
  } catch (error) {
    return {
      error: `Advanced JSON must be valid JSON: ${resolveErrorMessage(error)}`
    }
  }
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())

const createAdvancedOptions = (
  advancedJson: VideoGenerationJsonObject | undefined
): Record<string, unknown> => {
  if (!advancedJson) {
    return {}
  }
  const options: Record<string, unknown> = { advancedJson }
  for (const [key, value] of Object.entries(advancedJson)) {
    options[key] = value
    const camelKey = snakeToCamel(key)
    if (!hasOwn(options, camelKey)) {
      options[camelKey] = value
    }
  }
  return options
}

const getParsedNumberInput = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

const buildKlingCameraSimpleControls = (
  controls: KlingCameraSimpleControlInputState
): VideoGenerationCameraSimpleControls | undefined => {
  const result: VideoGenerationCameraSimpleControls = {}
  for (const key of KLING_CAMERA_SIMPLE_CONTROL_KEYS) {
    const parsed = getParsedNumberInput(controls[key])
    if (parsed != null) {
      result[key] = parsed
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const getKlingCameraSimpleControlError = (
  controls: KlingCameraSimpleControlInputState
): string | undefined => {
  for (const key of KLING_CAMERA_SIMPLE_CONTROL_KEYS) {
    const trimmed = controls[key].trim()
    if (!trimmed) {
      continue
    }
    const parsed = Number(trimmed)
    if (
      !Number.isFinite(parsed) ||
      parsed < KLING_CAMERA_SIMPLE_CONTROL_MIN ||
      parsed > KLING_CAMERA_SIMPLE_CONTROL_MAX
    ) {
      return 'Kling camera simple controls must be numbers from -10 to 10.'
    }
  }
  return undefined
}

const getUrlFileName = (url: string, fallback: string): string => {
  try {
    const parsed = new URL(url)
    const pathName = parsed.pathname.split('/').filter(Boolean).pop()
    return pathName || fallback
  } catch {
    return fallback
  }
}

const redactAssetUrlForPreview = (slotKey: AssetSlotKey, asset: AssetSlotState): string => {
  const mimeType = getAssetMimeType(slotKey, asset)
  const fileName = asset.fileName || slotKey
  if (!asset.dataUrl) {
    return ''
  }
  if (asset.dataUrl.startsWith('data:')) {
    return `[${mimeType} data URL: ${fileName}]`
  }
  return asset.dataUrl
}

const createAssetAttachment = (slotKey: AssetSlotKey, asset: AssetSlotState): ChatAttachment => {
  const config = ASSET_SLOT_CONFIG[slotKey]
  const role = ASSET_SLOT_REFERENCE_ROLES[slotKey]
  return {
    type: config.kind === 'image' ? 'image' : config.kind === 'video' ? 'video' : 'file',
    url: asset.dataUrl,
    mimeType: getAssetMimeType(slotKey, asset),
    fileName: asset.fileName || `${slotKey}.${config.extensions[0]}`,
    metadata: {
      videoGenerationAssetSlot: slotKey,
      videoGenerationRole: role
    },
    referenceRole: role
  } as ChatAttachment
}

const createPreviewAttachment = (attachment: ChatAttachment): Record<string, unknown> => ({
  type: attachment.type,
  mimeType: attachment.mimeType,
  fileName: attachment.fileName,
  url:
    attachment.url && attachment.metadata?.videoGenerationAssetSlot
      ? redactAssetUrlForPreview(attachment.metadata.videoGenerationAssetSlot as AssetSlotKey, {
          dataUrl: attachment.url,
          fileName: attachment.fileName || '',
          mimeType: attachment.mimeType || ''
        })
      : attachment.url,
  metadata: attachment.metadata
})

const createProviderAssetPreview = (
  slotKey: AssetSlotKey,
  assetSlots: Record<AssetSlotKey, AssetSlotState>
): string | undefined => {
  const asset = assetSlots[slotKey]
  if (!hasSelectedAsset(asset)) {
    return undefined
  }
  return redactAssetUrlForPreview(slotKey, asset)
}

const buildProviderRequestPreview = ({
  provider,
  profile,
  prompt,
  options,
  assetSlots,
  providerImageSlots
}: {
  provider?: VideoProvider
  profile?: LLMAPIProfile
  prompt: string
  options: ExtendedVideoGenerationOptions
  assetSlots: Record<AssetSlotKey, AssetSlotState>
  providerImageSlots: readonly ImageAssetSlotKey[]
}): Record<string, unknown> => {
  const trimmedPrompt = prompt.trim()
  const callbackUrl = options.callbackUrl?.trim()
  const externalTaskId = options.externalTaskId?.trim()

  if (provider === 'kling') {
    const leadingSlot = providerImageSlots.find((slotKey) => slotKey !== 'lastFrame')
    const hasLeadingImage = Boolean(leadingSlot)
    const body: Record<string, unknown> = {
      model_name: profile?.model_name || ''
    }
    if (options.advancedJson && typeof options.advancedJson === 'object') {
      Object.assign(body, options.advancedJson)
    }
    if (trimmedPrompt) {
      body.prompt = trimmedPrompt
    }
    if (hasLeadingImage && leadingSlot) {
      body.image = createProviderAssetPreview(leadingSlot, assetSlots)
      if (hasSelectedAsset(assetSlots.lastFrame)) {
        body.image_tail = createProviderAssetPreview('lastFrame', assetSlots)
      }
    } else {
      body.aspect_ratio = options.aspectRatio
    }
    if (options.duration != null) {
      body.duration = options.duration
    }
    if (options.negativePrompt) {
      body.negative_prompt = options.negativePrompt
    }
    if (options.cfgScale != null) {
      body.cfg_scale = options.cfgScale
    }
    if (options.mode) {
      body.mode = options.mode
    }
    if (options.sound) {
      body.sound = options.sound
    }
    if (options.cameraControl) {
      body.camera_control = options.cameraControl
    } else if (options.cameraSimpleControls) {
      body.camera_control = { type: 'simple', config: options.cameraSimpleControls }
    } else if (options.cameraPreset && options.cameraPreset !== 'none') {
      body.camera_control = { type: options.cameraPreset }
    }
    if (typeof options.watermark === 'boolean') {
      body.watermark_info = { enabled: options.watermark }
    }
    if (callbackUrl) {
      body.callback_url = callbackUrl
    }
    if (externalTaskId) {
      body.external_task_id = externalTaskId
    }
    return {
      note: 'Preview only. The main-process video client builds the final provider request.',
      endpoint: `/v1/videos/${hasLeadingImage ? 'image2video' : 'text2video'}`,
      body
    }
  }

  const content: Array<Record<string, unknown>> = []
  if (trimmedPrompt) {
    content.push({ type: 'text', text: trimmedPrompt })
  }
  for (const slotKey of providerImageSlots) {
    content.push({
      type: 'image_url',
      role: ASSET_SLOT_ROLES[slotKey],
      image_url: { url: createProviderAssetPreview(slotKey, assetSlots) }
    })
  }
  if (hasSelectedAsset(assetSlots.referenceVideo)) {
    content.push({
      type: 'video_url',
      role: 'reference_video',
      video_url: { url: createProviderAssetPreview('referenceVideo', assetSlots) },
      unsupportedByCurrentClient: true
    })
  }
  if (hasSelectedAsset(assetSlots.referenceAudio)) {
    content.push({
      type: 'audio_url',
      role: 'reference_audio',
      audio_url: { url: createProviderAssetPreview('referenceAudio', assetSlots) },
      unsupportedByCurrentClient: true
    })
  }

  const body: Record<string, unknown> = {
    model: profile?.model_name || '',
    content,
    ratio: options.aspectRatio,
    duration: options.duration,
    watermark: options.watermark ?? false,
    ...(options.advancedJson && typeof options.advancedJson === 'object'
      ? options.advancedJson
      : {})
  }
  if (options.resolution) {
    body.resolution = options.resolution
  }
  if (options.frames != null) {
    body.frames = options.frames
  }
  if (typeof options.generateAudio === 'boolean') {
    body.generate_audio = options.generateAudio
  }
  if (typeof options.returnLastFrame === 'boolean') {
    body.return_last_frame = options.returnLastFrame
  }
  if (callbackUrl) {
    body.callback_url = callbackUrl
  }
  return {
    note: 'Preview only. The main-process video client builds the final provider request.',
    endpoint: '/contents/generations/tasks',
    body
  }
}

type VideoProvider = 'kling' | 'volcengine'

const normalizeVideoProvider = (provider?: string): VideoProvider | undefined => {
  switch (provider) {
    case 'kling':
    case 'volcengine':
      return provider
    default:
      return undefined
  }
}

const hasExplicitNonVideoUse = (profile: LLMAPIProfile): boolean => {
  const modelUse = String(profile.model_use || '').trim()
  return Boolean(modelUse && modelUse !== 'default' && modelUse !== 'video')
}

const KLING_VIDEO_PROVIDER_DOMAINS = ['klingai.com', 'klingapi.com'] as const
const VOLCENGINE_VIDEO_PROVIDER_DOMAINS = [
  'ark.cn-beijing.volces.com',
  'volcengineapi.com',
  'byteplusapi.com'
] as const

const parseHttpUrl = (url: string): URL | undefined => {
  const normalized = url.trim()
  if (!normalized) {
    return undefined
  }

  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

const hostnameMatchesDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`)

const matchesVideoProviderHost = (url: string, domains: readonly string[]): boolean => {
  const parsed = parseHttpUrl(url)
  if (!parsed) {
    return false
  }

  const hostname = parsed.hostname.toLowerCase()
  return domains.some((domain) => hostnameMatchesDomain(hostname, domain))
}

const isSeedanceTaskEndpointUrl = (url: string): boolean => {
  const parsed = parseHttpUrl(url)
  const normalized = parsed?.pathname || url.trim().toLowerCase()
  return normalized.toLowerCase().includes('/contents/generations/tasks')
}

const resolveVideoProfileProvider = (profile: LLMAPIProfile): VideoProvider | undefined => {
  if (hasExplicitNonVideoUse(profile)) {
    return undefined
  }

  const explicitProvider = normalizeVideoProvider(profile.provider)
  if (explicitProvider) {
    return explicitProvider
  }

  const modelName = profile.model_name.trim().toLowerCase()
  const baseUrl = profile.base_url.trim()
  const isExplicitVideo = profile.model_use === 'video'

  if (
    (isExplicitVideo || modelName.startsWith('kling-')) &&
    matchesVideoProviderHost(baseUrl, KLING_VIDEO_PROVIDER_DOMAINS)
  ) {
    return 'kling'
  }

  if (
    isSeedanceTaskEndpointUrl(baseUrl) ||
    (isExplicitVideo &&
      (modelName.startsWith('doubao-seedance-') ||
        matchesVideoProviderHost(baseUrl, VOLCENGINE_VIDEO_PROVIDER_DOMAINS)))
  ) {
    return 'volcengine'
  }

  return undefined
}

const isVideoProfile = (profile: LLMAPIProfile): boolean => {
  const provider = resolveVideoProfileProvider(profile)
  if (!provider || !profile.model_name.trim() || !profile.base_url.trim()) {
    return false
  }
  if (provider === 'kling') {
    return Boolean(profile.api_key.trim() && profile.api_secret?.trim())
  }
  return Boolean(profile.api_key.trim())
}

const createVideoResultItem = (
  attachment: ChatAttachment,
  videoUrl: string,
  options: { promptId?: string; projectId?: string } = {}
): ResultItem => ({
  id: crypto.randomUUID(),
  promptId: options.promptId || VIDEO_GENERATION_RESULT_PROMPT_ID,
  type: 'video',
  objectUrl: videoUrl,
  projectId: options.projectId,
  fileItem: {
    filename: attachment.fileName || `ai-video-${Date.now()}.mp4`,
    type: 'output',
    format: attachment.mimeType || 'video/mp4'
  }
})

const getFirstVideoAttachment = (result: LLMChatResp): ChatAttachment | undefined =>
  result.attachments?.find((attachment) => attachment.type === 'video' && attachment.url.trim())

type VideoProfileOption = {
  key: string
  profile: LLMAPIProfile
  scope: LLMProfileScope
}

const buildVideoProfileOptions = (config: Config): VideoProfileOption[] => {
  const options: VideoProfileOption[] = []
  const seen = new Set<string>()
  const addOption = (profile: LLMAPIProfile, scope: LLMProfileScope) => {
    if (!isVideoProfile(profile)) {
      return
    }
    const key = `${scope}:${profile.id}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    options.push({ key, profile, scope })
  }

  for (const profile of config.plugin_config?.api_profiles ?? []) {
    addOption(profile, 'qapp')
  }

  for (const profile of config.llm_config.api_profiles) {
    addOption(profile, 'agent')
  }

  return options
}

type VideoGenerationWorkspaceProps = {
  projectId?: string
  inline?: boolean
  resultPromptId?: string
}

const VideoGenerationWorkspace: React.FC<VideoGenerationWorkspaceProps> = ({
  projectId,
  inline = false,
  resultPromptId = VIDEO_GENERATION_RESULT_PROMPT_ID
}) => {
  const { t } = useTranslation()
  const { config } = useConfig()
  const { notifyError, notifySuccess } = useMessage()
  const { appendResults } = useComfyStatus()
  const [selectedProfileKey, setSelectedProfileKey] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  const [assetSlots, setAssetSlots] = React.useState<Record<AssetSlotKey, AssetSlotState>>(() =>
    createEmptyAssetSlots()
  )
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [statusText, setStatusText] = React.useState('')
  const [hasStatusError, setHasStatusError] = React.useState(false)
  const [latestVideoUrl, setLatestVideoUrl] = React.useState('')
  const [latestFileName, setLatestFileName] = React.useState('')
  const [aspectRatio, setAspectRatio] = React.useState('16:9')
  const [duration, setDuration] = React.useState(5)
  const [negativePrompt, setNegativePrompt] = React.useState('')
  const [callbackUrl, setCallbackUrl] = React.useState('')
  const [externalTaskId, setExternalTaskId] = React.useState('')
  const [cfgScale, setCfgScale] = React.useState('')
  const [klingMode, setKlingMode] = React.useState<(typeof KLING_MODE_OPTIONS)[number]>('std')
  const [klingSound, setKlingSound] = React.useState<'off' | 'on'>('off')
  const [klingCameraPreset, setKlingCameraPreset] =
    React.useState<VideoGenerationCameraPreset>('none')
  const [klingCameraSimpleControlInputs, setKlingCameraSimpleControlInputs] =
    React.useState<KlingCameraSimpleControlInputState>(() => createEmptyKlingCameraSimpleControls())
  const [watermark, setWatermark] = React.useState(false)
  const [seedanceResolution, setSeedanceResolution] =
    React.useState<(typeof SEEDANCE_RESOLUTION_OPTIONS)[number]>('720p')
  const [seedanceGenerateAudio, setSeedanceGenerateAudio] = React.useState(false)
  const [seedanceReturnLastFrame, setSeedanceReturnLastFrame] = React.useState(false)
  const [seedanceReferenceRole, setSeedanceReferenceRole] = React.useState<
    VideoGenerationReferenceRole | 'auto'
  >('auto')
  const [frames, setFrames] = React.useState('')
  const [advancedJson, setAdvancedJson] = React.useState('')
  const [assetUrlInputs, setAssetUrlInputs] = React.useState<Record<AssetSlotKey, string>>(() => ({
    firstFrame: '',
    lastFrame: '',
    referenceImage: '',
    referenceVideo: '',
    referenceAudio: ''
  }))
  const [showValidation, setShowValidation] = React.useState(false)

  const txt = React.useCallback(
    (key: string, defaultValue: string, values?: Record<string, unknown>) =>
      t(`qapp.video_generation.${key}`, { defaultValue, ...values }),
    [t]
  )

  const videoProfileOptions = React.useMemo(() => buildVideoProfileOptions(config), [config])

  React.useEffect(() => {
    if (
      selectedProfileKey &&
      videoProfileOptions.some((option) => option.key === selectedProfileKey)
    ) {
      return
    }
    setSelectedProfileKey(videoProfileOptions[0]?.key || '')
  }, [selectedProfileKey, videoProfileOptions])

  const selectedProfileOption = React.useMemo(
    () => videoProfileOptions.find((option) => option.key === selectedProfileKey),
    [selectedProfileKey, videoProfileOptions]
  )
  const selectedProfile = selectedProfileOption?.profile
  const selectedProvider = selectedProfile
    ? resolveVideoProfileProvider(selectedProfile)
    : undefined
  const aspectRatioOptions =
    selectedProvider === 'volcengine' ? SEEDANCE_ASPECT_RATIO_OPTIONS : KLING_ASPECT_RATIO_OPTIONS
  const durationOptions =
    selectedProvider === 'volcengine' ? SEEDANCE_DURATION_OPTIONS : KLING_DURATION_OPTIONS
  const selectedImageAssetSlots = React.useMemo(
    () => getSelectedImageAssetSlots(assetSlots),
    [assetSlots]
  )
  const selectedNonImageAssetSlots = React.useMemo(
    () => getSelectedNonImageAssetSlots(assetSlots),
    [assetSlots]
  )
  const providerImageAssetSlots = React.useMemo(
    () => getProviderImageAssetSlots(selectedProvider, assetSlots),
    [assetSlots, selectedProvider]
  )
  const parsedAdvancedJson = React.useMemo(
    () => parseAdvancedJsonInput(advancedJson),
    [advancedJson]
  )

  React.useEffect(() => {
    if (!(aspectRatioOptions as readonly string[]).includes(aspectRatio)) {
      setAspectRatio(aspectRatioOptions[0])
    }
  }, [aspectRatio, aspectRatioOptions])

  React.useEffect(() => {
    if (!(durationOptions as readonly number[]).includes(duration)) {
      setDuration(durationOptions[0])
    }
  }, [duration, durationOptions])

  const buildVideoGenerationOptions = React.useCallback((): ExtendedVideoGenerationOptions => {
    const options: ExtendedVideoGenerationOptions = {
      aspectRatio,
      duration,
      watermark,
      ...createAdvancedOptions(parsedAdvancedJson.value)
    }
    const parsedCfgScale = cfgScale.trim() ? Number(cfgScale) : Number.NaN
    const parsedFrames = parsePositiveInteger(frames)
    const trimmedCallbackUrl = callbackUrl.trim()
    const trimmedExternalTaskId = externalTaskId.trim()

    if (negativePrompt.trim()) {
      options.negativePrompt = negativePrompt.trim()
    }
    if (trimmedCallbackUrl) {
      options.callbackUrl = trimmedCallbackUrl
    }

    if (selectedProvider === 'kling') {
      if (trimmedExternalTaskId) {
        options.externalTaskId = trimmedExternalTaskId
      }
      options.mode = klingMode
      options.sound = klingSound
      options.cameraPreset = klingCameraPreset
      const cameraSimpleControls = buildKlingCameraSimpleControls(klingCameraSimpleControlInputs)
      if (cameraSimpleControls) {
        options.cameraSimpleControls = cameraSimpleControls
        options.cameraControl = { type: 'simple', config: cameraSimpleControls }
      }
      if (Number.isFinite(parsedCfgScale)) {
        options.cfgScale = parsedCfgScale
      }
      return options
    }

    if (selectedProvider === 'volcengine') {
      options.durationMode = duration === -1 ? 'adaptive' : 'fixed'
      options.resolution = seedanceResolution
      options.generateAudio = seedanceGenerateAudio
      options.returnLastFrame = seedanceReturnLastFrame
      const referenceRole = getSeedanceReferenceRoleForOptions(
        seedanceReferenceRole,
        selectedImageAssetSlots
      )
      if (referenceRole) {
        options.referenceRole = referenceRole
      }
      if (parsedFrames != null) {
        options.frames = parsedFrames
      }
    }
    return options
  }, [
    aspectRatio,
    callbackUrl,
    cfgScale,
    duration,
    externalTaskId,
    frames,
    klingCameraPreset,
    klingCameraSimpleControlInputs,
    klingMode,
    klingSound,
    negativePrompt,
    parsedAdvancedJson.value,
    seedanceGenerateAudio,
    seedanceReferenceRole,
    seedanceResolution,
    seedanceReturnLastFrame,
    selectedImageAssetSlots,
    selectedProvider,
    watermark
  ])

  const buildMessageAttachments = React.useCallback((): ChatAttachment[] => {
    const attachments: ChatAttachment[] = []
    for (const slotKey of providerImageAssetSlots) {
      const asset = assetSlots[slotKey]
      if (hasSelectedAsset(asset)) {
        attachments.push(createAssetAttachment(slotKey, asset))
      }
    }
    for (const slotKey of NON_IMAGE_ASSET_SLOT_KEYS) {
      const asset = assetSlots[slotKey]
      if (hasSelectedAsset(asset)) {
        attachments.push(createAssetAttachment(slotKey, asset))
      }
    }
    return attachments
  }, [assetSlots, providerImageAssetSlots])

  const validateCurrentRequest = React.useCallback((): ValidationState => {
    const errors: string[] = []
    const warnings: string[] = []
    const trimmedPrompt = prompt.trim()
    const hasFirstFrame = hasSelectedAsset(assetSlots.firstFrame)
    const hasLastFrame = hasSelectedAsset(assetSlots.lastFrame)
    const hasReferenceImage = hasSelectedAsset(assetSlots.referenceImage)
    const hasSupportedAssetInput =
      selectedProvider === 'kling'
        ? hasFirstFrame || hasReferenceImage
        : selectedImageAssetSlots.length > 0 || selectedNonImageAssetSlots.length > 0

    if (!selectedProfile) {
      errors.push(
        txt(
          'errors.missing_profile',
          'Configure a Kling or Volcengine/Seedance video model in Settings first.'
        )
      )
    }
    if (selectedProfile && !selectedProvider) {
      errors.push(txt('errors.unknown_provider', 'The selected profile is not a video provider.'))
    }
    if (!trimmedPrompt && !hasSupportedAssetInput) {
      errors.push(
        txt(
          'errors.prompt_or_supported_asset_required',
          'Enter a video prompt or choose a supported image asset.'
        )
      )
    }

    if (callbackUrl.trim() && !isValidHttpUrl(callbackUrl.trim())) {
      errors.push(txt('errors.callback_url_invalid', 'Callback URL must be a valid http(s) URL.'))
    }
    if (parsedAdvancedJson.error) {
      errors.push(txt('errors.advanced_json_invalid', parsedAdvancedJson.error))
    }

    if (selectedProvider === 'kling') {
      if (cfgScale.trim()) {
        const parsedCfgScale = Number(cfgScale)
        if (!Number.isFinite(parsedCfgScale) || parsedCfgScale < 0 || parsedCfgScale > 1) {
          errors.push(
            txt('errors.cfg_scale_invalid', 'Kling CFG scale must be a number from 0 to 1.')
          )
        }
      }
      const cameraSimpleControlError = getKlingCameraSimpleControlError(
        klingCameraSimpleControlInputs
      )
      if (cameraSimpleControlError) {
        errors.push(txt('errors.camera_simple_controls_invalid', cameraSimpleControlError))
      }
      if (hasFirstFrame && hasReferenceImage) {
        errors.push(
          txt(
            'errors.kling_single_leading_image',
            'Kling can send only one leading image. Use either First frame or Reference image.'
          )
        )
      }
      if (hasLastFrame && !hasFirstFrame && !hasReferenceImage) {
        errors.push(
          txt(
            'errors.kling_image_tail_requires_image',
            'Kling image_tail requires a First frame or Reference image.'
          )
        )
      }
    }

    if (selectedProvider === 'volcengine') {
      if (frames.trim()) {
        const parsedFrames = parsePositiveInteger(frames)
        if (
          parsedFrames == null ||
          parsedFrames < 29 ||
          parsedFrames > 289 ||
          (parsedFrames - 25) % 4 !== 0
        ) {
          errors.push(
            txt(
              'errors.frames_invalid',
              'Frames must be an integer from 29 to 289 in the form 25 + 4n.'
            )
          )
        }
      }
      for (const slotKey of selectedNonImageAssetSlots) {
        if (isDataUrlAsset(assetSlots[slotKey])) {
          errors.push(
            txt(
              'errors.seedance_reference_url_required',
              'Seedance reference video/audio inputs must use public http(s) URLs or Volcengine asset:// URLs.'
            )
          )
          break
        }
      }
      if (seedanceReferenceRole !== 'auto' && selectedImageAssetSlots.length > 1) {
        errors.push(
          txt(
            'errors.seedance_manual_role_single_image',
            'The current Seedance client can apply a manual image role only when one image asset is selected.'
          )
        )
      }
    }

    if (selectedProvider === 'kling' && selectedNonImageAssetSlots.length > 0) {
      warnings.push(
        txt(
          'warnings.kling_non_image_assets_ignored',
          'Kling requests currently use image slots only; reference video/audio attachments are not sent for Kling.'
        )
      )
    }

    return { errors, warnings }
  }, [
    assetSlots,
    callbackUrl,
    cfgScale,
    externalTaskId,
    frames,
    klingCameraSimpleControlInputs,
    parsedAdvancedJson.error,
    prompt,
    seedanceReferenceRole,
    selectedImageAssetSlots,
    selectedNonImageAssetSlots.length,
    selectedProfile,
    selectedProvider,
    txt
  ])

  const validation = React.useMemo(() => validateCurrentRequest(), [validateCurrentRequest])

  const requestPreview = React.useMemo(() => {
    const attachments = buildMessageAttachments()
    return {
      provider: selectedProvider || null,
      profileId: selectedProfile?.id || null,
      profileScope: selectedProfileOption?.scope || null,
      videoGenerationOptions: buildVideoGenerationOptions(),
      messages: [
        {
          role: 'user',
          content: prompt.trim(),
          ...(attachments.length > 0
            ? {
                attachments: attachments.map(createPreviewAttachment)
              }
            : {})
        }
      ],
      providerRequest: buildProviderRequestPreview({
        provider: selectedProvider,
        profile: selectedProfile,
        prompt,
        options: buildVideoGenerationOptions(),
        assetSlots,
        providerImageSlots: providerImageAssetSlots
      })
    }
  }, [
    assetSlots,
    buildMessageAttachments,
    buildVideoGenerationOptions,
    prompt,
    providerImageAssetSlots,
    selectedProfile,
    selectedProfileOption?.scope,
    selectedProvider
  ])

  const requestPreviewJson = React.useMemo(
    () => JSON.stringify(requestPreview, null, 2),
    [requestPreview]
  )

  const handleSelectAsset = async (slotKey: AssetSlotKey) => {
    const slotConfig = ASSET_SLOT_CONFIG[slotKey]
    const file = await selectFile(slotConfig.extensions)
    if (!file) return
    if (!isExpectedFileKind(file, slotConfig.kind, slotConfig.extensions)) {
      notifyError(
        txt('errors.asset_kind_required', 'Please choose a {{kind}} file.', {
          kind: slotConfig.kind
        })
      )
      return
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      setAssetSlots((current) => ({
        ...current,
        [slotKey]: {
          dataUrl,
          fileName: file.name,
          mimeType: file.type || getDataUrlMimeType(dataUrl) || slotConfig.fallbackMimeType,
          source: 'file'
        }
      }))
    } catch (error) {
      notifyError(
        txt('errors.asset_read_failed', 'Failed to read file: {{error}}', {
          error: resolveErrorMessage(error)
        })
      )
    }
  }

  const handleClearAsset = (slotKey: AssetSlotKey) => {
    setAssetSlots((current) => ({ ...current, [slotKey]: createEmptyAssetSlot() }))
    setAssetUrlInputs((current) => ({ ...current, [slotKey]: '' }))
  }

  const handleAssetUrlInputChange = (slotKey: AssetSlotKey, value: string) => {
    setAssetUrlInputs((current) => ({ ...current, [slotKey]: value }))
  }

  const handleUseAssetUrl = (slotKey: AssetSlotKey) => {
    const trimmedUrl = assetUrlInputs[slotKey].trim()
    const slotConfig = ASSET_SLOT_CONFIG[slotKey]
    if (!trimmedUrl) {
      handleClearAsset(slotKey)
      return
    }
    if (!isValidReferenceAssetUrl(trimmedUrl)) {
      notifyError(
        txt(
          'errors.asset_url_invalid',
          'Reference URL must be a valid http(s) URL or Volcengine asset:// URL.'
        )
      )
      return
    }
    setAssetSlots((current) => ({
      ...current,
      [slotKey]: {
        dataUrl: trimmedUrl,
        fileName: getUrlFileName(trimmedUrl, `${slotKey}.${slotConfig.extensions[0]}`),
        mimeType: slotConfig.fallbackMimeType,
        source: 'url'
      }
    }))
  }

  const handleGenerate = async () => {
    setShowValidation(true)
    const currentValidation = validateCurrentRequest()
    if (currentValidation.errors.length > 0) {
      const message = currentValidation.errors[0]
      setHasStatusError(true)
      setStatusText(message)
      notifyError(message)
      return
    }

    const trimmedPrompt = prompt.trim()
    const attachments = buildMessageAttachments()

    setIsGenerating(true)
    setHasStatusError(false)
    setStatusText(
      txt('status.submitting', 'Submitting the async video task and polling the result.')
    )
    setLatestVideoUrl('')
    setLatestFileName('')

    try {
      const result = await api().svcLLMProxy.chat({
        profileId: selectedProfile!.id,
        profileScope: selectedProfileOption?.scope,
        videoGenerationOptions: buildVideoGenerationOptions(),
        messages: [
          {
            role: 'user',
            content: trimmedPrompt,
            ...(attachments.length > 0 ? { attachments } : {})
          }
        ]
      })

      const videoAttachment = getFirstVideoAttachment(result)
      if (!videoAttachment) {
        throw new Error(
          result.content ||
            txt('errors.no_video_url', 'The video task completed without a video URL.')
        )
      }

      const videoUrl = videoAttachment.url.trim()
      const resultItem = createVideoResultItem(videoAttachment, videoUrl, {
        promptId: resultPromptId,
        projectId
      })
      const resultItems = [resultItem]
      appendResults(resultItems)
      if (inline) {
        dispatchQAppResultsToCanvas(resultItems, projectId)
      }
      setLatestVideoUrl(videoUrl)
      setLatestFileName(videoAttachment.fileName || `ai-video-${Date.now()}.mp4`)
      setHasStatusError(false)
      setStatusText(txt('status.complete', 'Video generation completed.'))
      notifySuccess(txt('toast.complete', 'Video generation completed.'))
    } catch (error) {
      const message = resolveErrorMessage(error)
      setHasStatusError(true)
      setStatusText(txt('status.failed', 'Generation failed: {{error}}', { error: message }))
      notifyError(txt('toast.failed', 'Generation failed: {{error}}', { error: message }))
    } finally {
      setIsGenerating(false)
    }
  }

  const providerHint = selectedProfile
    ? selectedProvider === 'kling'
      ? txt(
          'hint.kling',
          'Kling sends First frame/Reference image as image and Last frame as image_tail for image-to-video.'
        )
      : txt(
          'hint.seedance',
          'Volcengine/Seedance sends selected image/video/audio assets as content references. Adaptive duration uses duration=-1.'
        )
    : txt(
        'hint.missing_profile',
        'Add a Video Generation profile in Settings -> Quick App API or Settings -> Agent Threads first.'
      )

  const getAssetSlotLabel = (slotKey: AssetSlotKey): string => {
    switch (slotKey) {
      case 'firstFrame':
        return txt('asset.first_frame', 'First frame')
      case 'lastFrame':
        return txt('asset.last_frame', 'Last frame')
      case 'referenceImage':
        return txt('asset.reference_image', 'Reference image')
      case 'referenceVideo':
        return txt('asset.reference_video', 'Reference video')
      case 'referenceAudio':
        return txt('asset.reference_audio', 'Reference audio')
      default:
        return slotKey
    }
  }

  const getAssetSlotDescription = (slotKey: AssetSlotKey): string => {
    switch (slotKey) {
      case 'firstFrame':
        return selectedProvider === 'kling'
          ? txt('asset.first_frame_kling_help', 'Kling image input; required before image_tail.')
          : txt('asset.first_frame_seedance_help', 'Seedance first_frame image reference.')
      case 'lastFrame':
        return selectedProvider === 'kling'
          ? txt(
              'asset.last_frame_kling_help',
              'Kling image_tail; requires a First frame or Reference image.'
            )
          : txt(
              'asset.last_frame_seedance_help',
              'Seedance last_frame role; current client supports it as a single image role.'
            )
      case 'referenceImage':
        return selectedProvider === 'kling'
          ? txt(
              'asset.reference_image_kling_help',
              'Alternative Kling leading image when First frame is empty.'
            )
          : txt('asset.reference_image_seedance_help', 'Seedance reference_image role.')
      case 'referenceVideo':
        return selectedProvider === 'volcengine'
          ? txt('asset.reference_video_seedance_help', 'Seedance reference_video URL attachment.')
          : txt(
              'asset.reference_video_help',
              'Reference video URL/file is sent only for Seedance profiles.'
            )
      case 'referenceAudio':
        return selectedProvider === 'volcengine'
          ? txt('asset.reference_audio_seedance_help', 'Seedance reference_audio URL attachment.')
          : txt(
              'asset.reference_audio_help',
              'Reference audio URL/file is sent only for Seedance profiles.'
            )
      default:
        return ''
    }
  }

  const renderAssetPreview = (slotKey: AssetSlotKey, asset: AssetSlotState) => {
    if (!asset.dataUrl) {
      return null
    }
    const kind = ASSET_SLOT_CONFIG[slotKey].kind
    if (asset.dataUrl.startsWith('asset://')) {
      return (
        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
          {asset.dataUrl}
        </Typography>
      )
    }
    if (kind === 'image') {
      return (
        <Box
          component="img"
          src={asset.dataUrl}
          alt={getAssetSlotLabel(slotKey)}
          sx={{ maxWidth: 220, maxHeight: 140, objectFit: 'contain', borderRadius: 1 }}
        />
      )
    }
    if (kind === 'video') {
      return <video src={asset.dataUrl} controls style={{ maxWidth: 260, width: '100%' }} />
    }
    return <audio src={asset.dataUrl} controls style={{ width: '100%' }} />
  }

  const getKlingCameraAxisLabel = (axis: KlingCameraSimpleControlKey): string => {
    switch (axis) {
      case 'horizontal':
        return txt('camera_axis_horizontal', 'Camera horizontal')
      case 'vertical':
        return txt('camera_axis_vertical', 'Camera vertical')
      case 'pan':
        return txt('camera_axis_pan', 'Camera pan')
      case 'tilt':
        return txt('camera_axis_tilt', 'Camera tilt')
      case 'roll':
        return txt('camera_axis_roll', 'Camera roll')
      case 'zoom':
        return txt('camera_axis_zoom', 'Camera zoom')
      default:
        return axis
    }
  }

  const renderAssetSlot = (slotKey: AssetSlotKey) => {
    const asset = assetSlots[slotKey]
    const label = getAssetSlotLabel(slotKey)
    const hasAsset = hasSelectedAsset(asset)
    return (
      <Card key={slotKey} variant="outlined" sx={{ bgcolor: 'background.default' }}>
        <CardContent sx={{ '&:last-child': { pb: 2 } }}>
          <Stack spacing={1}>
            <Box>
              <Typography variant="subtitle2">{label}</Typography>
              <Typography variant="caption" color="text.secondary">
                {getAssetSlotDescription(slotKey)}
              </Typography>
            </Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
              <Button
                variant="outlined"
                onClick={() => handleSelectAsset(slotKey)}
                disabled={isGenerating}
              >
                {hasAsset
                  ? txt('asset.replace', 'Replace {{label}}', { label })
                  : txt('asset.choose', 'Choose {{label}}', { label })}
              </Button>
              {hasAsset && (
                <Button
                  variant="text"
                  onClick={() => handleClearAsset(slotKey)}
                  disabled={isGenerating}
                >
                  {txt('asset.clear', 'Clear')}
                </Button>
              )}
              <Typography variant="body2" color="text.secondary" noWrap>
                {asset.fileName || txt('asset.none_selected', 'No file selected')}
              </Typography>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
              <TextField
                label={txt('asset.url_label', '{{label}} URL', { label })}
                value={assetUrlInputs[slotKey]}
                onChange={(event) => handleAssetUrlInputChange(slotKey, event.target.value)}
                placeholder={
                  ASSET_SLOT_CONFIG[slotKey].kind === 'image'
                    ? 'https://example.com/image.png'
                    : ASSET_SLOT_CONFIG[slotKey].kind === 'audio'
                      ? 'https://example.com/reference.mp3'
                      : 'https://example.com/reference.mp4'
                }
                disabled={isGenerating}
                fullWidth
                size="small"
              />
              <Button
                variant="outlined"
                onClick={() => handleUseAssetUrl(slotKey)}
                disabled={isGenerating}
                sx={{ whiteSpace: 'nowrap' }}
              >
                {txt('asset.use_url', 'Use URL')}
              </Button>
            </Stack>
            {renderAssetPreview(slotKey, asset)}
          </Stack>
        </CardContent>
      </Card>
    )
  }

  const shouldShowValidationErrors = showValidation && validation.errors.length > 0
  const promptRows = inline ? 3 : 5
  const sectionSpacing = inline ? 1.5 : 2.5

  return (
    <Box sx={{ p: inline ? 1.5 : 3, height: inline ? 'auto' : '100%', overflowY: 'auto' }}>
      <Stack spacing={sectionSpacing}>
        <Box>
          <Typography variant={inline ? 'h6' : 'h5'} fontWeight={700}>
            {txt('title', 'AI Video Generation')}
          </Typography>
          {!inline && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {txt(
                'description',
                'Submit Kling or Volcengine/Seedance async video-generation tasks and show the generated video here.'
              )}
            </Typography>
          )}
        </Box>

        <Alert severity={videoProfileOptions.length > 0 ? 'info' : 'warning'}>{providerHint}</Alert>

        {shouldShowValidationErrors && (
          <Alert severity="error">
            <Stack spacing={0.5}>
              {validation.errors.map((error) => (
                <Typography key={error} variant="body2">
                  {error}
                </Typography>
              ))}
            </Stack>
          </Alert>
        )}
        {validation.warnings.length > 0 && (
          <Alert severity="warning">
            <Stack spacing={0.5}>
              {validation.warnings.map((warning) => (
                <Typography key={warning} variant="body2">
                  {warning}
                </Typography>
              ))}
            </Stack>
          </Alert>
        )}

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" fontWeight={600}>
                  {txt('basic_title', 'Basic')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {txt('basic_description', 'Choose a video profile, prompt, ratio, and duration.')}
                </Typography>
              </Box>
              <TextField
                select
                label={txt('profile_label', 'Video model')}
                value={selectedProfileKey}
                onChange={(event) => setSelectedProfileKey(event.target.value)}
                disabled={videoProfileOptions.length === 0 || isGenerating}
                fullWidth
              >
                {videoProfileOptions.map((option) => (
                  <MenuItem key={option.key} value={option.key}>
                    {option.profile.model_name} ({option.profile.id}) ·{' '}
                    {resolveVideoProfileProvider(option.profile)} ·{' '}
                    {option.scope === 'qapp'
                      ? txt('scope_qapp', 'Quick App API')
                      : txt('scope_agent', 'Agent Threads')}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                label={txt('prompt_label', 'Video prompt')}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={txt(
                  'prompt_placeholder',
                  'Example: cinematic shot of a red panda walking through a misty bamboo forest, soft morning light, 4K'
                )}
                multiline
                minRows={promptRows}
                disabled={isGenerating}
                fullWidth
              />

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  label={txt('aspect_ratio', 'Aspect ratio')}
                  value={aspectRatio}
                  onChange={(event) => setAspectRatio(event.target.value)}
                  disabled={isGenerating}
                  fullWidth
                >
                  {aspectRatioOptions.map((value) => (
                    <MenuItem key={value} value={value}>
                      {value}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  label={txt('duration', 'Duration')}
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                  disabled={isGenerating}
                  fullWidth
                >
                  {durationOptions.map((value) => (
                    <MenuItem key={value} value={value}>
                      {value === -1
                        ? txt('duration_adaptive', 'Adaptive')
                        : txt('duration_seconds', '{{count}}s', { count: value })}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" fontWeight={600}>
                  {txt('assets_title', 'Assets')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {txt(
                    'assets_description',
                    'Add frame and reference assets. Use URLs for Seedance video/audio references when the provider cannot accept local files.'
                  )}
                </Typography>
              </Box>
              <Stack spacing={1.5}>
                {ASSET_SLOT_KEYS.map((slotKey) => renderAssetSlot(slotKey))}
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" fontWeight={600}>
                  {selectedProvider === 'kling'
                    ? txt('kling_parameters_title', 'Kling parameters')
                    : txt('seedance_parameters_title', 'Seedance parameters')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {selectedProvider === 'kling'
                    ? txt(
                        'kling_parameters_description',
                        'Controls specific to Kling text/image-to-video.'
                      )
                    : txt(
                        'seedance_parameters_description',
                        'Controls specific to Volcengine/Seedance content generation.'
                      )}
                </Typography>
              </Box>

              {selectedProvider === 'kling' ? (
                <Stack spacing={1.5}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      select
                      label={txt('kling_mode', 'Mode')}
                      value={klingMode}
                      onChange={(event) => setKlingMode(event.target.value as typeof klingMode)}
                      disabled={isGenerating}
                      fullWidth
                    >
                      {KLING_MODE_OPTIONS.map((value) => (
                        <MenuItem key={value} value={value}>
                          {value.toUpperCase()}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      select
                      label={txt('sound', 'Sound')}
                      value={klingSound}
                      onChange={(event) => setKlingSound(event.target.value as 'off' | 'on')}
                      disabled={isGenerating}
                      fullWidth
                    >
                      <MenuItem value="off">{txt('sound_off', 'Off')}</MenuItem>
                      <MenuItem value="on">{txt('sound_on', 'On')}</MenuItem>
                    </TextField>
                  </Stack>
                  <TextField
                    select
                    label={txt('camera_preset', 'Camera movement')}
                    value={klingCameraPreset}
                    onChange={(event) =>
                      setKlingCameraPreset(event.target.value as VideoGenerationCameraPreset)
                    }
                    disabled={isGenerating}
                    fullWidth
                  >
                    {KLING_CAMERA_PRESET_OPTIONS.map((value) => (
                      <MenuItem key={value} value={value}>
                        {txt(`camera_${value}`, value.replace(/_/g, ' '))}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Box>
                    <Typography variant="subtitle2">
                      {txt('camera_simple_title', 'Camera simple six-axis')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {txt(
                        'camera_simple_description',
                        'Optional Kling simple camera controls. Values must be between -10 and 10.'
                      )}
                    </Typography>
                  </Box>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} flexWrap="wrap">
                    {KLING_CAMERA_SIMPLE_CONTROL_KEYS.map((axis) => (
                      <TextField
                        key={axis}
                        label={getKlingCameraAxisLabel(axis)}
                        value={klingCameraSimpleControlInputs[axis]}
                        onChange={(event) =>
                          setKlingCameraSimpleControlInputs((current) => ({
                            ...current,
                            [axis]: event.target.value
                          }))
                        }
                        type="number"
                        inputProps={{
                          min: KLING_CAMERA_SIMPLE_CONTROL_MIN,
                          max: KLING_CAMERA_SIMPLE_CONTROL_MAX,
                          step: 0.1
                        }}
                        error={
                          showValidation &&
                          validation.errors.some((error) => error.includes('camera simple'))
                        }
                        disabled={isGenerating}
                        sx={{ minWidth: 160, flex: 1 }}
                      />
                    ))}
                  </Stack>
                </Stack>
              ) : (
                <Stack spacing={1.5}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      select
                      label={txt('resolution', 'Resolution')}
                      value={seedanceResolution}
                      onChange={(event) =>
                        setSeedanceResolution(event.target.value as typeof seedanceResolution)
                      }
                      disabled={isGenerating}
                      fullWidth
                    >
                      {SEEDANCE_RESOLUTION_OPTIONS.map((value) => (
                        <MenuItem key={value} value={value}>
                          {value}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      select
                      label={txt('reference_role', 'Image role')}
                      value={seedanceReferenceRole}
                      onChange={(event) =>
                        setSeedanceReferenceRole(
                          event.target.value as VideoGenerationReferenceRole | 'auto'
                        )
                      }
                      disabled={isGenerating}
                      fullWidth
                    >
                      {SEEDANCE_REFERENCE_ROLE_OPTIONS.map((value) => (
                        <MenuItem key={value} value={value}>
                          {value === 'auto'
                            ? txt('reference_role_auto', 'Auto from selected slot')
                            : txt(`reference_role_${value}`, value.replace(/_/g, ' '))}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={seedanceGenerateAudio}
                          onChange={(event) => setSeedanceGenerateAudio(event.target.checked)}
                          disabled={isGenerating}
                        />
                      }
                      label={txt('generate_audio', 'Generate/use audio')}
                    />
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={seedanceReturnLastFrame}
                          onChange={(event) => setSeedanceReturnLastFrame(event.target.checked)}
                          disabled={isGenerating}
                        />
                      }
                      label={txt('return_last_frame', 'Return last frame')}
                    />
                  </Stack>
                </Stack>
              )}
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" fontWeight={600}>
                  {txt('advanced_title', 'Advanced')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {txt(
                    'advanced_description',
                    'Optional provider controls, callback identifiers, and debug preview.'
                  )}
                </Typography>
              </Box>
              <TextField
                label={txt('negative_prompt', 'Negative prompt')}
                value={negativePrompt}
                onChange={(event) => setNegativePrompt(event.target.value)}
                placeholder={txt('negative_prompt_placeholder', 'Optional: things to avoid')}
                multiline
                minRows={inline ? 1 : 2}
                disabled={isGenerating}
                fullWidth
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                {selectedProvider === 'kling' && (
                  <TextField
                    label={txt('cfg_scale', 'CFG scale')}
                    value={cfgScale}
                    onChange={(event) => setCfgScale(event.target.value)}
                    placeholder="0 - 1"
                    type="number"
                    inputProps={{ min: 0, max: 1, step: 0.05 }}
                    error={
                      showValidation && validation.errors.some((error) => error.includes('CFG'))
                    }
                    disabled={isGenerating}
                    fullWidth
                  />
                )}
                {selectedProvider === 'volcengine' && (
                  <TextField
                    label={txt('frames', 'Frames')}
                    value={frames}
                    onChange={(event) => setFrames(event.target.value)}
                    placeholder={txt('frames_placeholder', 'Optional 29-289, 25 + 4n')}
                    type="number"
                    inputProps={{ min: 29, max: 289, step: 4 }}
                    error={
                      showValidation && validation.errors.some((error) => error.includes('Frames'))
                    }
                    disabled={isGenerating}
                    fullWidth
                  />
                )}
                <TextField
                  label={txt('callback_url', 'Callback URL')}
                  value={callbackUrl}
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  placeholder="https://example.com/video-callback"
                  error={
                    showValidation &&
                    validation.errors.some((error) => error.includes('Callback URL'))
                  }
                  disabled={isGenerating}
                  fullWidth
                />
                {selectedProvider === 'kling' && (
                  <TextField
                    label={txt('external_task_id', 'External task ID')}
                    value={externalTaskId}
                    onChange={(event) => setExternalTaskId(event.target.value)}
                    placeholder={txt(
                      'external_task_id_placeholder',
                      'Optional idempotency/correlation ID'
                    )}
                    disabled={isGenerating}
                    fullWidth
                  />
                )}
              </Stack>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={watermark}
                    onChange={(event) => setWatermark(event.target.checked)}
                    disabled={isGenerating}
                  />
                }
                label={txt('watermark', 'Generate with watermark')}
              />
              <TextField
                label={txt('advanced_json', 'Advanced JSON')}
                value={advancedJson}
                onChange={(event) => setAdvancedJson(event.target.value)}
                placeholder={txt(
                  'advanced_json_placeholder',
                  `Optional JSON object merged into provider options/request, e.g. {"seed": 1234}`
                )}
                multiline
                minRows={inline ? 3 : 5}
                error={showValidation && Boolean(parsedAdvancedJson.error)}
                helperText={
                  showValidation && parsedAdvancedJson.error ? parsedAdvancedJson.error : undefined
                }
                disabled={isGenerating}
                fullWidth
              />
              <Divider />
              <Box>
                <Typography variant="subtitle2">
                  {txt('request_preview_title', 'Request JSON preview')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {txt(
                    'request_preview_description',
                    'Shows the proxy request and intended provider body with local data URLs redacted.'
                  )}
                </Typography>
                <Box
                  component="pre"
                  data-testid="video-generation-request-preview"
                  sx={{
                    mt: 1,
                    p: 1.5,
                    maxHeight: inline ? 220 : 360,
                    overflow: 'auto',
                    borderRadius: 1,
                    bgcolor: 'grey.100',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {requestPreviewJson}
                </Box>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Stack spacing={1.5}>
          <Button
            variant="contained"
            size={inline ? 'medium' : 'large'}
            startIcon={<MovieCreationOutlined />}
            onClick={handleGenerate}
            disabled={isGenerating || !selectedProfile}
          >
            {isGenerating ? txt('generating', 'Generating...') : txt('generate', 'Generate video')}
          </Button>
          {isGenerating && <LinearProgress />}
          {statusText && <Alert severity={hasStatusError ? 'error' : 'info'}>{statusText}</Alert>}
        </Stack>

        {latestVideoUrl && (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1" fontWeight={600}>
                  {txt('latest_result', 'Latest result')}
                </Typography>
                <Box component="video" src={latestVideoUrl} controls sx={{ width: '100%' }} />
                <Alert severity="warning">
                  {txt(
                    'result_url_expiry_notice',
                    'Provider-hosted video URLs can be temporary signed URLs and may expire. Download or save the video now if you need long-term access.'
                  )}
                </Alert>
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="outlined"
                    startIcon={<DownloadOutlined />}
                    onClick={() => downloadFile(latestVideoUrl, latestFileName || 'ai-video.mp4')}
                  >
                    {txt('download', 'Download video')}
                  </Button>
                  <Button
                    variant="text"
                    startIcon={<OpenInNewOutlined />}
                    onClick={() => window.open(latestVideoUrl, '_blank')}
                  >
                    {txt('open_preview', 'Open preview')}
                  </Button>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
    </Box>
  )
}

export default VideoGenerationWorkspace
