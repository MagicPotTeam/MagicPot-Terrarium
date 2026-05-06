import { ExeInputBuilder } from './types'
import InputComfyVideo from '@renderer/components/inputs/InputComfyVideo'
import baseQAppInputBuilder from './baseBuilder'

const buildExeInputComfyVideo: ExeInputBuilder<'InputComfyVideo'> = baseQAppInputBuilder({
  typeofValue: '',
  inputType: 'InputComfyVideo',
  InputComponent: InputComfyVideo,
  getDefaultValue: () => '',
  validate: (_workflow, value) => {
    if (!value || value.trim() === '') {
      return 'Please load a video first.'
    }
    return ''
  }
})

export default buildExeInputComfyVideo
