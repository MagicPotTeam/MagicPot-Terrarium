import type { QAppMenuItem } from '@shared/api/svcQApp'

export const BUILTIN_VIDEO_GENERATION_QAPP_KEY = '~builtin/video-generation'

export const isBuiltinVideoGenerationQApp = (key: string): boolean =>
  key === BUILTIN_VIDEO_GENERATION_QAPP_KEY

export const createBuiltinVideoGenerationQApp = (): QAppMenuItem => ({
  key: BUILTIN_VIDEO_GENERATION_QAPP_KEY,
  name: 'ai_video_generation',
  category: 'video',
  isBuiltin: true,
  isDirectory: false
})
