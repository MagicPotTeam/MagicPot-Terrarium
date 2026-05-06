import * as fs from 'node:fs/promises'
import path from 'node:path'
import * as tencentcloud from 'tencentcloud-sdk-nodejs-ai3d'
import { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import {
  getFileNameHintFromContentDisposition,
  getFileNameHintFromUrl
} from '@shared/utils/urlFileHints'

const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const MODEL_INPUT_PROBE_RANGE = 'bytes=0-1023'
const SDK_SUBMIT_RETRY_DELAYS_MS = [1500, 4000, 8000, 15000] as const
const SDK_QUERY_RETRY_DELAYS_MS = [1500, 4000] as const

const RESULT_FILE_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.usdz', '.mp4', '.gif']
const MODEL_RESULT_FILE_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.usdz'])
const VIDEO_RESULT_FILE_EXTENSIONS = new Set(['.mp4'])
const IMAGE_RESULT_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const FILE_RESULT_FILE_EXTENSIONS = new Set(['.zip', '.mtl'])
const DIRECT_MODEL_RESULT_TYPES = new Set(['GLB', 'GLTF', 'FBX', 'STL', 'USDZ'])
const VIDEO_RESULT_TYPES = new Set(['MP4'])
const IMAGE_RESULT_TYPES = new Set(['GIF', 'IMAGE', 'TEXTURE_IMAGE'])
const FILE_RESULT_TYPES = new Set(['MTL', 'ZIP', 'POSTPROCESS_OBJ'])
const KNOWN_RESULT_TYPES = new Set(
  [
    'OBJ',
    ...DIRECT_MODEL_RESULT_TYPES,
    ...VIDEO_RESULT_TYPES,
    ...IMAGE_RESULT_TYPES,
    ...FILE_RESULT_TYPES
  ].map((type) => type.toLowerCase())
)
const PRO_RESULT_FORMATS = new Set(['STL', 'USDZ', 'FBX'])
const RAPID_RESULT_FORMATS = new Set(['OBJ', 'GLB', 'STL', 'USDZ', 'FBX', 'MP4'])
const TEXTURE_INPUT_TYPES = new Set(['OBJ', 'GLB'])
const REDUCE_FACE_INPUT_TYPES = new Set(['OBJ', 'GLB'])
const UV_INPUT_TYPES = new Set(['FBX', 'OBJ', 'GLB'])
const PART_INPUT_TYPES = new Set(['FBX'])
const CONVERT_INPUT_TYPES = new Set(['FBX', 'OBJ', 'GLB'])
const POST_PROCESS_INPUT_TYPES = new Set([
  ...TEXTURE_INPUT_TYPES,
  ...REDUCE_FACE_INPUT_TYPES,
  ...UV_INPUT_TYPES,
  ...PART_INPUT_TYPES,
  ...CONVERT_INPUT_TYPES
])
const CONVERT_OUTPUT_TYPES = new Set(['STL', 'USDZ', 'FBX', 'MP4', 'GIF'])
const FACE_LEVEL_TYPES = new Set(['low', 'medium', 'high'])
const POLYGON_TYPES = new Set(['triangle', 'quadrilateral'])
const PRO_MODEL_TYPES = new Set(['3.0', '3.1'])
const TEXTURE_MODEL_TYPES = new Set(['3.0', '3.1'])
const PRO_GENERATE_TYPES = new Set(['Normal', 'LowPoly', 'Geometry', 'Sketch'])
const RAPID_GENERATE_TYPES = new Set(['Normal', 'Geometry'])
const PRO_V31_ONLY_VIEWS = new Set<HunyuanView>(['top', 'bottom', 'left_front', 'right_front'])
const PRO_PROMPT_MAX_BYTES = 1024
const RAPID_PROMPT_MAX_CHARS = 200
const TEXTURE_PROMPT_MAX_CHARS = 200
const PRO_FACE_COUNT_MIN = 3000
const PRO_FACE_COUNT_MAX = 1500000
const PART_MODEL = '1.5'
const SIX_MEBIBYTES = 6 * 1024 * 1024
const EIGHT_MEBIBYTES = 8 * 1024 * 1024
const TEN_MEBIBYTES = 10 * 1024 * 1024
const MAIN_IMAGE_ALLOWED_FORMATS = new Set(['JPEG', 'PNG', 'WEBP'])
const TEXTURE_IMAGE_ALLOWED_FORMATS = new Set(['JPEG', 'PNG'])
const PROFILE_IMAGE_ALLOWED_FORMATS = new Set(['JPEG', 'PNG'])
const PROFILE_TEMPLATES = new Set([
  'basketball',
  'badminton',
  'pingpong',
  'gymnastics',
  'pilidance',
  'tennis',
  'athletics',
  'footballboykicking1',
  'footballboykicking2',
  'guitar',
  'footballboy',
  'skateboard',
  'futuresoilder',
  'explorer',
  'beardollgirl',
  'bibpantsboy',
  'womansitpose',
  'womanstandpose2',
  'mysteriousprincess',
  'manstandpose2'
])
const REMOTE_MODEL_INPUT_TYPE_CACHE = new Map<string, Promise<string>>()

type HunyuanSubmitResp = {
  Response?: {
    JobId?: string
    RequestId?: string
    Error?: {
      Code?: string
      Message?: string
    }
  }
}

type HunyuanQueryResp = {
  Response?: {
    JobStatus?: string
    Status?: string
    ErrorCode?: string
    ErrorMessage?: string
    JobErrorCode?: string
    JobErrorMessage?: string
    ResultFile3Ds?: unknown
    ResultFiles?: unknown
    ResultUrl?: unknown
    FileUrl?: unknown
    DownloadUrl?: unknown
    Url?: unknown
    ResultCreditDetails?: unknown
    ResultCreditConsumed?: unknown
    RequestId?: string
    Error?: {
      Code?: string
      Message?: string
    }
  }
}

type HunyuanView = 'left' | 'right' | 'back' | 'top' | 'bottom' | 'left_front' | 'right_front'

type HunyuanMultiViewImage = {
  ViewName: HunyuanView
  ImageUrl?: string
  ImageBase64?: string
}

type LoadedImageAttachment = {
  attachment: ChatAttachment
  base64: string
  byteLength: number
  width: number
  height: number
  format: string
  publicUrl?: string
}

type GenerateOptions = {
  Model?: string
  GenerateType?: string
  FaceCount?: number
  TargetFormat?: string
  SourceFileName?: string
  FaceLevel?: string
  PolygonType?: string
  EnablePBR?: boolean
  ProfileTemplate?: string
}

type HunyuanResultArtifactKind = 'model3d' | 'video' | 'image' | 'file'

type HunyuanAi3dResultFile = {
  Url?: unknown
  Type?: unknown
}

type HunyuanAi3dPayload = Record<string, unknown>
type HunyuanAi3dMethod<TResponse> = (payload: HunyuanAi3dPayload) => Promise<TResponse>
type HunyuanAi3dSubmitResponse = { JobId?: string }
type HunyuanAi3dConvertResponse = { ResultFile3D?: string }
type HunyuanAi3dQueryResponse = NonNullable<HunyuanQueryResp['Response']>
type HunyuanAi3dClient = InstanceType<typeof tencentcloud.ai3d.v20250513.Client>

type HunyuanResultArtifact = {
  kind: HunyuanResultArtifactKind
  type?: string
  url: string
}

type HunyuanQueryDiagnostics = {
  ResultCreditDetails?: unknown
  ResultCreditConsumed?: unknown
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const stringifyUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const isRetryableTencentSdkError = (error: unknown): boolean => {
  const message = stringifyUnknownError(error)
  return /An internal error has occurred|InternalError|InternalServerError|ServiceUnavailable|Retry your request|temporar(?:ily)? unavailable|GatewayTimeout|RequestLimitExceeded|TooManyRequests|ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(
    message
  )
}

const extractTencentTraceSuffix = (message: string): string => {
  const requestIdMatch = message.match(/requestId[:=]\s*([^\s]+)/i)
  const traceIdMatch = message.match(/traceId[:=]\s*([^\s]+)/i)
  const parts = [
    requestIdMatch ? `requestId:${requestIdMatch[1]}` : '',
    traceIdMatch ? `traceId:${traceIdMatch[1]}` : ''
  ].filter(Boolean)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

const HUNYUAN_MODE_LABELS: Record<string, string> = {
  SubmitHunyuanTo3DProJob: '专业版 3D 生成',
  SubmitHunyuanTo3DRapidJob: '极速版 3D 生成',
  SubmitTextureTo3DJob: '纹理生成',
  SubmitReduceFaceJob: '智能拓扑',
  SubmitHunyuanTo3DUVJob: 'UV 展开',
  SubmitHunyuan3DPartJob: '组件拆分',
  SubmitProfileTo3DJob: '3D 人物生成',
  Convert3DFormat: '格式转换'
}

const getHunyuanModeLabel = (mode: string): string => HUNYUAN_MODE_LABELS[mode] || mode

const wrapRetryableTencentSdkError = (
  mode: string,
  phase: 'submit' | 'query',
  error: unknown,
  retryDelaysMs: readonly number[],
  options?: {
    inputType?: string
  }
): Error => {
  if (!isRetryableTencentSdkError(error)) {
    return error instanceof Error ? error : new Error(stringifyUnknownError(error))
  }

  const traceSuffix = extractTencentTraceSuffix(stringifyUnknownError(error))
  const attemptCount = retryDelaysMs.length + 1
  const uvGlbHint =
    mode === 'SubmitHunyuanTo3DUVJob' && options?.inputType === 'GLB'
      ? ' 当前输入是 GLB；如果持续失败，可先用“格式转换”输出 FBX，再重新执行 UV 展开。'
      : ''

  return new Error(
    `[Hunyuan3D] ${getHunyuanModeLabel(mode)}${phase === 'submit' ? '提交' : '查询'}在 ${attemptCount} 次尝试后仍失败，请稍后重试。${uvGlbHint}${traceSuffix}`.trim()
  )
}

const callTencentSdkWithRetry = async <T>(
  operationLabel: string,
  fn: () => Promise<T>,
  retryDelaysMs: readonly number[]
): Promise<T> => {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (!isRetryableTencentSdkError(error) || attempt >= retryDelaysMs.length) {
        throw error
      }

      const retryDelayMs = retryDelaysMs[attempt]
      console.warn(
        `[Hunyuan3D] Retrying Tencent SDK ${operationLabel} after transient error (attempt ${attempt + 2}/${retryDelaysMs.length + 1})`,
        stringifyUnknownError(error)
      )
      await delay(retryDelayMs)
    }
  }

  throw new Error(`[Hunyuan3D] Tencent SDK ${operationLabel} failed without returning a result.`)
}

const getTencentSdkMethod = <TResponse>(
  client: HunyuanAi3dClient,
  methodName: string
): HunyuanAi3dMethod<TResponse> | null => {
  const method = (client as unknown as Record<string, unknown>)[methodName]
  if (typeof method !== 'function') {
    return null
  }

  return (payload: HunyuanAi3dPayload) =>
    (method as (this: HunyuanAi3dClient, payload: HunyuanAi3dPayload) => Promise<TResponse>).call(
      client,
      payload
    )
}

const normalizeLocalPath = (url: string): string => {
  if (url.startsWith('local-media:///')) {
    return decodeURIComponent(url.replace('local-media:///', ''))
  }
  if (url.startsWith('file:///')) {
    return decodeURIComponent(url.replace('file:///', ''))
  }
  if (url.startsWith('file://')) {
    return decodeURIComponent(url.replace('file://', ''))
  }
  return url
}

const normalizeMimeType = (value: string): string => value.split(';')[0].trim().toLowerCase()

const inferImageFormatFromMimeType = (value: string): string => {
  const normalizedMimeType = normalizeMimeType(value)
  if (normalizedMimeType === 'image/png') return 'PNG'
  if (normalizedMimeType === 'image/jpeg' || normalizedMimeType === 'image/jpg') return 'JPEG'
  if (normalizedMimeType === 'image/webp') return 'WEBP'
  if (normalizedMimeType === 'image/gif') return 'GIF'
  return ''
}

const inferImageFormatFromName = (value: string): string => {
  const normalizedValue = value.trim().toLowerCase()
  if (normalizedValue.endsWith('.png')) return 'PNG'
  if (normalizedValue.endsWith('.jpg') || normalizedValue.endsWith('.jpeg')) return 'JPEG'
  if (normalizedValue.endsWith('.webp')) return 'WEBP'
  if (normalizedValue.endsWith('.gif')) return 'GIF'
  return ''
}

const inferImageFormatFromBuffer = (buffer: Buffer): string => {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'PNG'
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'JPEG'
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'WEBP'
  }

  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'GIF8') {
    return 'GIF'
  }

  return ''
}

