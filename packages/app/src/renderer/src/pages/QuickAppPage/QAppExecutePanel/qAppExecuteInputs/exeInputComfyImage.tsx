import { ExeInputBuilder } from './types'
import InputComfyImage from '@renderer/components/inputs/InputComfyImage'
import baseQAppInputBuilder from './baseBuilder'

const buildExeInputComfyImage: ExeInputBuilder<'InputComfyImage'> = baseQAppInputBuilder({
  typeofValue: '',
  inputType: 'InputComfyImage',
  InputComponent: InputComfyImage,
  // 多数情况下 QApp 制作时的输入图片用户的 ComfyUI 上不会存在，所以默认值为空字符串
  getDefaultValue: (cfg, workflow) => '',
  // 验证图片是否已上传
  validate: (_workflow, value) => {
    if (!value || value.trim() === '') {
      return '请加载图像'
    }
    return ''
  }
})

export default buildExeInputComfyImage
