export const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'

const decodeHy3dProfileSegment = (value?: string): string => {
  if (!value) return ''

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export type Hy3dProfileExtras = {
  sourceFileName?: string
}

export const parseHy3dProfileExtras = (segments: string[]): Hy3dProfileExtras => {
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

    if (key === 'source') {
      extras.sourceFileName = value
    }
  }

  return extras
}

export const normalizeConfiguredSecret = (value?: string): string => String(value || '').trim()

type Hunyuan3DErrorContext = {
  mode?: string
  sourceFileName?: string
}

const isHunyuanGenericServiceFailure = (message: string): boolean =>
  /(?:\[Hunyuan3D\]\s*)?(?:Job failed:\s*)?(?:FailedOperation\.)?InnerError|InternalServerError|ServiceUnavailable|An internal error has occurred|Retry your request/i.test(
    message
  )

const buildHunyuanUvGlbHint = (context?: Hunyuan3DErrorContext): string => {
  if (context?.mode !== 'SubmitHunyuanTo3DUVJob') {
    return ''
  }

  const sourceFileName = String(context.sourceFileName || '')
    .trim()
    .toLowerCase()
  if (!sourceFileName.endsWith('.glb')) {
    return ''
  }

  return ' Current input is GLB; if UV unwrap keeps failing, convert it to FBX first and retry UV unwrap.'
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

const buildHunyuanGenericFailureMessage = (traceSuffix: string, uvGlbHint: string): string =>
  `[Hunyuan3D] Tencent 3D service is temporarily unavailable and the job failed. Please retry later.${uvGlbHint}${traceSuffix}`.trim()

export const normalizeHunyuan3DError = (error: unknown, context?: Hunyuan3DErrorContext): Error => {
  const fallback =
    error instanceof Error
      ? error
      : new Error(typeof error === 'object' ? JSON.stringify(error) : String(error))
  const message = fallback.message || ''
  const traceSuffix = extractTencentTraceSuffix(message)
  const uvGlbHint = buildHunyuanUvGlbHint(context)

  if (message.startsWith('[Hunyuan3D]') && !isHunyuanGenericServiceFailure(message)) {
    return fallback
  }

  if (isHunyuanGenericServiceFailure(message)) {
    return new Error(buildHunyuanGenericFailureMessage(traceSuffix, uvGlbHint))
  }

  if (
    /AuthFailure\.SecretIdNotFound|The SecretId is not found|InvalidAccessKeyId|Access Key Id you provided does not exist in our records/i.test(
      message
    )
  ) {
    return new Error(
      `[Hunyuan3D] The configured Tencent Cloud SecretId is invalid or has expired. Check the current SecretId/SecretKey pair and retry.${traceSuffix}`.trim()
    )
  }

  if (
    /AuthFailure\.SignatureFailure|The SecretKey is not found|SignatureDoesNotMatch|The request signature we calculated does not match|signature/i.test(
      message
    )
  ) {
    return new Error(
      `[Hunyuan3D] The configured Tencent Cloud SecretKey is invalid or does not match the SecretId. Check the current SecretId/SecretKey pair and retry.${traceSuffix}`.trim()
    )
  }

  if (
    /TencentCloudSDKException|An internal error has occurred|InternalError|InternalServerError|ServiceUnavailable|Retry your request/i.test(
      message
    )
  ) {
    return new Error(buildHunyuanGenericFailureMessage(traceSuffix, uvGlbHint))
  }

  return fallback
}
