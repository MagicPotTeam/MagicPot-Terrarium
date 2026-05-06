import { getFileNameHintFromUrl } from '@shared/utils/urlFileHints'

export type Hy3dMode = 'text2_3d' | 'img2_3d'

export type Hy3dApiAction =
  | 'SubmitHunyuanTo3DProJob'
  | 'SubmitHunyuanTo3DRapidJob'
  | 'SubmitProfileTo3DJob'
  | 'SubmitHunyuan3DPartJob'
  | 'SubmitReduceFaceJob'
  | 'SubmitHunyuanTo3DUVJob'
  | 'SubmitTextureTo3DJob'
  | 'Convert3DFormat'

export type Hy3dProfileTemplate =
  | 'DEFAULT'
  | 'basketball'
  | 'badminton'
  | 'pingpong'
  | 'gymnastics'
  | 'pilidance'
  | 'tennis'
  | 'athletics'
  | 'footballboykicking1'
  | 'footballboykicking2'
  | 'guitar'
  | 'footballboy'
  | 'skateboard'
  | 'futuresoilder'
  | 'explorer'
  | 'beardollgirl'
  | 'bibpantsboy'
  | 'womansitpose'
  | 'womanstandpose2'
  | 'mysteriousprincess'
  | 'manstandpose2'

export type Hy3dGenerateType = 'Normal' | 'LowPoly' | 'Geometry' | 'Sketch'

export type Hy3dGenerateTargetFormat = 'DEFAULT' | 'OBJ' | 'GLB' | 'STL' | 'USDZ' | 'FBX' | 'MP4'

export type Hy3dConvertTargetFormat = 'STL' | 'USDZ' | 'FBX' | 'MP4' | 'GIF'

export type Hy3dFaceLevel = 'low' | 'medium' | 'high'

export type Hy3dPolygonType = 'triangle' | 'quadrilateral'

export interface Hy3dParams {
  mode: Hy3dMode
  apiAction: Hy3dApiAction
  modelVersion: '3.0' | '3.1'
  generateType: Hy3dGenerateType
  faceCount: number
  targetFormat: Hy3dGenerateTargetFormat
  convertTargetFormat: Hy3dConvertTargetFormat
  polygonType: Hy3dPolygonType
  prompt: string
  enablePBR: boolean
  modelUrl: string
  modelSourceFileName: string
  modelStorageKey: string
  modelStorageBucket: string
  modelStorageRegion: string
  modelSignedUrlExpiresAt: string
  texturePrompt: string
  textureEnablePBR: boolean
  topoFaceLevel: Hy3dFaceLevel
  profileTemplate: Hy3dProfileTemplate
}

export interface Hy3dImageAttachment {
  type: 'image'
  url: string
  mimeType?: string
  fileName?: string
  slot?: string
}

export interface Hy3dMediaState {
  conceptImages: Hy3dImageAttachment[]
  textureRefImages: Hy3dImageAttachment[]
  profileRefImage: Hy3dImageAttachment | null
}

export type Hy3dGenerateAttachment = Omit<Hy3dImageAttachment, 'slot'>

export const cloneHy3dMediaState = (mediaState: Hy3dMediaState): Hy3dMediaState => ({
  conceptImages: mediaState.conceptImages.map((attachment) => ({ ...attachment })),
  textureRefImages: mediaState.textureRefImages.map((attachment) => ({ ...attachment })),
  profileRefImage: mediaState.profileRefImage ? { ...mediaState.profileRefImage } : null
})

const HY3D_STORAGE_KEY = 'hy3d.params'
const HY3D_MEDIA_STORAGE_KEY = 'hy3d.media'

export const BUILTIN_HUNYUAN3D_QAPP_KEY = '~builtin/hunyuan3d'
export const BUILTIN_HUNYUAN3D_STEP_KEY_PREFIX = `${BUILTIN_HUNYUAN3D_QAPP_KEY}/`

