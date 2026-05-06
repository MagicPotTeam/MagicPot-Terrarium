import React from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import { GLTFLoader } from 'three-stdlib'
import { BaseScene, configureTextureAwareLoader, type ModelBounds } from './shared'
import { configureGLTFCompressionLoaders } from './compressionLoaders'

const GLTFScene: React.FC<{
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
  const gl = useThree((state) => state.gl)
  const gltf = useLoader(GLTFLoader, src, (loader) => {
    configureTextureAwareLoader(loader, src, textures)
    configureGLTFCompressionLoaders(loader as GLTFLoader, gl)
  })

  return (
    <BaseScene
      sceneData={gltf.scene}
      initialRotation={initialRotation}
      instanceCacheKey={instanceCacheKey}
      animationCount={gltf.animations?.length ?? 0}
      onBoundsChange={onBoundsChange}
      emitModelCenteredEvent={emitModelCenteredEvent}
    />
  )
}

export default GLTFScene
