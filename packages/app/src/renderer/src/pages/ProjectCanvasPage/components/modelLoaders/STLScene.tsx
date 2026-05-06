import React from 'react'
import { useLoader } from '@react-three/fiber'
import { STLLoader } from 'three-stdlib'
import { BaseScene, configureTextureAwareLoader, type ModelBounds } from './shared'

const STLScene: React.FC<{
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
  const stlGeometry = useLoader(STLLoader, src, (loader) =>
    configureTextureAwareLoader(loader, src, textures)
  )

  return (
    <BaseScene
      sceneData={stlGeometry}
      initialRotation={initialRotation}
      instanceCacheKey={instanceCacheKey}
      onBoundsChange={onBoundsChange}
      emitModelCenteredEvent={emitModelCenteredEvent}
    />
  )
}

export default STLScene