export const DEFAULT_PARAMS: Hy3dParams = {
  mode: 'text2_3d',
  apiAction: 'SubmitHunyuanTo3DProJob',
  modelVersion: '3.1',
  generateType: 'Normal',
  faceCount: 500000,
  targetFormat: 'DEFAULT',
  convertTargetFormat: 'STL',
  polygonType: 'triangle',
  prompt: '',
  enablePBR: false,
  modelUrl: '',
  modelSourceFileName: '',
  modelStorageKey: '',
  modelStorageBucket: '',
  modelStorageRegion: '',
  modelSignedUrlExpiresAt: '',
  texturePrompt: '',
  textureEnablePBR: false,
  topoFaceLevel: 'low',
  profileTemplate: 'DEFAULT'
}

export const DEFAULT_MEDIA_STATE: Hy3dMediaState = {
  conceptImages: [],
  textureRefImages: [],
  profileRefImage: null
}

const cloneDefaultMediaState = (): Hy3dMediaState => ({
  conceptImages: [],
  textureRefImages: [],
  profileRefImage: null
})

const isHy3dImageAttachment = (value: unknown): value is Hy3dImageAttachment =>
  !!value &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'image' &&
  typeof (value as { url?: unknown }).url === 'string'

const normalizeHy3dMediaState = (value: unknown): Hy3dMediaState => {
  const candidate =
    (value as
      | (Partial<Hy3dMediaState> & {
          textureRefImage?: unknown
        })
      | null
      | undefined) || undefined

  return {
    conceptImages: Array.isArray(candidate?.conceptImages)
      ? candidate.conceptImages.filter(isHy3dImageAttachment)
      : [],
    textureRefImages: Array.isArray(candidate?.textureRefImages)
      ? candidate.textureRefImages.filter(isHy3dImageAttachment)
      : isHy3dImageAttachment(candidate?.textureRefImage)
        ? [candidate.textureRefImage]
        : [],
    profileRefImage: isHy3dImageAttachment(candidate?.profileRefImage)
      ? candidate.profileRefImage
      : null
  }
}

const stripAttachmentSlot = ({
  slot: _slot,
  ...attachment
}: Hy3dImageAttachment): Hy3dGenerateAttachment => attachment

const CONCEPT_ATTACHMENT_SLOT_ORDER = [
  'single',
  'front',
  'left',
  'right',
  'back',
  'top',
  'bottom',
  'left_front',
  'right_front'
] as const

const getConceptAttachmentSlotRank = (slot?: string): number => {
  const normalizedSlot = String(slot || '')
  const index = CONCEPT_ATTACHMENT_SLOT_ORDER.indexOf(
    normalizedSlot as (typeof CONCEPT_ATTACHMENT_SLOT_ORDER)[number]
  )
  return index === -1 ? CONCEPT_ATTACHMENT_SLOT_ORDER.length : index
}

export const sortHy3dConceptImages = (attachments: Hy3dImageAttachment[]): Hy3dImageAttachment[] =>
  [...attachments].sort((a, b) => {
    const rankDiff = getConceptAttachmentSlotRank(a.slot) - getConceptAttachmentSlotRank(b.slot)
    if (rankDiff !== 0) return rankDiff

    return String(a.fileName || a.url).localeCompare(String(b.fileName || b.url))
  })

export const buildHy3dGenerateAttachments = (
  params: Pick<Hy3dParams, 'apiAction' | 'mode'>,
  mediaState: Hy3dMediaState
): Hy3dGenerateAttachment[] => {
  switch (params.apiAction) {
    case 'SubmitHunyuanTo3DProJob':
    case 'SubmitHunyuanTo3DRapidJob':
      return params.mode === 'img2_3d'
        ? sortHy3dConceptImages(mediaState.conceptImages).map(stripAttachmentSlot)
        : []
    case 'SubmitTextureTo3DJob':
      return sortHy3dConceptImages(mediaState.textureRefImages).map(stripAttachmentSlot)
    case 'SubmitProfileTo3DJob':
      return mediaState.profileRefImage ? [stripAttachmentSlot(mediaState.profileRefImage)] : []
    default:
      return []
  }
}