const readImageDimensions = (buffer: Buffer, format: string): { width: number; height: number } => {
  const normalizedFormat = format.toUpperCase()
  switch (normalizedFormat) {
    case 'PNG': {
      if (buffer.length < 24) {
        throw new Error('[Hunyuan3D] PNG image is invalid.')
      }
      const ihdrOffset = 16
      return {
        width: buffer.readUInt32BE(ihdrOffset),
        height: buffer.readUInt32BE(ihdrOffset + 4)
      }
    }
    case 'GIF': {
      if (buffer.length < 10) {
        throw new Error('[Hunyuan3D] GIF image is invalid.')
      }
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8)
      }
    }
    case 'JPEG': {
      let offset = 2
      const sofMarkers = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
      ])

      while (offset < buffer.length) {
        while (offset < buffer.length && buffer[offset] !== 0xff) {
          offset += 1
        }
        while (offset < buffer.length && buffer[offset] === 0xff) {
          offset += 1
        }
        if (offset >= buffer.length) break

        const marker = buffer[offset]
        offset += 1

        if (marker === 0xd8 || marker === 0x01) {
          continue
        }

        if (marker === 0xd9 || marker === 0xda) {
          break
        }

        if (offset + 1 >= buffer.length) {
          break
        }

        const segmentLength = buffer.readUInt16BE(offset)
        if (segmentLength < 2 || offset + segmentLength > buffer.length) {
          break
        }

        if (sofMarkers.has(marker)) {
          return {
            height: buffer.readUInt16BE(offset + 3),
            width: buffer.readUInt16BE(offset + 5)
          }
        }

        offset += segmentLength
      }

      throw new Error('[Hunyuan3D] JPEG image dimensions could not be determined.')
    }
    default:
      throw new Error('[Hunyuan3D] Unsupported image format.')
  }
}

const EXPIRING_RESULT_URL_MODES = new Set(['SubmitHunyuanTo3DUVJob', 'SubmitHunyuan3DPartJob'])

const normalizeCreditDetails = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const normalizeCreditConsumed = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

const buildSuccessDiagnostics = (
  mode: string,
  diagnosticsSource?: HunyuanQueryDiagnostics
): string[] => {
  const diagnostics: string[] = []

  if (EXPIRING_RESULT_URL_MODES.has(mode)) {
    diagnostics.push('[Hunyuan3D] Result URLs may expire after 1 day.')
  }

  const creditConsumed = normalizeCreditConsumed(diagnosticsSource?.ResultCreditConsumed)
  if (creditConsumed !== null) {
    diagnostics.push(`[Hunyuan3D] Credits consumed: ${creditConsumed}`)
  }

  const creditDetails = normalizeCreditDetails(diagnosticsSource?.ResultCreditDetails)
  if (creditDetails) {
    diagnostics.push(`[Hunyuan3D] Credit details: ${creditDetails}`)
  }

  return diagnostics
}

const formatSuccessResponse = (
  mode: string,
  artifacts: HunyuanResultArtifact[],
  diagnosticsSource?: HunyuanQueryDiagnostics
): string => {
  const artifactText = artifacts.map(formatResultArtifact).join('\n')
  const diagnostics = buildSuccessDiagnostics(mode, diagnosticsSource)

  return diagnostics.length > 0 ? `${artifactText}\n\n${diagnostics.join('\n')}` : artifactText
}

const summarizeQueryResultFields = (
  response:
    | HunyuanQueryResp['Response']
    | {
        ResultFile3Ds?: unknown
        ResultFiles?: unknown
        ResultUrl?: unknown
        FileUrl?: unknown
        DownloadUrl?: unknown
        Url?: unknown
      }
) => ({
  resultFile3DCount: Array.isArray(response?.ResultFile3Ds) ? response.ResultFile3Ds.length : 0,
  resultFilesCount: Array.isArray(response?.ResultFiles) ? response.ResultFiles.length : 0,
  hasResultUrl: typeof response?.ResultUrl === 'string' && response.ResultUrl.trim().length > 0,
  hasFileUrl: typeof response?.FileUrl === 'string' && response.FileUrl.trim().length > 0,
  hasDownloadUrl:
    typeof response?.DownloadUrl === 'string' && response.DownloadUrl.trim().length > 0,
  hasUrl: typeof response?.Url === 'string' && response.Url.trim().length > 0
})

const logQuerySuccessArtifacts = (
  mode: string,
  source: 'sdk' | 'rest',
  response:
    | HunyuanQueryResp['Response']
    | {
        ResultFile3Ds?: unknown
        ResultFiles?: unknown
        ResultUrl?: unknown
        FileUrl?: unknown
        DownloadUrl?: unknown
        Url?: unknown
      },
  artifacts: HunyuanResultArtifact[]
): void => {
  console.info('[Hunyuan3D] Query completed', {
    mode,
    source,
    ...summarizeQueryResultFields(response),
    artifactCount: artifacts.length,
    artifacts: artifacts.map((artifact, index) => ({
      index,
      kind: artifact.kind,
      type: artifact.type || '',
      url: artifact.url
    }))
  })
}

