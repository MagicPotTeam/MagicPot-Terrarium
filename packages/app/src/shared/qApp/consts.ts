import { QAppCfgAllComponentType } from './cfgTypes'

export const QAppCfgComponentNameMap: Record<QAppCfgAllComponentType, string> = {
  Section: '分组',
  Description: '文字说明',
  InputPrompt: '提示词',
  InputComfyImage: '加载图像',
  InputComfyVideo: '加载视频',
  InputComfyImageMask: '图片蒙版',
  InputVideoBoundaryFrames: '视频首尾帧',
  InputSeed: '随机种',
  InputNumber: '数值',
  InputText: '文本',
  InputComfySelect: '下拉框',
  InputImageSize: '图片尺寸',
  InputSlider: '滑块',
  InputCamera3D: '3D相机',
  InputLoRAChain: 'LoRA链',
  InputLLMAPI: 'LLM API',
  AutoSeed: '隐藏种子',
  AutoLLMAPI: '默认 LLM API'
}