export const buildHy3dSubmissionContent = (
  params: Pick<Hy3dParams, 'apiAction' | 'mode' | 'modelUrl' | 'prompt' | 'texturePrompt'>
): string => {
  switch (params.apiAction) {
    case 'SubmitHunyuan3DPartJob':
    case 'SubmitReduceFaceJob':
    case 'SubmitHunyuanTo3DUVJob':
    case 'Convert3DFormat':
      return params.modelUrl.trim()
    case 'SubmitTextureTo3DJob':
      return [params.modelUrl, params.texturePrompt].filter(Boolean).join('\n').trim()
    case 'SubmitHunyuanTo3DProJob':
    case 'SubmitHunyuanTo3DRapidJob':
      return params.mode === 'text2_3d' ? params.prompt.trim() : ''
    default:
      return ''
  }
}

export const getHy3dSubmissionConflictMessage = (
  params: Pick<Hy3dParams, 'apiAction' | 'generateType'>,
  content: string,
  attachmentCount: number
): string | null => {
  if (!content || attachmentCount === 0) {
    return null
  }

  if (params.apiAction === 'SubmitHunyuanTo3DRapidJob') {
    return '极速版不支持同时提交提示词和参考图。请只保留一种输入。'
  }

  if (params.apiAction === 'SubmitHunyuanTo3DProJob' && params.generateType !== 'Sketch') {
    return '专业版仅在草图模式下支持同时提交提示词和参考图。请切换为草图模式，或只保留一种输入。'
  }

  return null
}

export const getHy3dMissingInputMessage = (params: Pick<Hy3dParams, 'apiAction'>): string => {
  switch (params.apiAction) {
    case 'SubmitProfileTo3DJob':
      return '请先上传人物参考图，再开始生成人物模型。'
    case 'SubmitTextureTo3DJob':
      return '请先上传待处理模型，并填写纹理描述或参考图。'
    case 'SubmitHunyuan3DPartJob':
    case 'SubmitReduceFaceJob':
    case 'SubmitHunyuanTo3DUVJob':
    case 'Convert3DFormat':
      return '请先上传待处理模型，再执行当前流程。'
    case 'SubmitHunyuanTo3DProJob':
    case 'SubmitHunyuanTo3DRapidJob':
    default:
      return '请先填写提示词或上传参考图，再开始生成 3D。'
  }
}

export function getHy3dParams(): Hy3dParams {
  try {
    const saved = localStorage.getItem(HY3D_STORAGE_KEY)
    if (saved) {
      const params = { ...DEFAULT_PARAMS, ...JSON.parse(saved) } as Hy3dParams
      return {
        ...params,
        faceCount: normalizeHy3dFaceCount(params.faceCount)
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PARAMS
}

export function saveHy3dParams(params: Hy3dParams): void {
  try {
    localStorage.setItem(
      HY3D_STORAGE_KEY,
      JSON.stringify({
        ...params,
        faceCount: normalizeHy3dFaceCount(params.faceCount)
      })
    )
  } catch {
    /* ignore */
  }
}

export function getHy3dMediaState(): Hy3dMediaState {
  try {
    const saved = sessionStorage.getItem(HY3D_MEDIA_STORAGE_KEY)
    if (saved) {
      return normalizeHy3dMediaState(JSON.parse(saved))
    }
  } catch {
    /* ignore */
  }

  return cloneDefaultMediaState()
}

export function saveHy3dMediaState(mediaState: Hy3dMediaState): void {
  try {
    sessionStorage.setItem(
      HY3D_MEDIA_STORAGE_KEY,
      JSON.stringify(normalizeHy3dMediaState(mediaState))
    )
  } catch {
    /* ignore */
  }
}

export const PRO_PROMPT_MAX_LENGTH = 1024

export const RAPID_PROMPT_MAX_LENGTH = 200

export const TEXTURE_PROMPT_MAX_LENGTH = 200

export const TEXTURE_MODEL_EXTENSIONS = ['.obj', '.glb'] as const

export const TOPOLOGY_MODEL_EXTENSIONS = ['.obj', '.glb'] as const

export const UV_MODEL_EXTENSIONS = ['.fbx', '.obj', '.glb'] as const

export const SPLIT_MODEL_EXTENSIONS = ['.fbx'] as const

export const CONVERT_MODEL_EXTENSIONS = ['.fbx', '.obj', '.glb'] as const

export type Hy3dPostProcessModelCompatibilityStatus =
  | 'empty'
  | 'compatible'
  | 'incompatible'
  | 'unknown'

export type Hy3dPostProcessModelCompatibility = {
  status: Hy3dPostProcessModelCompatibilityStatus
  inferredFormat: string
  acceptedFormats: string[]
}

const HY3D_POST_PROCESS_ACCEPTED_EXTENSIONS: Partial<Record<Hy3dApiAction, readonly string[]>> = {
  SubmitTextureTo3DJob: TEXTURE_MODEL_EXTENSIONS,
  SubmitReduceFaceJob: TOPOLOGY_MODEL_EXTENSIONS,
  SubmitHunyuanTo3DUVJob: UV_MODEL_EXTENSIONS,
  SubmitHunyuan3DPartJob: SPLIT_MODEL_EXTENSIONS,
  Convert3DFormat: CONVERT_MODEL_EXTENSIONS
}

const HY3D_MODEL_INPUT_MARKDOWN_LINK_REGEX =
  /\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/|local-media:\/\/)[^)]+)\)/i