const parseDataUrl = (url: string): { buffer: Buffer; base64: string; mimeType: string } => {
  const commaIndex = url.indexOf(',')
  if (commaIndex < 0) {
    throw new Error('[Hunyuan3D] 无效的 data URL')
  }

  const metadata = url.slice(5, commaIndex)
  const payload = url.slice(commaIndex + 1).replace(/\s+/g, '')
  const mimeType = normalizeMimeType(metadata)
  const isBase64 = /;base64/i.test(metadata)
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')

  return {
    buffer,
    base64: isBase64 ? payload : buffer.toString('base64'),
    mimeType
  }
}

const loadImageAttachment = async (attachment: ChatAttachment): Promise<LoadedImageAttachment> => {
  let buffer: Buffer
  let base64: string
  let mimeType = normalizeMimeType(attachment.mimeType || '')
  let publicUrl: string | undefined

  if (attachment.url.startsWith('data:')) {
    const parsed = parseDataUrl(attachment.url)
    buffer = parsed.buffer
    base64 = parsed.base64
    mimeType = mimeType || parsed.mimeType
  } else if (
    attachment.url.startsWith('local-media:///') ||
    attachment.url.startsWith('file:///') ||
    attachment.url.startsWith('file://') ||
    /^[A-Za-z]:\\/.test(attachment.url)
  ) {
    const filePath = normalizeLocalPath(attachment.url)
    buffer = await fs.readFile(filePath)
    base64 = buffer.toString('base64')
    mimeType = mimeType || inferImageFormatFromName(filePath).toLowerCase()
  } else {
    const resp = await fetch(attachment.url)
    if (!resp.ok) {
      throw new Error(`[Hunyuan3D] 下载参考图失败: ${resp.status} ${resp.statusText}`)
    }
    buffer = Buffer.from(await resp.arrayBuffer())
    base64 = buffer.toString('base64')
    mimeType = mimeType || normalizeMimeType(resp.headers.get('content-type') || '')
    publicUrl = isRemoteHttpUrl(attachment.url) ? attachment.url : undefined
  }

  const format =
    inferImageFormatFromMimeType(mimeType) ||
    inferImageFormatFromName(attachment.fileName || '') ||
    inferImageFormatFromName(attachment.url) ||
    inferImageFormatFromBuffer(buffer)

  if (!format) {
    throw new Error(
      '[Hunyuan3D] Unsupported image format. Allowed formats depend on the current API mode.'
    )
  }

  const { width, height } = readImageDimensions(buffer, format)

  return {
    attachment,
    base64,
    byteLength: buffer.byteLength,
    width,
    height,
    format,
    publicUrl
  }
}

const assertImageAttachmentConstraints = (
  context: string,
  image: LoadedImageAttachment,
  {
    allowedFormats,
    minEdgeInclusive,
    maxEdgeInclusive,
    minEdgeExclusive,
    maxEdgeExclusive,
    maxByteLengthInclusive,
    maxBase64LengthExclusive
  }: {
    allowedFormats: Set<string>
    minEdgeInclusive?: number
    maxEdgeInclusive?: number
    minEdgeExclusive?: number
    maxEdgeExclusive?: number
    maxByteLengthInclusive?: number
    maxBase64LengthExclusive?: number
  }
) => {
  if (!allowedFormats.has(image.format)) {
    throw new Error(
      `[Hunyuan3D] ${context} only supports ${Array.from(allowedFormats).join('/')} images.`
    )
  }

  const edges = [image.width, image.height]
  if (typeof minEdgeInclusive === 'number' && edges.some((edge) => edge < minEdgeInclusive)) {
    throw new Error(
      `[Hunyuan3D] ${context} image dimensions must stay within ${minEdgeInclusive}-${maxEdgeInclusive}px.`
    )
  }
  if (typeof maxEdgeInclusive === 'number' && edges.some((edge) => edge > maxEdgeInclusive)) {
    throw new Error(
      `[Hunyuan3D] ${context} image dimensions must stay within ${minEdgeInclusive}-${maxEdgeInclusive}px.`
    )
  }
  if (typeof minEdgeExclusive === 'number' && edges.some((edge) => edge <= minEdgeExclusive)) {
    throw new Error(
      `[Hunyuan3D] ${context} image dimensions must be greater than ${minEdgeExclusive}px and less than ${maxEdgeExclusive}px.`
    )
  }
  if (typeof maxEdgeExclusive === 'number' && edges.some((edge) => edge >= maxEdgeExclusive)) {
    throw new Error(
      `[Hunyuan3D] ${context} image dimensions must be greater than ${minEdgeExclusive}px and less than ${maxEdgeExclusive}px.`
    )
  }
  if (typeof maxByteLengthInclusive === 'number' && image.byteLength > maxByteLengthInclusive) {
    throw new Error(
      `[Hunyuan3D] ${context} image payload must be ${Math.floor(maxByteLengthInclusive / (1024 * 1024))}MB or smaller.`
    )
  }
  if (
    typeof maxBase64LengthExclusive === 'number' &&
    image.base64.length >= maxBase64LengthExclusive
  ) {
    throw new Error(
      `[Hunyuan3D] ${context} image Base64 payload must stay below ${Math.floor(maxBase64LengthExclusive / (1024 * 1024))}MB.`
    )
  }
}

const assertTotalBase64Length = (
  context: string,
  images: LoadedImageAttachment[],
  maxTotalBase64LengthInclusive: number
) => {
  const totalBase64Length = images.reduce((sum, image) => sum + image.base64.length, 0)
  if (totalBase64Length > maxTotalBase64LengthInclusive) {
    throw new Error(
      `[Hunyuan3D] ${context} total Base64 payload must stay within ${Math.floor(maxTotalBase64LengthInclusive / (1024 * 1024))}MB.`
    )
  }
}

const assertTotalByteLength = (
  context: string,
  images: LoadedImageAttachment[],
  maxTotalByteLengthInclusive: number
) => {
  const totalByteLength = images.reduce((sum, image) => sum + image.byteLength, 0)
  if (totalByteLength > maxTotalByteLengthInclusive) {
    throw new Error(
      `[Hunyuan3D] ${context} total source image size must stay within ${Math.floor(maxTotalByteLengthInclusive / (1024 * 1024))}MB.`
    )
  }
}

const inferViewName = (
  attachment: Pick<ChatAttachment, 'fileName' | 'url'>
): HunyuanView | null => {
  const candidate =
    `${attachment.fileName || ''} ${getFileNameHintFromUrl(attachment.url) || ''} ${attachment.url || ''}`.toLowerCase()

  if (/(^|[^a-z0-9])(left[_-]?front|front[_-]?left|left45)([^a-z0-9]|$)/.test(candidate)) {
    return 'left_front'
  }
  if (/(^|[^a-z0-9])(right[_-]?front|front[_-]?right|right45)([^a-z0-9]|$)/.test(candidate)) {
    return 'right_front'
  }
  if (/(^|[^a-z0-9])left([^a-z0-9]|$)/.test(candidate)) {
    return 'left'
  }
  if (/(^|[^a-z0-9])right([^a-z0-9]|$)/.test(candidate)) {
    return 'right'
  }
  if (/(^|[^a-z0-9])back([^a-z0-9]|$)/.test(candidate)) {
    return 'back'
  }
  if (/(^|[^a-z0-9])top([^a-z0-9]|$)/.test(candidate)) {
    return 'top'
  }
  if (/(^|[^a-z0-9])bottom([^a-z0-9]|$)/.test(candidate)) {
    return 'bottom'
  }

  return null
}

const buildMultiViewImages = (attachments: LoadedImageAttachment[]): HunyuanMultiViewImage[] => {
  if (attachments.length === 0) {
    return []
  }

  const limitedAttachments = attachments.slice(0, 7)
  const orderedViews: HunyuanView[] = [
    'left',
    'right',
    'back',
    'top',
    'bottom',
    'left_front',
    'right_front'
  ]
  const assignedViews = new Set<HunyuanView>()
  const pendingAttachments: ChatAttachment[] = []
  const mappedAttachments: Array<{ attachment: LoadedImageAttachment; view: HunyuanView }> = []

  for (const attachment of limitedAttachments) {
    const inferredView = inferViewName(attachment.attachment)
    if (inferredView && !assignedViews.has(inferredView)) {
      assignedViews.add(inferredView)
      mappedAttachments.push({ attachment, view: inferredView })
    } else {
      pendingAttachments.push(attachment.attachment)
    }
  }

  for (const attachment of pendingAttachments) {
    const nextView = orderedViews.find((view) => !assignedViews.has(view))
    if (!nextView) break
    assignedViews.add(nextView)
    const matchedAttachment = limitedAttachments.find(
      (candidate) => candidate.attachment === attachment
    )
    if (matchedAttachment) {
      mappedAttachments.push({ attachment: matchedAttachment, view: nextView })
    }
  }

  const multiViewImages = mappedAttachments.map(({ attachment, view }) => ({
    ViewName: view,
    ...(attachment.publicUrl ? { ImageUrl: attachment.publicUrl } : {}),
    ...(!attachment.publicUrl ? { ImageBase64: attachment.base64 } : {})
  }))

  return multiViewImages
}

