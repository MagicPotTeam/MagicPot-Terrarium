/* eslint-disable react/no-unknown-property */
/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoomEnvironment, SkeletonUtils } from 'three-stdlib'
import {
  hasCachedSceneInstanceClone,
  readCachedSceneInstanceClone,
  writeCachedSceneInstanceClone
} from './sceneInstanceCloneCache'
import { resolveModelInspectionMetadata } from './modelInspectionMetadata'
import {
  CANVAS_MODEL3D_METADATA_UPDATED_EVENT,
  writeCanvasModel3DInspectionMetadataCache
} from './modelInspectionMetadataCache'

type ModelSceneEventMap = {
  'model-centered': {
    type: 'model-centered'
    center: THREE.Vector3
    size: THREE.Vector3
    radius: number
  }
}

const asModelSceneDispatcher = (scene: THREE.Scene): THREE.EventDispatcher<ModelSceneEventMap> =>
  scene as unknown as THREE.EventDispatcher<ModelSceneEventMap>

export type ModelBounds = {
  center: THREE.Vector3
  size: THREE.Vector3
  radius: number
}

type SceneLayoutCacheEntry = {
  modelCenter: THREE.Vector3
  bounds: ModelBounds
}

const SCENE_LAYOUT_RETRY_FRAME_LIMIT = 8
const MODEL_TEXTURE_MAX_ANISOTROPY = 8
const MODEL_SCENE_TONE_MAPPING_EXPOSURE = 1.02
const MODEL_SCENE_ENVIRONMENT_INTENSITY = 1.08
const MODEL_SCENE_ENVIRONMENT_SIGMA = 0.04
const MODEL_SCENE_MAIN_LIGHT_INTENSITY_MULTIPLIER = 1.12
const MODEL_SCENE_AREA_LIGHT_INTENSITY_MULTIPLIER = 1.04
const MODEL_SCENE_DARK_COLOR_LIGHTNESS_FLOOR = 0.18
const MODEL_SCENE_DARK_COLOR_SATURATION_CAP = 0.38

const cloneObject3D = (sceneData: THREE.Object3D) => SkeletonUtils.clone(sceneData)

const cloneModelBounds = (bounds: ModelBounds): ModelBounds => ({
  center: bounds.center.clone(),
  size: bounds.size.clone(),
  radius: bounds.radius
})

const sceneLayoutCache = new WeakMap<
  THREE.Object3D | THREE.BufferGeometry,
  Map<string, SceneLayoutCacheEntry>
>()

const getSceneLayoutCacheKey = (initialRotation?: [number, number, number]) =>
  initialRotation ? initialRotation.join('|') : 'default'

const readSceneLayoutCache = (
  sceneData: THREE.Object3D | THREE.BufferGeometry,
  initialRotation?: [number, number, number]
): SceneLayoutCacheEntry | null => {
  const cacheEntry = sceneLayoutCache.get(sceneData)?.get(getSceneLayoutCacheKey(initialRotation))
  if (!cacheEntry) return null

  return {
    modelCenter: cacheEntry.modelCenter.clone(),
    bounds: cloneModelBounds(cacheEntry.bounds)
  }
}

const writeSceneLayoutCache = (
  sceneData: THREE.Object3D | THREE.BufferGeometry,
  initialRotation: [number, number, number] | undefined,
  modelCenter: THREE.Vector3,
  bounds: ModelBounds
) => {
  const existingCache = sceneLayoutCache.get(sceneData)
  const cacheBucket = existingCache ?? new Map<string, SceneLayoutCacheEntry>()
  cacheBucket.set(getSceneLayoutCacheKey(initialRotation), {
    modelCenter: modelCenter.clone(),
    bounds: cloneModelBounds(bounds)
  })

  if (!existingCache) {
    sceneLayoutCache.set(sceneData, cacheBucket)
  }
}

const isRenderableObject = (object: THREE.Object3D): boolean => {
  return Boolean(
    (object as THREE.Mesh).isMesh ||
    (object as THREE.Line).isLine ||
    (object as THREE.Points).isPoints ||
    (object as THREE.Sprite).isSprite
  )
}