const normalizeModelExtension = (value: string): string => {
  const trimmed = String(value || '')
    .trim()
    .toLowerCase()
  if (!trimmed) return ''

  let pathLikeValue = trimmed
  try {
    if (/^[a-z]+:\/\//i.test(trimmed)) {
      pathLikeValue = new URL(trimmed).pathname.toLowerCase()
    }
  } catch {
    pathLikeValue = trimmed
  }

  const sanitized = pathLikeValue.split('?')[0].split('#')[0]
  const lastSegment = sanitized.split(/[\\/]/).pop() || ''
  const match = lastSegment.match(/\.[a-z0-9]+$/i)
  if (!match) return ''

  const extension = match[0]
  return extension.startsWith('.') ? extension : `.${extension}`
}

const inferHy3dModelExtensionHint = (value: string): string => {
  const explicitExtension = normalizeModelExtension(value)
  if (explicitExtension) {
    return explicitExtension
  }

  const normalizedValue = String(value || '').toUpperCase()
  const knownExtensions = ['.FBX', '.OBJ', '.GLB', '.GLTF', '.STL']
  for (const extension of knownExtensions) {
    const bareType = extension.slice(1)
    if (new RegExp(`(^|[^A-Z0-9])${bareType}([^A-Z0-9]|$)`).test(normalizedValue)) {
      return extension.toLowerCase()
    }
  }

  return ''
}

const isHelpfulHy3dModelHint = (value: string): boolean => !!inferHy3dModelExtensionHint(value)

export const parseHy3dModelInputValue = (
  rawValue: string
): Pick<Hy3dParams, 'modelUrl' | 'modelSourceFileName'> => {
  const trimmedValue = String(rawValue || '').trim()
  if (!trimmedValue) {
    return {
      modelUrl: '',
      modelSourceFileName: ''
    }
  }

  const markdownMatch = trimmedValue.match(HY3D_MODEL_INPUT_MARKDOWN_LINK_REGEX)
  const modelUrl = (markdownMatch?.[2] || trimmedValue).trim()
  const markdownLabel = String(markdownMatch?.[1] || '').trim()
  const modelSourceFileName = isHelpfulHy3dModelHint(markdownLabel)
    ? markdownLabel
    : getFileNameHintFromUrl(modelUrl)

  return {
    modelUrl,
    modelSourceFileName
  }
}

export const getHy3dPostProcessModelCompatibility = (
  action: Hy3dApiAction,
  params: Pick<Hy3dParams, 'modelUrl' | 'modelSourceFileName'>
): Hy3dPostProcessModelCompatibility => {
  const acceptedExtensions = HY3D_POST_PROCESS_ACCEPTED_EXTENSIONS[action]
  if (!acceptedExtensions) {
    return {
      status: 'compatible',
      inferredFormat: '',
      acceptedFormats: []
    }
  }

  if (!params.modelUrl) {
    return {
      status: 'empty',
      inferredFormat: '',
      acceptedFormats: acceptedExtensions.map((ext) => ext.slice(1).toUpperCase())
    }
  }

  const inferredExtension =
    inferHy3dModelExtensionHint(params.modelUrl) ||
    inferHy3dModelExtensionHint(params.modelSourceFileName) ||
    inferHy3dModelExtensionHint(getFileNameHintFromUrl(params.modelUrl))

  const acceptedFormats = acceptedExtensions.map((ext) => ext.slice(1).toUpperCase())
  if (!inferredExtension) {
    return {
      status: 'unknown',
      inferredFormat: '',
      acceptedFormats
    }
  }

  return {
    status: acceptedExtensions.includes(inferredExtension) ? 'compatible' : 'incompatible',
    inferredFormat: inferredExtension.slice(1).toUpperCase(),
    acceptedFormats
  }
}