const utf8ByteLength = (value: string): number => Buffer.byteLength(value, 'utf8')
const unicodeCharacterLength = (value: string): number => Array.from(value).length

const assertValidProOptions = (
  promptText: string,
  model: string,
  generateType: string,
  faceCount: number | undefined,
  multiViewImages: HunyuanMultiViewImage[]
) => {
  if (promptText && utf8ByteLength(promptText) > PRO_PROMPT_MAX_BYTES) {
    throw new Error('[Hunyuan3D] Pro prompt must be 1024 UTF-8 bytes or fewer.')
  }

  if (!PRO_MODEL_TYPES.has(model)) {
    throw new Error('[Hunyuan3D] Pro model version must be 3.0 or 3.1.')
  }

  if (!PRO_GENERATE_TYPES.has(generateType)) {
    throw new Error('[Hunyuan3D] Pro generate type must be Normal, LowPoly, Geometry, or Sketch.')
  }

  if (model === '3.1' && generateType === 'LowPoly') {
    throw new Error('[Hunyuan3D] LowPoly is not available for Pro model version 3.1.')
  }

  if (
    typeof faceCount === 'number' &&
    generateType !== 'LowPoly' &&
    (faceCount < PRO_FACE_COUNT_MIN || faceCount > PRO_FACE_COUNT_MAX)
  ) {
    throw new Error(
      `[Hunyuan3D] Pro face count must stay within ${PRO_FACE_COUNT_MIN}-${PRO_FACE_COUNT_MAX}.`
    )
  }

  if (model !== '3.1' && multiViewImages.some((image) => PRO_V31_ONLY_VIEWS.has(image.ViewName))) {
    throw new Error(
      '[Hunyuan3D] top, bottom, left_front, and right_front multiview inputs require Pro model version 3.1.'
    )
  }
}

const assertValidRapidOptions = (
  promptText: string,
  generateType: string,
  targetFormat: string
) => {
  if (promptText && unicodeCharacterLength(promptText) > RAPID_PROMPT_MAX_CHARS) {
    throw new Error(
      `[Hunyuan3D] Rapid prompt must be ${RAPID_PROMPT_MAX_CHARS} characters or fewer.`
    )
  }

  if (!RAPID_GENERATE_TYPES.has(generateType)) {
    throw new Error('[Hunyuan3D] Rapid generate type must be Normal or Geometry.')
  }

  if (generateType === 'Geometry' && targetFormat === 'OBJ') {
    throw new Error('[Hunyuan3D] Rapid Geometry mode does not support OBJ output.')
  }
}

const assertValidTexturePrompt = (promptText: string) => {
  if (promptText && unicodeCharacterLength(promptText) > TEXTURE_PROMPT_MAX_CHARS) {
    throw new Error(
      `[Hunyuan3D] Texture prompt must be ${TEXTURE_PROMPT_MAX_CHARS} characters or fewer.`
    )
  }
}

const assertValidProReferenceImages = (
  primaryImage: LoadedImageAttachment | undefined,
  multiViewImages: LoadedImageAttachment[]
) => {
  if (primaryImage) {
    assertImageAttachmentConstraints('Pro reference', primaryImage, {
      allowedFormats: MAIN_IMAGE_ALLOWED_FORMATS,
      minEdgeInclusive: 128,
      maxEdgeInclusive: 5000,
      maxByteLengthInclusive: primaryImage.publicUrl ? EIGHT_MEBIBYTES : SIX_MEBIBYTES
    })
  }

  multiViewImages.forEach((image) =>
    assertImageAttachmentConstraints('Pro multiview', image, {
      allowedFormats: TEXTURE_IMAGE_ALLOWED_FORMATS,
      minEdgeExclusive: 128,
      maxEdgeExclusive: 5000,
      ...(image.publicUrl
        ? { maxByteLengthInclusive: EIGHT_MEBIBYTES }
        : { maxBase64LengthExclusive: SIX_MEBIBYTES })
    })
  )
  if (multiViewImages.length > 0) {
    assertTotalByteLength('Pro multiview', multiViewImages, EIGHT_MEBIBYTES)
    const base64Images = multiViewImages.filter((image) => !image.publicUrl)
    if (base64Images.length > 0) {
      assertTotalBase64Length('Pro multiview', base64Images, SIX_MEBIBYTES)
    }
  }
}

const assertValidRapidReferenceImage = (primaryImage: LoadedImageAttachment | undefined) => {
  if (!primaryImage) return
  assertImageAttachmentConstraints('Rapid reference', primaryImage, {
    allowedFormats: MAIN_IMAGE_ALLOWED_FORMATS,
    minEdgeInclusive: 128,
    maxEdgeInclusive: 5000,
    maxByteLengthInclusive: primaryImage.publicUrl ? EIGHT_MEBIBYTES : SIX_MEBIBYTES
  })
}

const assertValidTextureReferenceImage = (primaryImage: LoadedImageAttachment | undefined) => {
  if (!primaryImage) return
  assertImageAttachmentConstraints('Texture reference', primaryImage, {
    allowedFormats: TEXTURE_IMAGE_ALLOWED_FORMATS,
    minEdgeExclusive: 128,
    maxEdgeExclusive: 4096,
    ...(primaryImage.publicUrl ? {} : { maxBase64LengthExclusive: TEN_MEBIBYTES })
  })
}

const assertValidTextureReferenceImages = (
  primaryImage: LoadedImageAttachment | undefined,
  multiViewImages: LoadedImageAttachment[]
) => {
  assertValidTextureReferenceImage(primaryImage)

  multiViewImages.forEach((image) =>
    assertImageAttachmentConstraints('Texture multiview', image, {
      allowedFormats: TEXTURE_IMAGE_ALLOWED_FORMATS,
      minEdgeExclusive: 128,
      maxEdgeExclusive: 5000,
      ...(image.publicUrl
        ? { maxByteLengthInclusive: EIGHT_MEBIBYTES }
        : { maxBase64LengthExclusive: SIX_MEBIBYTES })
    })
  )
  if (multiViewImages.length > 0) {
    assertTotalByteLength('Texture multiview', multiViewImages, EIGHT_MEBIBYTES)
    const base64Images = multiViewImages.filter((image) => !image.publicUrl)
    if (base64Images.length > 0) {
      assertTotalBase64Length('Texture multiview', base64Images, SIX_MEBIBYTES)
    }
  }
}

const assertValidTextureOptions = (model: string, multiViewImages: HunyuanMultiViewImage[]) => {
  if (!TEXTURE_MODEL_TYPES.has(model)) {
    throw new Error('[Hunyuan3D] Texture model version must be 3.0 or 3.1.')
  }

  if (model !== '3.1' && multiViewImages.length > 0) {
    throw new Error('[Hunyuan3D] Texture multiview inputs require model version 3.1.')
  }
}

const assertValidProfileReferenceImage = (primaryImage: LoadedImageAttachment | undefined) => {
  if (!primaryImage) return
  assertImageAttachmentConstraints('Profile reference', primaryImage, {
    allowedFormats: PROFILE_IMAGE_ALLOWED_FORMATS,
    minEdgeExclusive: 500,
    maxEdgeExclusive: 4096,
    ...(primaryImage.publicUrl ? {} : { maxBase64LengthExclusive: TEN_MEBIBYTES })
  })
}

const buildPrimaryImagePayload = (
  image: LoadedImageAttachment | undefined
): { url?: string; base64?: string } => {
  if (!image) return {}
  if (image.publicUrl) {
    return { url: image.publicUrl }
  }
  return { base64: image.base64 }
}

const buildViewImagePayload = (image: HunyuanMultiViewImage) => ({
  ViewType: image.ViewName,
  ...(image.ImageUrl ? { ViewImageUrl: image.ImageUrl } : {}),
  ...(image.ImageBase64 ? { ViewImageBase64: image.ImageBase64 } : {})
})

const ai3dRequest = async <TResp>(
  url: string,
  payload: Record<string, unknown>,
  apiToken: string
): Promise<TResp> => {
  const authorization = apiToken.startsWith('Bearer ') ? apiToken : `Bearer ${apiToken}`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`[Hunyuan3D] 请求失败: ${resp.status} ${resp.statusText} ${text}`.trim())
  }

  return (await resp.json()) as TResp
}

const formatRequestIdSuffix = (requestId: unknown): string => {
  const normalizedRequestId = String(requestId || '').trim()
  return normalizedRequestId ? ` RequestId=${normalizedRequestId}` : ''
}

