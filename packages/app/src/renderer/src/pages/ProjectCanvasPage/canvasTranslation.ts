import type { TFunction } from 'i18next'
import type { resources } from '../../i18n'

type CanvasResourceKey = Extract<keyof (typeof resources)['zh-CN']['translation']['canvas'], string>

export type CanvasTranslationKey = `canvas.${CanvasResourceKey}`

export type CanvasTranslate = TFunction<'translation'>