export const FACE_COUNT_PRESETS = [
  { label: '1.5M', value: 1500000 },
  { label: '1M', value: 1000000 },
  { label: '500K', value: 500000 },
  { label: '50K', value: 50000 }
]

function normalizeHy3dFaceCount(value: unknown): number {
  const numericValue = Number(value)
  if (FACE_COUNT_PRESETS.some((preset) => preset.value === numericValue)) {
    return numericValue
  }

  return FACE_COUNT_PRESETS[FACE_COUNT_PRESETS.length - 1]?.value ?? DEFAULT_PARAMS.faceCount
}

export const PRO_GENERATE_TYPES_V30 = [
  { value: 'Normal', label: '几何+纹理' },
  { value: 'LowPoly', label: '智能拓扑' },
  { value: 'Geometry', label: '白模' },
  { value: 'Sketch', label: '草图模式' }
] as const

export const PRO_GENERATE_TYPES_V31 = [
  { value: 'Normal', label: '几何+纹理' },
  { value: 'Geometry', label: '白模' },
  { value: 'Sketch', label: '草图模式' }
] as const

export const RAPID_GENERATE_TYPES = [
  { value: 'Normal', label: '标准' },
  { value: 'Geometry', label: '白模' }
] as const

export const PRO_TARGET_FORMATS = [
  { value: 'DEFAULT', label: '默认' },
  { value: 'STL', label: 'STL' },
  { value: 'USDZ', label: 'USDZ' },
  { value: 'FBX', label: 'FBX' }
] as const

export const RAPID_TARGET_FORMATS = [
  { value: 'DEFAULT', label: '默认' },
  { value: 'OBJ', label: 'OBJ' },
  { value: 'GLB', label: 'GLB' },
  { value: 'STL', label: 'STL' },
  { value: 'USDZ', label: 'USDZ' },
  { value: 'FBX', label: 'FBX' },
  { value: 'MP4', label: 'MP4 转台视频' }
] as const

export const RAPID_GEOMETRY_TARGET_FORMATS = RAPID_TARGET_FORMATS.filter(
  (item) => item.value !== 'OBJ'
)

export const CONVERT_TARGET_FORMATS = [
  { value: 'STL', label: 'STL' },
  { value: 'USDZ', label: 'USDZ' },
  { value: 'FBX', label: 'FBX' },
  { value: 'MP4', label: 'MP4 转台视频' },
  { value: 'GIF', label: 'GIF 预览动图' }
] as const

export const FACE_LEVEL_OPTIONS = [
  { value: 'low', label: '低', desc: '约 3,000 面' },
  { value: 'medium', label: '中', desc: '约 15,000 面' },
  { value: 'high', label: '高', desc: '约 50,000 面' }
] as const

export const POLYGON_TYPE_OPTIONS = [
  { value: 'triangle', label: '三角面' },
  { value: 'quadrilateral', label: '四边混合' }
] as const

export interface WorkflowStep {
  id: string
  label: string
  icon: string
  apiAction?: Hy3dApiAction
  enabled: boolean
}