const withRequestId = (message: string, requestId: unknown): string =>
  `${message}${formatRequestIdSuffix(requestId)}`

const assertNoApiError = (
  response: HunyuanSubmitResp['Response'] | HunyuanQueryResp['Response'] | undefined
) => {
  const error = response?.Error
  if (error?.Code || error?.Message) {
    throw new Error(
      withRequestId(
        `[Hunyuan3D] ${error.Code || 'Unknown'} ${error.Message || ''}`.trim(),
        response?.RequestId
      )
    )
  }
}

const getJobStatus = (response: HunyuanQueryResp['Response']): string =>
  String(response?.JobStatus || response?.Status || '').toUpperCase()

const isSuccessStatus = (status: string): boolean =>
  ['SUCCESS', 'SUCCEEDED', 'FINISH', 'FINISHED', 'DONE'].includes(status)

const isFailureStatus = (status: string): boolean =>
  ['FAIL', 'FAILED', 'ERROR', 'CANCEL', 'CANCELLED'].includes(status)

const inferFileType = (modelUrl: string): string => {
  const hintedFileName = getFileNameHintFromUrl(modelUrl)
  if (hintedFileName) {
    return path.extname(hintedFileName).replace('.', '').toUpperCase()
  }

  try {
    if (/^https?:\/\//i.test(modelUrl)) {
      const pathname = new URL(modelUrl).pathname
      return path.extname(pathname).replace('.', '').toUpperCase()
    }
  } catch {
    /* ignore */
  }

  const normalizedPath = normalizeLocalPath(modelUrl)
  return path.extname(normalizedPath).replace('.', '').toUpperCase()
}

const inferModelInputTypeHint = (value: string): string => {
  const directType = inferFileType(value)
  if (POST_PROCESS_INPUT_TYPES.has(directType)) {
    return directType
  }

  const normalizedValue = String(value || '').toUpperCase()
  for (const type of POST_PROCESS_INPUT_TYPES) {
    if (new RegExp(`(^|[^A-Z0-9])${type}([^A-Z0-9]|$)`).test(normalizedValue)) {
      return type
    }
  }

  return ''
}

const inferModelInputType = (modelUrl: string, sourceFileName: string): string =>
  inferModelInputTypeHint(modelUrl) ||
  inferModelInputTypeHint(sourceFileName) ||
  inferModelInputTypeHint(getFileNameHintFromUrl(modelUrl))

const getRemoteModelHintFromHeaders = (headers: Headers): string => {
  const contentDispositionHint = getFileNameHintFromContentDisposition(
    String(headers.get('content-disposition') || '')
  )
  const headerFileNameHint =
    contentDispositionHint ||
    [
      'x-file-name',
      'x-filename',
      'x-amz-meta-filename',
      'x-cos-meta-filename',
      'x-goog-meta-filename'
    ]
      .map((headerName) => getFileNameHintFromUrl(String(headers.get(headerName) || '')))
      .find(Boolean) ||
    ''

  const hintedType = inferModelInputTypeHint(headerFileNameHint)
  if (hintedType) {
    return hintedType
  }

  const contentType = String(headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('gltf-binary')) {
    return 'GLB'
  }
  if (contentType.includes('fbx')) {
    return 'FBX'
  }
  if (contentType.includes('model/obj') || contentType.includes('text/obj')) {
    return 'OBJ'
  }

  return ''
}

const inferModelInputTypeFromBuffer = (buffer: Buffer): string => {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('utf8') === 'glTF') {
    return 'GLB'
  }

  if (buffer.length >= 18 && buffer.subarray(0, 18).toString('utf8') === 'Kaydara FBX Binary') {
    return 'FBX'
  }

  const textSample = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8')
  if (!textSample) {
    return ''
  }

  const normalizedSample = `\n${textSample.replace(/\r\n/g, '\n')}`
  const hasAsciiFbxHeader =
    /(?:^|\n)\s*FBXHeaderExtension\b/.test(normalizedSample) ||
    /(?:^|\n)\s*;+?\s*FBX\s+\d/i.test(normalizedSample)
  if (hasAsciiFbxHeader) {
    return 'FBX'
  }
  const hasVertices = /(?:^|\n)v\s+-?\d/.test(normalizedSample)
  const hasFaces = /(?:^|\n)f\s+[\d/-]+/.test(normalizedSample)
  const hasObjDirectives = /(?:^|\n)(o|g|mtllib|usemtl|vn|vt)\s+/.test(normalizedSample)

  if ((hasVertices && hasFaces) || (hasVertices && hasObjDirectives)) {
    return 'OBJ'
  }

  return ''
}

