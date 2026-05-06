import * as THREE from 'three'

import type { ModelBounds } from './modelLoaders/shared'
import {
  configureModelSceneRendererForDisplay,
  createModelSceneEnvironmentResources,
  measureSceneDataLayout,
  tuneLoadedModelSceneForDisplay
} from './modelLoaders/shared'
import { readCachedSceneInstanceClone } from './modelLoaders/sceneInstanceCloneCache'
import {
  CANVAS_3D_STAGE_PREVIEW_LIGHTING_CONFIG,
  CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION
} from './canvas3DStagePresentation'

const CANVAS_3D_STAGE_PREVIEW_TEXTURE_SIZE = 192
const CANVAS_3D_STAGE_PREVIEW_TEXTURE_CACHE_LIMIT = 48
const MIN_PREVIEW_RATIO = 0.24
const MAX_PREVIEW_RATIO = 1
const PREVIEW_FILL_RATIO = 0.92
const PREVIEW_MIN_EXTENT = 0.001

type Canvas3DStagePreviewTextureCacheEntry = {
  texture: THREE.Texture | null
  promise: Promise<THREE.Texture | null> | null
  lastUsedAt: number
}

type Canvas3DStagePreviewShape = {
  widthRatio: number
  heightRatio: number
  depthRatio: number
}

const canvas3DStagePreviewTextureCache = new Map<string, Canvas3DStagePreviewTextureCacheEntry>()

const clampPreviewRatio = (value: number) =>
  Math.min(Math.max(value, MIN_PREVIEW_RATIO), MAX_PREVIEW_RATIO)

const quantizePreviewRatio = (value: number) => Math.round(value * 100) / 100

const getRenderablePreviewFootprint = (size: THREE.Vector3, rotation: [number, number, number]) => {
  const halfExtents = size.clone().multiplyScalar(0.5)
  const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation))
  const elements = rotationMatrix.elements
  const extentX =
    Math.abs(elements[0]) * halfExtents.x +
    Math.abs(elements[4]) * halfExtents.y +
    Math.abs(elements[8]) * halfExtents.z
  const extentY =
    Math.abs(elements[1]) * halfExtents.x +
    Math.abs(elements[5]) * halfExtents.y +
    Math.abs(elements[9]) * halfExtents.z
  const extentZ =
    Math.abs(elements[2]) * halfExtents.x +
    Math.abs(elements[6]) * halfExtents.y +
    Math.abs(elements[10]) * halfExtents.z

  return {
    width: Math.max(extentX * 2, PREVIEW_MIN_EXTENT),
    height: Math.max(extentY * 2, PREVIEW_MIN_EXTENT),
    depth: Math.max(extentZ * 2, PREVIEW_MIN_EXTENT)
  }
}

const touchCanvas3DStagePreviewTextureCacheEntry = (
  cacheKey: string,
  entry: Canvas3DStagePreviewTextureCacheEntry
) => {
  entry.lastUsedAt = Date.now()
  canvas3DStagePreviewTextureCache.delete(cacheKey)
  canvas3DStagePreviewTextureCache.set(cacheKey, entry)
}

const evictCanvas3DStagePreviewTextureCache = () => {
  while (
    Array.from(canvas3DStagePreviewTextureCache.values()).filter((entry) => entry.texture).length >
    CANVAS_3D_STAGE_PREVIEW_TEXTURE_CACHE_LIMIT
  ) {
    let oldestEntryKey: string | null = null
    let oldestEntryTimestamp = Number.POSITIVE_INFINITY

    for (const [cacheKey, entry] of canvas3DStagePreviewTextureCache) {
      if (!entry.texture) continue
      if (entry.lastUsedAt < oldestEntryTimestamp) {
        oldestEntryTimestamp = entry.lastUsedAt
        oldestEntryKey = cacheKey
      }
    }

    if (!oldestEntryKey) {
      break
    }

    const oldestEntry = canvas3DStagePreviewTextureCache.get(oldestEntryKey)
    oldestEntry?.texture?.dispose()
    canvas3DStagePreviewTextureCache.delete(oldestEntryKey)
  }
}