const computeRenderableBounds = (root: THREE.Object3D): THREE.Box3 | null => {
  const box = new THREE.Box3()
  let hasRenderable = false

  root.updateWorldMatrix(true, true)
  root.traverse((child) => {
    if (!child.visible || !isRenderableObject(child)) return
    box.expandByObject(child)
    hasRenderable = true
  })

  if (hasRenderable && !box.isEmpty()) {
    return box
  }

  const fallback = new THREE.Box3().setFromObject(root)
  return fallback.isEmpty() ? null : fallback
}

const createSceneLayoutEntry = (box: THREE.Box3): SceneLayoutCacheEntry => {
  const modelCenter = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())

  return {
    modelCenter,
    bounds: {
      center: new THREE.Vector3(),
      size,
      radius: size.length() / 2
    }
  }
}

const measureObject3DSceneLayout = (
  sceneData: THREE.Object3D,
  initialRotation?: [number, number, number]
) => {
  const measurementRoot =
    initialRotation && initialRotation.some((value) => value !== 0)
      ? (() => {
          const wrapper = new THREE.Group()
          wrapper.rotation.set(...initialRotation)
          wrapper.add(cloneObject3D(sceneData))
          return wrapper
        })()
      : sceneData
  const box = computeRenderableBounds(measurementRoot)
  return box ? createSceneLayoutEntry(box) : null
}

const measureBufferGeometryLayout = (
  geometry: THREE.BufferGeometry,
  initialRotation?: [number, number, number]
) => {
  const measurementMesh = new THREE.Mesh(geometry)
  if (initialRotation?.some((value) => value !== 0)) {
    measurementMesh.rotation.set(...initialRotation)
  }
  const box = computeRenderableBounds(measurementMesh)
  return box ? createSceneLayoutEntry(box) : null
}

export const measureSceneDataLayout = (
  sceneData: THREE.Object3D | THREE.BufferGeometry,
  initialRotation?: [number, number, number]
): SceneLayoutCacheEntry | null => {
  if (sceneData instanceof THREE.BufferGeometry) {
    return measureBufferGeometryLayout(sceneData, initialRotation)
  }

  return measureObject3DSceneLayout(sceneData, initialRotation)
}

export const dummyTextureUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

type TextureAwareMaterial = THREE.Material & {
  alphaMap?: THREE.Texture | null
  aoMap?: THREE.Texture | null
  bumpMap?: THREE.Texture | null
  color?: THREE.Color
  clearcoatMap?: THREE.Texture | null
  clearcoatNormalMap?: THREE.Texture | null
  clearcoatRoughnessMap?: THREE.Texture | null
  displacementMap?: THREE.Texture | null
  emissiveMap?: THREE.Texture | null
  envMapIntensity?: number
  iridescenceMap?: THREE.Texture | null
  iridescenceThicknessMap?: THREE.Texture | null
  map?: THREE.Texture | null
  metalness?: number
  metalnessMap?: THREE.Texture | null
  normalMap?: THREE.Texture | null
  roughness?: number
  roughnessMap?: THREE.Texture | null
  sheenColorMap?: THREE.Texture | null
  specularColor?: THREE.Color
  specularColorMap?: THREE.Texture | null
  specularIntensity?: number
  specularIntensityMap?: THREE.Texture | null
  thicknessMap?: THREE.Texture | null
  transmissionMap?: THREE.Texture | null
}

const COLOR_TEXTURE_KEYS = ['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'] as const
const DATA_TEXTURE_KEYS = [
  'alphaMap',
  'aoMap',
  'bumpMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'displacementMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'metalnessMap',
  'normalMap',
  'roughnessMap',
  'specularIntensityMap',
  'thicknessMap',
  'transmissionMap'
] as const
const PASSTHROUGH_TEXTURE_URL_PREFIXES = [
  'blob:',
  'data:',
  'file:',
  'local-media:',
  'http://',
  'https://'
] as const

const getModelTextureAnisotropy = (maxAnisotropy?: number) =>
  Math.max(0, Math.min(maxAnisotropy ?? 0, MODEL_TEXTURE_MAX_ANISOTROPY))

