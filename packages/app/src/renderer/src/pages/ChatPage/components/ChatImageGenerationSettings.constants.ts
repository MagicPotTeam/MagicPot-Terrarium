import type { OpenAIImageGenerationOptions } from '@shared/llm'

export const DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS: OpenAIImageGenerationOptions = {
  enabled: false,
  outputFormat: 'png',
  size: 'auto',
  quality: 'high',
  background: 'auto'
}
