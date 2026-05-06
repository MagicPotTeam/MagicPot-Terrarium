export const DEFAULT_CANVAS_MODEL3D_SESSION_KEY = 'canvas:model3d:default'
const SCENE_INSTANCE_CLONE_CACHE_SCHEMA_VERSION = 'render-v4'

export const getSceneInstanceCloneTextureSignature = (textures?: Record<string, string>) => {
  if (!textures || Object.keys(textures).length === 0) {
    return 'no-textures'
  }

  return Object.entries(textures)
    .sort(([nameA], [nameB]) => nameA.localeCompare(nameB))
    .map(([name, url]) => `${name}:${url}`)
    .join('|')
}

export const getSceneInstanceCloneAssetSignature = ({
  src,
  fileName,
  itemId,
  textures
}: {
  src?: string
  fileName?: string
  itemId?: string
  textures?: Record<string, string>
}) => {
  const normalizedSrc = src?.trim()
  const normalizedFileName = fileName?.trim()
  const normalizedItemId = itemId?.trim()
  const modelIdentity =
    normalizedSrc ||
    (normalizedFileName ? `file:${normalizedFileName}` : undefined) ||
    (normalizedItemId ? 'unknown-model' : 'unknown-model')

  return `${SCENE_INSTANCE_CLONE_CACHE_SCHEMA_VERSION}:${modelIdentity}:${getSceneInstanceCloneTextureSignature(textures)}`
}

export const getSceneInstanceCloneCacheKey = ({
  sessionKey,
  src,
  fileName,
  itemId,
  textures
}: {
  sessionKey: string
  src?: string
  fileName?: string
  itemId: string
  textures?: Record<string, string>
}) =>
  `${sessionKey}:${getSceneInstanceCloneAssetSignature({
    src,
    fileName,
    itemId,
    textures
  })}`