const buildPreviewCanvasTexture = (canvas: HTMLCanvasElement) => {
  const frozenCanvas = document.createElement('canvas')
  frozenCanvas.width = canvas.width
  frozenCanvas.height = canvas.height
  const context = frozenCanvas.getContext('2d')
  if (!context) {
    return null
  }

  context.clearRect(0, 0, frozenCanvas.width, frozenCanvas.height)
  context.drawImage(canvas, 0, 0)

  const texture = new THREE.CanvasTexture(frozenCanvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

const createPreviewRenderable = (
  instanceCacheKey: string,
  maxAnisotropy: number
): {
  object: THREE.Object3D
  size: THREE.Vector3
  radius: number
  dispose: () => void
} | null => {
  const sceneAsset = readCachedSceneInstanceClone(instanceCacheKey)
  if (!sceneAsset) {
    return null
  }

  const sceneLayout = measureSceneDataLayout(sceneAsset)
  if (!sceneLayout) {
    if (sceneAsset instanceof THREE.BufferGeometry) {
      sceneAsset.dispose()
    }
    return null
  }

  if (sceneAsset instanceof THREE.BufferGeometry) {
    if (!sceneAsset.attributes.normal) {
      sceneAsset.computeVertexNormals()
    }

    const material = new THREE.MeshStandardMaterial({
      color: '#cbd5e1',
      metalness: 0.22,
      roughness: 0.58
    })
    const mesh = new THREE.Mesh(sceneAsset, material)
    mesh.position.copy(sceneLayout.modelCenter).multiplyScalar(-1)

    return {
      object: mesh,
      size: sceneLayout.bounds.size,
      radius: sceneLayout.bounds.radius,
      dispose: () => {
        material.dispose()
        sceneAsset.dispose()
      }
    }
  }

  const renderObject = tuneLoadedModelSceneForDisplay(sceneAsset, {
    maxAnisotropy
  })
  renderObject.position.copy(sceneLayout.modelCenter).multiplyScalar(-1)

  return {
    object: renderObject,
    size: sceneLayout.bounds.size,
    radius: sceneLayout.bounds.radius,
    dispose: () => {}
  }
}

const renderCanvas3DStagePreviewTexture = (instanceCacheKey: string) => {
  if (typeof document === 'undefined') {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_3D_STAGE_PREVIEW_TEXTURE_SIZE
  canvas.height = CANVAS_3D_STAGE_PREVIEW_TEXTURE_SIZE

  let renderer: THREE.WebGLRenderer | null = null
  let environmentResources: ReturnType<typeof createModelSceneEnvironmentResources> | null = null

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      stencil: false
    })
    renderer.setPixelRatio(1)
    renderer.setSize(
      CANVAS_3D_STAGE_PREVIEW_TEXTURE_SIZE,
      CANVAS_3D_STAGE_PREVIEW_TEXTURE_SIZE,
      false
    )
    configureModelSceneRendererForDisplay(renderer)
    renderer.setClearColor(0x000000, 0)

    const previewRenderable = createPreviewRenderable(
      instanceCacheKey,
      renderer.capabilities.getMaxAnisotropy()
    )
    if (!previewRenderable) {
      return null
    }
    try {
      const scene = new THREE.Scene()
      environmentResources = createModelSceneEnvironmentResources(renderer)
      environmentResources.applyToScene(scene)
      scene.add(
        new THREE.AmbientLight('#ffffff', CANVAS_3D_STAGE_PREVIEW_LIGHTING_CONFIG.ambientIntensity)
      )
      scene.add(
        new THREE.HemisphereLight(
          '#ffffff',
          CANVAS_3D_STAGE_PREVIEW_LIGHTING_CONFIG.hemisphereGround,
          CANVAS_3D_STAGE_PREVIEW_LIGHTING_CONFIG.hemisphereIntensity
        )
      )

      CANVAS_3D_STAGE_PREVIEW_LIGHTING_CONFIG.directionalLights.forEach((light) => {
        const directionalLight = new THREE.DirectionalLight('#ffffff', light.intensity)
        directionalLight.position.set(...light.position)
        scene.add(directionalLight)
      })

      const previewRoot = new THREE.Group()
      previewRoot.rotation.set(
        CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION[0],
        CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION[1],
        CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION[2]
      )
      previewRoot.add(previewRenderable.object)
      scene.add(previewRoot)

      const footprint = getRenderablePreviewFootprint(
        previewRenderable.size,
        CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION
      )
      const halfWidth = Math.max(footprint.width / PREVIEW_FILL_RATIO / 2, PREVIEW_MIN_EXTENT)
      const halfHeight = Math.max(footprint.height / PREVIEW_FILL_RATIO / 2, PREVIEW_MIN_EXTENT)
      const cameraDistance = Math.max(previewRenderable.radius * 4, footprint.depth * 3, 8)
      const camera = new THREE.OrthographicCamera(
        -halfWidth,
        halfWidth,
        halfHeight,
        -halfHeight,
        0.1,
        Math.max(cameraDistance * 4, 64)
      )
      camera.position.set(0, 0, cameraDistance)
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()

      renderer.render(scene, camera)
      return buildPreviewCanvasTexture(renderer.domElement)
    } finally {
      previewRenderable.dispose()
    }
  } catch (error) {
    console.warn('[3D] Failed to render canvas preview texture', error)
    return null
  } finally {
    environmentResources?.dispose()
    renderer?.forceContextLoss?.()
    renderer?.dispose()
  }
}