const probeRemoteModelInputType = async (modelUrl: string): Promise<string> => {
  if (!/^https?:\/\//i.test(modelUrl)) {
    return ''
  }

  const cached = REMOTE_MODEL_INPUT_TYPE_CACHE.get(modelUrl)
  if (cached) {
    return cached
  }

  const probePromise = (async () => {
    try {
      const response = await fetch(modelUrl, {
        headers: {
          Range: MODEL_INPUT_PROBE_RANGE
        }
      })

      if (!response.ok) {
        return ''
      }

      const headerHint = getRemoteModelHintFromHeaders(response.headers)
      if (headerHint) {
        return headerHint
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      return inferModelInputTypeFromBuffer(buffer)
    } catch {
      return ''
    }
  })()

  REMOTE_MODEL_INPUT_TYPE_CACHE.set(modelUrl, probePromise)
  return probePromise
}

const resolveModelInputType = async (modelUrl: string, sourceFileName: string): Promise<string> =>
  inferModelInputType(modelUrl, sourceFileName) || (await probeRemoteModelInputType(modelUrl))

const assertSupportedFileType = async (
  modelUrl: string,
  sourceFileName: string,
  allowedTypes: Set<string>,
  actionLabel: string
): Promise<string> => {
  const type = await resolveModelInputType(modelUrl, sourceFileName)
  if (!type || !allowedTypes.has(type)) {
    throw new Error(
      `[Hunyuan3D] ${actionLabel} 仅支持 ${Array.from(allowedTypes).join('/')} 格式的公开模型 URL`
    )
  }
  return type
}

export class Hunyuan3DClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string = 'https://api.ai3d.cloud.tencent.com',
    private readonly secretId: string = '',
    private readonly secretKey: string = '',
    private readonly region: string = ''
  ) {}

  async generateFromMessages(
    messages: ChatMessage[],
    mode: string = 'SubmitHunyuanTo3DProJob',
    options: GenerateOptions = {}
  ): Promise<string> {
    const lastUserMessage = getLastUserMessage(messages)
    const promptText = stripModelUrlFromPrompt(lastUserMessage?.content || '')
    const normalizedModel = String(options.Model || '3.1')
    const normalizedGenerateType = String(options.GenerateType || 'Normal')
    const normalizedFaceCount =
      typeof options.FaceCount === 'number' ? options.FaceCount : undefined

    const needsModel = [
      'SubmitTextureTo3DJob',
      'SubmitReduceFaceJob',
      'SubmitHunyuanTo3DUVJob',
      'SubmitHunyuan3DPartJob',
      'Convert3DFormat'
    ].includes(mode)
    const preflightModelUrls = needsModel
      ? lastUserMessage?.content?.match(/https?:\/\/[^\s]+/g) || []
      : []
    const preflightModelPublicUrl = needsModel
      ? preflightModelUrls.find((url) => isResultFileUrl(url)) || preflightModelUrls[0] || ''
      : ''
    const sourceFileName = String(options.SourceFileName || '')
    const requestedTargetFormat = String(options.TargetFormat || '')
      .trim()
      .toUpperCase()
    const hasExplicitTargetFormat =
      requestedTargetFormat !== '' && requestedTargetFormat !== 'DEFAULT'
    let normalizedTargetFormat = normalizeRequestedResultType(
      mode,
      requestedTargetFormat,
      preflightModelPublicUrl,
      sourceFileName
    )

    const imageAttachments = getImageAttachments(lastUserMessage)

    if (mode === 'SubmitProfileTo3DJob' && imageAttachments.length === 0) {
      throw new Error('[Hunyuan3D] 3D 人物生成功能需要先上传头像参考图')
    }

    if (
      ['SubmitHunyuanTo3DProJob', 'SubmitHunyuanTo3DRapidJob'].includes(mode) &&
      !promptText &&
      imageAttachments.length === 0
    ) {
      throw new Error('[Hunyuan3D] 文生/图生 3D 至少需要提供文本提示词或参考图')
    }

    if (mode === 'SubmitHunyuanTo3DRapidJob' && promptText && imageAttachments.length > 0) {
      throw new Error('[Hunyuan3D] 极速版接口不支持同时提交提示词和参考图')
    }

    if (
      mode === 'SubmitHunyuanTo3DProJob' &&
      normalizedGenerateType !== 'Sketch' &&
      promptText &&
      imageAttachments.length > 0
    ) {
      throw new Error('[Hunyuan3D] 专业版除 Sketch 模式外，不支持同时提交提示词和参考图')
    }

    if (mode === 'SubmitTextureTo3DJob') {
      if (!promptText && imageAttachments.length === 0) {
        throw new Error('[Hunyuan3D] 纹理生成至少需要提供提示词或参考图')
      }

      if (promptText && imageAttachments.length > 0) {
        throw new Error('[Hunyuan3D] 纹理生成接口不支持同时提交提示词和参考图')
      }

      assertValidTexturePrompt(promptText)
    }

    const useSDK = !!(this.secretId && this.secretKey)
    if (!useSDK && mode !== 'SubmitHunyuanTo3DProJob') {
      throw new Error(
        '[Hunyuan3D] 当前选择的官方接口需要在设置中配置腾讯云 SecretId 和 SecretKey。'
      )
    }

    const loadedImageAttachments =
      imageAttachments.length > 0
        ? await Promise.all(
            imageAttachments.slice(0, 8).map((attachment) => loadImageAttachment(attachment))
          )
        : []
    const primaryLoadedImage = loadedImageAttachments[0]
    const multiViewLoadedImages = loadedImageAttachments.slice(1)

    if (mode === 'SubmitHunyuanTo3DProJob') {
      assertValidProReferenceImages(primaryLoadedImage, multiViewLoadedImages)
    }

    if (mode === 'SubmitHunyuanTo3DRapidJob') {
      assertValidRapidReferenceImage(primaryLoadedImage)
    }

    if (mode === 'SubmitTextureTo3DJob') {
      assertValidTextureReferenceImages(primaryLoadedImage, multiViewLoadedImages)
    }

    if (mode === 'SubmitProfileTo3DJob') {
      assertValidProfileReferenceImage(primaryLoadedImage)
    }

    const primaryImagePayload = buildPrimaryImagePayload(primaryLoadedImage)
    const multiViewImages = buildMultiViewImages(multiViewLoadedImages)

    if (mode === 'SubmitHunyuanTo3DProJob') {
      assertValidProOptions(
        promptText,
        normalizedModel,
        normalizedGenerateType,
        normalizedFaceCount,
        multiViewImages
      )
    }

    if (mode === 'SubmitHunyuanTo3DRapidJob') {
      assertValidRapidOptions(
        promptText,
        normalizedGenerateType,
        String(options.TargetFormat || '').toUpperCase()
      )
    }

    if (mode === 'SubmitTextureTo3DJob') {
      assertValidTextureOptions(normalizedModel, multiViewImages)
    }

    let modelPublicUrl = ''
    if (needsModel) {
      const urlsInMessage = lastUserMessage?.content?.match(/https?:\/\/[^\s]+/g) || []
      modelPublicUrl = urlsInMessage.find((url) => isResultFileUrl(url)) || urlsInMessage[0] || ''
      if (!modelPublicUrl) {
        throw new Error('[Hunyuan3D] 该模式需要公开可访问的 3D 模型 URL。')
      }
    }

    let jobId: string | undefined
    let ai3dClient: HunyuanAi3dClient | undefined
    const restBaseUrl = resolveAi3dRestBaseUrl(this.baseURL)

    if (useSDK) {
      const Ai3dClient = tencentcloud.ai3d.v20250513.Client
      ai3dClient = new Ai3dClient({
        credential: { secretId: this.secretId, secretKey: this.secretKey },
        region: this.region,
        profile: { httpProfile: { endpoint: 'ai3d.tencentcloudapi.com' } }
      })

      if (!getTencentSdkMethod(ai3dClient, mode)) {
        throw new Error(`[Hunyuan3D] 不支持的接口: ${mode}`)
      }

      let payload: Record<string, unknown> = {}
      let sdkInputTypeHint = ''
      const normalizedPolygonType = POLYGON_TYPES.has(String(options.PolygonType || ''))
        ? String(options.PolygonType)
        : 'triangle'
      const normalizedFaceLevel = FACE_LEVEL_TYPES.has(
        String(options.FaceLevel || '').toLowerCase()
      )
        ? String(options.FaceLevel).toLowerCase()
        : 'low'
      const normalizedProfileTemplate = PROFILE_TEMPLATES.has(String(options.ProfileTemplate || ''))
        ? String(options.ProfileTemplate)
        : undefined

      switch (mode) {
        case 'SubmitHunyuanTo3DProJob':
          payload = {
            ...(promptText ? { Prompt: promptText } : {}),
            ...(primaryImagePayload.url ? { ImageUrl: primaryImagePayload.url } : {}),
            ...(primaryImagePayload.base64 ? { ImageBase64: primaryImagePayload.base64 } : {}),
            Model: normalizedModel,
            GenerateType: normalizedGenerateType,
            EnablePBR: !!options.EnablePBR,
            ...(PRO_RESULT_FORMATS.has(normalizedTargetFormat)
              ? { ResultFormat: normalizedTargetFormat }
              : {}),
            ...(normalizedFaceCount && normalizedGenerateType !== 'LowPoly'
              ? { FaceCount: normalizedFaceCount }
              : {}),
            ...(normalizedGenerateType === 'LowPoly' ? { PolygonType: normalizedPolygonType } : {}),
            ...(multiViewImages.length > 0
              ? {
                  MultiViewImages: multiViewImages.map(buildViewImagePayload)
                }
              : {})
          }
          break
        case 'SubmitHunyuanTo3DRapidJob':
          if (normalizedGenerateType === 'Geometry' && normalizedTargetFormat === 'OBJ') {
            throw new Error('[Hunyuan3D] 极速版白模模式不支持 OBJ 输出格式')
          }
          payload = {
            ...(promptText ? { Prompt: promptText } : {}),
            ...(primaryImagePayload.url ? { ImageUrl: primaryImagePayload.url } : {}),
            ...(primaryImagePayload.base64 ? { ImageBase64: primaryImagePayload.base64 } : {}),
            ...(RAPID_RESULT_FORMATS.has(normalizedTargetFormat)
              ? { ResultFormat: normalizedTargetFormat }
              : {}),
            ...(normalizedGenerateType === 'Geometry' ? { EnableGeometry: true } : {}),
            ...(options.EnablePBR ? { EnablePBR: true } : {})
          }
          break
        case 'SubmitProfileTo3DJob':
          payload = {
            Profile: primaryImagePayload.url
              ? { Url: primaryImagePayload.url }
              : { Base64: primaryImagePayload.base64 || '' },
            ...(normalizedProfileTemplate ? { Template: normalizedProfileTemplate } : {})
          }
          break
        case 'SubmitTextureTo3DJob': {
          const textureInputType = await assertSupportedFileType(
            modelPublicUrl,
            sourceFileName,
            TEXTURE_INPUT_TYPES,
            '纹理生成'
          )
          sdkInputTypeHint = textureInputType
          if (!hasExplicitTargetFormat) {
            normalizedTargetFormat = textureInputType
          }
          payload = {
            File3D: {
              Url: modelPublicUrl,
              Type: textureInputType
            },
            Model: normalizedModel,
            ...(promptText ? { Prompt: promptText } : {}),
            ...(primaryImagePayload.url ? { Image: { Url: primaryImagePayload.url } } : {}),
            ...(primaryImagePayload.base64
              ? { Image: { Base64: primaryImagePayload.base64 } }
              : {}),
            ...(multiViewImages.length > 0
              ? {
                  MultiViewImages: multiViewImages.map(buildViewImagePayload)
                }
              : {}),
            EnablePBR: !!options.EnablePBR
          }

          break
        }
        case 'SubmitReduceFaceJob': {
          const reduceFaceInputType = await assertSupportedFileType(
            modelPublicUrl,
            sourceFileName,
            REDUCE_FACE_INPUT_TYPES,
            '智能拓扑'
          )
          sdkInputTypeHint = reduceFaceInputType
          if (!hasExplicitTargetFormat) {
            normalizedTargetFormat = reduceFaceInputType
          }
          payload = {
            File3D: {
              Url: modelPublicUrl,
              Type: reduceFaceInputType
            },
            FaceLevel: normalizedFaceLevel,
            PolygonType: normalizedPolygonType
          }
          break
        }
        case 'SubmitHunyuanTo3DUVJob': {
          const uvInputType = await assertSupportedFileType(
            modelPublicUrl,
            sourceFileName,
            UV_INPUT_TYPES,
            'UV 展开'
          )
          sdkInputTypeHint = uvInputType
          if (!hasExplicitTargetFormat) {
            normalizedTargetFormat = uvInputType
          }
          payload = {
            File: {
              Url: modelPublicUrl,
              Type: uvInputType
            }
          }
          break
        }
        case 'SubmitHunyuan3DPartJob': {
          const partInputType = await assertSupportedFileType(
            modelPublicUrl,
            sourceFileName,
            PART_INPUT_TYPES,
            '组件拆分'
          )
          sdkInputTypeHint = partInputType
          if (!hasExplicitTargetFormat) {
            normalizedTargetFormat = partInputType
          }
          payload = {
            Model: PART_MODEL,
            File: {
              Url: modelPublicUrl,
              Type: partInputType
            }
          }
          break
        }
        case 'Convert3DFormat': {
          const convert3DFormat = getTencentSdkMethod<HunyuanAi3dConvertResponse>(
            ai3dClient,
            'Convert3DFormat'
          )
          if (!convert3DFormat) {
            throw new Error('[Hunyuan3D] 不支持的接口: Convert3DFormat')
          }
          sdkInputTypeHint = await assertSupportedFileType(
            modelPublicUrl,
            sourceFileName,
            CONVERT_INPUT_TYPES,
            '格式转换'
          )
          let response: HunyuanAi3dConvertResponse
          try {
            response = await callTencentSdkWithRetry(
              'Convert3DFormat submit',
              () =>
                convert3DFormat({
                  File3D: modelPublicUrl,
                  Format: CONVERT_OUTPUT_TYPES.has(normalizedTargetFormat)
                    ? normalizedTargetFormat
                    : 'STL'
                }),
              SDK_SUBMIT_RETRY_DELAYS_MS
            )
          } catch (error) {
            throw wrapRetryableTencentSdkError(mode, 'submit', error, SDK_SUBMIT_RETRY_DELAYS_MS, {
              inputType: sdkInputTypeHint
            })
          }
          if (response.ResultFile3D) {
            const resultType = normalizeResultType(
              normalizedTargetFormat || inferFileType(response.ResultFile3D)
            )
            return formatResultArtifact({
              kind: inferResultArtifactKind(response.ResultFile3D, resultType),
              type: resultType,
              url: response.ResultFile3D
            })
          }
          throw new Error('[Hunyuan3D] 模型格式转换失败，未返回下载地址')
        }
        default:
          throw new Error(`[Hunyuan3D] 不支持的接口: ${mode}`)
      }

      const submitMethod = getTencentSdkMethod<HunyuanAi3dSubmitResponse>(ai3dClient, mode)
      if (!submitMethod) {
        throw new Error(`[Hunyuan3D] 不支持的接口: ${mode}`)
      }
      let response: HunyuanAi3dSubmitResponse
      try {
        response = await callTencentSdkWithRetry(
          `${mode} submit`,
          () => submitMethod(payload),
          SDK_SUBMIT_RETRY_DELAYS_MS
        )
      } catch (error) {
        throw wrapRetryableTencentSdkError(mode, 'submit', error, SDK_SUBMIT_RETRY_DELAYS_MS, {
          inputType: sdkInputTypeHint
        })
      }
      jobId = response.JobId
    } else {
      const submitPayload = {
        ...(promptText ? { Prompt: promptText } : {}),
        ...(primaryImagePayload.url ? { ImageUrl: primaryImagePayload.url } : {}),
        ...(primaryImagePayload.base64 ? { ImageBase64: primaryImagePayload.base64 } : {}),
        ...(multiViewImages.length > 0
          ? {
              MultiViewImages: multiViewImages.map(buildViewImagePayload)
            }
          : {}),
        GenerateType: normalizedGenerateType,
        EnablePBR: !!options.EnablePBR,
        ...(normalizedModel ? { Model: normalizedModel } : {}),
        ...(PRO_RESULT_FORMATS.has(normalizedTargetFormat)
          ? { ResultFormat: normalizedTargetFormat }
          : {}),
        ...(normalizedFaceCount && normalizedGenerateType !== 'LowPoly'
          ? { FaceCount: normalizedFaceCount }
          : {}),
        ...(normalizedGenerateType === 'LowPoly'
          ? {
              PolygonType: POLYGON_TYPES.has(String(options.PolygonType || ''))
                ? options.PolygonType
                : 'triangle'
            }
          : {})
      }

      const submitEndpoint = `${restBaseUrl}/submit`
      const submitResp = await ai3dRequest<HunyuanSubmitResp>(
        submitEndpoint,
        submitPayload,
        this.apiKey
      )

      assertNoApiError(submitResp.Response)
      jobId = submitResp.Response?.JobId
    }

    if (!jobId) {
      throw new Error('[Hunyuan3D] 未返回任务 ID')
    }

    const queryModeMap: Record<string, string> = {
      SubmitHunyuanTo3DProJob: 'QueryHunyuanTo3DProJob',
      SubmitHunyuanTo3DRapidJob: 'QueryHunyuanTo3DRapidJob',
      SubmitHunyuan3DPartJob: 'QueryHunyuan3DPartJob',
      SubmitTextureTo3DJob: 'DescribeTextureTo3DJob',
      SubmitReduceFaceJob: 'DescribeReduceFaceJob',
      SubmitHunyuanTo3DUVJob: 'DescribeHunyuanTo3DUVJob',
      SubmitProfileTo3DJob: 'DescribeProfileTo3DJob'
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await delay(POLL_INTERVAL_MS)

      if (useSDK) {
        const queryMode = queryModeMap[mode]
        const queryMethod =
          queryMode && ai3dClient
            ? getTencentSdkMethod<HunyuanAi3dQueryResponse>(ai3dClient, queryMode)
            : null
        if (!queryMode || !queryMethod) {
          throw new Error(`[Hunyuan3D] 找不到对应的查询接口: ${queryMode || mode}`)
        }

        let sdkQueryResp: HunyuanAi3dQueryResponse
        try {
          sdkQueryResp = await callTencentSdkWithRetry(
            `${queryMode} query`,
            () => queryMethod({ JobId: jobId }),
            SDK_QUERY_RETRY_DELAYS_MS
          )
        } catch (error) {
          throw wrapRetryableTencentSdkError(mode, 'query', error, SDK_QUERY_RETRY_DELAYS_MS)
        }
        const status = getJobStatus({
          JobStatus: sdkQueryResp.JobStatus,
          Status: sdkQueryResp.Status
        })

        if (isFailureStatus(status)) {
          const code = sdkQueryResp.ErrorCode || sdkQueryResp.JobErrorCode || 'Unknown'
          const message = sdkQueryResp.ErrorMessage || sdkQueryResp.JobErrorMessage || '任务失败'
          throw new Error(
            withRequestId(
              `[Hunyuan3D] Job failed: ${code} ${message}`.trim(),
              (sdkQueryResp as { RequestId?: string }).RequestId
            )
          )
        }

        if (isSuccessStatus(status)) {
          const resultArtifacts = extractResultArtifacts(
            {
              ResultFile3Ds: sdkQueryResp.ResultFile3Ds,
              ResultFiles: sdkQueryResp.ResultFiles,
              ResultUrl: sdkQueryResp.ResultUrl,
              FileUrl: sdkQueryResp.FileUrl,
              DownloadUrl: sdkQueryResp.DownloadUrl,
              Url: sdkQueryResp.Url
            },
            normalizedTargetFormat
          )
          if (resultArtifacts.length === 0) {
            throw new Error(
              '[Hunyuan3D] Job completed, but no downloadable result file was returned.'
            )
          }
          logQuerySuccessArtifacts(
            mode,
            'sdk',
            {
              ResultFile3Ds: sdkQueryResp.ResultFile3Ds,
              ResultFiles: sdkQueryResp.ResultFiles,
              ResultUrl: sdkQueryResp.ResultUrl,
              FileUrl: sdkQueryResp.FileUrl,
              DownloadUrl: sdkQueryResp.DownloadUrl,
              Url: sdkQueryResp.Url
            },
            resultArtifacts
          )
          return formatSuccessResponse(mode, resultArtifacts, {
            ResultCreditDetails: (sdkQueryResp as HunyuanQueryDiagnostics).ResultCreditDetails,
            ResultCreditConsumed: (sdkQueryResp as HunyuanQueryDiagnostics).ResultCreditConsumed
          })
        }
      } else {
        const queryEndpoint = `${restBaseUrl}/query`
        const queryResp = await ai3dRequest<HunyuanQueryResp>(
          queryEndpoint,
          { JobId: jobId },
          this.apiKey
        )

        assertNoApiError(queryResp.Response)
        const status = getJobStatus(queryResp.Response)

        if (isFailureStatus(status)) {
          const code =
            queryResp.Response?.JobErrorCode || queryResp.Response?.ErrorCode || 'Unknown'
          const message =
            queryResp.Response?.JobErrorMessage || queryResp.Response?.ErrorMessage || 'Task failed'
          throw new Error(
            withRequestId(
              `[Hunyuan3D] Job failed: ${code} ${message}`.trim(),
              queryResp.Response?.RequestId
            )
          )
        }

        if (isSuccessStatus(status)) {
          const resultArtifacts = extractResultArtifacts(queryResp.Response, normalizedTargetFormat)
          if (resultArtifacts.length === 0) {
            throw new Error(
              '[Hunyuan3D] Job completed, but no downloadable result file was returned.'
            )
          }
          logQuerySuccessArtifacts(mode, 'rest', queryResp.Response, resultArtifacts)
          return formatSuccessResponse(mode, resultArtifacts, queryResp.Response)
        }
      }
    }

    throw new Error('[Hunyuan3D] Job timed out. Please retry later.')
  }
}