const applyTextureDisplayTuning = (
  texture: THREE.Texture | null | undefined,
  colorSpace: string,
  anisotropy: number
) => {
  if (!texture) return false

  let changed = false

  if (texture.colorSpace !== colorSpace) {
    texture.colorSpace = colorSpace
    changed = true
  }

  if (anisotropy > 0 && texture.anisotropy !== anisotropy) {
    texture.anisotropy = anisotropy
    changed = true
  }

  if (changed) {
    texture.needsUpdate = true
  }

  return changed
}

const tuneMaterialForDisplay = (material: THREE.Material, anisotropy: number) => {
  const textureAwareMaterial = material as TextureAwareMaterial
  let changed = false

  COLOR_TEXTURE_KEYS.forEach((key) => {
    if (applyTextureDisplayTuning(textureAwareMaterial[key], THREE.SRGBColorSpace, anisotropy)) {
      changed = true
    }
  })

  DATA_TEXTURE_KEYS.forEach((key) => {
    if (applyTextureDisplayTuning(textureAwareMaterial[key], THREE.NoColorSpace, anisotropy)) {
      changed = true
    }
  })

  if (
    typeof textureAwareMaterial.specularIntensity === 'number' &&
    textureAwareMaterial.specularIntensity > 1
  ) {
    textureAwareMaterial.specularIntensity = 1
    changed = true
  }

  if (textureAwareMaterial.specularColor) {
    const clampedR = THREE.MathUtils.clamp(textureAwareMaterial.specularColor.r, 0, 1)
    const clampedG = THREE.MathUtils.clamp(textureAwareMaterial.specularColor.g, 0, 1)
    const clampedB = THREE.MathUtils.clamp(textureAwareMaterial.specularColor.b, 0, 1)
    if (
      clampedR !== textureAwareMaterial.specularColor.r ||
      clampedG !== textureAwareMaterial.specularColor.g ||
      clampedB !== textureAwareMaterial.specularColor.b
    ) {
      textureAwareMaterial.specularColor.setRGB(clampedR, clampedG, clampedB)
      changed = true
    }
  }

  if (!textureAwareMaterial.map && textureAwareMaterial.color) {
    const hsl = { h: 0, s: 0, l: 0 }
    textureAwareMaterial.color.getHSL(hsl)
    const nextLightness = Math.max(hsl.l, MODEL_SCENE_DARK_COLOR_LIGHTNESS_FLOOR)
    const nextSaturation =
      hsl.l < MODEL_SCENE_DARK_COLOR_LIGHTNESS_FLOOR
        ? Math.min(hsl.s, MODEL_SCENE_DARK_COLOR_SATURATION_CAP)
        : hsl.s

    if (Math.abs(nextLightness - hsl.l) > 0.0001 || Math.abs(nextSaturation - hsl.s) > 0.0001) {
      textureAwareMaterial.color.setHSL(hsl.h, nextSaturation, nextLightness)
      changed = true
    }
  }

  if (changed) {
    material.needsUpdate = true
  }
}

export const tuneLoadedModelSceneForDisplay = (
  sceneData: THREE.Object3D,
  options?: {
    maxAnisotropy?: number
  }
) => {
  const anisotropy = getModelTextureAnisotropy(options?.maxAnisotropy)

  sceneData.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      if (material) {
        tuneMaterialForDisplay(material, anisotropy)
      }
    })
  })

  return sceneData
}

const disposeEnvironmentScene = (environmentScene: THREE.Scene) => {
  environmentScene.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry
    if (geometry) {
      geometry.dispose()
    }

    const material = (child as THREE.Mesh).material
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose())
    } else {
      material?.dispose?.()
    }
  })
}