export const resolveCanvas3DStagePreviewShape = (
  bounds: ModelBounds
): Canvas3DStagePreviewShape => {
  const maxExtent = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 0.001)

  return {
    widthRatio: quantizePreviewRatio(clampPreviewRatio(bounds.size.x / maxExtent)),
    heightRatio: quantizePreviewRatio(clampPreviewRatio(bounds.size.y / maxExtent)),
    depthRatio: quantizePreviewRatio(clampPreviewRatio(bounds.size.z / maxExtent))
  }
}

export const getCanvas3DStagePreviewTextureKey = ({
  instanceCacheKey,
  fileName,
  bounds
}: {
  instanceCacheKey?: string
  fileName: string
  bounds: ModelBounds | null
}) => {
  if (!instanceCacheKey || !bounds) {
    return null
  }

  const extension = fileName.toLowerCase().split('.').pop() || '3d'
  const shape = resolveCanvas3DStagePreviewShape(bounds)
  return [
    instanceCacheKey,
    extension,
    shape.widthRatio.toFixed(2),
    shape.heightRatio.toFixed(2),
    shape.depthRatio.toFixed(2)
  ].join('|')
}

export const readCanvas3DStagePreviewTexture = (cacheKey: string | null) => {
  if (!cacheKey) {
    return null
  }

  const cacheEntry = canvas3DStagePreviewTextureCache.get(cacheKey)
  if (!cacheEntry?.texture) {
    return null
  }

  touchCanvas3DStagePreviewTextureCacheEntry(cacheKey, cacheEntry)
  return cacheEntry.texture
}

export const writeCanvas3DStagePreviewTexture = ({
  cacheKey,
  texture
}: {
  cacheKey: string | null
  texture: THREE.Texture | null
}) => {
  if (!cacheKey || !texture) {
    return null
  }

  const existingEntry = canvas3DStagePreviewTextureCache.get(cacheKey)
  if (existingEntry?.texture && existingEntry.texture !== texture) {
    existingEntry.texture.dispose()
  }

  const cacheEntry: Canvas3DStagePreviewTextureCacheEntry = {
    texture,
    promise: null,
    lastUsedAt: Date.now()
  }
  touchCanvas3DStagePreviewTextureCacheEntry(cacheKey, cacheEntry)
  evictCanvas3DStagePreviewTextureCache()
  return texture
}

export const getOrCreateCanvas3DStagePreviewTexture = async ({
  cacheKey,
  instanceCacheKey
}: {
  cacheKey: string | null
  instanceCacheKey?: string
}) => {
  const existingTexture = readCanvas3DStagePreviewTexture(cacheKey)
  if (existingTexture) {
    return existingTexture
  }

  if (!cacheKey || !instanceCacheKey) {
    return null
  }

  const existingEntry = canvas3DStagePreviewTextureCache.get(cacheKey)
  if (existingEntry?.promise) {
    touchCanvas3DStagePreviewTextureCacheEntry(cacheKey, existingEntry)
    return existingEntry.promise
  }

  const previewPromise = Promise.resolve().then(() => {
    const renderedTexture = renderCanvas3DStagePreviewTexture(instanceCacheKey)
    if (renderedTexture) {
      return writeCanvas3DStagePreviewTexture({
        cacheKey,
        texture: renderedTexture
      })
    }

    const pendingEntry = canvas3DStagePreviewTextureCache.get(cacheKey)
    if (pendingEntry?.promise === previewPromise) {
      canvas3DStagePreviewTextureCache.delete(cacheKey)
    }
    return null
  })

  touchCanvas3DStagePreviewTextureCacheEntry(cacheKey, {
    texture: null,
    promise: previewPromise,
    lastUsedAt: Date.now()
  })

  return previewPromise
}

export const clearCanvas3DStagePreviewTextureCache = () => {
  for (const entry of canvas3DStagePreviewTextureCache.values()) {
    entry.texture?.dispose()
  }
  canvas3DStagePreviewTextureCache.clear()
}

export const getCanvas3DStagePreviewTextureCacheCount = () =>
  Array.from(canvas3DStagePreviewTextureCache.values()).filter((entry) => entry.texture).length