const RESULT_FILE_KEY_PATTERNS = [
  /^https?:\/\/.+$/,
  /^data:/,
  /^local-media:\/\//,
  /^file:\/\//
] as const

const isResultFileUrl = (value: string): boolean =>
  typeof value === 'string' && RESULT_FILE_KEY_PATTERNS.some((pattern) => pattern.test(value))

const getResultFileExtension = (url: string): string => {
  const hintedFileName = getFileNameHintFromUrl(url)
  if (hintedFileName) {
    return path.extname(hintedFileName).toLowerCase()
  }

  try {
    return path.extname(new URL(url).pathname).toLowerCase()
  } catch {
    return path.extname(url).toLowerCase()
  }
}

const formatResultArtifact = (artifact: HunyuanResultArtifact): string => {
  const normalizedType = String(artifact.type || '')
    .trim()
    .toUpperCase()
  const extension = getResultFileExtension(artifact.url)

  switch (artifact.kind) {
    case 'model3d':
      if (normalizedType === 'OBJ' && extension !== '.obj') {
        return `[Generated OBJ Package.zip](${artifact.url})`
      }
      return `[Generated 3D Model](${artifact.url})`
    case 'video':
      return `[Generated Video](${artifact.url})`
    case 'image':
      return `![Generated ${IMAGE_RESULT_FILE_EXTENSIONS.has(extension) ? extension.replace('.', '').toUpperCase() : normalizedType || 'IMAGE'}](${artifact.url})`
    default:
      if (normalizedType === 'OBJ' && extension !== '.obj') {
        return `[Generated OBJ Package.zip](${artifact.url})`
      }
      return `[Generated File](${artifact.url})`
  }
}

