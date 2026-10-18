import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'

const popupTranslationCases = [
  ['qapp.design.preview_panel_title', 'Quick App Panel Preview', '快应用面板预览'],
  ['qapp.design.preview_open', 'Try Quick App >>>', '试用快应用 >>>'],
  ['qapp.design.preview_close', '<<< Close Preview', '<<< 关闭试用'],
  ['qapp.design.unsaved_changes_title', 'Unsaved changes', '未保存的更改'],
  [
    'qapp.design.unsaved_changes_message',
    'There are unsaved changes. Are you sure you want to discard them?',
    '当前有未保存的更改，确定要放弃吗？'
  ],
  ['qapp.design.continue_editing', 'Continue editing', '继续编辑'],
  ['qapp.design.discard_changes', 'Discard changes', '放弃更改'],
  ['quickapp.workspace.more_categories', 'More categories', '更多分类']
] as const

describe('QAppDesignPopUpPanel locale resources', () => {
  it.each([
    ['en-US', en, 1],
    ['zh-CN', zh, 2]
  ] as const)(
    'resolves every required %s key from real i18next resources',
    async (lng, locale, valueIndex) => {
      const i18n = createInstance()
      await i18n.init({
        lng,
        fallbackLng: false,
        resources: { [lng]: { translation: locale } },
        interpolation: { escapeValue: false }
      })

      for (const [key, englishValue, chineseValue] of popupTranslationCases) {
        const expected = valueIndex === 1 ? englishValue : chineseValue
        expect(i18n.t(key)).toBe(expected)
        expect(i18n.t(key)).not.toBe(key)
      }
    }
  )
})