export const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: 'concept',
    label: '概念设计',
    icon: 'concept',
    apiAction: 'SubmitHunyuanTo3DProJob',
    enabled: true
  },
  {
    id: 'profile',
    label: '人物生成',
    icon: 'profile',
    apiAction: 'SubmitProfileTo3DJob',
    enabled: true
  },
  {
    id: 'split',
    label: '组件拆分',
    icon: 'split',
    apiAction: 'SubmitHunyuan3DPartJob',
    enabled: true
  },
  {
    id: 'topology',
    label: '智能拓扑',
    icon: 'topology',
    apiAction: 'SubmitReduceFaceJob',
    enabled: true
  },
  {
    id: 'uv',
    label: 'UV展开',
    icon: 'uv',
    apiAction: 'SubmitHunyuanTo3DUVJob',
    enabled: true
  },
  {
    id: 'texture',
    label: '纹理绘制',
    icon: 'texture',
    apiAction: 'SubmitTextureTo3DJob',
    enabled: true
  },
  {
    id: 'convert',
    label: '格式转换',
    icon: 'convert',
    apiAction: 'Convert3DFormat',
    enabled: true
  }
]

export interface MultiViewSlot {
  id: string
  label: string
  apiKey: string
  required?: boolean
  gridRow: number
  gridCol: number
  minVersion?: '3.1'
}

export const MULTI_VIEW_SLOTS: MultiViewSlot[] = [
  { id: 'top', label: '顶视图', apiKey: 'top', gridRow: 1, gridCol: 2, minVersion: '3.1' },
  {
    id: 'left45',
    label: '左前45°',
    apiKey: 'left_front',
    gridRow: 2,
    gridCol: 1,
    minVersion: '3.1'
  },
  { id: 'front', label: '正视图', apiKey: 'front', gridRow: 2, gridCol: 2, required: true },
  {
    id: 'right45',
    label: '右前45°',
    apiKey: 'right_front',
    gridRow: 2,
    gridCol: 3,
    minVersion: '3.1'
  },
  { id: 'left', label: '左视图', apiKey: 'left', gridRow: 3, gridCol: 1 },
  { id: 'right', label: '右视图', apiKey: 'right', gridRow: 3, gridCol: 3 },
  { id: 'back', label: '后视图', apiKey: 'back', gridRow: 4, gridCol: 2 },
  { id: 'bottom', label: '底视图', apiKey: 'bottom', gridRow: 5, gridCol: 2, minVersion: '3.1' }
]

export const PROFILE_TEMPLATE_OPTIONS: Array<{
  value: Hy3dProfileTemplate
  label: string
  desc: string
}> = [
  { value: 'DEFAULT', label: '官方默认', desc: '不传 Template，由接口走默认人物模板。' },
  { value: 'basketball', label: '动感球手', desc: 'basketball' },
  { value: 'badminton', label: '羽扬中华', desc: 'badminton' },
  { value: 'pingpong', label: '国球荣耀', desc: 'pingpong' },
  { value: 'gymnastics', label: '勇攀巅峰', desc: 'gymnastics' },
  { value: 'pilidance', label: '舞动青春', desc: 'pilidance' },
  { value: 'tennis', label: '网球甜心', desc: 'tennis' },
  { value: 'athletics', label: '东方疾风', desc: 'athletics' },
  { value: 'footballboykicking1', label: '激情逐风', desc: 'footballboykicking1' },
  { value: 'footballboykicking2', label: '绿茵之星', desc: 'footballboykicking2' },
  { value: 'guitar', label: '甜酷弦音', desc: 'guitar' },
  { value: 'footballboy', label: '足球小将', desc: 'footballboy' },
  { value: 'skateboard', label: '滑跃青春', desc: 'skateboard' },
  { value: 'futuresoilder', label: '未来战士', desc: 'futuresoilder' },
  { value: 'explorer', label: '逐梦旷野', desc: 'explorer' },
  { value: 'beardollgirl', label: '可爱女孩', desc: 'beardollgirl' },
  { value: 'bibpantsboy', label: '都市白领', desc: 'bibpantsboy' },
  { value: 'womansitpose', label: '职业丽影', desc: 'womansitpose' },
  { value: 'womanstandpose2', label: '悠闲时光', desc: 'womanstandpose2' },
  { value: 'mysteriousprincess', label: '海洋公主', desc: 'mysteriousprincess' },
  { value: 'manstandpose2', label: '演讲之星', desc: 'manstandpose2' }
]

export interface Hy3dProfileTemplatePreviewMeta {
  desc: string
  templateCode: string
  previewTags: [string, string, string]
  previewGradient: string
}