const tuneEnvironmentSceneForModelDisplay = (environmentScene: THREE.Scene) => {
  environmentScene.traverse((child) => {
    const pointLight = child as THREE.PointLight
    if (pointLight.isPointLight) {
      pointLight.intensity *= MODEL_SCENE_MAIN_LIGHT_INTENSITY_MULTIPLIER
      return
    }

    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      if (!material) return

      const emissiveMaterial = material as THREE.Material & {
        emissive?: THREE.Color
        emissiveIntensity?: number
      }

      if (typeof emissiveMaterial.emissiveIntensity === 'number') {
        emissiveMaterial.emissiveIntensity *= MODEL_SCENE_AREA_LIGHT_INTENSITY_MULTIPLIER
        material.needsUpdate = true
      }
    })
  })

  return environmentScene
}

export const configureModelSceneRendererForDisplay = (gl: THREE.WebGLRenderer) => {
  gl.outputColorSpace = THREE.SRGBColorSpace
  gl.toneMapping = THREE.NeutralToneMapping
  gl.toneMappingExposure = MODEL_SCENE_TONE_MAPPING_EXPOSURE
}

type ModelSceneEnvironmentResources = {
  applyToScene: (scene: THREE.Scene) => void
  dispose: () => void
}

export const createModelSceneEnvironmentResources = (
  gl: THREE.WebGLRenderer
): ModelSceneEnvironmentResources => {
  const pmremGenerator = new THREE.PMREMGenerator(gl)
  const environmentScene = tuneEnvironmentSceneForModelDisplay(RoomEnvironment())
  const environmentRenderTarget = pmremGenerator.fromScene(
    environmentScene,
    MODEL_SCENE_ENVIRONMENT_SIGMA
  )

  return {
    applyToScene: (scene: THREE.Scene) => {
      scene.environment = environmentRenderTarget.texture
      if ('environmentIntensity' in scene) {
        ;(scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity =
          MODEL_SCENE_ENVIRONMENT_INTENSITY
      }
    },
    dispose: () => {
      environmentRenderTarget.dispose()
      pmremGenerator.dispose()
      disposeEnvironmentScene(environmentScene)
    }
  }
}

export const ModelSceneCanvasSetup: React.FC<{ enableEnvironment?: boolean }> = ({
  enableEnvironment = true
}) => {
  const { gl, invalidate, scene } = useThree()

  useEffect(() => {
    const previousOutputColorSpace = gl.outputColorSpace
    const previousToneMapping = gl.toneMapping
    const previousToneMappingExposure = gl.toneMappingExposure
    const previousEnvironment = scene.environment
    const previousEnvironmentIntensity = (scene as THREE.Scene & { environmentIntensity?: number })
      .environmentIntensity
    let environmentResources: ModelSceneEnvironmentResources | null = null

    configureModelSceneRendererForDisplay(gl)

    if (enableEnvironment) {
      environmentResources = createModelSceneEnvironmentResources(gl)
      environmentResources.applyToScene(scene)
    }

    invalidate()

    return () => {
      gl.outputColorSpace = previousOutputColorSpace
      gl.toneMapping = previousToneMapping
      gl.toneMappingExposure = previousToneMappingExposure
      scene.environment = previousEnvironment
      if ('environmentIntensity' in scene) {
        ;(scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity =
          previousEnvironmentIntensity
      }
      environmentResources?.dispose()
    }
  }, [enableEnvironment, gl, invalidate, scene])

  return null
}

export const BaseScene: React.FC<{
  sceneData: THREE.Object3D | THREE.BufferGeometry
  initialRotation?: [number, number, number]
  instanceCacheKey?: string
  animationCount?: number
  onBoundsChange?: (bounds: ModelBounds) => void
  emitModelCenteredEvent?: boolean
}> = ({
  sceneData,
  initialRotation,
  instanceCacheKey,
  animationCount,
  onBoundsChange,
  emitModelCenteredEvent = true
}) => {
  const rootRef = useRef<THREE.Group>(null)
  const contentRef = useRef<THREE.Group>(null)
  const { gl, scene, invalidate } = useThree()
  const renderSceneData = useMemo(() => {
    if (sceneData instanceof THREE.BufferGeometry) {
      if (instanceCacheKey && !hasCachedSceneInstanceClone(instanceCacheKey)) {
        const cachedGeometry = sceneData.clone()
        resolveModelInspectionMetadata(cachedGeometry, { animationCount })
        writeCachedSceneInstanceClone({
          cacheKey: instanceCacheKey,
          renderSceneData: cachedGeometry
        })
      }

      resolveModelInspectionMetadata(sceneData, { animationCount })
      return sceneData
    }

    const maxAnisotropy = gl.capabilities.getMaxAnisotropy()

    if (!instanceCacheKey) {
      const sceneClone = tuneLoadedModelSceneForDisplay(cloneObject3D(sceneData), {
        maxAnisotropy
      })
      resolveModelInspectionMetadata(sceneClone, { animationCount })
      return sceneClone
    }
    const cachedSceneClone = readCachedSceneInstanceClone(instanceCacheKey)
    if (cachedSceneClone instanceof THREE.Object3D) {
      const renderedSceneClone = tuneLoadedModelSceneForDisplay(cachedSceneClone, {
        maxAnisotropy
      })
      resolveModelInspectionMetadata(renderedSceneClone, { animationCount })
      return renderedSceneClone
    }

    const sceneTemplate = tuneLoadedModelSceneForDisplay(cloneObject3D(sceneData), {
      maxAnisotropy
    })
    resolveModelInspectionMetadata(sceneTemplate, { animationCount })
    writeCachedSceneInstanceClone({
      cacheKey: instanceCacheKey,
      renderSceneData: sceneTemplate
    })
    const renderedSceneClone = tuneLoadedModelSceneForDisplay(cloneObject3D(sceneTemplate), {
      maxAnisotropy
    })
    resolveModelInspectionMetadata(renderedSceneClone, { animationCount })
    return renderedSceneClone
  }, [animationCount, gl, instanceCacheKey, sceneData])
  const modelInspectionMetadata = useMemo(
    () => resolveModelInspectionMetadata(renderSceneData, { animationCount }),
    [animationCount, renderSceneData]
  )
  const precomputedLayout = useMemo(() => {
    const cachedLayout = readSceneLayoutCache(sceneData, initialRotation)
    if (cachedLayout) {
      return cachedLayout
    }

    const measuredLayout = measureSceneDataLayout(sceneData, initialRotation)
    if (!measuredLayout) {
      return null
    }

    writeSceneLayoutCache(
      sceneData,
      initialRotation,
      measuredLayout.modelCenter,
      measuredLayout.bounds
    )
    return measuredLayout
  }, [initialRotation, sceneData])

  useLayoutEffect(() => {
    if (!rootRef.current || !contentRef.current || !sceneData) return
    let cancelled = false
    let rafId = 0
    let retryFrameCount = 0

    const publishBounds = (bounds: ModelBounds) => {
      const clonedBounds = cloneModelBounds(bounds)
      onBoundsChange?.(clonedBounds)
      if (emitModelCenteredEvent) {
        asModelSceneDispatcher(scene).dispatchEvent({
          type: 'model-centered',
          center: clonedBounds.center,
          size: clonedBounds.size,
          radius: clonedBounds.radius
        })
      }
      invalidate()
    }

    const scheduleRetry = () => {
      if (cancelled || retryFrameCount >= SCENE_LAYOUT_RETRY_FRAME_LIMIT) {
        invalidate()
        return
      }
      retryFrameCount += 1
      rafId = requestAnimationFrame(applySceneLayout)
    }

    const applySceneLayout = () => {
      if (cancelled || !rootRef.current || !contentRef.current) return

      const initialLayout = precomputedLayout ?? readSceneLayoutCache(sceneData, initialRotation)

      if (initialLayout) {
        contentRef.current.position.copy(initialLayout.modelCenter).multiplyScalar(-1)
        contentRef.current.updateWorldMatrix(true, true)
        publishBounds(initialLayout.bounds)
        return
      }

      contentRef.current.position.set(0, 0, 0)
      contentRef.current.scale.setScalar(1)
      contentRef.current.updateWorldMatrix(true, true)

      const cachedLayout = readSceneLayoutCache(sceneData, initialRotation)
      if (cachedLayout) {
        contentRef.current.position.copy(cachedLayout.modelCenter).multiplyScalar(-1)
        contentRef.current.updateWorldMatrix(true, true)
        publishBounds(cachedLayout.bounds)
        return
      }

      const box = computeRenderableBounds(contentRef.current)
      if (!box) {
        scheduleRetry()
        return
      }

      const center = box.getCenter(new THREE.Vector3())
      contentRef.current.position.set(-center.x, -center.y, -center.z)
      contentRef.current.updateWorldMatrix(true, true)

      const finalBox = computeRenderableBounds(rootRef.current)
      if (!finalBox) {
        scheduleRetry()
        return
      }

      const size = finalBox.getSize(new THREE.Vector3())
      const bounds = {
        center: finalBox.getCenter(new THREE.Vector3()),
        size,
        radius: size.length() / 2
      }

      writeSceneLayoutCache(sceneData, initialRotation, center, bounds)
      publishBounds(bounds)
    }

    applySceneLayout()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [
    emitModelCenteredEvent,
    initialRotation,
    invalidate,
    onBoundsChange,
    precomputedLayout,
    renderSceneData,
    scene,
    sceneData
  ])
  useEffect(() => {
    if (!instanceCacheKey || typeof window === 'undefined') {
      return
    }

    writeCanvasModel3DInspectionMetadataCache(instanceCacheKey, modelInspectionMetadata)

    window.dispatchEvent(
      new CustomEvent(CANVAS_MODEL3D_METADATA_UPDATED_EVENT, {
        detail: {
          instanceCacheKey,
          metadata: modelInspectionMetadata
        }
      })
    )
  }, [instanceCacheKey, modelInspectionMetadata])

  if (renderSceneData instanceof THREE.BufferGeometry) {
    return (
      <group ref={rootRef}>
        <group ref={contentRef}>
          <mesh geometry={renderSceneData}>
            <meshStandardMaterial color="#cccccc" />
          </mesh>
        </group>
      </group>
    )
  }

  return (
    <group ref={rootRef}>
      <group ref={contentRef}>
        <primitive object={renderSceneData} rotation={initialRotation} />
      </group>
    </group>
  )
}

function buildTextureLookup(textures?: Record<string, string>): Map<string, string> | null {
  if (!textures || Object.keys(textures).length === 0) return null

  const map = new Map<string, string>()
  for (const [name, blobUrl] of Object.entries(textures)) {
    map.set(name, blobUrl)
    const lower = name.toLowerCase()
    if (!map.has(lower)) map.set(lower, blobUrl)
    const baseName = name.replace(/^.*[/\\]/, '')
    if (!map.has(baseName)) map.set(baseName, blobUrl)
    const lowerBaseName = lower.replace(/^.*[/\\]/, '')
    if (!map.has(lowerBaseName)) map.set(lowerBaseName, blobUrl)
  }

  return map
}

const tryDecodeUrl = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const shouldPassThroughTextureUrl = (url: string, src: string, knownBlobUrls: Set<string>) =>
  url === src ||
  knownBlobUrls.has(url) ||
  PASSTHROUGH_TEXTURE_URL_PREFIXES.some((prefix) => url.startsWith(prefix))

export const configureTextureAwareLoader = (
  loader: THREE.Loader,
  src: string,
  textures?: Record<string, string>
) => {
  const lookup = buildTextureLookup(textures)
  const knownBlobUrls = new Set(Object.values(textures || {}))
  const manager = new THREE.LoadingManager()

  manager.setURLModifier((url: string) => {
    if (shouldPassThroughTextureUrl(url, src, knownBlobUrls)) return url

    if (lookup) {
      const urlWithoutQuery = url.split('?')[0]?.split('#')[0] || url
      const decodedUrl = tryDecodeUrl(urlWithoutQuery)
      const requestedFileName = decodedUrl.split('/').pop()?.split('\\').pop() || decodedUrl
      const lowerRequestedFileName = requestedFileName.toLowerCase()
      const hit =
        lookup.get(decodedUrl) ||
        lookup.get(decodedUrl.toLowerCase()) ||
        lookup.get(requestedFileName) ||
        lookup.get(lowerRequestedFileName)

      if (hit) return hit
    }

    return dummyTextureUrl
  })

  loader.manager = manager
}
