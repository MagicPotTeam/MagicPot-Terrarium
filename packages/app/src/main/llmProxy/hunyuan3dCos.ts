import COS from 'cos-nodejs-sdk-v5'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

const DEFAULT_SIGNED_URL_EXPIRES_SECONDS = 24 * 60 * 60
const DEFAULT_KEY_PREFIX = 'magicpot/hunyuan3d'
const MULTIPART_SLICE_SIZE = 8 * 1024 * 1024

type Hy3dCosCredentials = {
  secretId: string
  secretKey: string
}

type Hy3dCosTarget = {
  bucket: string
  region: string
  keyPrefix?: string
}

export type Hy3dSignedModel = {
  url: string
  expiresAt: string
}

export type Hy3dUploadedModel = Hy3dSignedModel & {
  key: string
  bucket: string
  region: string
  fileName: string
}

export type Hy3dClearedPrefix = {
  bucket: string
  region: string
  keyPrefix: string
  matchedCount: number
  deletedCount: number
  errorCount: number
}

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '')

const sanitizePrefix = (value?: string): string => {
  const sanitized = trimSlashes(value?.trim() || '')
  return sanitized || DEFAULT_KEY_PREFIX
}

const sanitizeFileName = (fileName: string): string => {
  const ext = path.extname(fileName).toLowerCase()
  const baseName = path.basename(fileName, ext)
  const safeBase = baseName
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  const safeExt = ext.replace(/[^.\w-]+/g, '')
  return `${safeBase || 'model'}${safeExt}`
}

const buildObjectKey = (fileName: string, keyPrefix?: string): string => {
  const now = new Date()
  const y = String(now.getFullYear())
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const timestamp = `${y}${m}${d}-${String(now.getTime())}`
  const safeName = sanitizeFileName(fileName)
  return [
    sanitizePrefix(keyPrefix),
    y,
    m,
    d,
    `${timestamp}-${randomUUID().slice(0, 8)}-${safeName}`
  ]
    .filter(Boolean)
    .join('/')
}

const buildExpiresAt = (expiresInSeconds: number): string =>
  new Date(Date.now() + expiresInSeconds * 1000).toISOString()

const createCosClient = (credentials: Hy3dCosCredentials): COS =>
  new COS({
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey
  })

const assertCosTarget = (
  credentials: Hy3dCosCredentials,
  target: Hy3dCosTarget
): { bucket: string; region: string; keyPrefix: string } => {
  if (!credentials.secretId || !credentials.secretKey) {
    throw new Error('[Hunyuan3D] Missing Tencent Cloud SecretId or SecretKey.')
  }
  if (!target.bucket || !target.region) {
    throw new Error('[Hunyuan3D] Missing COS bucket or region.')
  }

  return {
    bucket: target.bucket.trim(),
    region: target.region.trim(),
    keyPrefix: sanitizePrefix(target.keyPrefix)
  }
}

const listAllKeysForPrefix = async (
  cos: COS,
  bucket: string,
  region: string,
  keyPrefix: string
): Promise<string[]> => {
  const prefix = keyPrefix ? `${keyPrefix}/` : ''
  const keys: string[] = []
  let marker: string | undefined

  while (true) {
    const response = await cos.getBucket({
      Bucket: bucket,
      Region: region,
      Prefix: prefix,
      Marker: marker,
      MaxKeys: 1000
    })

    const batchKeys = (response.Contents || [])
      .map((item) => item?.Key)
      .filter((item): item is string => typeof item === 'string' && item.length > 0)

    keys.push(...batchKeys)

    if (String(response.IsTruncated).toLowerCase() !== 'true') {
      break
    }

    marker = response.NextMarker || batchKeys[batchKeys.length - 1]
    if (!marker) {
      break
    }
  }

  return keys
}

const assertCosConfig = (
  credentials: Hy3dCosCredentials,
  target: Hy3dCosTarget,
  key?: string
): { bucket: string; region: string; key: string } => {
  if (!credentials.secretId || !credentials.secretKey) {
    throw new Error('[Hunyuan3D] 请先在设置中填写腾讯云 SecretId 和 SecretKey。')
  }
  if (!target.bucket || !target.region) {
    throw new Error('[Hunyuan3D] 请先在设置中填写 COS Bucket 和 Region。')
  }
  if (!key) {
    throw new Error('[Hunyuan3D] 缺少已上传模型的 COS Key。')
  }
  return {
    bucket: target.bucket.trim(),
    region: target.region.trim(),
    key: trimSlashes(key)
  }
}

