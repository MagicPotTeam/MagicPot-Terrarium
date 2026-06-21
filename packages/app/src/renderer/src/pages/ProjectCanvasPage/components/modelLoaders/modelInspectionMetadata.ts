import * as THREE from 'three'
import {
  cloneModelInspectionMetadata,
  type ModelInspectionMetadata
} from './modelInspectionMetadataCache'

export {
  CANVAS_MODEL3D_METADATA_UPDATED_EVENT,
  writeCanvasModel3DInspectionMetadataCache
} from './modelInspectionMetadataCache'
export type { ModelInspectionMetadata } from './modelInspectionMetadataCache'

const MODEL_INSPECTION_METADATA_USER_DATA_KEY = '__magicpotModelInspectionMetadata'

const normalizeModelInspectionCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null

const readStoredModelInspectionMetadata = (
  sceneData: THREE.Object3D | THREE.BufferGeometry
): ModelInspectionMetadata | null => {
  const storedMetadata = sceneData.userData?.[MODEL_INSPECTION_METADATA_USER_DATA_KEY]
  if (!storedMetadata || typeof storedMetadata !== 'object') {
    return null
  }

  const metadataRecord = storedMetadata as Partial<ModelInspectionMetadata>
  const vertexCount = normalizeModelInspectionCount(metadataRecord.vertexCount)
  const faceCount = normalizeModelInspectionCount(metadataRecord.faceCount)
  const materialCount = normalizeModelInspectionCount(metadataRecord.materialCount)
  const animationCount = normalizeModelInspectionCount(metadataRecord.animationCount)
  const boneCount = normalizeModelInspectionCount(metadataRecord.boneCount)
  const uvSetCount = normalizeModelInspectionCount(metadataRecord.uvSetCount)

  if (
    vertexCount == null ||
    faceCount == null ||
    materialCount == null ||
    animationCount == null ||
    boneCount == null ||
    uvSetCount == null ||
    typeof metadataRecord.normalData !== 'boolean' ||
    typeof metadataRecord.tangentData !== 'boolean'
  ) {
    return null
  }

  return {
    vertexCount,
    faceCount,
    materialCount,
    animationCount,
    boneCount,
    uvSetCount,
    normalData: metadataRecord.normalData,
    tangentData: metadataRecord.tangentData
  }
}

const writeStoredModelInspectionMetadata = (
  sceneData: THREE.Object3D | THREE.BufferGeometry,
  metadata: ModelInspectionMetadata
) => {
  sceneData.userData = {
    ...(sceneData.userData || {}),
    [MODEL_INSPECTION_METADATA_USER_DATA_KEY]: cloneModelInspectionMetadata(metadata)
  }
}

const countGeometryUvSets = (geometry: THREE.BufferGeometry) =>
  Object.keys(geometry.attributes).filter((attributeName) => /^uv\d*$/.test(attributeName)).length

const getGeometryFaceCount = (geometry: THREE.BufferGeometry) => {
  const indexedFaceCount =
    typeof geometry.index?.count === 'number' && Number.isFinite(geometry.index.count)
      ? geometry.index.count / 3
      : null
  if (indexedFaceCount != null) {
    return Math.max(0, Math.floor(indexedFaceCount))
  }

  const positionAttribute = geometry.getAttribute('position')
  if (!positionAttribute || !Number.isFinite(positionAttribute.count)) {
    return 0
  }

  return Math.max(0, Math.floor(positionAttribute.count / 3))
}

const resolveBufferGeometryInspectionMetadata = (
  geometry: THREE.BufferGeometry,
  animationCountOverride?: number | null
): ModelInspectionMetadata => {
  const positionAttribute = geometry.getAttribute('position')

  return {
    vertexCount:
      typeof positionAttribute?.count === 'number' && Number.isFinite(positionAttribute.count)
        ? positionAttribute.count
        : 0,
    faceCount: getGeometryFaceCount(geometry),
    materialCount: 1,
    animationCount: normalizeModelInspectionCount(animationCountOverride) ?? 0,
    boneCount: 0,
    uvSetCount: countGeometryUvSets(geometry),
    normalData: geometry.hasAttribute('normal'),
    tangentData: geometry.hasAttribute('tangent')
  }
}

const resolveObject3DAnimationCount = (
  sceneData: THREE.Object3D,
  animationCountOverride?: number | null
) => {
  const overrideCount = normalizeModelInspectionCount(animationCountOverride)
  if (overrideCount != null) {
    return overrideCount
  }

  const sceneAnimations = (sceneData as THREE.Object3D & { animations?: THREE.AnimationClip[] })
    .animations
  return Array.isArray(sceneAnimations) ? sceneAnimations.length : 0
}

const resolveObject3DInspectionMetadata = (
  sceneData: THREE.Object3D,
  animationCountOverride?: number | null
): ModelInspectionMetadata => {
  let vertexCount = 0
  let faceCount = 0
  let uvSetCount = 0
  let normalData = false
  let tangentData = false
  const materialIds = new Set<string>()
  const boneIds = new Set<string>()

  sceneData.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      boneIds.add(child.uuid)
    }

    const mesh = child as THREE.Mesh & {
      skeleton?: THREE.Skeleton
    }
    if (!mesh.isMesh) {
      return
    }

    const geometry = mesh.geometry
    if (geometry instanceof THREE.BufferGeometry) {
      const positionAttribute = geometry.getAttribute('position')
      if (
        typeof positionAttribute?.count === 'number' &&
        Number.isFinite(positionAttribute.count)
      ) {
        vertexCount += positionAttribute.count
      }
      faceCount += getGeometryFaceCount(geometry)
      uvSetCount = Math.max(uvSetCount, countGeometryUvSets(geometry))
      normalData = normalData || geometry.hasAttribute('normal')
      tangentData = tangentData || geometry.hasAttribute('tangent')
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      if (material?.uuid) {
        materialIds.add(material.uuid)
      }
    })

    mesh.skeleton?.bones?.forEach((bone) => {
      if (bone?.uuid) {
        boneIds.add(bone.uuid)
      }
    })
  })

  return {
    vertexCount,
    faceCount,
    materialCount: materialIds.size,
    animationCount: resolveObject3DAnimationCount(sceneData, animationCountOverride),
    boneCount: boneIds.size,
    uvSetCount,
    normalData,
    tangentData
  }
}

export const resolveModelInspectionMetadata = (
  sceneData: THREE.Object3D | THREE.BufferGeometry,
  options?: {
    animationCount?: number | null
  }
): ModelInspectionMetadata => {
  const storedMetadata = readStoredModelInspectionMetadata(sceneData)
  const nextAnimationCount = normalizeModelInspectionCount(options?.animationCount)

  if (
    storedMetadata &&
    (nextAnimationCount == null || storedMetadata.animationCount === nextAnimationCount)
  ) {
    return storedMetadata
  }

  const resolvedMetadata =
    sceneData instanceof THREE.BufferGeometry
      ? resolveBufferGeometryInspectionMetadata(sceneData, nextAnimationCount)
      : resolveObject3DInspectionMetadata(sceneData, nextAnimationCount)

  writeStoredModelInspectionMetadata(sceneData, resolvedMetadata)
  return cloneModelInspectionMetadata(resolvedMetadata)
}