const inferResultArtifactKind = (url: string, type?: string): HunyuanResultArtifactKind => {
  const extension = getResultFileExtension(url)

  if (VIDEO_RESULT_FILE_EXTENSIONS.has(extension)) {
    return 'video'
  }
  if (IMAGE_RESULT_FILE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (FILE_RESULT_FILE_EXTENSIONS.has(extension)) {
    return 'file'
  }

  if (type) {
    const normalizedType = type.toLowerCase()
    if (VIDEO_RESULT_TYPES.has(type.toUpperCase())) return 'video'
    if (IMAGE_RESULT_TYPES.has(type.toUpperCase())) return 'image'
    if (FILE_RESULT_TYPES.has(type.toUpperCase())) return 'file'
    if (normalizedType === 'obj') {
      return getResultFileExtension(url) === '.obj' ? 'model3d' : 'file'
    }
    if (DIRECT_MODEL_RESULT_TYPES.has(type.toUpperCase())) {
      return 'model3d'
    }
  }

  if (MODEL_RESULT_FILE_EXTENSIONS.has(extension)) {
    return 'model3d'
  }
  return 'model3d'
}

const normalizeRequestedResultType = (
  mode: string,
  requestedType: string,
  preflightModelUrl: string,
  sourceFileName: string
): string => {
  const normalizedRequestedType = String(requestedType || '')
    .trim()
    .toUpperCase()
  if (normalizedRequestedType && normalizedRequestedType !== 'DEFAULT') {
    return normalizedRequestedType
  }

  if (
    [
      'SubmitHunyuanTo3DProJob',
      'SubmitTextureTo3DJob',
      'SubmitProfileTo3DJob',
      'SubmitHunyuan3DRapidJob'
    ].includes(mode)
  ) {
    return 'GLB'
  }

  if (['SubmitReduceFaceJob', 'SubmitHunyuanTo3DUVJob'].includes(mode)) {
    const inferredFromSource = inferModelInputType(preflightModelUrl, sourceFileName)
    if (inferredFromSource) {
      return inferredFromSource
    }
    return 'OBJ'
  }

  return 'STL'
}

const normalizeResultType = (resultType: string | undefined): string => {
  const normalizedType = String(resultType || '')
    .trim()
    .toUpperCase()
  if (KNOWN_RESULT_TYPES.has(normalizedType.toLowerCase())) {
    return normalizedType
  }

  return 'UNKNOWN'
}

const extractResultArtifacts = (
  response:
    | HunyuanQueryResp['Response']
    | {
        ResultFile3Ds?: unknown
        ResultFiles?: unknown
        ResultUrl?: unknown
        FileUrl?: unknown
        DownloadUrl?: unknown
        Url?: unknown
      },
  targetType: string
): HunyuanResultArtifact[] => {
  const normalizedTargetType = normalizeResultType(targetType)
  const artifacts: HunyuanResultArtifact[] = []

  const pushArtifact = (
    url: unknown,
    kindHint?: HunyuanResultArtifactKind,
    resultTypeHint?: unknown
  ) => {
    if (typeof url !== 'string' || !url.trim()) {
      return
    }

    const normalizedResultType = normalizeResultType(
      typeof resultTypeHint === 'string' ? resultTypeHint : normalizedTargetType
    )
    const typeHint =
      kindHint === 'image' ? 'image' : inferResultArtifactKind(url, normalizedResultType)
    artifacts.push({
      kind: kindHint || typeHint,
      type: normalizedResultType,
      url
    })
  }

  if (Array.isArray(response?.ResultFile3Ds)) {
    response.ResultFile3Ds.forEach((item: HunyuanAi3dResultFile) => {
      if (item && item.Url && typeof item.Url === 'string') {
        if (isResultFileUrl(item.Url) || isResultFileType(item.Type)) {
          pushArtifact(item.Url, undefined, item.Type)
        }
      }
    })
  }

  if (Array.isArray(response?.ResultFiles)) {
    response.ResultFiles.forEach((item: HunyuanAi3dResultFile) => {
      if (!item || typeof item.Url !== 'string') {
        return
      }
      pushArtifact(item.Url, undefined, item.Type)
    })
  }

  const firstLevelArtifactFields = [
    response?.ResultUrl,
    response?.FileUrl,
    response?.DownloadUrl,
    response?.Url
  ]

  firstLevelArtifactFields.forEach((url) => pushArtifact(url))

  return artifacts
}

const isResultFileType = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false
  }

  if (value.trim() === 'IMAGE') return true

  const normalizedType = value.trim().toUpperCase()
  if (!KNOWN_RESULT_TYPES.has(normalizedType.toLowerCase())) {
    return false
  }
  return true
}

const getFileNameHintFromUrlSafe = (url: string): string =>
  String(getFileNameHintFromUrl(url) || '').trim()

const getLastUserMessage = (messages: ChatMessage[]): ChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]
    }
  }
  return undefined
}

const getImageAttachments = (message: ChatMessage | undefined): ChatAttachment[] =>
  message?.attachments?.filter((attachment) => isImageAttachment(attachment)) || []

const isImageAttachment = (attachment: ChatAttachment): boolean => {
  if (!attachment?.url) {
    return false
  }

  if (attachment.type === 'image' || /^data:image\//i.test(attachment.url)) {
    return true
  }

  if (/\.(png|jpg|jpeg|webp|gif)(?:[?#].*)?$/i.test(attachment.url)) {
    return true
  }

  const mimeType = normalizeMimeType(attachment.mimeType || '')
  if (mimeType.startsWith('image/')) {
    return true
  }

  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].some(
    (ext) =>
      attachment.url.toLowerCase().endsWith(ext) ||
      String(attachment.fileName || '')
        .toLowerCase()
        .endsWith(ext)
  )
}

const stripModelUrlFromPrompt = (value: string): string =>
  (value || '').replace(/https?:\/\/[^\s]+/g, '').trim()

const isRemoteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value)

const resolveAi3dRestBaseUrl = (baseURL: string): string => {
  const normalized = baseURL.trim().replace(/\/+$/, '')
  if (/\/v1\/ai3d$/i.test(normalized)) {
    return normalized
  }
  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/ai3d`
  }
  return `${normalized}/v1/ai3d`
}

const ai3dClient = new Hunyuan3DClient(
  process.env.HUNYUAN_AI3D_API_KEY || '',
  process.env.HUNYUAN_AI3D_API_URL || 'https://api.hunyuan.cloud.tencent.com/v1',
  process.env.HUNYUAN_AI3D_SECRET_ID || '',
  process.env.HUNYUAN_AI3D_SECRET_KEY || '',
  process.env.HUNYUAN_AI3D_REGION || ''
)

export const isTextureJobMode = (mode: string): boolean => mode === 'SubmitTextureTo3DJob'

export const createHunyuan3DClient = () => ai3dClient
