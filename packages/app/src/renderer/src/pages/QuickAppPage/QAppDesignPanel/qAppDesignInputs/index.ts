import { QAppCfgAutoType, QAppCfgInputType } from '@shared/qApp/cfgTypes'
import { QAppDesignComponent } from './types'
import DsnInputPrompt from './DsnInputPrompt'
import DsnInputSeed from './DsnInputSeed'
import DsnInputNumber from './DsnInputNumber'
import DsnInputComfySelect from './DsnInputComfySelect'
import DsnInputText from './DsnInputText'
import DsnInputSlider from './DsnInputSlider'
import DsnInputComfyImage from './DsnInputComfyImage'
import DsnInputComfyVideo from './DsnInputComfyVideo'
import DsnInputImageSize from './DsnInputImageSize'
import DsnInputLoRAChain from './DsnInputLoRAChain'
import DsnInputComfyImageMask from './DsnInputComfyImageMask'
import DsnInputVideoBoundaryFrames from './DsnInputVideoBoundaryFrames'
import DsnSection from './DsnSection'
import DsnAutoSeed from './DsnAutoSeed'
import DsnAutoLLMAPI from './DsnAutoLLMAPI'
import DsnInputLLMAPI from './DsnInputLLMAPI'
import DsnInputCamera3D from './DsnInputCamera3D'
import DsnDescription from './DsnDescription'

export type QAppDesignInputMap = {
  [K in QAppCfgInputType]: QAppDesignComponent<K>
}

export const qAppDesignInputMap: QAppDesignInputMap = {
  InputPrompt: DsnInputPrompt,
  InputSeed: DsnInputSeed,
  InputComfySelect: DsnInputComfySelect,
  InputComfyImage: DsnInputComfyImage,
  InputComfyVideo: DsnInputComfyVideo,
  InputNumber: DsnInputNumber,
  InputText: DsnInputText,
  InputComfyImageMask: DsnInputComfyImageMask,
  InputVideoBoundaryFrames: DsnInputVideoBoundaryFrames,
  InputSlider: DsnInputSlider,
  InputImageSize: DsnInputImageSize,
  InputLoRAChain: DsnInputLoRAChain,
  InputLLMAPI: DsnInputLLMAPI,
  InputCamera3D: DsnInputCamera3D
}

export type QAppDesignMetaMap = {
  Section: QAppDesignComponent<'Section'>
  Description: QAppDesignComponent<'Description'>
}

export const qAppDesignMetaMap: QAppDesignMetaMap = {
  Description: DsnDescription,
  Section: DsnSection
}

export type QAppDesignAutoMap = {
  [K in QAppCfgAutoType]: QAppDesignComponent<K>
}

export const qAppDesignAutoMap: QAppDesignAutoMap = {
  AutoSeed: DsnAutoSeed,
  AutoLLMAPI: DsnAutoLLMAPI
}
