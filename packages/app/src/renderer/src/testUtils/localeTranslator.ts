import { createInstance } from 'i18next'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'

export type LocaleTranslate = (key: string, options?: Record<string, unknown>) => string

const translators = new Map<string, LocaleTranslate>()

/**
 * Real i18next translation backed by the renderer locale files, for tests that mock
 * react-i18next. Any language starting with "zh" reads zh-CN; everything else en-US.
 */
export function localeTranslator(language: string): LocaleTranslate {
  const lng = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  const cached = translators.get(lng)
  if (cached) return cached
  const instance = createInstance()
  void instance.init({
    lng,
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false },
    initAsync: false
  })
  const t = instance.t as unknown as LocaleTranslate
  const translate: LocaleTranslate = (key, options) => t(key, options)
  translators.set(lng, translate)
  return translate
}

/**
 * Translates only the keys under `prefixes` with the locale files and hands every other key
 * to `fallback`, so a test that asserts on raw keys elsewhere keeps doing so.
 */
export function scopedLocaleTranslator(
  language: string,
  prefixes: readonly string[],
  fallback: LocaleTranslate
): LocaleTranslate {
  const translate = localeTranslator(language)
  return (key, options) =>
    prefixes.some((prefix) => key.startsWith(prefix)) ? translate(key, options) : fallback(key, options)
}
