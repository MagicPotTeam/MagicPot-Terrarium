import type { Canvas3DStageLightingPreset } from './canvas3DStageQuality'

export type Canvas3DStageDirectionalLight = {
  position: [number, number, number]
  intensity: number
}

export type Canvas3DStageLightingConfig = {
  ambientIntensity: number
  hemisphereGround: string
  hemisphereIntensity: number
  directionalLights: Canvas3DStageDirectionalLight[]
}

export const CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION: [number, number, number] = [0.34, 0.62, 0]
export const CANVAS_3D_VIEWER_CAMERA_DIRECTION: [number, number, number] = [0, 0, 1]

export const resolveCanvas3DStageLightingConfig = (
  lightingPreset: Canvas3DStageLightingPreset
): Canvas3DStageLightingConfig => {
  if (lightingPreset === 'flat') {
    return {
      ambientIntensity: 1.08,
      hemisphereGround: '#dbe4ee',
      hemisphereIntensity: 0.84,
      directionalLights: [
        { position: [4, 6, 7], intensity: 0.34 },
        { position: [-2.5, 3, -1.5], intensity: 0.14 }
      ]
    }
  }

  if (lightingPreset === 'balanced') {
    return {
      ambientIntensity: 0.94,
      hemisphereGround: '#94a3b8',
      hemisphereIntensity: 0.68,
      directionalLights: [{ position: [4, 6, 7], intensity: 0.62 }]
    }
  }

  return {
    ambientIntensity: 0.86,
    hemisphereGround: '#94a3b8',
    hemisphereIntensity: 0.62,
    directionalLights: [
      { position: [4, 6, 7], intensity: 0.72 },
      { position: [-3, 4, -2], intensity: 0.28 },
      { position: [0, 2, 8], intensity: 0.12 }
    ]
  }
}

export const CANVAS_3D_STAGE_PREVIEW_LIGHTING_CONFIG = resolveCanvas3DStageLightingConfig('full')
