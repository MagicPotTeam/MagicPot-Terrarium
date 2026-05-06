import type React from 'react'

import {
  IconConcept,
  IconConvert,
  IconGeometry,
  IconProfile,
  IconSplit,
  IconTexture,
  IconTopology,
  IconUV
} from './icons'

export const STEP_ICONS: Record<string, React.FC> = {
  concept: IconConcept,
  geometry: IconGeometry,
  profile: IconProfile,
  split: IconSplit,
  topology: IconTopology,
  uv: IconUV,
  texture: IconTexture,
  convert: IconConvert
}
