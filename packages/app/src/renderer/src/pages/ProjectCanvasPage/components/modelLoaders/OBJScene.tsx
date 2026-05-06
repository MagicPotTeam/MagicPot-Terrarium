import React from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { MTLLoader, OBJLoader } from 'three-stdlib'
import { BaseScene, configureTextureAwareLoader, type ModelBounds } from './shared'

const OBJWithMTLScene: React.FC<{
  src: string
  mtlUrl: string
  textures?: Record<string, string>
  instanceCacheKey?: string
  initialRotation?: [number, number, number]
  onBoundsChange?: (bounds: ModelBounds) => void
  emitModelCenteredEvent?: boolean
}> = ({
  src,
  mtlUrl,
  textures,
  instanceCacheKey,
  initialRotation,
  onBoundsChange,
  emitModelCenteredEvent
}) => {
  const mtl = useLoader(MTLLoader, mtlUrl, (loader: THREE.Loader) =>
    configureTextureAwareLoader(loader, mtlUrl, textures)
  )
  mtl.preload()

  const obj = useLoader(OBJLoader, src, (loader) => {
    configureTextureAwareLoader(loader, src, textures)
    ;(loader as OBJLoader).setMaterials(mtl)
  })

  return (
    <BaseScene
      sceneData={obj}
      initialRotation={initialRotation}
      instanceCacheKey={instanceCacheKey}
      onBoundsChange={onBoundsChange}
      emitModelCenteredEvent={emitModelCenteredEvent}
    />
  )
}

const OBJPlainScene: React.FC<{
  src: string
  textures?: Record<string, string>
  instanceCacheKey?: string
  initialRotation?: [number, number, number]
  onBoundsChange?: (bounds: ModelBounds) => void
  emitModelCenteredEvent?: boolean
}> = ({
  src,
  textures,
  instanceCacheKey,
  initialRotation,
  onBoundsChange,
  emitModelCenteredEvent
}) => {
  const obj = useLoader(OBJLoader, src, (loader) =>
    configureTextureAwareLoader(loader, src, textures)
  )

  return (
    <BaseScene
      sceneData={obj}
      initialRotation={initialRotation}
      instanceCacheKey={instanceCacheKey}
      onBoundsChange={onBoundsChange}
      emitModelCenteredEvent={emitModelCenteredEvent}
    />
  )
}

const OBJScene: React.FC<{
  src: string
  textures?: Record<string, string>
  instanceCacheKey?: string
  initialRotation?: [number, number, number]
  onBoundsChange?: (bounds: ModelBounds) => void
  emitModelCenteredEvent?: boolean
}> = ({
  src,
  textures,
  instanceCacheKey,
  initialRotation,
  onBoundsChange,
  emitModelCenteredEvent
}) => {
  const mtlEntry = textures
    ? Object.entries(textures).find(([name]) => name.toLowerCase().endsWith('.mtl'))
    : undefined

  if (mtlEntry) {
    return (
      <OBJWithMTLScene
        src={src}
        mtlUrl={mtlEntry[1]}
        textures={textures}
        instanceCacheKey={instanceCacheKey}
        initialRotation={initialRotation}
        onBoundsChange={onBoundsChange}
        emitModelCenteredEvent={emitModelCenteredEvent}
      />
    )
  }

  return (
    <OBJPlainScene
      src={src}
      textures={textures}
      instanceCacheKey={instanceCacheKey}
      initialRotation={initialRotation}
      onBoundsChange={onBoundsChange}
      emitModelCenteredEvent={emitModelCenteredEvent}
    />
  )
}

export default OBJScene
