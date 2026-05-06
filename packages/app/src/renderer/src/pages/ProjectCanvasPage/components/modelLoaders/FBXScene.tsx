import React from 'react'
import { useLoader } from '@react-three/fiber'
import { FBXLoader } from 'three-stdlib'
import { BaseScene, configureTextureAwareLoader, type ModelBounds } from './shared'

const FBXScene: React.FC<{
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
  const fbx = useLoader(FBXLoader, src, (loader) =>
    configureTextureAwareLoader(loader, src, textures)
  )

  return (
    <BaseScene
      sceneData={fbx}
      initialRotation={initialRotation}
      instanceCacheKey={instanceCacheKey}
      animationCount={fbx.animations?.length ?? 0}
      onBoundsChange={onBoundsChange}
      emitModelCenteredEvent={emitModelCenteredEvent}
    />
  )
}

export default FBXScene
