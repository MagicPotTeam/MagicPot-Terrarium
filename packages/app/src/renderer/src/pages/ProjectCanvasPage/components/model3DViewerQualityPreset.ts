import type { Canvas3DViewerQualityPreset } from './Canvas3DStage'
import { resolveCanvas3DStageLightingConfig } from './canvas3DStagePresentation'

export const resolveModel3DViewerQualityPreset = ({
  fileName,
  textureCount
}: {
  fileName: string
  textureCount: number
}): Canvas3DViewerQualityPreset => {
  const ext = fileName.toLowerCase().split('.').pop()
  const heavyModel = ext === 'fbx' || ext === 'obj' || textureCount >= 4
  const mediumModel = ext === 'stl' || textureCount >= 2
  const sharedLightingConfig = resolveCanvas3DStageLightingConfig('full')

  if (heavyModel) {
    return {
      dpr: [1, 1.15],
      ambientIntensity: sharedLightingConfig.ambientIntensity,
      hemisphereIntensity: sharedLightingConfig.hemisphereIntensity,
      directionalLights: sharedLightingConfig.directionalLights
    }
  }

  if (mediumModel) {
    return {
      dpr: [1, 1.3],
      ambientIntensity: sharedLightingConfig.ambientIntensity,
      hemisphereIntensity: sharedLightingConfig.hemisphereIntensity,
      directionalLights: sharedLightingConfig.directionalLights
    }
  }

  return {
    dpr: [1, 1.45],
    ambientIntensity: sharedLightingConfig.ambientIntensity,
    hemisphereIntensity: sharedLightingConfig.hemisphereIntensity,
    directionalLights: sharedLightingConfig.directionalLights
  }
}