export const HY3D_PROFILE_TEMPLATE_PREVIEW_META: Record<
  Hy3dProfileTemplate,
  Hy3dProfileTemplatePreviewMeta
> = {
  DEFAULT: {
    desc: '不传 Template，由官方接口自动选择通用人物模板。',
    templateCode: 'DEFAULT',
    previewTags: ['通用', '自然', '稳妥'],
    previewGradient: 'linear-gradient(135deg, #4b6cb7 0%, #182848 100%)'
  },
  basketball: {
    desc: '偏热血球场气质，动作张力更强，适合强调爆发力。',
    templateCode: 'basketball',
    previewTags: ['热血', '球场', '腾跃'],
    previewGradient: 'linear-gradient(135deg, #ff7a18 0%, #ff3d54 55%, #6b2fff 100%)'
  },
  badminton: {
    desc: '轻盈挥拍感更明显，适合利落、敏捷的人物气质。',
    templateCode: 'badminton',
    previewTags: ['轻盈', '挥拍', '竞技'],
    previewGradient: 'linear-gradient(135deg, #00c6a7 0%, #0072ff 100%)'
  },
  pingpong: {
    desc: '更偏自信和速度感，适合节奏快、姿态稳定的表现。',
    templateCode: 'pingpong',
    previewTags: ['自信', '速度', '荣耀'],
    previewGradient: 'linear-gradient(135deg, #ff512f 0%, #dd2476 100%)'
  },
  gymnastics: {
    desc: '强调舒展与力量，适合动作幅度大的高难姿态。',
    templateCode: 'gymnastics',
    previewTags: ['舒展', '力量', '高难'],
    previewGradient: 'linear-gradient(135deg, #7f53ac 0%, #647dee 100%)'
  },
  pilidance: {
    desc: '舞台感更强，整体更轻快，适合青春律动风格。',
    templateCode: 'pilidance',
    previewTags: ['舞台', '青春', '律动'],
    previewGradient: 'linear-gradient(135deg, #f857a6 0%, #ff5858 100%)'
  },
  tennis: {
    desc: '清爽运动感更明显，适合明快、阳光的角色氛围。',
    templateCode: 'tennis',
    previewTags: ['清爽', '阳光', '挥拍'],
    previewGradient: 'linear-gradient(135deg, #c1dfc4 0%, #deecdd 28%, #f6d365 100%)'
  },
  athletics: {
    desc: '更偏冲刺速度感，适合表现爆发起跑和前倾动势。',
    templateCode: 'athletics',
    previewTags: ['疾速', '冲刺', '爆发'],
    previewGradient: 'linear-gradient(135deg, #fc466b 0%, #3f5efb 100%)'
  },
  footballboykicking1: {
    desc: '偏射门瞬间的动态姿势，适合高能绿茵题材。',
    templateCode: 'footballboykicking1',
    previewTags: ['射门', '绿茵', '高能'],
    previewGradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)'
  },
  footballboykicking2: {
    desc: '更偏控球与起势动作，整体更青春、更从容。',
    templateCode: 'footballboykicking2',
    previewTags: ['控球', '青春', '从容'],
    previewGradient: 'linear-gradient(135deg, #56ab2f 0%, #a8e063 100%)'
  },
  guitar: {
    desc: '更偏舞台表演感，适合音乐、潮流、轻酷的人物设定。',
    templateCode: 'guitar',
    previewTags: ['舞台', '潮流', '轻酷'],
    previewGradient: 'linear-gradient(135deg, #8e2de2 0%, #ff6a88 100%)'
  },
  footballboy: {
    desc: '整体更少年感，姿态轻快，适合清朗运动风格。',
    templateCode: 'footballboy',
    previewTags: ['少年', '运动', '轻快'],
    previewGradient: 'linear-gradient(135deg, #3ca55c 0%, #b5ac49 100%)'
  },
  skateboard: {
    desc: '街头感更强，适合自由、不拘束的年轻角色氛围。',
    templateCode: 'skateboard',
    previewTags: ['街头', '自由', '腾跃'],
    previewGradient: 'linear-gradient(135deg, #f7971e 0%, #ffd200 45%, #7f53ac 100%)'
  },
  futuresoilder: {
    desc: '更偏科幻与力量感，适合装备感和英雄感更强的角色。',
    templateCode: 'futuresoilder',
    previewTags: ['科幻', '装甲', '力量'],
    previewGradient: 'linear-gradient(135deg, #0f2027 0%, #2c5364 100%)'
  },
  explorer: {
    desc: '更偏户外探险感，适合远征、旅行和野外主题角色。',
    templateCode: 'explorer',
    previewTags: ['户外', '远征', '冒险'],
    previewGradient: 'linear-gradient(135deg, #355c7d 0%, #6c5b7b 40%, #c06c84 100%)'
  },
  beardollgirl: {
    desc: '更偏软萌和亲和力，适合甜美、轻松的人物气质。',
    templateCode: 'beardollgirl',
    previewTags: ['甜美', '软萌', '亲和'],
    previewGradient: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)'
  },
  bibpantsboy: {
    desc: '更偏通勤与城市感，适合简洁、利落的现代人物形象。',
    templateCode: 'bibpantsboy',
    previewTags: ['都市', '利落', '现代'],
    previewGradient: 'linear-gradient(135deg, #485563 0%, #29323c 100%)'
  },
  womansitpose: {
    desc: '更偏优雅坐姿和职业感，适合成熟、克制的气质表达。',
    templateCode: 'womansitpose',
    previewTags: ['优雅', '职业', '坐姿'],
    previewGradient: 'linear-gradient(135deg, #614385 0%, #516395 100%)'
  },
  womanstandpose2: {
    desc: '更偏松弛站姿和日常感，适合轻松自然的角色设定。',
    templateCode: 'womanstandpose2',
    previewTags: ['松弛', '日常', '自然'],
    previewGradient: 'linear-gradient(135deg, #eacda3 0%, #d6ae7b 100%)'
  },
  mysteriousprincess: {
    desc: '更偏梦幻与礼服气质，适合童话、神秘主题角色。',
    templateCode: 'mysteriousprincess',
    previewTags: ['梦幻', '礼服', '童话'],
    previewGradient: 'linear-gradient(135deg, #1fa2ff 0%, #12d8fa 45%, #a6ffcb 100%)'
  },
  manstandpose2: {
    desc: '更偏正式站姿与表达感，适合稳重、清晰的角色氛围。',
    templateCode: 'manstandpose2',
    previewTags: ['正式', '稳重', '表达'],
    previewGradient: 'linear-gradient(135deg, #232526 0%, #414345 100%)'
  }
}