const assertKeyWithinConfiguredPrefix = (key: string, keyPrefix?: string): void => {
  const normalizedKey = trimSlashes(key)
  const normalizedPrefix = sanitizePrefix(keyPrefix)
  const allowedPrefix = `${normalizedPrefix}/`

  if (normalizedKey === normalizedPrefix || normalizedKey.startsWith(allowedPrefix)) {
    return
  }

  throw new Error('[Hunyuan3D] Refusing to access a COS object outside the configured prefix.')
}

export const signHy3dCosModel = (
  credentials: Hy3dCosCredentials,
  target: Hy3dCosTarget,
  key: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRES_SECONDS
): Hy3dSignedModel => {
  const resolved = assertCosConfig(credentials, target, key)
  assertKeyWithinConfiguredPrefix(resolved.key, target.keyPrefix)
  const cos = createCosClient(credentials)
  const url = cos.getObjectUrl({
    Bucket: resolved.bucket,
    Region: resolved.region,
    Key: resolved.key,
    Sign: true,
    Expires: expiresInSeconds,
    Protocol: 'https:'
  })

  return {
    url,
    expiresAt: buildExpiresAt(expiresInSeconds)
  }
}

export const uploadLocalHy3dModel = async (
  credentials: Hy3dCosCredentials,
  target: Hy3dCosTarget,
  filePath: string
): Promise<Hy3dUploadedModel> => {
  if (!filePath) {
    throw new Error('[Hunyuan3D] 未选择本地模型文件。')
  }

  const absolutePath = path.resolve(filePath)
  const stat = await fs.stat(absolutePath).catch(() => null)
  if (!stat?.isFile()) {
    throw new Error('[Hunyuan3D] 选择的本地模型文件不存在。')
  }

  const fileName = path.basename(absolutePath)
  const key = buildObjectKey(fileName, target.keyPrefix)
  const resolved = assertCosConfig(credentials, target, key)
  const cos = createCosClient(credentials)

  await cos.uploadFile({
    Bucket: resolved.bucket,
    Region: resolved.region,
    Key: resolved.key,
    FilePath: absolutePath,
    SliceSize: MULTIPART_SLICE_SIZE
  })

  return {
    ...signHy3dCosModel(credentials, target, resolved.key),
    key: resolved.key,
    bucket: resolved.bucket,
    region: resolved.region,
    fileName
  }
}

export const uploadBufferedHy3dModel = async (
  credentials: Hy3dCosCredentials,
  target: Hy3dCosTarget,
  fileName: string,
  body: Buffer
): Promise<Hy3dUploadedModel> => {
  if (!fileName || !body?.length) {
    throw new Error('[Hunyuan3D] 缺少可上传的模型文件内容。')
  }

  const key = buildObjectKey(fileName, target.keyPrefix)
  const resolved = assertCosConfig(credentials, target, key)
  const cos = createCosClient(credentials)

  await cos.putObject({
    Bucket: resolved.bucket,
    Region: resolved.region,
    Key: resolved.key,
    Body: body,
    ContentLength: body.length
  })

  return {
    ...signHy3dCosModel(credentials, target, resolved.key),
    key: resolved.key,
    bucket: resolved.bucket,
    region: resolved.region,
    fileName
  }
}

export const clearHy3dCosPrefix = async (
  credentials: Hy3dCosCredentials,
  target: Hy3dCosTarget
): Promise<Hy3dClearedPrefix> => {
  const resolved = assertCosTarget(credentials, target)
  const cos = createCosClient(credentials)
  const keys = await listAllKeysForPrefix(cos, resolved.bucket, resolved.region, resolved.keyPrefix)

  let deletedCount = 0
  let errorCount = 0

  for (let index = 0; index < keys.length; index += 1000) {
    const batchKeys = keys.slice(index, index + 1000)
    if (batchKeys.length === 0) {
      continue
    }

    const result = await cos.deleteMultipleObject({
      Bucket: resolved.bucket,
      Region: resolved.region,
      Objects: batchKeys.map((key) => ({ Key: key }))
    })

    deletedCount += result.Deleted?.length || 0
    errorCount += result.Error?.length || 0
  }

  return {
    bucket: resolved.bucket,
    region: resolved.region,
    keyPrefix: resolved.keyPrefix,
    matchedCount: keys.length,
    deletedCount,
    errorCount
  }
}
