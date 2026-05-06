import { ExeInputBuilder } from './types'
import InputComfyImageMask from '@renderer/components/inputs/InputComfyImageMask'
import baseQAppInputBuilder from './baseBuilder'

const buildExeInputComfyImageMask: ExeInputBuilder<'InputComfyImageMask'> = baseQAppInputBuilder({
  typeofValue: '',
  inputType: 'InputComfyImageMask',
  InputComponent: InputComfyImageMask,
  // 多数情况下 QApp 制作时的输入图片用户的 ComfyUI 上不会存在，所以默认值为空字符串
  getDefaultValue: (cfg, workflow) => ''
})

export default buildExeInputComfyImageMask