export const getWorkflowStepIdForAction = (action: Hy3dApiAction): string => {
  switch (action) {
    case 'SubmitProfileTo3DJob':
      return 'profile'
    case 'SubmitHunyuan3DPartJob':
      return 'split'
    case 'SubmitReduceFaceJob':
      return 'topology'
    case 'SubmitHunyuanTo3DUVJob':
      return 'uv'
    case 'SubmitTextureTo3DJob':
      return 'texture'
    case 'Convert3DFormat':
      return 'convert'
    case 'SubmitHunyuanTo3DProJob':
    case 'SubmitHunyuanTo3DRapidJob':
    default:
      return 'concept'
  }
}

export const isBuiltinHunyuan3DWorkflowKey = (key: string): boolean =>
  key.startsWith(BUILTIN_HUNYUAN3D_STEP_KEY_PREFIX)

export const isBuiltinHunyuan3DMenuKey = (key: string): boolean =>
  key === BUILTIN_HUNYUAN3D_QAPP_KEY || isBuiltinHunyuan3DWorkflowKey(key)

export const getBuiltinHunyuan3DStepKey = (stepId: string): string =>
  `${BUILTIN_HUNYUAN3D_STEP_KEY_PREFIX}${stepId}`

export const getBuiltinHunyuan3DStepId = (key: string): string =>
  isBuiltinHunyuan3DWorkflowKey(key) ? key.slice(BUILTIN_HUNYUAN3D_STEP_KEY_PREFIX.length) : ''

export const getBuiltinHunyuan3DQuickAppKeyForAction = (action: Hy3dApiAction): string =>
  getBuiltinHunyuan3DStepKey(getWorkflowStepIdForAction(action))
