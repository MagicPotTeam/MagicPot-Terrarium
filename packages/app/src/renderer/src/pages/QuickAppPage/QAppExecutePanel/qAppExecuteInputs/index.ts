import { QAppCfgAutoType, QAppCfgInputType } from '@shared/qApp/cfgTypes'
import { ExeAutoBuilder, ExeInputBuilder } from './types'
import buildExeInputSeed from './exeInputSeed'
import buildExeInputComfySelect from './exeInputComfySelect'
import buildExeInputPrompt from './exeInputPrompt'
import buildExeInputComfyImage from './exeInputComfyImage'
import buildExeInputComfyVideo from './exeInputComfyVideo'
import buildExeInputNumber from './exeInputNumber'
import buildExeInputText from './exeInputText'
import buildExeInputComfyImageMask from './exeInputComfyImageMask'
import buildExeInputVideoBoundaryFrames from './exeInputVideoBoundaryFrames'
import buildExeInputSlider from './exeInputSlider'
import buildExeInputLoRAChain from './exeInputLoRAChain'
import buildExeInputImageSize from './exeInputImageSize'
import buildExeAutoSeed from './exeAutoSeed'
import buildExeAutoLLMAPI from './exeAutoLLMAPI'
import buildExeInputLLMAPI from './exeInputLLMAPI'
import buildExeInputCamera3D from './exeInputCamera3D'
import buildExeDescription from './exeDescription'

export const buildQAppInputMap: {
  [K in QAppCfgInputType | 'Description']: ExeInputBuilder<K>
} = {
  InputPrompt: buildExeInputPrompt,
  InputSeed: buildExeInputSeed,
  InputComfySelect: buildExeInputComfySelect,
  InputComfyImage: buildExeInputComfyImage,
  InputComfyVideo: buildExeInputComfyVideo,
  InputNumber: buildExeInputNumber,
  InputText: buildExeInputText,
  InputComfyImageMask: buildExeInputComfyImageMask,
  InputVideoBoundaryFrames: buildExeInputVideoBoundaryFrames,
  InputSlider: buildExeInputSlider,
  InputImageSize: buildExeInputImageSize,
  InputLoRAChain: buildExeInputLoRAChain,
  InputLLMAPI: buildExeInputLLMAPI,
  InputCamera3D: buildExeInputCamera3D,
  Description: buildExeDescription
}

export const buildQAppAutoMap: {
  [K in QAppCfgAutoType]: ExeAutoBuilder<K>
} = {
  AutoSeed: buildExeAutoSeed,
  AutoLLMAPI: buildExeAutoLLMAPI
}
